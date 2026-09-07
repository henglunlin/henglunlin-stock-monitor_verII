# -*- coding: utf-8 -*-
"""
core/signals.py
===============
signal_module/ 的銜接層：把歷史日K + 今天即時開高低收組成一根當日 K 棒，
餵給訊號模組跑，再依「優先等級」規則收斂成單一顯示文字。

原始碼對照：0_💻_monitor.py 行 1717-1844

⚠️ signal_module/ 刻意「不搬」
------------------------------
原本的拆解計畫是把 signal_module/ 移進 core/signals/，但實際看過之後決定不搬：
它已經是乾淨的純 Python（22 個訊號模組零 streamlit 依賴，module_loader.py 只有
註解提到 streamlit），**搬了反而會弄壞 Streamlit 版的 import**。

所以它留在 repo 根目錄，Streamlit 版和 FastAPI 版都 `import signal_module`，
共用同一份訊號公式——這正是我們要避免「兩邊公式漂移」的做法。
"""
from __future__ import annotations

import logging
from datetime import datetime

import pandas as pd

from core.tradingday import TW_TZ

log = logging.getLogger(__name__)

# ===== 接上 signal_module（沿用跟「台股掃描器」repo 相同的那一套）=====
from signal_module import module_loader
from signal_module.base import SIGNAL_REGISTRY, SignalContext as ModuleSignalContext
from signal_module.indicators import add_indicators as _sm_add_indicators

if not SIGNAL_REGISTRY:
    module_loader.load_default_signal_modules()

__all__ = [
    "SIGNAL_PRIORITY", "SIGNAL_PRIORITY_DEFAULT",
    "GENERALIZED_THREE_METHOD_LABELS",
    "get_signal_registry", "prepare_signal_dataframe", "run_stock_signals",
]

# 訊號優先等級：數字越小越重要（1 > 2 > 3）。同一天同等級的訊號一起觸發就一起顯示；
# 等級不同時只顯示等級數字最小（最重要）的那些。
# key 對應 signal_module 各檔案 register_signal() 裡的 label。
SIGNAL_PRIORITY = {
    "布林縮窄突破": 1,
    "反向島狀": 1,
    "下降趨勢線突破": 1,
    "3K反轉": 2,
    "巧妙點": 2,
    "雙跳空": 2,
    "雙漲停": 2,
    "島狀反轉": 2,
    "KD高腳": 2,
    "跌停": 2,
    "單跳空": 2,
    "周1K": 2,
    "廣義下降三法": 3,
    "漲停": 3,
    "移動停利": 3,
    "廣義上升三法": 3,
    "三白兵": 3,
}
SIGNAL_PRIORITY_DEFAULT = 3

# 廣義上升／下降三法：雜訊較多，單獨出現時不觸發 Telegram 推播；
# 但只要同時有其他訊號一起命中（例如 廣義上升三法 + 巧妙點），就視為有效訊號一併推送。
GENERALIZED_THREE_METHOD_LABELS = {"廣義上升三法", "廣義下降三法"}


def get_signal_registry() -> dict:
    return SIGNAL_REGISTRY


