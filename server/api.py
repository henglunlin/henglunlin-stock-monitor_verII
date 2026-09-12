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

from core import config, groups as core_groups, line as core_line, notify, targets
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
    row_refresh_sec: int | None = None
    detector_interval_ms: int | None = None
    tg_push_enabled: bool | None = None
    line_push_enabled: bool | None = None
    scheduled_push_enabled: bool | None = None
    push_slots: list[str] | None = None
    digest_to_telegram: bool | None = None
    digest_to_line: bool | None = None
    line_message_format: str | None = None
    line_max_signals_per_stock: int | None = None
    tg_event_min_priority: int | None = None
    sync_groups_to_github: bool | None = None
    rise_threshold: float | None = None
    signal_rise_threshold: float | None = None
    dashboard_hot_ratio: float | None = None
    rebound_pct: float | None = None
    rebound_cooldown_sec: int | None = None
    rebound_open_silence_min: int | None = None
    limit_approach_pct: float | None = None
    limit_cooldown_sec: int | None = None
    entry_bucket_sec: int | None = None
    entry_track_sec: int | None = None
    entry_volume_ratio: float | None = None
    entry_min_volume: int | None = None
    entry_min_ticks: int | None = None
    entry_buy_pressure: float | None = None
    entry_price_move_pct: float | None = None
    entry_early_2s_pct: float | None = None
    entry_early_5s_pct: float | None = None
    entry_early_10s_pct: float | None = None
    entry_cooldown_sec: int | None = None
    warning_cooldown_sec: int | None = None
    fubon_watchdog_enabled: bool | None = None
    fubon_stale_sec: int | None = None
    fubon_watchdog_interval_sec: int | None = None
    fubon_ws_ping_sec: int | None = None
    fubon_ws_ping_timeout_sec: int | None = None
    fubon_connect_timeout_sec: int | None = None


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

    # 存檔前先留一份快照。誤刪一整個分類是很難救的，而快照幾乎不花成本。
    try:
        core_groups.save_backup_snapshot(get_state().stock_groups)
    except Exception as e:
        log.warning("備份快照失敗（不影響存檔）：%s", e)

    result = core_groups.persist_groups(normalized)
    # 訂閱同步：新增的訂閱、移除的退訂
    sub = hub.resubscribe()
    return {
        "ok": result.ok,
        "message": result.message,
        "pushed_self": result.pushed_self,
        "pushed_scanner": result.pushed_scanner,
        "subscription": sub,
        "groups": normalized,
    }


@router.get("/symbols/search", dependencies=auth)
async def search_symbols(q: str = "", limit: int = 20):
    """
    股票搜尋。給分類編輯器的「快速新增」用——打「台積」或「2330」都找得到。

    對照表（2,173 檔）在 core.symbols 裡是 24 小時快取的，所以這支只是記憶體裡的
    字串比對，成本趨近於零。**刻意不做模糊比對或注音**：那會讓結果變得難以預測，
    而這個輸入框的使用情境是「你已經知道要找哪一檔」，前綴與包含就夠了。

    排序：代碼完全相符 → 名稱開頭相符 → 名稱包含 → 代碼開頭相符。
    """
    from core.symbols import load_stock_lookup_maps, normalize_symbol_quick

    q = (q or "").strip().upper()
    if not q:
        return {"results": []}

    lookup = load_stock_lookup_maps()
    code_to_name = lookup.get("code_to_name", {})
    code_to_symbol = lookup.get("code_to_symbol", {})

    exact, name_prefix, name_contains, code_prefix = [], [], [], []
    for code, name in code_to_name.items():
        symbol = code_to_symbol.get(code) or normalize_symbol_quick(code)
        item = {"code": code, "name": name, "symbol": symbol}
        upper_name = name.upper()
        if code == q:
            exact.append(item)
        elif upper_name.startswith(q):
            name_prefix.append(item)
        elif q in upper_name:
            name_contains.append(item)
        elif code.startswith(q):
            code_prefix.append(item)
        if len(exact) + len(name_prefix) + len(name_contains) + len(code_prefix) > limit * 4:
            break

    results = (exact + name_prefix + name_contains + code_prefix)[:limit]
    return {"results": results}


@router.get("/groups/backups", dependencies=auth)
async def list_group_backups():
    """
    分組的備份快照。每次存檔前會自動留一份，這裡列出來讓你可以還原。

    ⚠️ Render 免費方案沒有持久磁碟，備份跟著服務走，重新部署就沒了。
    真正持久的那份是 GitHub 同步（sync_groups_to_github，現在預設開）。
    """
    return {"backups": core_groups.list_backup_files()}


