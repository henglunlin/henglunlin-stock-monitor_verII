# -*- coding: utf-8 -*-
"""
core/quotes.py
==============
報價取得與資料來源切換。整個 core/ 裡最核心的一支。

原始碼對照：0_💻_monitor.py 行 953-1008、1123-1146、1154-1272、1333-1367

搬家時的改動只有兩類（邏輯完全沒動）
------------------------------------
1. `@st.cache_data` → `@ttl_cache`
2. `st.session_state.get("history_source", ...)` → `get_state().settings.history_source`

第 2 點是這支檔案唯一需要動腦的地方：原本資料來源開關存在「每個瀏覽器分頁各一份」
的 session_state 裡，現在改成整個服務共用一份 Settings。這正是我們要的語意——
資料來源是服務層級的設定，不該每個分頁不一樣。

資料來源的優先順序（原版行為，原封不動保留）
--------------------------------------------
【盤後模式開啟】
    post_market_source == "db"  → twse_ohlcv.db 最新收盤
    否則                        → yfinance 最新日線收盤

【盤後模式關閉】
    realtime_source == "yfinance" → 強制走 after_1330 那套多層 fallback
    否則（"fubon"）：
        09:00-13:30 → 富邦 WebSocket → 失敗退 yfinance fast_info → 再退歷史最後一筆
        13:30 之後  → after_1330_price_logic()

after_1330_price_logic 自己還有四層 fallback：
    yfinance fast_info → Yahoo TW → yfinance 日線 → 過期的 fast_info → 歷史收盤
這個多層退避是原版累積出來的實戰經驗（雲端 yfinance 常被限流），一層都不要拿掉。
"""
from __future__ import annotations

import json
import logging

import pandas as pd
import requests
import yfinance as yf

from core import db
from core.cache import ttl_cache
from core.state import get_state
from core.symbols import build_yfinance_candidates
from core.tradingday import (
    TW_TZ,
    YFINANCE_HISTORY_CACHE_TTL_SEC,
    get_history_cutoff_date,
    is_fubon_realtime_time,
    today_str,
)

log = logging.getLogger(__name__)

__all__ = [
    "download_stock_data", "normalize_ohlc", "parse_price_value",
    "get_yfinance_fast_info_price", "get_yahoo_tw_quote_price",
    "get_yfinance_latest_daily_close", "after_1330_price_logic",
    "get_last_price", "download_history_yfinance",
]


# =============================================================================
# 歷史資料
# =============================================================================
@ttl_cache(ttl=YFINANCE_HISTORY_CACHE_TTL_SEC)
def download_history_yfinance(symbol: str, today_string: str):
    """
    yfinance 日線歷史（原名 _download_stock_data_yfinance_history_cached）。

    會依序嘗試 build_yfinance_candidates() 給的代碼變體，全部失敗才拋例外。
    """
    candidates = build_yfinance_candidates(symbol)
    last_error = ""
    cutoff = get_history_cutoff_date(today_string)

    for yf_symbol in candidates:
        try:
            df = yf.download(
                yf_symbol,
                period="3mo",
                interval="1d",
                auto_adjust=True,
                progress=False,
                threads=False,   # 雲端環境開 threads 容易被 yfinance 限流
            )
        except Exception as e:
            last_error = f"{yf_symbol}: {e}"
            continue

        if df is None or df.empty:
            last_error = f"{yf_symbol}: yfinance 無資料"
            continue

        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] if isinstance(c, tuple) else c for c in df.columns]

        df = df.reset_index()
        date_col = (
            "Date" if "Date" in df.columns
            else "Datetime" if "Datetime" in df.columns
            else df.columns[0]
        )
        df = df.rename(columns={date_col: "Date"})
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
        df = df.dropna(subset=["Date"])

        df = df[df["Date"].dt.date < cutoff]

        required_cols = ["Open", "High", "Low", "Close", "Volume"]
        if not set(required_cols).issubset(df.columns):
            last_error = f"{yf_symbol}: 缺少 OHLCV 欄位"
            continue

        for col in required_cols:
            df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna(subset=["Open", "High", "Low", "Close"])
        if len(df) < 26:
            last_error = f"{yf_symbol}: 歷史資料不足 {len(df)} 筆"
            continue

        return df[["Date", "Open", "High", "Low", "Close", "Volume"]].copy()

    raise ValueError(
        f"無法取得 yfinance 歷史資料。已嘗試：{', '.join(candidates)}。最後錯誤：{last_error}"
    )


