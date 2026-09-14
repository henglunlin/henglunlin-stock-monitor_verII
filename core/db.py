# -*- coding: utf-8 -*-
"""
core/db.py
==========
twse_ohlcv.db（本機 SQLite 歷史 OHLCV）存取層。

表格 ohlcv_data 欄位：
    Date, Market('上市'/'上櫃'), SecurityCode, SecurityName,
    Open, High, Low, Close, Volume

原始碼對照：0_💻_monitor.py 行 1009-1122

搬家時的唯一改動
----------------
1. @st.cache_data → @ttl_cache
2. TWSE_DB_PATH 從相對路徑改成 core.config 的絕對路徑
   （原本在 Streamlit 下 cwd 剛好是 repo 根目錄所以能動，FastAPI 不保證）
3. sqlite3 連線加上 check_same_thread=False 的說明（見下方註解）

⚠️ Render 免費方案的注意事項
---------------------------
twse_ohlcv.db 有 38MB，會跟著 repo 一起部署上去，這沒問題。但 Render 免費方案
**沒有持久磁碟**——每次重新部署，這個檔案會回到 repo 裡的版本。所以：

  * 唯讀查詢（這支檔案在做的事）完全沒問題
  * 但**不要**在 Render 上寫入這個 db，重啟就沒了

每日更新 OHLCV 的工作應該留在 GitHub Actions，commit 回 repo，
Render 下次部署時自然拿到新的。這也是「快慢分層」設計的一部分。
"""
from __future__ import annotations

import logging
import os
import sqlite3

import pandas as pd

from core import config
from core.cache import ttl_cache
from core.symbols import symbol_to_code
from core.tradingday import get_history_cutoff_date

log = logging.getLogger(__name__)

# 沿用原版常數
DB_HISTORY_CACHE_TTL_SEC = 60 * 60   # 歷史資料每小時更新一次
DB_LATEST_PRICE_CACHE_TTL_SEC = 30   # 「全部由 DB 讀取」模式下的當日價格快取秒數

__all__ = [
    "symbol_to_db_market",
    "download_history_from_db",
    "get_db_latest_price",
    "get_db_ohlc_for_date",
    "db_available",
    "DB_HISTORY_CACHE_TTL_SEC",
    "DB_LATEST_PRICE_CACHE_TTL_SEC",
]


def db_available() -> bool:
    return os.path.exists(config.TWSE_DB_PATH)


def _connect() -> sqlite3.Connection:
    """
    每次查詢開一條新連線、用完關掉。

    刻意不共用連線物件：sqlite3 的 Connection 預設綁定建立它的執行緒，
    而這裡會被 FastAPI 的多個 worker thread 同時呼叫。開關連線對 SQLite
    來說很便宜（尤其是唯讀），比處理跨執行緒共用的坑划算得多。
    """
    return sqlite3.connect(config.TWSE_DB_PATH)


def symbol_to_db_market(symbol: str) -> str:
    """.TWO → 上櫃，其餘 → 上市。"""
    s = str(symbol).strip().upper()
    return "上櫃" if s.endswith(".TWO") else "上市"


