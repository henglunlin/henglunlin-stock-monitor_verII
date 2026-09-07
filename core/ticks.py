# -*- coding: utf-8 -*-
"""
core/ticks.py
=============
逐筆成交明細的環形緩衝。🚀 瞬間拉抬需要的四樣東西全都存在這裡：
細粒度價格點、單筆量、內外盤、累積量。

⚠️ 為什麼不能照抄原版的存法
----------------------------
`盤中訊號監控器.py` 每檔股票留 `price_points` 1500 筆 + `recent_ticks` 1500 筆，
每一筆是含 datetime 物件的 dict。那支只跑 19 檔，很寬裕。**我們是 193 檔**：

    193 × 3000 筆 × 約 280 bytes（dict + datetime + float）  ≈  162 MB

Render 免費方案只有 512MB，而 pandas + 193 份歷史 DataFrame + 各種快取的底
已經吃掉一大半。照抄會直接把服務撐爆。

解法不是砍功能，是換存法：**四條平行的 float 陣列，時間戳存 epoch 秒**，
沒有 dict、沒有 datetime 物件、沒有 per-object 開銷：

    193 × 1500 筆 × 4 × 8 bytes  ≈  9.3 MB     ← 少 17 倍

窗口也從 400 秒縮到 120 秒。拉抬最長只回看 60 秒高低點、最大用到 30 秒桶，
120 秒綽綽有餘，所以功能一分都沒少。

存取模式
--------
寫入在富邦 SDK 的接收執行緒上（每秒可能幾十筆），讀取在偵測線上（每秒一次）。
寫入路徑刻意做到只有 append 與偶爾一次批次裁切——沒有排序、沒有搜尋、
沒有 numpy。裁切用攤還的方式（超過上限才一次砍掉四分之一），
不是每筆都 pop(0)。
"""
from __future__ import annotations

import threading
import time
from array import array
from bisect import bisect_left, bisect_right
from datetime import date, datetime

from core.state import TW_TZ

__all__ = ["TickStore", "get_tick_store", "SIDE_BUY", "SIDE_SELL", "SIDE_UNKNOWN"]

# 內外盤編碼。用數字而不是字串，是為了讓整條序列可以塞進 float 陣列。
SIDE_BUY = 1.0       # 外盤（買）
SIDE_SELL = -1.0     # 內盤（賣）
SIDE_UNKNOWN = 0.0

# 只保留最近這麼多秒。拉抬最長回看 60 秒，這裡留一倍餘裕。
WINDOW_SEC = 120.0
# 每檔的筆數上限。熱門股一秒十幾筆，120 秒約 1200~1500 筆。
MAX_TICKS = 1500
# 超過上限時一次砍掉這個比例（攤還裁切，避免每筆都做 O(n) 的搬移）
TRIM_RATIO = 0.25


class _Series:
    """
    單一股票的平行陣列。所有索引都是對齊的。

    `buyvol` 是刻意的空間換時間：寫入時就把「外盤的量」分流存一份
    （內盤與不明的位置存 0）。這樣「這段區間的外盤量」就變成
    `sum(buyvol[i:j])` —— 一個 C 層級的加總，而不是 Python 迴圈裡逐筆
    判斷 side 再累加。多 8 bytes/筆（總共約 +1.8MB），換掉整個掃描的熱點。
    """

    __slots__ = ("ts", "price", "vol", "buyvol", "last_cum")

    def __init__(self) -> None:
        self.ts = array("d")
        self.price = array("d")
        self.vol = array("d")
        self.buyvol = array("d")
        # 富邦有時只給累積量不給單筆量，要靠差值推回單筆量
        self.last_cum: float | None = None

    def append(self, ts: float, price: float, vol: float, side: float) -> None:
        self.ts.append(ts)
        self.price.append(price)
        self.vol.append(vol)
        self.buyvol.append(vol if side > 0 else 0.0)
        if len(self.ts) > MAX_TICKS:
            cut = int(MAX_TICKS * TRIM_RATIO)
            del self.ts[:cut]
            del self.price[:cut]
            del self.vol[:cut]
            del self.buyvol[:cut]

    def drop_before(self, cutoff: float) -> None:
        """丟掉超出時間窗的舊資料。時間戳遞增，用二分搜尋找切點。"""
        if not self.ts or self.ts[0] >= cutoff:
            return
        i = bisect_left(self.ts, cutoff)
        if i:
            del self.ts[:i]
            del self.price[:i]
            del self.vol[:i]
            del self.buyvol[:i]