def download_stock_data(symbol: str):
    """
    依目前設定取得日線歷史資料。

    ⚠️ 搬家改動點：原本讀 st.session_state，現在讀 AppState.settings。
    """
    settings = get_state().settings
    day = today_str()

    if settings.post_market_enabled:
        if settings.post_market_source == "db":
            return db.download_history_from_db(symbol, day, include_today=False)
        return download_history_yfinance(symbol, day)

    if settings.history_source == "db":
        return db.download_history_from_db(symbol, day, include_today=False)
    return download_history_yfinance(symbol, day)


def normalize_ohlc(df):
    if df is None or df.empty:
        return pd.DataFrame()
    required_cols = ["Open", "High", "Low", "Close", "Volume"]
    if set(required_cols).issubset(df.columns):
        keep_cols = ["Date"] + required_cols if "Date" in df.columns else required_cols
        return df[keep_cols].copy()
    return pd.DataFrame()


# =============================================================================
# 價格解析
# =============================================================================
def parse_price_value(value):
    """
    從各種形狀的 payload 裡挖出一個 float 價格。

    Yahoo 的 API 有時回 {"raw": 1085.0, "fmt": "1,085.00"}，有時直接回數字，
    有時回字串帶千分位。這支就是在處理那些不一致。
    """
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    if isinstance(value, dict):
        for key in ["raw", "fmt", "value"]:
            parsed = parse_price_value(value.get(key))
            if parsed is not None:
                return parsed
        return None
    try:
        text_val = str(value).strip().replace(",", "")
        if not text_val or text_val in ["-", "--", "None", "nan"]:
            return None
        return float(text_val)
    except Exception:
        return None


# =============================================================================
# 即時價格來源（多層 fallback）
# =============================================================================
def get_yfinance_fast_info_price(symbol: str):
    """回傳 (price, 實際成功的代碼)。刻意不快取——這是「即時」價格。"""
    primary = str(symbol).strip().upper()
    candidates = [primary] + [s for s in build_yfinance_candidates(symbol) if s != primary]
    seen = set()
    last_error = ""
    for yf_symbol in candidates:
        if not yf_symbol or yf_symbol in seen:
            continue
        seen.add(yf_symbol)
        try:
            ticker = yf.Ticker(yf_symbol)
            price = ticker.fast_info.get("last_price", None)
            if price is not None and pd.notna(price):
                return float(price), yf_symbol
        except Exception as e:
            last_error = f"{yf_symbol}: {e}"
            continue
    raise ValueError(f"yfinance fast_info 無法取得 {symbol} 價格。最後錯誤：{last_error}")


@ttl_cache(ttl=30)
def get_yahoo_tw_quote_price(symbol: str):
    """
    Yahoo 奇摩股市的非公開 API。yfinance 被限流時的第二層備援。

    ⚠️ 非官方端點，格式可能無預警改變，所以整支包在多層 try 裡，
    失敗就往下一層 fallback 走，絕不讓它中斷報價。
    """
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Referer": "https://tw.stock.yahoo.com/",
    }
    last_error = ""
    price_keys = [
        "regularMarketPrice", "price", "lastPrice",
        "tradePrice", "close", "closePrice", "latestPrice",
    ]
    for yahoo_symbol in build_yfinance_candidates(symbol):
        url = (
            "https://tw.stock.yahoo.com/_td-stock/api/resource/"
            f"StockServices.stockList;symbols={yahoo_symbol}"
        )
        try:
            res = requests.get(url, headers=headers, timeout=5)
            if res.status_code != 200:
                last_error = f"{yahoo_symbol}: HTTP {res.status_code}"
                continue
            raw_text = res.text.strip()
            # Yahoo 有時會加防 JSON 劫持的前綴
            if raw_text.startswith(")]}'"):
                raw_text = raw_text.split("\n", 1)[-1]
            payload = json.loads(raw_text)
        except Exception as e:
            last_error = f"{yahoo_symbol}: {e}"
            continue

        items = (
            payload if isinstance(payload, list)
            else payload.get("data", []) if isinstance(payload, dict)
            else []
        )
        if isinstance(items, dict):
            items = [items]
        for item in items:
            if not isinstance(item, dict):
                continue
            for key in price_keys:
                price = parse_price_value(item.get(key))
                if price is not None:
                    return float(price), yahoo_symbol
            # 有時價格藏在巢狀物件裡，再往下找一層
            for value in item.values():
                if isinstance(value, dict):
                    for key in price_keys:
                        price = parse_price_value(value.get(key))
                        if price is not None:
                            return float(price), yahoo_symbol
        last_error = f"{yahoo_symbol}: 找不到可用價格欄位"
    raise ValueError(f"Yahoo TW 無法取得 {symbol} 價格。最後錯誤：{last_error}")


