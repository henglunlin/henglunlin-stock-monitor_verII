# -*- coding: utf-8 -*-
"""
core/indicators.py
==================
技術指標計算（MA 位置／排列、KD、昨收、漲跌幅）。

原始碼對照：0_💻_monitor.py 行 1572-1680（compute_indicators）

⚠️ 這支檔案一行邏輯都沒改，連 `datetime.now(TW_TZ).date()` 的預設值行為都保留。
原因是這裡藏著你花了很久才修好的「昨收基準日」bug，任何看似無害的整理都可能
把它弄回去。

那個 bug 的來龍去脈（原註解的重點，值得保留在這裡）
--------------------------------------------------
`download_stock_data()` 內部的 `get_history_cutoff_date()` 已經會依星期幾把歷史
資料的上界往前推（週六退 1 天、週日退 2 天）。如果這裡又用「呼叫當下的日曆日期」
重新判斷一次「今天／昨天」，等於兩層邏輯各退一次、**會多退一天**——這正是
「今天抓到 8/7、昨收卻抓到 8/5」的真正原因。

所以呼叫端一定要傳 `price_ref_date`（用
`core.tradingday.get_effective_trading_reference_date()` 算出來），
讓這裡跟 `_prepare_signal_dataframe()` 共用同一套規則，不要各自猜。
"""
from __future__ import annotations

from datetime import datetime

import pandas as pd

from core.tradingday import TW_TZ

__all__ = ["compute_indicators"]


def compute_indicators(df, price, price_ref_date=None) -> dict:
    """
    回傳 {price, pct, yesterday_close, ma_range, ma_trend, k, d}

    df           日線歷史（不含今天），需含 Date/Open/High/Low/Close/Volume
    price        當下即時價（來自 core.quotes.get_last_price）
    price_ref_date
                 這個即時價實際代表哪一個交易日。**強烈建議一定要傳**，
                 用 get_effective_trading_reference_date() 取得。
    """
    if df is None or df.empty:
        raise ValueError("下載資料為空")
    if len(df) < 20:
        raise ValueError("歷史資料不足（至少需要 20 筆）")

    calc_df = df.copy().reset_index(drop=True)
    close = pd.to_numeric(calc_df["Close"].squeeze(), errors="coerce")
    low = pd.to_numeric(calc_df["Low"].squeeze(), errors="coerce")
    high = pd.to_numeric(calc_df["High"].squeeze(), errors="coerce")
    if close.isna().all() or low.isna().all() or high.isna().all():
        raise ValueError("OHLC 資料格式異常")

    # 「昨收」判斷邏輯，必須跟 core.signals._prepare_signal_dataframe() 保持一致，
    # 否則兩邊對「今天是哪一天」認知不同，畫面顯示的昨收／漲跌% 會跟訊號模組
    # （單跳空／雙跳空／島狀反轉／反向島狀／跌停／漲停…）實際判斷用的基準日對不起來。
    ref_date = price_ref_date if price_ref_date is not None else datetime.now(TW_TZ).date()
    today_ts = pd.Timestamp(ref_date)
    is_weekday = pd.Timestamp(ref_date).weekday() < 5

    last_date = None
    if "Date" in calc_df.columns:
        parsed_dates = pd.to_datetime(calc_df["Date"], errors="coerce")
        if parsed_dates.notna().any():
            last_date = parsed_dates.iloc[-1].normalize()

    # 判斷規則跟 _prepare_signal_dataframe() 的 should_merge_into_last_row 完全一致：
    # ref_date 是平日、且歷史最後一筆剛好就是 ref_date → 這筆算「今天」，昨收往前一筆拿；
    # 只有歷史資料還沒有 ref_date 這一天（單純盤中情境），最後一筆才是「昨天」。
    treat_last_row_as_today = (last_date is not None and last_date == today_ts) or (not is_weekday)

    if treat_last_row_as_today:
        if len(close.dropna()) < 2:
            raise ValueError("資料筆數不足，無法取得昨收")
        yesterday_close = float(close.iloc[-2])
    else:
        yesterday_close = float(close.iloc[-1])

    if pd.isna(yesterday_close) or yesterday_close == 0:
        raise ValueError("昨收資料異常")

    price_val = float(price)
    change_pct = float((price_val / yesterday_close - 1) * 100)

    # 把「今天」這一根 K 棒接上去再算指標（開高低收都先用即時價，
    # 真正的當日高低由呼叫端的 intraday tracker 或 db 查表補上）
    today_row = pd.DataFrame([{
        "Date": today_ts,
        "Open": price_val,
        "High": price_val,
        "Low": price_val,
        "Close": price_val,
        "Volume": 0,
    }])
    calc_df = pd.concat([calc_df, today_row], ignore_index=True)
    close = pd.to_numeric(calc_df["Close"].squeeze(), errors="coerce")
    low = pd.to_numeric(calc_df["Low"].squeeze(), errors="coerce")
    high = pd.to_numeric(calc_df["High"].squeeze(), errors="coerce")

    ma5 = float(close.tail(5).mean())
    ma10 = float(close.tail(10).mean())
    ma20 = float(close.tail(20).mean())

    if price_val > ma5:
        ma_range = ">MA5"
    elif ma5 >= price_val > ma10:
        ma_range = "MA5~10"
    elif ma10 >= price_val > ma20:
        ma_range = "MA10~20"
    else:
        ma_range = "<MA20"

    if ma5 > ma10 > ma20:
        ma_trend = "多頭"
    elif ma5 < ma10 < ma20:
        ma_trend = "空頭"
    else:
        ma_trend = "糾結"

    # KD（9,3,3）——用 ewm(alpha=1/3) 等價於傳統的 2/3 舊值 + 1/3 新值
    low_9 = low.rolling(9).min()
    high_9 = high.rolling(9).max()
    denominator = (high_9 - low_9).replace(0, pd.NA)
    rsv = ((close - low_9) / denominator) * 100
    k = rsv.ewm(alpha=1 / 3, adjust=False).mean()
    d = k.ewm(alpha=1 / 3, adjust=False).mean()
    if len(k.dropna()) < 2 or len(d.dropna()) < 2:
        raise ValueError("KD 計算資料不足")

    k_t = float(k.iloc[-1])
    d_t = float(d.iloc[-1])

    # KD 黃金交叉／跳空等訊號判斷已移交給 signal_module（見 core/signals.py），
    # 這裡只保留 K值/D值/MA位置/MA排列 供顯示用。
    return {
        "price": round(price_val, 2),
        "pct": round(change_pct, 2),
        "yesterday_close": round(yesterday_close, 2),
        "ma_range": ma_range,
        "ma_trend": ma_trend,
        "k": round(k_t, 1),
        "d": round(d_t, 1),
    }