@router.post("/groups/backup", dependencies=auth)
async def create_group_backup():
    path = core_groups.save_backup_snapshot(get_state().stock_groups)
    return {"ok": True, "path": path}


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
# 盤中走勢
# =============================================================================
@router.get("/taiex", dependencies=auth)
async def read_taiex():
    """
    加權指數即時走勢。對應 Streamlit 版的 render_taiex_chart()。

    失敗不拋例外，改回 {"available": false, "reason": ...}——加權指數只是輔助資訊，
    取不到的時候該顯示一行說明，不該讓整個畫面變成錯誤狀態。
    """
    from core import quotes
    return quotes.get_taiex_snapshot(get_state().fubon_manager)


@router.get("/intraday/{symbol}", dependencies=auth)
async def read_symbol_intraday(symbol: str):
    """
    單檔的當日盤中走勢（點開個股詳情時才呼叫）。

    優先用富邦分鐘 K——那涵蓋 09:00 到現在的完整一天，即使你中午才打開網頁。
    取不到才退回服務自己累積的 tick 序列。
    """
    from core import quotes
    from core.symbols import normalize_symbol_quick
    sym = normalize_symbol_quick(symbol) or symbol
    return quotes.get_symbol_intraday(get_state().fubon_manager, sym)


# =============================================================================
# 盤中事件流
# =============================================================================
@router.get("/events", dependencies=auth)
async def read_events(limit: int = 200, levels: str = ""):
    """
    事件流。前端剛連上時抓一次全量，之後靠 WebSocket 的 events 訊息收增量。

    levels 可傳逗號分隔的種類做篩選（例如 `entry,rebound,limit_up`），
    留空就是全部。
    """
    from core.events import get_event_bus
    wanted = {x.strip() for x in levels.split(",") if x.strip()} or None
    bus = get_event_bus()
    return {"events": bus.recent(limit=limit, levels=wanted), "counts": bus.counts()}


@router.post("/events/clear", dependencies=auth)
async def clear_events():
    from core.events import get_event_bus
    return {"ok": True, "cleared": get_event_bus().clear()}


# =============================================================================
# 設定
# =============================================================================
@router.get("/settings", dependencies=auth)
async def read_settings():
    return get_state().settings.to_dict()


@router.patch("/settings", dependencies=auth)
async def patch_settings(patch: SettingsPatch):
    changes = {k: v for k, v in patch.model_dump().items() if v is not None}
    s = get_state().update_settings(changes)
    # keepalive／逾時是套在 fugle 的 client 類別上的，改了設定要立刻生效
    # （下一次連線就會用新值；已經連著的那條維持原本的 ping 週期）
    if any(k.startswith("fubon_ws_") or k == "fubon_connect_timeout_sec" for k in changes):
        from core import fugle_patch
        fugle_patch.apply(
            ping_interval_sec=s.fubon_ws_ping_sec,
            ping_timeout_sec=s.fubon_ws_ping_timeout_sec,
            connect_timeout_sec=s.fubon_connect_timeout_sec,
        )
    return s.to_dict()