@ttl_cache(ttl=30)
def get_yfinance_latest_daily_close(symbol: str):
    """回傳 (close, date, 實際成功的代碼)。第三層備援。"""
    last_error = ""
    for yf_symbol in build_yfinance_candidates(symbol):
        try:
            daily_df = yf.download(
                yf_symbol, period="10d", interval="1d",
                auto_adjust=True, progress=False, threads=False,
            )
        except Exception as e:
            last_error = f"{yf_symbol}: {e}"
            continue
        if daily_df is None or daily_df.empty:
            last_error = f"{yf_symbol}: daily 無資料"
            continue
        if isinstance(daily_df.columns, pd.MultiIndex):
            daily_df.columns = [c[0] if isinstance(c, tuple) else c for c in daily_df.columns]
        if "Close" not in daily_df.columns:
            last_error = f"{yf_symbol}: daily 缺少 Close 欄位"
            continue
        daily_df = daily_df.reset_index()
        date_col = (
            "Date" if "Date" in daily_df.columns
            else "Datetime" if "Datetime" in daily_df.columns
            else daily_df.columns[0]
        )
        daily_df = daily_df.rename(columns={date_col: "Date"})
        daily_df["Date"] = pd.to_datetime(daily_df["Date"], errors="coerce")
        daily_df["Close"] = pd.to_numeric(daily_df["Close"], errors="coerce")
        daily_df = daily_df.dropna(subset=["Date", "Close"]).sort_values("Date")
        if daily_df.empty:
            last_error = f"{yf_symbol}: daily Close 皆為空"
            continue
        last_row = daily_df.iloc[-1]
        return float(last_row["Close"]), pd.to_datetime(last_row["Date"]).date(), yf_symbol
    raise ValueError(f"yfinance daily 無法取得 {symbol} 最新收盤價。最後錯誤：{last_error}")


def after_1330_price_logic(symbol: str, df, forced: bool = False):
    """
    13:30 收盤後（或強制使用 yfinance 時）的價格取得，四層退避。

    每一層都會跟「歷史資料最後一筆」比對，避免拿到跟昨收一模一樣的過期價格
    ——那會讓漲跌幅恆為 0%，是最難察覺的錯誤。

    回傳 (price, source_label)，source_label 會顯示在畫面上讓你知道這筆價從哪來。
    """
    last_hist_close = None
    last_hist_date = None
    if df is not None and not df.empty and "Close" in df.columns:
        try:
            last_hist_close = float(df["Close"].iloc[-1])
        except Exception:
            last_hist_close = None
        try:
            if "Date" in df.columns:
                last_hist_date = pd.to_datetime(df["Date"].iloc[-1]).date()
        except Exception:
            last_hist_date = None

    # 第 1 層：yfinance fast_info，且必須跟歷史最後一筆不同
    fast_price = None
    try:
        fast_price, _ = get_yfinance_fast_info_price(symbol)
    except Exception:
        fast_price = None
    if fast_price is not None and pd.notna(fast_price):
        if last_hist_close is None or abs(float(fast_price) - last_hist_close) > 1e-9:
            return float(fast_price), "Forced 13:30 yfinance fast_info" if forced else "yfinance after 13:30"

    # 第 2 層：Yahoo TW
    try:
        yahoo_price, _ = get_yahoo_tw_quote_price(symbol)
        if yahoo_price is not None and pd.notna(yahoo_price):
            return float(yahoo_price), "Forced 13:30 Yahoo TW" if forced else "Yahoo TW after 13:30"
    except Exception:
        pass

    # 第 3 層：yfinance 日線，且日期必須比歷史最後一筆新
    try:
        daily_close, daily_date, _ = get_yfinance_latest_daily_close(symbol)
        if daily_close is not None and pd.notna(daily_close):
            if last_hist_date is None or daily_date > last_hist_date:
                return float(daily_close), "Forced 13:30 yfinance daily" if forced else "yfinance daily after 13:30"
    except Exception:
        pass

    # 第 4 層：即使跟歷史相同也接受的 fast_info
    if fast_price is not None and pd.notna(fast_price):
        return float(fast_price), "Forced 13:30 yfinance stale fast_info" if forced else "yfinance stale fast_info after 13:30"

    # 最後：歷史收盤
    if last_hist_close is not None:
        return last_hist_close, "Forced 13:30 history fallback" if forced else "history after 13:30"

    raise ValueError("無法取得 13:30 後價格")