class TickStore:
    """全服務唯一一份。用 get_tick_store() 取得。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._s: dict = {}
        self._day: date = datetime.now(TW_TZ).date()
        self.total_ticks = 0

    def _ensure_today(self) -> None:
        today = datetime.now(TW_TZ).date()
        if today != self._day:
            self._day = today
            self._s.clear()
            self.total_ticks = 0

    # ------------------------------------------------------------------
    def record(self, code: str, price: float | None, size: float | None,
               cum_volume: float | None, side: float) -> None:
        """
        記一筆成交。**在富邦 SDK 的接收執行緒上被呼叫，必須很快。**

        單筆量的取得沿用原版的兩段邏輯：
          1. 訊息裡直接有 size → 就用它
          2. 只有累積量 → 用「這次累積量 − 上次累積量」推回單筆量
             （差值 <= 0 代表沒有新成交或資料回捲，當成沒有這筆量）
        """
        if price is None:
            return
        now = time.time()
        with self._lock:
            self._ensure_today()
            s = self._s.get(code)
            if s is None:
                s = self._s[code] = _Series()

            vol = 0.0
            if size is not None and size > 0:
                vol = float(size)
                if cum_volume is not None:
                    s.last_cum = float(cum_volume)
            elif cum_volume is not None:
                cum = float(cum_volume)
                if s.last_cum is not None:
                    diff = cum - s.last_cum
                    if diff > 0:
                        vol = diff
                s.last_cum = cum

            s.append(now, float(price), vol, side)
            self.total_ticks += 1

    # ------------------------------------------------------------------
    def aggregate(self, code: str, now_ts: float, bucket_sec: float,
                  track_sec: float, ago_list: tuple) -> dict | None:
        """
        一次算完拉抬需要的所有聚合值。

        ⚠️ 這支的寫法是為了 Render 免費方案的 0.1 CPU 特別調過的
        ------------------------------------------------------------------
        第一版是「把整個視窗複製出來，再用 Python 迴圈掃四五遍」——
        193 檔各 1200 筆的最壞情況量到 **p50 60ms**。每秒跑一次就是
        一顆核心的 6%，換算到 0.1 CPU 是**六成的預算**，跟慢線和 SDK
        接收執行緒搶起來一定出事。

        改法有三個，全都是把 Python 迴圈換成 C 層級的操作：

          1. **二分搜尋找邊界**（bisect）取代線性掃描找起點
          2. **切片加總**（`sum(vol[i:j])`）取代逐筆累加的 for 迴圈；
             外盤量靠寫入時就分流的 buyvol 陣列，同樣一個 sum 解決
          3. **`max()`/`min()` 切片**取代自己寫的高低點迴圈

        結果是整支函式裡一個 Python 層級的迴圈都沒有。

        鎖：因為現在全部是微秒等級的 C 操作，直接在鎖裡算完就好，
        不需要先複製一份出來——複製本身才是原本最大的成本。
        """
        cutoff = now_ts - WINDOW_SEC
        bucket_start = int(now_ts // bucket_sec) * bucket_sec
        prev_start = bucket_start - bucket_sec
        track_start = now_ts - track_sec

        with self._lock:
            s = self._s.get(code)
            if s is None or not s.ts:
                return None
            s.drop_before(cutoff)
            ts = s.ts
            n = len(ts)
            if n < 2:
                return None

            i_bucket = bisect_left(ts, bucket_start)
            i_prev = bisect_left(ts, prev_start)
            i_track = bisect_left(ts, track_start)

            cur_vol = sum(s.vol[i_bucket:])
            cur_buy = sum(s.buyvol[i_bucket:])
            cur_ticks = n - i_bucket
            prev_vol = sum(s.vol[i_prev:i_bucket])

            if i_track < n:
                seg = s.price[i_track:]
                low, high = min(seg), max(seg)
            else:
                low = high = s.price[-1]

            # 各時間點的回溯價格：二分搜尋 O(log n)，取「不晚於該時刻」的最後一筆
            ago_prices = {}
            for sec in ago_list:
                j = bisect_right(ts, now_ts - sec)
                ago_prices[sec] = s.price[j - 1] if j > 0 else s.price[0]

            last_ts = ts[-1]

        return {
            "cur_vol": cur_vol, "cur_buy": cur_buy, "cur_ticks": cur_ticks,
            "prev_vol": prev_vol, "low": low, "high": high,
            "ago": ago_prices, "bucket_start": bucket_start, "last_ts": last_ts,
        }

    def last_tick_ts(self, code: str) -> float | None:
        """這檔最後一筆成交的時間。偵測線用它來跳過安靜的股票。"""
        with self._lock:
            s = self._s.get(code)
            return s.ts[-1] if (s and s.ts) else None

    def stats(self) -> dict:
        """給診斷端點用：目前追了幾檔、總共幾筆、記憶體大概多少。"""
        with self._lock:
            self._ensure_today()
            symbols = len(self._s)
            ticks = sum(len(s.ts) for s in self._s.values())
        return {
            "symbols": symbols,
            "buffered_ticks": ticks,
            # 四條陣列 × 8 bytes
            # 四條陣列（ts / price / vol / buyvol）× 8 bytes
            "approx_bytes": ticks * 4 * 8,
            "total_recorded": self.total_ticks,
            "window_sec": WINDOW_SEC,
            "max_ticks_per_symbol": MAX_TICKS,
        }

    def has_data(self, code: str) -> bool:
        with self._lock:
            s = self._s.get(code)
            return bool(s and len(s.ts))


_store: TickStore | None = None
_store_lock = threading.Lock()


def get_tick_store() -> TickStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = TickStore()
    return _store
