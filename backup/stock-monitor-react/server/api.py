# -*- coding: utf-8 -*-
"""
server/api.py
=============
REST 端點。刻意保持很薄——所有邏輯都在 core/，這裡只做「接收請求 → 呼叫 core →
回傳 JSON」。

存取控制
--------
除了 /api/health 之外，全部端點都要求 `X-App-Token` header 與環境變數
APP_SHARED_TOKEN 相符。Render 給的網址是公開的，沒有這道防線等於把你的持股、
目標價、訊號攤在網路上給任何猜到網址的人看。

APP_SHARED_TOKEN 沒設定時（本機開發）驗證會自動放行，方便你不用先設環境變數
就能跑起來——但正式部署一定要設。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from core import config, groups as core_groups, targets
from core.cache import all_cache_info, clear_all_caches
from core.state import get_state
from server.hub import hub

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api")


# =============================================================================
# 認證
# =============================================================================
async def require_token(x_app_token: str | None = Header(default=None)) -> None:
    expected = config.APP_SHARED_TOKEN
    if not expected:
        return                      # 本機開發：沒設就不擋
    if x_app_token != expected:
        raise HTTPException(status_code=401, detail="X-App-Token 不正確")


auth = [Depends(require_token)]


# =============================================================================
# 請求／回應模型
# 這些 Pydantic model 同時也是自動產生 TypeScript 型別的來源（FastAPI 的 OpenAPI）
# =============================================================================
class FubonLoginRequest(BaseModel):
    fubon_id: str = Field(..., description="身分證字號")
    password: str = Field(..., description="富邦登入密碼")
    cert_password: str = Field(..., description="憑證密碼")


class GroupsRequest(BaseModel):
    groups: dict = Field(..., description="{分組名稱: [股票代碼, ...]}")


class SettingsPatch(BaseModel):
    realtime_source: str | None = None
    history_source: str | None = None
    post_market_enabled: bool | None = None
    post_market_source: str | None = None
    refresh_sec: int | None = None
    broadcast_interval_ms: int | None = None
    tg_push_enabled: bool | None = None
    scheduled_push_enabled: bool | None = None
    sync_groups_to_github: bool | None = None
    rise_threshold: float | None = None


# =============================================================================
# 健康檢查（不需 token —— 前端用它喚醒休眠中的 Render 服務）
# =============================================================================
@router.get("/health")
async def health():
    """
    Render 免費方案 15 分鐘無流量會休眠，冷啟動約 1 分鐘。
    前端載入時先打這支，拿到 200 才建 WebSocket，中間顯示「喚醒後端中…」。
    """
    state = get_state()
    return {
        "ok": True,
        "fubon_logged_in": state.fubon_logged_in,
        "clients": hub.client_count(),
    }


# =============================================================================
# 狀態
# =============================================================================
@router.get("/status", dependencies=auth)
async def status():
    """完整狀態，給前端的連線狀態列用。刻意不含任何憑證資訊。"""
    return get_state().snapshot_status()


# =============================================================================
# 富邦登入
# =============================================================================
@router.post("/fubon/login", dependencies=auth)
async def fubon_login(req: FubonLoginRequest):
    """
    手動登入。依你的決定，pfx 憑證放在伺服器的環境變數，
    身分證／密碼／憑證密碼由這次請求帶進來，用完不留存、不寫 log。
    """
    try:
        hub.login_fubon(req.fubon_id, req.password, req.cert_password)
    except Exception as e:
        get_state().fubon_last_error = str(e)
        # 注意：只回傳例外訊息，絕不回傳請求內容
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "status": get_state().snapshot_status()["fubon"]}


@router.post("/fubon/resubscribe", dependencies=auth)
async def fubon_resubscribe():
    hub.resubscribe()
    return {"ok": True, "status": get_state().snapshot_status()["fubon"]}


# =============================================================================
# 分組
# =============================================================================
@router.get("/groups", dependencies=auth)
async def read_groups():
    return {"groups": get_state().stock_groups}


@router.put("/groups", dependencies=auth)
async def write_groups(req: GroupsRequest):
    """
    存檔並（依設定）同步回 GitHub。

    ⚠️ Render 免費方案沒有持久磁碟，本機檔案重新部署就會還原。
    所以正式使用時 sync_groups_to_github 應該打開，那才是真正持久的存檔。
    """
    try:
        normalized = core_groups.validate_and_normalize_group_json(req.groups)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    result = core_groups.persist_groups(normalized)
    hub.resubscribe()
    return {
        "ok": result.ok,
        "message": result.message,
        "pushed_self": result.pushed_self,
        "pushed_scanner": result.pushed_scanner,
        "groups": normalized,
    }


@router.post("/groups/reload-from-github", dependencies=auth)
async def reload_groups_from_github():
    try:
        fetched = core_groups.fetch_groups_from_github()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"從 GitHub 讀取失敗：{e}")
    get_state().stock_groups = fetched
    hub.resubscribe()
    return {"ok": True, "groups": fetched}


# =============================================================================
# 資料
# =============================================================================
@router.get("/rows", dependencies=auth)
async def read_rows():
    """
    最近一次慢線算出來的完整列。前端剛連上時先打這支拿全量，
    之後靠 WebSocket 收增量。
    """
    return {"rows": hub.latest_rows()}


@router.post("/rows/refresh", dependencies=auth)
async def refresh_rows():
    """手動觸發一次慢線重算（前端的「重新整理」按鈕）。"""
    rows = hub.compute_all_rows()
    return {"ok": True, "count": len(rows), "rows": rows}


@router.get("/targets", dependencies=auth)
async def read_targets():
    return {"targets": targets.load_target_price_list()}


# =============================================================================
# 設定
# =============================================================================
@router.get("/settings", dependencies=auth)
async def read_settings():
    return get_state().settings.to_dict()


@router.patch("/settings", dependencies=auth)
async def patch_settings(patch: SettingsPatch):
    changes = {k: v for k, v in patch.model_dump().items() if v is not None}
    return get_state().update_settings(changes).to_dict()


# =============================================================================
# 維運
# =============================================================================
@router.get("/debug/cache", dependencies=auth)
async def debug_cache():
    """看每個快取累積了幾筆——Render 只有 512MB，這是盯記憶體最直接的方式。"""
    return {"caches": all_cache_info()}


@router.post("/admin/clear-cache", dependencies=auth)
async def admin_clear_cache():
    return {"ok": True, "cleared": clear_all_caches()}


@router.post("/admin/reset-daily", dependencies=auth)
async def admin_reset_daily():
    """手動重置當日狀態（當日高低、推播去重）。正常情況會自動換日重置。"""
    get_state().reset_daily()
    return {"ok": True}