def get_last_price(symbol: str, df, manager=None):
    """
    取得「當下應該顯示的價格」與它的來源標籤。

    ⚠️ 搬家改動點：原本讀 st.session_state，現在讀 AppState.settings。
    其餘分支邏輯與原版逐行一致。

    manager 是 core.fubon.FubonRealtimeManager，盤中優先用它。
    """
    settings = get_state().settings

    # --- 盤後模式：當日＋歷史都由單一來源讀 ---
    if settings.post_market_enabled:
        day = today_str()
        if settings.post_market_source == "db":
            db_price, db_date_str = db.get_db_latest_price(symbol)
            label = "TWSE DB（今日）" if db_date_str == day else f"TWSE DB（最新收盤 {db_date_str}）"
            return float(db_price), label
        daily_close, daily_date, _ = get_yfinance_latest_daily_close(symbol)
        label = "yfinance（今日收盤）" if str(daily_date) == day else f"yfinance（最新收盤 {daily_date}）"
        return float(daily_close), label

    # --- 強制 yfinance ---
    if settings.realtime_source == "yfinance":
        return after_1330_price_logic(symbol, df, forced=True)

    # --- 預設：盤中富邦，收盤後 yfinance ---
    use_fubon_ws = is_fubon_realtime_time()
    if manager is not None and use_fubon_ws:
        ws_price = manager.get_price(symbol)
        if ws_price is not None and pd.notna(ws_price):
            return float(ws_price), "Fubon WebSocket trades"

    if use_fubon_ws:
        # 盤中但富邦沒資料（還沒訂閱到／剛連上／該檔沒成交）
        try:
            yf_price, _ = get_yfinance_fast_info_price(symbol)
            return float(yf_price), "yfinance fallback"
        except Exception:
            pass
        if df is not None and not df.empty and "Close" in df.columns:
            return float(df["Close"].iloc[-1]), "history fallback"
        raise ValueError("無法取得即時價格")

    return after_1330_price_logic(symbol, df, forced=False)


# =============================================================================
# 富邦 REST：今日官方開高低（給訊號模組用）
# 原始碼對照：0_💻_monitor.py 行 456-525
# =============================================================================
FUBON_OHLC_CACHE_TTL_SEC = 20


@ttl_cache(ttl=FUBON_OHLC_CACHE_TTL_SEC)
def fetch_fubon_intraday_ohlc(_sdk, code: str) -> dict:
    """
    透過富邦官方 REST API 取得指定股票「今天」的官方 OHLC。

    `_sdk` 底線開頭 → ttl_cache 不會嘗試對它做 hash（比照原本 st.cache_data 的行為，
    core/cache.py 已經複製了這個語意）。失敗直接拋例外，由呼叫端 fallback。
    """
    reststock = _sdk.marketdata.rest_client.stock
    quote = reststock.intraday.quote(symbol=code)
    return {
        "previousClose": quote.get("previousClose"),
        "openPrice": quote.get("openPrice"),
        "highPrice": quote.get("highPrice"),
        "lowPrice": quote.get("lowPrice"),
        "lastPrice": quote.get("lastPrice"),
    }


def get_official_today_ohlc(manager, symbol: str) -> dict:
    """
    取得「今天」的官方開高低價，供 signal_module 使用——很多型態訊號
    （島狀反轉、跳空、三白兵…）需要真正的當日開高低，不是只靠單一 tick 價格。

    任何情況失敗都回傳全 None 的 dict，讓呼叫端無痛 fallback 回自己追蹤的
    intraday_high/low 邏輯（現在存在 AppState 裡）。
    """
    empty = {"open": None, "high": None, "low": None}
    try:
        sdk = getattr(manager, "sdk", None)
        if sdk is None:
            return empty
        from core.symbols import symbol_to_code
        code = symbol_to_code(symbol)
        ohlc = fetch_fubon_intraday_ohlc(sdk, code)

        def _to_float(v):
            try:
                return float(v) if v is not None else None
            except Exception:
                return None

        return {
            "open": _to_float(ohlc.get("openPrice")),
            "high": _to_float(ohlc.get("highPrice")),
            "low": _to_float(ohlc.get("lowPrice")),
        }
    except Exception:
        return empty