def prepare_signal_dataframe(
    df: pd.DataFrame,
    open_val: float,
    high_val: float,
    low_val: float,
    close_val: float,
    price_ref_date=None,
) -> pd.DataFrame:
    """
    組出 signal_module 需要的格式：index = Date 字串、由舊到新排序，
    並附上 K/D/MA/Bias/BBand 等技術指標欄位。

    ── 為什麼一定要傳 price_ref_date（原註解的第三版修正，重點保留）──
    前兩版都用「呼叫當下的日曆日期」猜今天是哪一天，但這個猜測本身有問題：
    `download_stock_data()` 內部的 `get_history_cutoff_date()` 已經依星期幾把歷史
    資料上界往前推（週六退 1 天、週日退 2 天）。這裡若又用日曆日期判斷一次
    「該不該多退一天」，等於兩層邏輯各退一次、**多退了一天**（今天週日、最新交易日
    其實是週五，結果昨收卻抓到週四之前）。

    改用 price_ref_date 之後，這裡跟 core/indicators.py 共用同一套規則，不再各自猜。

    ⚠️ 已知限制：沒有台股國定假日行事曆，平日的國定假日仍可能被誤判成新交易日。
    這是原版就有的限制，搬家階段刻意不改行為。
    """
    work = df.copy()
    if "Date" not in work.columns:
        work = work.reset_index().rename(columns={work.reset_index().columns[0]: "Date"})
    work["Date"] = pd.to_datetime(work["Date"], errors="coerce")
    work = work.dropna(subset=["Date"]).sort_values("Date").reset_index(drop=True)
    if work.empty:
        raise ValueError("下載資料為空")

    ref_date = price_ref_date if price_ref_date is not None else datetime.now(TW_TZ).date()
    today_ts = pd.Timestamp(ref_date)
    is_weekday = pd.Timestamp(ref_date).weekday() < 5   # 0=一 … 4=五, 5=六, 6=日
    last_date = work["Date"].iloc[-1].normalize()

    should_merge_into_last_row = (last_date == today_ts) or (not is_weekday)

    if should_merge_into_last_row:
        # 歷史資料已經有今天這一筆 → 把即時的高低併進去，不要新增一根重複的 K 棒
        real_today = work.iloc[-1]
        real_date = work["Date"].iloc[-1]
        candidate_highs = [v for v in [real_today.get("High"), high_val] if pd.notna(v)]
        candidate_lows = [v for v in [real_today.get("Low"), low_val] if pd.notna(v)]
        real_open = real_today.get("Open")

        merged_high = max(candidate_highs) if candidate_highs else high_val
        merged_low = min(candidate_lows) if candidate_lows else low_val
        merged_open = real_open if pd.notna(real_open) else open_val

        work = work.iloc[:-1]
        today_ts = real_date          # 沿用資料庫裡「真實」的交易日日期
        open_val, high_val, low_val = merged_open, merged_high, merged_low
        # close_val 維持傳入的即時價：盤中即時反映，非交易時間通常等於當天實際收盤。
    else:
        # 平日盤中、資料庫還沒有這一天 → 用真實交易日日期新增一根
        today_ts = pd.Timestamp(ref_date)

    today_row = pd.DataFrame([{
        "Date": today_ts, "Open": open_val, "High": high_val,
        "Low": low_val, "Close": close_val, "Volume": 0,
    }])
    work = pd.concat(
        [work[["Date", "Open", "High", "Low", "Close", "Volume"]], today_row],
        ignore_index=True,
    )

    work = work.set_index(work["Date"].dt.strftime("%Y-%m-%d"))[
        ["Open", "High", "Low", "Close", "Volume"]
    ]
    work.index.name = "Date"
    work = _sm_add_indicators(work)
    return work


def run_stock_signals(
    symbol: str,
    name: str,
    df,
    open_val: float,
    high_val: float,
    low_val: float,
    close_val: float,
    rise_threshold: float = 5.0,
    price_ref_date=None,
):
    """
    對單一股票跑過全部已註冊訊號。

    回傳 (hit_list, display_text)
      hit_list      依優先等級排序的命中清單
                    [{"label","kind","priority","detail"}, ...]
      display_text  套用優先等級規則後的顯示文字（同等級一起顯示）

    任何一個訊號模組拋例外都只跳過該模組，不影響其他訊號——這是原版行為，
    對「使用者自己上傳的訊號檔」這種情境是必要的容錯。
    """
    try:
        df_ind = prepare_signal_dataframe(
            df, open_val, high_val, low_val, close_val, price_ref_date=price_ref_date
        )
    except Exception as e:
        log.debug("%s 準備訊號資料失敗：%s", symbol, e)
        return [], "-"

    scan_date = df_ind.index[-1]
    ctx = ModuleSignalContext(
        code=symbol, name=name, df=df_ind, scan_date=scan_date,
        params={"rise_threshold": rise_threshold},
    )

    hit_list = []
    for key, cfg in SIGNAL_REGISTRY.items():
        try:
            result = cfg["func"](ctx)
        except Exception:
            continue
        if getattr(result, "hit", False):
            label = cfg["label"]
            hit_list.append({
                "label": label,
                "kind": cfg.get("kind", "buy"),
                "priority": SIGNAL_PRIORITY.get(label, SIGNAL_PRIORITY_DEFAULT),
                "detail": result.detail,
            })

    if not hit_list:
        return [], "-"

    hit_list.sort(key=lambda h: h["priority"])
    top_priority = hit_list[0]["priority"]
    top_hits = [h for h in hit_list if h["priority"] == top_priority]
    display_text = "、".join(
        f"{h['label']}({'買' if h['kind'] == 'buy' else '賣'})" for h in top_hits
    )
    return hit_list, display_text