# =============================================================================
# 維運
# =============================================================================
@router.get("/debug/signals/{symbol}", dependencies=auth)
async def debug_signals(symbol: str):
    """
    單一股票的訊號偵錯：列出**全部**訊號的判定結果，含沒觸發的原因。

    這是把 Streamlit 版的「🔍 訊號偵錯（單檔股票細節）」面板搬過來。原版註解說得
    很清楚：主畫面的「買賣訊號」欄位只顯示有觸發、而且優先等級最高的那幾個，
    看不到「為什麼沒觸發」——這裡直接把每個模組的 SignalResult.detail 攤開來看。

    用的是這次呼叫當下的即時資料，跟主掃描迴圈完全同一套邏輯，不是另外模擬的。

    回傳裡刻意包含 price_ref_date、scan_date 與最後三根 K 棒——「掃描日對不對」
    是這類問題最常見的根因，攤開來比對最快。
    """
    from core import quotes
    from core.indicators import compute_indicators
    from core.signals import (
        SIGNAL_PRIORITY, SIGNAL_PRIORITY_DEFAULT, SIGNAL_REGISTRY,
        prepare_signal_dataframe,
    )
    from core.symbols import get_stock_name, normalize_symbol_quick
    from core.tradingday import get_effective_trading_reference_date
    from signal_module.base import SignalContext
    from server.hub import json_safe

    sym = normalize_symbol_quick(symbol) or symbol
    state = get_state()
    mgr = state.fubon_manager
    ref = get_effective_trading_reference_date()

    try:
        raw = quotes.download_stock_data(sym)
        df = quotes.normalize_ohlc(raw)
        if df.empty:
            raise ValueError("無法解析 OHLC 欄位格式")
        price, price_source = quotes.get_last_price(sym, df, mgr)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"取得 {sym} 資料失敗：{e}")

    ohlc = quotes.get_official_today_ohlc(mgr, sym)
    ohlc_from = "富邦 REST"
    if any(ohlc.get(k) is None for k in ("open", "high", "low")):
        db_ohlc = quotes.db.get_db_ohlc_for_date(sym, ref.strftime("%Y-%m-%d"))
        filled = False
        for k in ("open", "high", "low"):
            if ohlc.get(k) is None and db_ohlc.get(k) is not None:
                ohlc[k] = db_ohlc[k]
                filled = True
        ohlc_from = "twse_ohlcv.db" if filled else "全部退回即時價（今日 K 棒是一根十字線）"

    open_val = ohlc.get("open") if ohlc.get("open") is not None else price
    high_val = ohlc.get("high") if ohlc.get("high") is not None else (state.get_intraday_high(sym) or price)
    low_val = ohlc.get("low") if ohlc.get("low") is not None else (state.get_intraday_low(sym) or price)

    try:
        ind = prepare_signal_dataframe(df, open_val, high_val, low_val, price, price_ref_date=ref)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"prepare_signal_dataframe 失敗（所有訊號都會是 '-'）：{type(e).__name__}: {e}",
        )

    scan_date = ind.index[-1]
    ctx = SignalContext(
        code=sym, name=get_stock_name(sym), df=ind, scan_date=scan_date,
        params={"rise_threshold": state.settings.signal_rise_threshold},
    )

    results = []
    for key, cfg in SIGNAL_REGISTRY.items():
        label = cfg["label"]
        entry = {
            "key": key,
            "label": label,
            "kind": cfg.get("kind", "buy"),
            "priority": SIGNAL_PRIORITY.get(label, SIGNAL_PRIORITY_DEFAULT),
            "in_priority_table": label in SIGNAL_PRIORITY,
        }
        try:
            r = cfg["func"](ctx)
            entry["hit"] = bool(getattr(r, "hit", False))
            entry["detail"] = getattr(r, "detail", "")
        except Exception as e:
            entry["hit"] = False
            entry["detail"] = f"⚠️ 模組拋出例外（主畫面會安靜跳過）：{type(e).__name__}: {e}"
            entry["error"] = True
        results.append(entry)

    results.sort(key=lambda x: (not x["hit"], x["priority"]))

    try:
        indicators = compute_indicators(df, price, price_ref_date=ref)
    except Exception as e:
        indicators = {"error": str(e)}

    tail = ind.tail(3).reset_index()
    return json_safe({
        "symbol": sym,
        "name": get_stock_name(sym),
        # ── 「掃描日對不對」是這類問題最常見的根因，放最前面 ──
        "price_ref_date": ref.isoformat(),
        "scan_date": str(scan_date),
        "scan_date_matches_ref": str(scan_date) == ref.isoformat(),
        "price": price,
        "price_source": price_source,
        "today_ohlc": {"open": open_val, "high": high_val, "low": low_val, "來源": ohlc_from},
        "rise_threshold": state.settings.signal_rise_threshold,
        "history_rows": len(df),
        "history_last_date": str(df["Date"].iloc[-1].date()),
        "indicators": indicators,
        "hit_count": sum(1 for r in results if r["hit"]),
        "signals": results,
        "last_3_bars": tail.to_dict(orient="records"),
    })