@ttl_cache(ttl=DB_HISTORY_CACHE_TTL_SEC)
def download_history_from_db(symbol: str, today_string: str, include_today: bool):
    """
    從 twse_ohlcv.db 取得日線歷史資料。

    原名 _download_stock_data_db_cached，改成公開名稱（前面的底線在原本是
    「內部函式」的意思，但搬過來之後它是 core 的正式 API 之一）。
    """
    if not db_available():
        raise ValueError(f"找不到資料庫檔案：{config.TWSE_DB_PATH}")

    code = symbol_to_code(symbol)
    market = symbol_to_db_market(symbol)
    cutoff = get_history_cutoff_date(today_string)

    conn = _connect()
    try:
        df = pd.read_sql_query(
            "SELECT Date, Open, High, Low, Close, Volume FROM ohlcv_data "
            "WHERE SecurityCode = ? AND Market = ? ORDER BY Date ASC",
            conn,
            params=(code, market),
        )
    finally:
        conn.close()

    if df is None or df.empty:
        raise ValueError(f"twse_ohlcv.db 無 {symbol}（代碼 {code}，{market}）資料")

    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"])

    if not include_today:
        df = df[df["Date"].dt.date < cutoff]

    required_cols = ["Open", "High", "Low", "Close", "Volume"]
    for col in required_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["Open", "High", "Low", "Close"])

    # 26 筆是技術指標（MACD 等）能算出有效值的最低要求，沿用原版門檻
    if len(df) < 26:
        raise ValueError(f"twse_ohlcv.db 資料不足（{symbol} 僅 {len(df)} 筆）")

    return (
        df[["Date", "Open", "High", "Low", "Close", "Volume"]]
        .sort_values("Date")
        .reset_index(drop=True)
    )


@ttl_cache(ttl=DB_LATEST_PRICE_CACHE_TTL_SEC)
def get_db_latest_price(symbol: str):
    """
    取得該股票在 db 裡「最新一筆」的收盤價與日期。
    用於「全部由 DB 讀取」（盤後模式）時的當日價格。

    回傳 (close: float, date_str: str)
    """
    if not db_available():
        raise ValueError(f"找不到資料庫檔案：{config.TWSE_DB_PATH}")

    code = symbol_to_code(symbol)
    market = symbol_to_db_market(symbol)

    conn = _connect()
    try:
        row = conn.execute(
            "SELECT Date, Close FROM ohlcv_data WHERE SecurityCode = ? AND Market = ? "
            "ORDER BY Date DESC LIMIT 1",
            (code, market),
        ).fetchone()
    finally:
        conn.close()

    if not row or row[1] is None:
        raise ValueError(f"twse_ohlcv.db 無 {symbol}（代碼 {code}，{market}）最新價格")

    date_str, close = row
    return float(close), str(date_str)


@ttl_cache(ttl=DB_LATEST_PRICE_CACHE_TTL_SEC)
def get_db_ohlc_for_date(symbol: str, target_date_str: str) -> dict:
    """
    直接撈出「特定日期」那天完整的真實開高低收，不受 get_history_cutoff_date()
    上界限制（那個限制只是決定「歷史資料」要不要包含這天，不代表這天的真實資料
    不存在於資料庫裡）。

    ── 為什麼需要這支（原版註解的重點，值得保留）──
    在「TWSE DB」這種非即時來源（收盤後查詢、或週末假日重新整理）的情況下，
    get_last_price() 拿到的是固定不變的歷史收盤價，每次輪詢都一樣。如果拿這種
    「不會變」的價格去跑 update_intraday_low()/update_intraday_high() 這種為了
    「即時逐筆追蹤」設計的累積邏輯，只會追蹤到一條扁平的死線（min/max 一個常數
    序列，結果就是那個常數本身），完全遺失掉當天真正的高低點。

    既然資料庫裡其實已經有這天完整的真實 OHLC，直接查表最準。

    查不到不拋例外，回傳三個 None，由呼叫端決定要不要退回追蹤機制。
    """
    result = {"open": None, "high": None, "low": None}
    if not db_available():
        return result

    def _to_float(v):
        try:
            return float(v) if v is not None else None
        except Exception:
            return None

    try:
        code = symbol_to_code(symbol)
        market = symbol_to_db_market(symbol)
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT Open, High, Low FROM ohlcv_data "
                "WHERE SecurityCode = ? AND Market = ? AND Date = ?",
                (code, market, target_date_str),
            ).fetchone()
        finally:
            conn.close()
        if row:
            o, h, l = row
            result = {"open": _to_float(o), "high": _to_float(h), "low": _to_float(l)}
    except Exception as e:
        log.debug("get_db_ohlc_for_date(%s, %s) 失敗：%s", symbol, target_date_str, e)
    return result
