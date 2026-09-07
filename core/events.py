# -*- coding: utf-8 -*-
"""
core/events.py
==============
盤中事件流。跑馬燈、事件流面板、Telegram **全部吃這一條**。

為什麼一定要統一在這裡
----------------------
原本 Telegram 推播是在 `_telegram_loop` 裡自己從 latest_rows() 重推一次的。
如果盤中事件另外再走一條，就會出現「畫面有跳但 Telegram 沒推」或是反過來的狀況，
而且因為兩邊的判斷條件是各寫一份，出問題時你根本不知道要查哪一邊。

所以這裡是唯一的出口：偵測器只負責 `emit()`，要不要真的發出去由這裡決定；
跑馬燈與 Telegram 都只是這條流的消費者。

三道閘門，缺一個跑馬燈就會變成看不懂的洪流
------------------------------------------
193 檔股票配 1 秒偵測線，如果每次條件成立就發一則，一分鐘內畫面就沒法看了。
原版 `盤中訊號監控器.py` 累積出來的三道防線原封搬過來：

  1. **signal_key 去重** —— 同一個 key 只會發一次。key 裡含時間分桶與價量，
     所以「同一波行情的同一秒」不會重複發。

     ⚠️ 只有**真的發出去**的 key 才記進去重集合。被冷卻或優先權窗擋下的**不記**——
     那兩個是暫時性條件，等它過去同一個 key 應該還能發。原版是連擋下的也一起記，
     這在它那些帶秒級時間戳的 key 上沒事，但我們的「已觸及漲停價」key 是**整天
     唯一**的（`{code}_limit_up_hit_{日期}`）：一旦在被擋下時記進去，這檔今天就
     再也報不出漲停了。離線模擬跑出來的，不是推測。

  2. **每種訊號各自的冷卻** —— 拉抬 45 秒、反彈 240 秒、漲跌停 1800 秒。
     冷卻是「每檔 × 每種訊號」各自計算的，不是全域的。

  3. **30 秒優先權窗** —— 同一檔股票 30 秒內，如果已經發過更高優先的訊號，
     低優先的直接吞掉。這是為了避免「即將漲停」發完，緊接著同一檔的「預警」
     又發一則說同一件事。

⚠️ 一個原版的坑，這裡刻意修掉了
--------------------------------
原版的 `warning_active` **沒有檢查冷卻**（只有 entry 有）。在他那 19 檔上還撐得住，
193 檔配 1 秒偵測線就會炸。所以這裡每一種訊號都一定要帶 cooldown_sec，
沒有例外。
"""
from __future__ import annotations

import logging
import threading
from dataclasses import asdict, dataclass, field
from datetime import date, datetime

from core.state import TW_TZ

log = logging.getLogger(__name__)

__all__ = [
    "MarketEvent", "EventBus", "get_event_bus",
    "PRIORITY", "MARQUEE_LEVELS", "LEVEL_LABEL",
]

# 環形緩衝的長度。Render 免費方案沒有持久磁碟，事件流本來就只活在記憶體裡，
# 服務一重啟就沒了——想要當天的完整紀錄，Telegram 才是持久的那份。
MAX_EVENTS = 500

# 同一檔股票在這個秒數內，低優先的訊號會被高優先的壓掉
PRIORITY_WINDOW_SEC = 30

# 沿用原版 TG_SIGNAL_PRIORITY 的相對順序，數字大的贏。
#
# ⚠️ 「真的觸價」必須跟「接近」分成兩個等級，這是離線模擬抓出來的
# ------------------------------------------------------------------
# 一開始兩者共用 level="limit_up"，結果一檔在 30 秒內從 7.5% 直接鎖上漲停時，
# 「已觸及漲停價」會被 30 秒優先權窗當成「同等級的重複訊號」吞掉——
# 你只收到「快漲停了」，永遠收不到「漲停了」。而後者才是你真正要的那一則。
#
# 分成兩級之後，觸價(8/7) 高於接近(6/5)，所以它一定壓得過先前的預警。
PRIORITY = {
    "limit_up_hit": 8,    # 🔴 已觸及漲停價
    "limit_down_hit": 7,  # 🟢 已觸及跌停價
    "limit_up": 6,        # 🔺 即將漲停
    "limit_down": 5,      # 🔻 即將跌停
    "entry": 4,           # 🚀 瞬間拉抬
    "rebound": 2,         # 📈 瞬間反彈
    "warning": 1,         # ⚠️ 預警
}

# 上跑馬燈的種類。其餘（預警、跌停、觸及跌停）只進事件流面板。
# 跑馬燈是「一眼就要看懂」的地方，放太多種類等於沒有跑馬燈。
MARQUEE_LEVELS = {"entry", "rebound", "limit_up", "limit_up_hit"}

LEVEL_LABEL = {
    "limit_up_hit": "🔴 漲停",
    "limit_down_hit": "🟢 跌停",
    "limit_up": "🔺 即將漲停",
    "limit_down": "🔻 即將跌停",
    "entry": "🚀 瞬間拉抬",
    "rebound": "📈 瞬間反彈",
    "warning": "⚠️ 預警",
}


