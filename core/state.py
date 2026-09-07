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
import time
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

# ── 盤中走勢的取樣參數 ──
# 富邦逐筆成交進來非常密（熱門股一秒好幾筆），全存會爆記憶體也沒有意義：
# 迷你走勢圖只有 96px 寬，畫再多點也看不出來。所以每檔每 SAMPLE 秒只留一個點，
# 同一個取樣窗內的後續 tick 只更新那個點的值（等同於「該區間的收盤價」）。
#
# 09:00–13:30 共 270 分鐘，20 秒一點 = 810 點，上限開 900 讓盤前試撮也放得下。
# 193 檔 × 900 點 × 2 個 float ≈ 3MB，Render 免費方案的 512MB 完全吃得下。
INTRADAY_SAMPLE_SEC = 20
INTRADAY_MAX_POINTS = 900


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
    # WebSocket 廣播節流間隔（毫秒）＝「快線」。富邦逐筆進來很密，不節流會淹掉瀏覽器。
    broadcast_interval_ms: int = 300
    # 慢線：技術指標與訊號的重算間隔（秒）。
    # 原本寫死在 hub.py 的 ROW_REFRESH_SEC，改成設定值，前端才能調。
    # 這是 Streamlit 版「刷新秒數」在新架構下真正對應的東西——
    # 那個 3 秒是「整頁重跑」的間隔，而整頁重跑做的就是「重算指標與訊號」。
    row_refresh_sec: int = 20
    # 偵測線：盤中事件偵測的掃描間隔（毫秒）。
    # 拉抬用 2 秒窗，所以這個值不能超過 2000，否則 2 秒訊號會被跳過。
    detector_interval_ms: int = 1000
    # Telegram
    tg_push_enabled: bool = False
    scheduled_push_enabled: bool = False
    # 盤中事件要推 Telegram 的最低優先權（見 core/events.py 的 PRIORITY）。
    # 預設 2 = 反彈以上都推，預警(1)不推——預警在 193 檔上很吵，適合留在畫面看。
    tg_event_min_priority: int = 2
    # 分組存檔時是否同步推回 GitHub
    sync_groups_to_github: bool = True

    # ── 兩個門檻，刻意分開 ──
    # 原本只有一個 rise_threshold，同時被「儀表板要不要算達標」和「漲幅達標訊號要不要
    # 觸發」使用。這兩件事沒有理由綁在一起：前者是你想怎麼看，後者會改變訊號行為。
    # 所以拆開——UI 歸 UI、訊號歸訊號。
    rise_threshold: float = 5.0            # 儀表板達標計數、表格漲跌%高亮
    signal_rise_threshold: float = 3.0     # 傳進訊號引擎（「漲幅達標」訊號吃這個）

    # 儀表板卡片轉紅的達標比例門檻（%）。下界 0 是語意（完全沒達標）不是參數，寫死。
    dashboard_hot_ratio: float = 60.0

    # ── 盤中事件偵測 ──
    # 📈 瞬間反彈：現價相對「今日最低」的漲幅
    rebound_pct: float = 3.0
    rebound_cooldown_sec: int = 240
    # 開盤靜默期（分鐘）：只套用在反彈上。
    # 開盤第一筆 tick 必然就是當時的「今日最低」，所以 09:00 一路衝的股票會在幾分鐘內
    # 誤報反彈。拉抬與漲停沒有這個問題（它們不依賴今日最低），所以不靜音。設 0 可關閉。
    rebound_open_silence_min: int = 5

    # 🔺 即將漲停 / 跌停：漲跌幅達到這個值就預警（真正的漲停價另外用升降單位算）
    limit_approach_pct: float = 7.5
    limit_cooldown_sec: int = 1800         # 30 分鐘，沿用原版

    # ── 🚀 瞬間拉抬（第二批）──
    # 這一組全部照搬 盤中訊號監控器.py 的 DEFAULT_ENTRY_* / DEFAULT_EARLY_*，
    # 那是實戰調出來的值。開放在設定裡調，但預設不動它。
    entry_bucket_sec: int = 30             # 量能比較的時間桶
    entry_track_sec: int = 60              # 高低點追蹤窗
    entry_volume_ratio: float = 1.1        # 預估本桶量 / 前一桶量
    entry_min_volume: int = 20             # 本桶最小量，濾掉零星成交
    entry_min_ticks: int = 2               # 本桶最少筆數
    entry_buy_pressure: float = 0.55       # 外盤占比
    entry_price_move_pct: float = 2.0      # 30 秒漲幅 ／ 從 60 秒低點拉抬
    entry_early_2s_pct: float = 0.8
    entry_early_5s_pct: float = 0.8
    entry_early_10s_pct: float = 1.2
    entry_cooldown_sec: int = 45
    # ⚠️ 原版的「預警」沒有冷卻（只有進場訊號有）。他那 19 檔撐得住，
    # 我們 193 檔配每秒偵測會變成洪流，所以這裡一定要給它自己的冷卻。
    warning_cooldown_sec: int = 60

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
        # {symbol: [[epoch_sec, price], ...]} —— 當日盤中走勢，見 INTRADAY_SAMPLE_SEC
        self.intraday_series: dict = {}
        self.notified_stocks: set = set()
        self.processed_time_slots: set = set()
        self.tg_last_update_id: int | None = None

    # ------------------------------------------------------------------
    # 代碼正規化
    # ------------------------------------------------------------------
    @staticmethod
    def _key(symbol: str) -> str:
        """
        當日狀態一律用「代碼」當 key（2330，不是 2330.TW）。

        ⚠️ 這個正規化不是可有可無的，它修掉一個很安靜的 bug
        --------------------------------------------------------
        富邦的 on_tick 回呼送進來的是 **代碼**（`_extract_symbol_price()` 裡
        已經做過 symbol_to_code），所以三個當日追蹤字典的 key 全都是 "2330"。
        但 hub._compute_row() 是拿 **完整 symbol**（"2330.TW"）來查的。

        結果：查永遠查不到，而且**不會報錯**——
          · 當日高低點的 fallback 永遠落到「用現價當高低點」
          · 盤中走勢序列永遠是空的，走勢欄整天退回日線

        兩個都是「看起來有在動、其實沒作用」的那種問題。與其要求每個呼叫端
        自己記得轉換，不如在這裡統一吃下兩種寫法。

        （這裡不 import core.symbols 是為了避免 import 循環——
        core.symbols 之後若要讀設定就會反過來需要 core.state。邏輯完全一樣。）
        """
        return str(symbol).strip().upper().split(".")[0]

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
            self.intraday_series.clear()
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
            self.intraday_series.clear()
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
        key = self._key(symbol)
        with self._lock:
            self._ensure_today()
            current = self.intraday_low_tracker.get(key)
            if current is None or price < current:
                self.intraday_low_tracker[key] = price
                return price
            return current

    def update_intraday_high(self, symbol: str, price: float | None) -> float | None:
        if price is None:
            return self.get_intraday_high(symbol)
        key = self._key(symbol)
        with self._lock:
            self._ensure_today()
            current = self.intraday_high_tracker.get(key)
            if current is None or price > current:
                self.intraday_high_tracker[key] = price
                return price
            return current

    def get_intraday_low(self, symbol: str) -> float | None:
        with self._lock:
            self._ensure_today()
            return self.intraday_low_tracker.get(self._key(symbol))

    def get_intraday_high(self, symbol: str) -> float | None:
        with self._lock:
            self._ensure_today()
            return self.intraday_high_tracker.get(self._key(symbol))

    # ------------------------------------------------------------------
    # 當日盤中走勢：每檔一條取樣過的價格序列
    # ------------------------------------------------------------------
    def record_tick(self, symbol: str, price: float | None) -> None:
        """
        記一筆盤中價。由富邦的 on_tick 回呼進來，**必須很快**——熱門股一秒好幾筆，
        193 檔同時進來，這裡多花 1ms 都會拖住 SDK 的接收執行緒。

        所以只做兩件事：判斷是否還在同一個取樣窗，然後 append 或改寫最後一點。
        沒有排序、沒有搜尋、沒有 numpy。
        """
        if price is None:
            return
        now = time.time()
        key = self._key(symbol)
        with self._lock:
            self._ensure_today()
            buf = self.intraday_series.setdefault(key, [])
            if buf and now - buf[-1][0] < INTRADAY_SAMPLE_SEC:
                buf[-1][1] = price          # 同一取樣窗 → 只更新值（等同該區間收盤價）
                return
            buf.append([now, price])
            if len(buf) > INTRADAY_MAX_POINTS:
                del buf[: len(buf) - INTRADAY_MAX_POINTS]

    @staticmethod
    def _downsample(buf: list, limit: int) -> list:
        """
        等距抽樣到 limit 點，**且一定包含最後一點**。

        最後一點必須保留，因為那是「現在的價格」——迷你走勢圖的線尾要跟價格欄
        對得上，抽樣抽掉線尾會讓兩個欄位看起來互相矛盾。
        """
        n = len(buf)
        if n <= limit:
            return [p[1] for p in buf]
        step = (n - 1) / (limit - 1)
        idx = sorted({min(n - 1, int(round(i * step))) for i in range(limit)})
        if idx[-1] != n - 1:
            idx.append(n - 1)
        return [buf[i][1] for i in idx]

    def series_of(self, symbol: str, limit: int = 60) -> list:
        with self._lock:
            self._ensure_today()
            return self._downsample(self.intraday_series.get(self._key(symbol), []), limit)

    def series_with_time(self, symbol: str, limit: int = 400) -> list:
        """給單檔詳情圖用：保留時間戳，前端才畫得出 X 軸。"""
        with self._lock:
            self._ensure_today()
            buf = self.intraday_series.get(self._key(symbol), [])
            n = len(buf)
            if n <= limit:
                picked = list(buf)
            else:
                step = (n - 1) / (limit - 1)
                idx = sorted({min(n - 1, int(round(i * step))) for i in range(limit)})
                if idx[-1] != n - 1:
                    idx.append(n - 1)
                picked = [buf[i] for i in idx]
            return [
                {"t": datetime.fromtimestamp(t, TW_TZ).strftime("%H:%M:%S"), "v": v}
                for t, v in picked
            ]

    def all_series(self, limit: int = 60) -> dict:
        """一次拿全部——前端剛連上時用這包當種子，之後靠快線自己往後長。"""
        with self._lock:
            self._ensure_today()
            return {
                sym: self._downsample(buf, limit)
                for sym, buf in self.intraday_series.items()
                if buf
            }

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
                "tick_count": manager_status.get("tick_count", 0),
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
