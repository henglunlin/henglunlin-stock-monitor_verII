# -*- coding: utf-8 -*-
"""
core/state.py
=============
取代 st.session_state。

為什麼不能直接照搬
------------------
Streamlit 的 session_state 是「每個瀏覽器分頁一份」。這在 monitor 裡造成過一個
你已經修過的 bug：富邦 SDK manager 被存成 per-tab，開兩個分頁就登入兩次。

搬到 FastAPI 之後，正確的模型是反過來的——**整個服務只有一份狀態**，所有連進來
的瀏覽器共享它。所以這裡用單例，不是 per-connection。

⚠️ 一個 Streamlit 幫你隱藏、但長駐服務會咬人的問題
--------------------------------------------------
`intraday_low_tracker`、`intraday_high_tracker`、`notified_stocks`、
`processed_time_slots` 這四個東西**本質上是「今天」的狀態**。

在 Streamlit 下它們跟著 session 死掉，所以你從來不用管重置。但 FastAPI 會連續
跑好幾天不重啟——如果不處理，昨天的當日最低價會被當成今天的，Telegram 昨天推過
的股票今天就不推了。

所以這裡的每個「當日狀態」都綁一個 trading_date，讀取時自動偵測換日並重置。
這是搬家過程中最容易漏掉、而且最難發現的一個坑（因為它只在隔天出錯）。
"""
from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, asdict, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from core import config

log = logging.getLogger(__name__)

TW_TZ = ZoneInfo("Asia/Taipei")

__all__ = ["Settings", "AppState", "get_state", "TW_TZ"]

SETTINGS_PATH = Path(config.REPO_ROOT) / "runtime_settings.json"