@dataclass
class MarketEvent:
    id: int
    ts: float
    time: str                       # HH:MM:SS，前端直接顯示
    level: str
    priority: int
    label: str
    symbol: str
    code: str
    name: str
    groups: list = field(default_factory=list)
    price: float | None = None
    pct: float | None = None
    text: str = ""
    marquee: bool = False           # 是否上跑馬燈

    def to_dict(self) -> dict:
        return asdict(self)


class EventBus:
    """全服務唯一一份。用 get_event_bus() 取得。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._events: list = []
        self._next_id = 1
        self._day: date = datetime.now(TW_TZ).date()

        # 去重與冷卻的簿記，全部是「當日」狀態，換日要清
        self._seen_keys: set = set()
        self._last_at: dict = {}        # {(code, level): ts}
        self._last_priority: dict = {}  # {code: (ts, priority)}

    # ------------------------------------------------------------------
    def _ensure_today(self) -> None:
        """
        換日重置。跟 AppState 一樣，長駐服務不處理這件事的話，
        昨天發過的訊號今天就不會再發（去重集合裡還留著昨天的 key）。
        """
        today = datetime.now(TW_TZ).date()
        if today != self._day:
            log.info("事件流偵測到換日 %s → %s，重置", self._day, today)
            self._day = today
            self._events.clear()
            self._seen_keys.clear()
            self._last_at.clear()
            self._last_priority.clear()

    # ------------------------------------------------------------------
    def emit(
        self,
        *,
        level: str,
        symbol: str,
        code: str,
        name: str,
        text: str,
        signal_key: str,
        cooldown_sec: int,
        groups: list | None = None,
        price: float | None = None,
        pct: float | None = None,
        now_ts: float | None = None,
    ) -> MarketEvent | None:
        """
        發一則事件。被任何一道閘門擋下就回傳 None（偵測器不需要知道被擋的原因）。

        回傳 MarketEvent 代表「這則真的要送出去」——呼叫端拿到它才去廣播與推播。
        """
        priority = PRIORITY.get(level, 0)
        now = datetime.now(TW_TZ)
        ts = now_ts if now_ts is not None else now.timestamp()

        with self._lock:
            self._ensure_today()

            # 閘門 1：同一個 key 只發一次
            if signal_key in self._seen_keys:
                return None

            # 閘門 2：這檔股票的這種訊號還在冷卻
            last = self._last_at.get((code, level))
            if last is not None and ts - last < max(0, cooldown_sec):
                return None

            # 閘門 3：30 秒內已經發過同等或更高優先的訊號
            prev = self._last_priority.get(code)
            if prev is not None:
                prev_ts, prev_priority = prev
                if ts - prev_ts < PRIORITY_WINDOW_SEC and priority <= prev_priority:
                    return None

            # 三關都過了，這則真的要發
            self._seen_keys.add(signal_key)
            self._trim_keys()
            self._last_at[(code, level)] = ts
            self._last_priority[code] = (ts, priority)

            event = MarketEvent(
                id=self._next_id,
                ts=ts,
                time=now.strftime("%H:%M:%S"),
                level=level,
                priority=priority,
                label=LEVEL_LABEL.get(level, level),
                symbol=symbol,
                code=code,
                name=name,
                groups=list(groups or []),
                price=price,
                pct=pct,
                text=text,
                marquee=level in MARQUEE_LEVELS,
            )
            self._next_id += 1
            self._events.append(event)
            if len(self._events) > MAX_EVENTS:
                del self._events[: len(self._events) - MAX_EVENTS]
            return event

    def _trim_keys(self) -> None:
        """去重集合不能無限長。沿用原版的做法：超過 2000 就砍成 1000。"""
        if len(self._seen_keys) > 2000:
            self._seen_keys = set(list(self._seen_keys)[-1000:])

    # ------------------------------------------------------------------
    def recent(self, limit: int = 100, levels: set | None = None) -> list:
        """最新的在前面。前端拿去畫事件流面板。"""
        with self._lock:
            self._ensure_today()
            items = self._events
            if levels:
                items = [e for e in items if e.level in levels]
            return [e.to_dict() for e in reversed(items[-limit:])]

    def counts(self) -> dict:
        """每種訊號今天發了幾則。狀態列與面板的篩選鈕用。"""
        with self._lock:
            self._ensure_today()
            out = {k: 0 for k in PRIORITY}
            for e in self._events:
                out[e.level] = out.get(e.level, 0) + 1
            return out

    def clear(self) -> int:
        with self._lock:
            n = len(self._events)
            self._events.clear()
            self._seen_keys.clear()
            self._last_at.clear()
            self._last_priority.clear()
            return n


_bus: EventBus | None = None
_bus_lock = threading.Lock()


def get_event_bus() -> EventBus:
    global _bus
    if _bus is None:
        with _bus_lock:
            if _bus is None:
                _bus = EventBus()
    return _bus
