# -*- coding: utf-8 -*-
"""
core/tradingday.py
==================
交易日與時段判斷。

獨立成一支的理由是**避免循環相依**：`core/db.py`（SQLite 歷史資料）和
`core/quotes.py`（報價來源）都需要 get_history_cutoff_date()，但兩者互相也有
呼叫關係。把這個共用的日期規則抽出來，兩邊都只依賴它，就不會繞成一圈。

原始碼對照：0_💻_monitor.py 行 935-952（get_history_cutoff_date）、
             行 1147-1153（is_fubon_realtime_time）、
             行 1314-1332（get_effective_trading_reference_date）

⚠️ 已知限制（原版就有，這裡照舊，沒有偷偷「修好」）
--------------------------------------------------
只用星期幾判斷，**沒有台股國定假日行事曆**。所以春節、端午這種連假，
cutoff 會算錯一天。原版註解自己也標了這點。要修的話是另一個 issue
（接 TWSE 的開休市日曆），不在 Phase 0 範圍內——搬家階段不改行為。
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

from core.cache import ttl_cache

TW_TZ = ZoneInfo("Asia/Taipei")

# yfinance 今日以前的歷史資料每小時更新一次（沿用原版常數）
YFINANCE_HISTORY_CACHE_TTL_SEC = 60 * 60

__all__ = [
    "TW_TZ",
    "get_history_cutoff_date",
    "get_effective_trading_reference_date",
    "is_fubon_realtime_time",
    "today_str",
]


def today_str() -> str:
    """台北時間的今天，YYYY-MM-DD。所有快取的日期參數都用它，確保 key 一致。"""
    return datetime.now(TW_TZ).strftime("%Y-%m-%d")


@ttl_cache(ttl=YFINANCE_HISTORY_CACHE_TTL_SEC)
def get_history_cutoff_date(today_string: str):
    """
    回傳「歷史資料」允許的日期上界（不含此日期）。

    平日：直接用今天的日期即可（今天的 K 線本來就還沒收，歷史資料自然只到昨天）。

    週六／週日：因為沒有新的交易日，最新一筆歷史資料（週五收盤）會被
    get_last_price() 的「當日價格」重複抓到，導致「價格」與「昨收」變成同一天、
    漲跌% 恆為 0%。此時把上界往前推到週五，讓歷史資料只到週四，
    週五那筆改由「當日價格」呈現，避免重複。
    """
    today = pd.to_datetime(today_string).date()
    weekday = today.weekday()  # Mon=0 ... Sat=5, Sun=6
    if weekday == 5:      # 週六 → 上界為週五
        return today - timedelta(days=1)
    if weekday == 6:      # 週日 → 上界為週五
        return today - timedelta(days=2)
    return today


def get_effective_trading_reference_date(reference_dt=None):
    """
    取得「目前應該視為基準的交易日」，直接沿用跟 get_history_cutoff_date() 完全
    相同的規則（平日=今天；週六往前推 1 天=週五；週日往前推 2 天=週五），確保
    「今天是哪一天」的認知，在抓歷史資料、算昨收、跑訊號模組這三個地方永遠一致。

    原版註解記錄了上一版的錯誤做法（從 price_source 字串解析日期），這裡保留
    正確的做法：兩處共用同一套星期幾規則，不用猜。
    """
    dt = reference_dt if reference_dt is not None else datetime.now(TW_TZ)
    day_string = dt.strftime("%Y-%m-%d") if hasattr(dt, "strftime") else str(dt)
    return get_history_cutoff_date(day_string)


def is_fubon_realtime_time() -> bool:
    """09:00 ≤ 現在 < 13:30 才用富邦 WebSocket，之後自動切 yfinance。"""
    now = datetime.now(TW_TZ).time()
    start = datetime.strptime("09:00", "%H:%M").time()
    end = datetime.strptime("13:30", "%H:%M").time()
    return start <= now < end