@router.get("/debug/fubon", dependencies=auth)
async def debug_fubon():
    """
    富邦連線黑盒子。

    斷線是偶發的，而且多半發生在沒人盯著畫面的時候。之前每次出事都只剩一張
    截圖可以看，只能猜是哪一種斷法。這支把「今天這條連線發生過什麼事」整條
    時間軸吐出來：登入、連上、斷線、半開被抓到、重連成功／失敗與失敗原因。

    **不含任何憑證**——只有事件種類、時間與錯誤訊息。
    """
    state = get_state()
    mgr = state.fubon_manager
    if mgr is None:
        return {"available": False, "reason": "富邦 manager 尚未建立"}

    st = mgr.get_status()
    gap = mgr.seconds_since_last_message()
    s = state.settings
    return {
        "available": True,
        "logged_in": st.get("logged_in"),
        "connected": st.get("connected"),
        "subscribed_count": st.get("subscribed_count"),
        "tick_count": st.get("tick_count"),
        "seconds_since_last_message": round(gap, 1) if gap is not None else None,
        "is_stale": mgr.is_stale(max(30, int(s.fubon_stale_sec))),
        "disconnect_count": st.get("disconnect_count"),
        "stale_count": st.get("stale_count"),
        "reconnect_count": st.get("reconnect_count"),
        "reconnect_fail_count": st.get("reconnect_fail_count"),
        "session_dead": st.get("session_dead"),
        "last_reconnect_error": st.get("last_reconnect_error"),
        "error": st.get("error"),
        "watchdog": {
            "enabled": s.fubon_watchdog_enabled,
            "stale_sec": s.fubon_stale_sec,
            "interval_sec": s.fubon_watchdog_interval_sec,
            "connect_timeout_sec": s.fubon_connect_timeout_sec,
            "ws_ping_sec": s.fubon_ws_ping_sec,
            "ws_ping_timeout_sec": s.fubon_ws_ping_timeout_sec,
        },
        "history": mgr.conn_history(),
    }


@router.get("/debug/ws", dependencies=auth)
async def debug_ws(limit: int = 8):
    """
    富邦 WebSocket 偵錯。對應 Streamlit 側邊欄的「🔍 WebSocket Debug」expander。

    看的是**最原始的訊息內容**：連線狀態說「已連線」但價格不動的時候，
    真正的答案幾乎都在這裡——不是沒收到訊息，而是訊息的欄位名稱跟預期不同，
    _extract_symbol_price() 抓不到價格。把 raw 攤開就一眼看得出來。
    """
    from server.hub import json_safe

    state = get_state()
    mgr = state.fubon_manager
    if mgr is None:
        return {"available": False, "reason": "富邦 manager 尚未建立（服務剛啟動或未登入）。"}

    try:
        status = mgr.get_status()
    except Exception as e:
        return {"available": False, "reason": f"取得狀態失敗：{e}"}

    with mgr.lock:
        items = list(mgr.messages.items())[-limit:]
        prices = dict(list(mgr.prices.items())[:limit])
        subscribed = list(mgr.subscribed)[:40]

    last_at = status.get("last_message_at")
    return json_safe({
        "available": True,
        "connected": status.get("connected"),
        "logged_in": status.get("logged_in"),
        "subscribed_count": status.get("subscribed_count"),
        "tick_count": status.get("tick_count"),
        "pending_dirty": status.get("pending_dirty"),
        "last_message_at": last_at.isoformat(timespec="seconds") if last_at else None,
        "error": status.get("error"),
        "series_symbols": len(state.intraday_series),
        "subscribed_sample": subscribed,
        "price_sample": prices,
        "recent_messages": [
            {"symbol": sym, "time": m["time"].strftime("%H:%M:%S"), "raw": m["raw"]}
            for sym, m in items
        ],
    })


@router.get("/debug/detector", dependencies=auth)
async def debug_detector(sample: int = 8):
    """
    偵測器診斷。

    ⚠️ 這支存在的理由很具體：**訊號沒出來的時候，你要分得出是「真的沒訊號」
    還是「壞了」。** 我們踩過一次「所有訊號都顯示 —」而完全沒有錯誤訊息的坑，
    查了很久才發現是模組載入順序。這次直接把每個條件當下的實際值攤開：
    現價、昨收、今日最低、反彈%、算出來的漲跌停價、有沒有武裝。

    `scan_ms` 同時是「Render 免費方案 0.1 CPU 夠不夠」的量測依據——
    本機跑一天看 p95 是 5ms 還是 300ms，數字出來再決定要不要升方案。
    """
    from core.detectors import get_detector_engine
    from core.events import get_event_bus
    from server.hub import json_safe

    state = get_state()
    mgr = state.fubon_manager
    rows = hub.latest_rows()

    def price_of(code):
        return mgr.get_price(code) if mgr is not None else None

    diag = get_detector_engine().diagnostics(rows, price_of, sample=sample)
    diag["event_counts"] = get_event_bus().counts()
    diag["rows"] = len(rows)
    diag["detector_interval_ms"] = state.settings.detector_interval_ms
    return json_safe(diag)


