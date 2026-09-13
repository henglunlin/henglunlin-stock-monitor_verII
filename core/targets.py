# -*- coding: utf-8 -*-
"""
core/targets.py
===============
目標價清單（target_price_list.json）：買入區間 + 停損。

原始碼對照：0__monitor.py 行 900-995

⚠️ 這五個函式只存在於 0__monitor.py（3,250 行版），不在 0_💻_monitor.py（3,039 行版）
--------------------------------------------------------------------------------
兩支檔案比對後確認：3,250 版 = 3,039 版 ＋ 這五個目標價函式，沒有任何東西被移除。
加上 pages/2_🎯_目標價編輯.py 的註解寫著「monitor 主程式的 render_live_monitor()
每次刷新都會讀這份 JSON 查表」，可判斷 **0__monitor.py 才是現行版**。

這支檔案把它補上，所以無論以哪一版為準，core/ 都涵蓋得到。

JSON 格式
---------
    {
      "2330.TW": {
        "target_price": 2200,     # 中心價
        "low_pct": 5,             # 買入區間下緣，相對中心價的 %
        "high_pct": 5,            # 買入區間上緣
        "stop_loss": 2000,        # 可為 null
        "enabled": true           # 舊資料沒有這個欄位時預設 true
      }
    }

只存「原始輸入」，買入區間的絕對值一律由 compute_buy_zone() 現算，不寫進 JSON——
這樣公式改了不用回頭改資料。
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime

import requests

from core import config
from core import groups as core_groups
from core.state import TW_TZ, get_state

log = logging.getLogger(__name__)

# 買入區間的計算公式直接用 signal_module 那一份，不重寫。
# pages/2_🎯_目標價編輯.py 的註解已經說明過理由：避免兩邊公式將來改到不一致。
try:
    from signal_module.target_price import compute_buy_zone
except Exception:  # pragma: no cover
    def compute_buy_zone(center: float, low_pct: float, high_pct: float):
        """signal_module 載不到時的等價備援（公式與該模組一致）。"""
        center = float(center)
        return center * (1 - float(low_pct) / 100.0), center * (1 + float(high_pct) / 100.0)

__all__ = [
    "load_target_price_list", "validate_and_normalize_target_price_json",
    "save_target_price_list", "compute_buy_zone", "format_target_price",
    "evaluate_target_price", "TargetSyncResult", "persist_target_price_list",
    "save_backup_snapshot", "fetch_target_price_list_from_github",
    "upload_target_price_list_to_github",
]

# 目標價編輯頁的存檔備份目錄。跟 core/groups.py 的 BACKUP_DIR 分開放，
# 避免兩種完全不同性質的快照混在同一個資料夾裡。
BACKUP_DIR = str(config.REPO_ROOT / "target_price_backups")


def _to_bool(value, default: bool = True) -> bool:
    """
    各種原始輸入正規化成布林。value 為 None 時視為 default——
    相容沒有 enabled 欄位的既有 target_price_list.json，一律預設開啟。
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() not in ("false", "0", "no", "off", "")
    return default


def _normalize_entry(raw) -> dict | None:
    """單筆正規化。型別不對就盡量救，救不了回 None（呼叫端跳過這筆）。"""
    if not isinstance(raw, dict):
        return None
    try:
        target_price = float(raw.get("target_price"))
    except (TypeError, ValueError):
        return None
    if target_price <= 0:
        return None

    def _pct(value, default=5.0):
        try:
            v = float(value)
        except (TypeError, ValueError):
            return default
        return v if v >= 0 else default

    low_pct = _pct(raw.get("low_pct"), 5.0)
    high_pct = _pct(raw.get("high_pct"), 5.0)

    stop_loss = None
    stop_loss_raw = raw.get("stop_loss")
    if stop_loss_raw not in (None, ""):
        try:
            sl = float(stop_loss_raw)
            if sl > 0:
                stop_loss = sl
        except (TypeError, ValueError):
            stop_loss = None

    return {
        "target_price": target_price,
        "low_pct": low_pct,
        "high_pct": high_pct,
        "stop_loss": stop_loss,
        "enabled": _to_bool(raw.get("enabled"), True),
    }


def validate_and_normalize_target_price_json(data) -> dict:
    """
    驗證／正規化整份 JSON（讀檔、GitHub 抓取、匯入時共用）。
    格式錯誤的個股直接跳過，不讓整份資料讀取失敗。
    """
    if not isinstance(data, dict):
        raise ValueError("JSON 格式錯誤：最外層必須是物件（dict）")
    validated = {}
    for symbol, raw in data.items():
        symbol = str(symbol).strip().upper()
        if not symbol:
            continue
        entry = _normalize_entry(raw)
        if entry is not None:
            validated[symbol] = entry
    return validated


def load_target_price_list() -> dict:
    """讀不到或格式壞掉都回空 dict——沒設定目標價不是錯誤狀態。"""
    path = config.TARGET_PRICE_FILE
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return validate_and_normalize_target_price_json(json.load(f))
        except Exception as e:
            log.warning("讀取 %s 失敗：%s", path, e)
    return {}