# =============================================================================
# 使用者設定：原本散在 session_state 的資料來源開關
# =============================================================================
@dataclass
class Settings:
    """
    對應原本 monitor 的這幾個 session_state key：
        realtime_source / history_source / post_market_enabled /
        post_market_source / refresh_sec / tg_push_enabled /
        scheduled_push_enabled / sync_groups_to_github

    第一版前端不提供切換介面（依 Phase 0 的決定），但值仍然可讀可寫，
    走 /api/settings，之後要加 UI 隨時可以加。
    """

    # 即時資料來源："fubon" | "yfinance"
    realtime_source: str = "fubon"
    # 歷史資料來源："db" | "yfinance"
    history_source: str = "db"
    # 盤後模式：開啟時當日＋歷史都由單一來源讀
    post_market_enabled: bool = False
    post_market_source: str = "db"
    # 前端輪詢／推送節奏（秒）。新架構是 WebSocket 推送，這個值只用於降級輪詢。
    refresh_sec: int = 3
    # WebSocket 廣播節流間隔（毫秒）。富邦逐筆進來很密，不節流會淹掉瀏覽器。
    broadcast_interval_ms: int = 300
    # Telegram
    tg_push_enabled: bool = False
    scheduled_push_enabled: bool = False
    # 分組存檔時是否同步推回 GitHub
    sync_groups_to_github: bool = False
    # 漲幅達標門檻（原本是側邊欄的 number_input）
    rise_threshold: float = 3.0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def load(cls) -> "Settings":
        if not SETTINGS_PATH.exists():
            return cls()
        try:
            raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            known = {f for f in cls.__dataclass_fields__}
            return cls(**{k: v for k, v in raw.items() if k in known})
        except Exception as e:
            log.warning("讀取 runtime_settings.json 失敗，改用預設值：%s", e)
            return cls()

    def save(self) -> None:
        try:
            SETTINGS_PATH.write_text(
                json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            # Render 免費方案的磁碟是暫時性的，寫失敗不該讓服務掛掉
            log.warning("寫入 runtime_settings.json 失敗（Render 免費方案無持久磁碟屬正常）：%s", e)


# =============================================================================
# 應用層狀態單例
# =============================================================================
class AppState:
    """
    整個服務共用的一份狀態。用 get_state() 取得，不要自己 new。

    所有讀寫都在 RLock 下進行——富邦的 callback 跑在 SDK 自己的執行緒，
    FastAPI 的 request 跑在別的執行緒，沒有鎖一定會出事。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()

        # --- 富邦連線 ---
        self.fubon_manager: Any = None          # core.fubon.FubonRealtimeManager
        self.fubon_logged_in: bool = False
        self.fubon_login_time: datetime | None = None
        self.fubon_last_error: str | None = None

        # --- 分組 ---
        self.stock_groups: dict = {}

        # --- 設定 ---
        self.settings: Settings = Settings.load()

        # --- 當日狀態（會自動換日重置，見 _ensure_today）---
        self._trading_date: date = self._today()
        self.intraday_low_tracker: dict = {}
        self.intraday_high_tracker: dict = {}
        self.notified_stocks: set = set()
        self.processed_time_slots: set = set()
        self.tg_last_update_id: int | None = None

    # ------------------------------------------------------------------
    # 換日處理
    # ------------------------------------------------------------------
    @staticmethod
    def _today() -> date:
        return datetime.now(TW_TZ).date()

    def _ensure_today(self) -> None:
        """
        偵測是否已經換日，是的話把所有「當日狀態」清空。

        必須在每個當日狀態的存取點呼叫。這是 Streamlit 版沒有、但長駐服務
        一定要有的東西。
        """
        today = self._today()
        if today != self._trading_date:
            log.info("偵測到換日 %s → %s，重置當日狀態", self._trading_date, today)
            self._trading_date = today
            self.intraday_low_tracker.clear()
            self.intraday_high_tracker.clear()
            self.notified_stocks.clear()
            self.processed_time_slots.clear()
            # tg_last_update_id 刻意不清：那是 Telegram 的訊息游標，
            # 跟交易日無關，清掉會把昨天的舊指令重收一次。

    def reset_daily(self) -> None:
        """手動重置當日狀態（給 /api/admin/reset-daily 或開盤前排程用）。"""
        with self._lock:
            self._trading_date = self._today()
            self.intraday_low_tracker.clear()
            self.intraday_high_tracker.clear()
            self.notified_stocks.clear()
            self.processed_time_slots.clear()
            log.info("已手動重置當日狀態")

    # ------------------------------------------------------------------
    # 當日高低點：取代原本的 update_intraday_low / update_intraday_high
    # ------------------------------------------------------------------
    def update_intraday_low(self, symbol: str, price: float | None) -> float | None:
        """
        記住這檔股票「今天」看過的最低價並回傳。

        原本的註解說得很清楚：富邦推來的當日最低價會忽有忽無，所以要自己
        在記憶體裡累積一份。邏輯不變，只是換了存放的地方。
        """
        if price is None:
            return self.get_intraday_low(symbol)
        with self._lock:
            self._ensure_today()
            current = self.intraday_low_tracker.get(symbol)
            if current is None or price < current:
                self.intraday_low_tracker[symbol] = price
                return price
            return current

    def update_intraday_high(self, symbol: str, price: float | None) -> float | None:
        if price is None:
            return self.get_intraday_high(symbol)
        with self._lock:
            self._ensure_today()
            current = self.intraday_high_tracker.get(symbol)
            if current is None or price > current:
                self.intraday_high_tracker[symbol] = price
                return price
            return current

    def get_intraday_low(self, symbol: str) -> float | None:
        with self._lock:
            self._ensure_today()
            return self.intraday_low_tracker.get(symbol)

    def get_intraday_high(self, symbol: str) -> float | None:
        with self._lock:
            self._ensure_today()
            return self.intraday_high_tracker.get(symbol)

    # ------------------------------------------------------------------
    # Telegram 去重
    # ------------------------------------------------------------------
    def already_notified(self, key: str) -> bool:
        with self._lock:
            self._ensure_today()
            return key in self.notified_stocks

    def mark_notified(self, key: str) -> None:
        with self._lock:
            self._ensure_today()
            self.notified_stocks.add(key)

    def clear_notified(self) -> None:
        """收到 'push' 指令要強制推播時，清掉去重記錄（原本的行為）。"""
        with self._lock:
            self.notified_stocks.clear()

    def slot_processed(self, slot_key: str) -> bool:
        with self._lock:
            self._ensure_today()
            return slot_key in self.processed_time_slots

    def mark_slot_processed(self, slot_key: str) -> None:
        with self._lock:
            self._ensure_today()
            self.processed_time_slots.add(slot_key)

    # ------------------------------------------------------------------
    # 設定
    # ------------------------------------------------------------------
    def update_settings(self, patch: dict) -> Settings:
        with self._lock:
            known = set(Settings.__dataclass_fields__)
            for key, value in patch.items():
                if key in known:
                    setattr(self.settings, key, value)
            self.settings.save()
            return self.settings

    # ------------------------------------------------------------------
    # 診斷
    # ------------------------------------------------------------------
    def snapshot_status(self) -> dict:
        """給 /api/status 用。刻意不含任何憑證資訊。"""
        with self._lock:
            self._ensure_today()
            manager_status = {}
            if self.fubon_manager is not None:
                try:
                    manager_status = self.fubon_manager.get_status()
                except Exception as e:
                    manager_status = {"error": str(e)}
            last_msg = manager_status.get("last_message_at")
            return {
                "trading_date": self._trading_date.isoformat(),
                "server_time": datetime.now(TW_TZ).isoformat(timespec="seconds"),
                "fubon": {
                    "logged_in": bool(self.fubon_logged_in),
                    "login_time": self.fubon_login_time.isoformat(timespec="seconds")
                    if self.fubon_login_time else None,
                    "connected": manager_status.get("connected", False),
                    "subscribed_count": manager_status.get("subscribed_count", 0),
                    "last_message_at": last_msg.isoformat(timespec="seconds")
                    if isinstance(last_msg, datetime) else None,
                    "error": manager_status.get("error") or self.fubon_last_error,
                },
                "groups": {name: len(v) for name, v in self.stock_groups.items()},
                "tracked_symbols": len(self.intraday_low_tracker),
                "notified_today": len(self.notified_stocks),
                "settings": self.settings.to_dict(),
            }


# =============================================================================
# 單例存取
# =============================================================================
_state: AppState | None = None
_state_lock = threading.Lock()


def get_state() -> AppState:
    """取得全域唯一的 AppState。多執行緒安全。"""
    global _state
    if _state is None:
        with _state_lock:
            if _state is None:
                _state = AppState()
    return _state