@router.get("/debug/github", dependencies=auth)
async def debug_github():
    """
    GitHub 同步診斷。不用真的存分組就能知道 token 到底哪裡不對。

    ⚠️ 這支存在的理由跟偵測器診斷一樣：原本失敗訊息把 401 / 403 / 404 講成同一句
    「請確認設定」，而且失敗完全不寫 log，使用者只能在四種可能之間猜。

    三段檢查，逐段回報：環境變數有沒有 → token 有沒有效 → 這個 repo 推不推得動。
    **絕對不回傳 token 本身**，只回傳長度與前四碼，足夠判斷「有沒有貼錯／多引號」。
    """
    import requests

    cfg = config.github_repo_config()
    token, owner, repo, branch = cfg["token"], cfg["owner"], cfg["repo"], cfg["branch"]

    out = {
        "owner": owner, "repo": repo, "branch": branch,
        "token_present": bool(token),
        "token_len": len(token) if token else 0,
        "token_prefix": (token[:4] + "…") if token else "",
        "token_looks_quoted": bool(token) and (token[0] in "\"'" or token[-1] in "\"'"),
        "sync_enabled": get_state().settings.sync_groups_to_github,
    }
    if not token:
        out["verdict"] = "❌ 沒有 GITHUB_TOKEN。Render → Settings → Environment Variables 加上去。"
        return out
    if out["token_looks_quoted"]:
        out["verdict"] = "❌ token 前後有引號。Render 的輸入框不需要引號，直接貼值。"
        return out

    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    try:
        u = requests.get("https://api.github.com/user", headers=headers, timeout=15)
        out["token_valid"] = u.status_code == 200
        out["as_user"] = u.json().get("login") if u.status_code == 200 else None
        if u.status_code != 200:
            out["verdict"] = f"❌ token 無效（HTTP {u.status_code}）。重發一組新的 PAT。"
            return out

        r = requests.get(f"https://api.github.com/repos/{owner}/{repo}",
                         headers=headers, timeout=15)
        out["repo_status"] = r.status_code
        if r.status_code == 404:
            out["verdict"] = (f"❌ 找不到 {owner}/{repo}。名稱可能打錯"
                              "（注意 verII 前面是**底線**不是連字號），"
                              "或 fine-grained token 沒把這個 repo 加進 Repository access。")
            return out
        if r.status_code != 200:
            out["verdict"] = f"❌ 讀取 repo 失敗（HTTP {r.status_code}）。"
            return out

        perms = r.json().get("permissions", {})
        out["can_push"] = bool(perms.get("push"))
        out["verdict"] = ("✅ 一切正常，分組同步應該會成功。" if out["can_push"] else
                          "❌ token 對這個 repo 只有讀取權限。Contents 要改成 Read and write。")
    except Exception as e:
        out["verdict"] = f"❌ 連線 GitHub 失敗：{type(e).__name__}: {e}"
    return out


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


# =============================================================================
# 推播
# =============================================================================
@router.get("/debug/line", dependencies=auth)
async def debug_line():
    """
    LINE 推播診斷。設定頁的「LINE 推送狀態」區塊吃這個。

    這一組欄位是照著「真實查不出原因的事故」設計的：LINE 推播失敗時，
    HTTP 狀態碼只告訴你 400/401/429，真正的原因在 body 裡
    （token 過期？對象 id 錯？月額度用盡？）。所以 error 欄位一定要留著。

    ⚠️ 不回傳 token 本身，只回「有沒有設」與收件對象的尾四碼。
    """
    return {
        **core_line.last_status(),
        "digest_targets": notify.digest_targets(),
    }


class NotifyTestRequest(BaseModel):
    channel: str = Field("line", description='"line" | "telegram"')


@router.post("/notify/test", dependencies=auth)
async def notify_test(req: NotifyTestRequest):
    """
    發一則測試訊息。走的是與正式推播完全相同的函式，所以測試通過就代表
    正式推播會通。

    ⚠️ 這是同步的 requests 呼叫（約 1 秒），但刻意**不丟 executor**：
    它只在你按按鈕時跑一次，不是迴圈。api.py 裡真正需要丟 executor 的是
    debug_signals 與 debug_github 那兩支（會卡住 event loop 幾十秒）。
    """
    return notify.push_test(req.channel)