def save_target_price_list(data: dict) -> bool:
    try:
        with open(config.TARGET_PRICE_FILE, "w", encoding="utf-8") as f:
            json.dump(validate_and_normalize_target_price_json(data), f,
                      ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        log.warning("寫入 %s 失敗：%s", config.TARGET_PRICE_FILE, e)
        return False


def format_target_price(value) -> str:
    """整數不顯示小數點，否則到小數第二位——避免 2200.00 這種冗長顯示。"""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return str(value)
    if value == int(value):
        return str(int(value))
    return f"{value:.2f}"


def evaluate_target_price(symbol: str, price: float, table: dict | None = None) -> dict | None:
    """
    給前端用的整合結果：這檔股票現在落在買入區間的哪裡、有沒有跌破停損。

    ── 為什麼放在後端算 ──
    這是「訊號公式只留在 Python」原則的一部分。前端只負責畫那把量尺，
    不重算任何一個數字，避免將來兩邊公式漂移。

    回傳 None 表示這檔沒有設定目標價（或已停用）。
    """
    table = load_target_price_list() if table is None else table
    entry = table.get(str(symbol).strip().upper())
    if not entry or not entry.get("enabled", True):
        return None

    center = entry["target_price"]
    low, high = compute_buy_zone(center, entry["low_pct"], entry["high_pct"])
    stop_loss = entry.get("stop_loss")

    try:
        price = float(price)
    except (TypeError, ValueError):
        return None

    if stop_loss is not None and price <= stop_loss:
        zone = "stop_loss"        # 已跌破停損
    elif low <= price <= high:
        zone = "in_buy_zone"      # 落在買入區間
    elif price < low:
        zone = "below"            # 低於買入區間下緣
    else:
        zone = "above"            # 高於買入區間上緣

    return {
        "symbol": symbol,
        "target_price": center,
        "buy_low": round(low, 2),
        "buy_high": round(high, 2),
        "stop_loss": stop_loss,
        "price": price,
        "zone": zone,
        # 現價在「停損 → 買入上緣」這條軸上的相對位置（0~1），前端畫量尺直接用
        "position": _position_on_scale(price, stop_loss, low, high),
    }


def _position_on_scale(price, stop_loss, low, high):
    lo = stop_loss if stop_loss is not None else low * 0.95
    hi = high * 1.02
    if hi <= lo:
        return None
    return round(min(max((price - lo) / (hi - lo), 0.0), 1.0), 4)


# =============================================================================
# 目標價編輯器：備份與 GitHub 同步
# =============================================================================
# 沿用 core/groups.py 已經寫好的 SyncResult 概念，但欄位精簡一層——目標價只推
# 這個監控 app 自己的 repo，不像 stock_groups.json 還要同時推掃描器 repo，
# 所以不需要 pushed_scanner 那個欄位。
@dataclass
class TargetSyncResult:
    saved_local: bool = False
    pushed: bool = False
    attempted_push: bool = False
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.saved_local and (not self.attempted_push or self.pushed)


def _ensure_backup_dir() -> None:
    os.makedirs(BACKUP_DIR, exist_ok=True)


def save_backup_snapshot(data: dict) -> str:
    _ensure_backup_dir()
    filename = f"target_price_list_{datetime.now(TW_TZ).strftime('%Y%m%d_%H%M%S')}.json"
    file_path = os.path.join(BACKUP_DIR, filename)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return file_path


def fetch_target_price_list_from_github() -> dict:
    """從 raw.githubusercontent.com 讀最新版 target_price_list.json（公開 repo 免 token）。"""
    cfg = config.github_repo_config()
    url = (
        f"https://raw.githubusercontent.com/{cfg['owner']}/{cfg['repo']}"
        f"/{cfg['branch']}/target_price_list.json"
    )
    res = requests.get(url, timeout=15)
    res.raise_for_status()
    return validate_and_normalize_target_price_json(res.json())


def upload_target_price_list_to_github(
    data: dict,
    commit_message: str = "Update target_price_list.json via monitor app",
) -> tuple:
    """
    只推這個監控 app 自己的 repo——target_price_list.json 跟 stock_groups.json
    不一樣，不需要讓掃描器那邊也讀到。實際的 HTTP 呼叫直接借用
    core/groups.py 的 upload_file_to_repo()，不重寫一份一樣的錯誤處理邏輯。
    """
    content = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    return core_groups.upload_file_to_repo(
        content, "target_price_list.json", commit_message, config.github_repo_config()
    )


def persist_target_price_list(data: dict) -> TargetSyncResult:
    """
    存檔的統一入口：先存本機，再依設定決定要不要推 GitHub。跟
    core/groups.py 的 persist_groups() 是同一套邏輯，理由也相同——
    Render 免費方案沒有持久磁碟，本機檔案重新部署就會還原成 repo 裡的版本。
    """
    result = TargetSyncResult()
    result.saved_local = save_target_price_list(data)

    state = get_state()
    if not state.settings.sync_target_price_to_github:
        result.message = "已存檔（未啟用 GitHub 同步）" if result.saved_local else "本機存檔失敗"
        return result

    if not config.github_repo_config().get("token"):
        result.message = (
            "已存檔到本機。GitHub 同步已啟用但找不到 GITHUB_TOKEN，這次略過同步"
            "——注意 Render 免費方案沒有持久磁碟，重新部署後目標價設定會還原成 repo 裡那份。"
        )
        return result

    result.attempted_push = True
    ok, why = upload_target_price_list_to_github(data)
    result.pushed = ok
    result.message = "已同步更新到 GitHub 的 target_price_list.json。" if ok else f"同步 GitHub 失敗 → {why}"
    return result
