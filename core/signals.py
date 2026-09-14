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

from core.cache import ttl_cache
from core.tradingday import TW_TZ
from core.trendlines import compute_trendlines

log = logging.getLogger(__name__)

# ===== 接上 signal_module（沿用跟「台股掃描器」repo 相同的那一套）=====
from signal_module import module_loader
from signal_module.base import SIGNAL_REGISTRY, SignalContext as ModuleSignalContext
from signal_module.indicators import add_indicators as _sm_add_indicators

# ⚠️ 這裡「不能」寫成 `if not SIGNAL_REGISTRY: load(...)`
# ================================================================
# 原版是那樣寫的，但那個判斷會被 **import 順序**害死，而且錯得很安靜：
#
#   core/targets.py 有一行 `from signal_module.target_price import compute_buy_zone`，
#   而 target_price.py 自己就註冊了 2 個訊號（進入買入區間、觸及停損價格）。
#   server/hub.py 的 import 是照字母排的，`targets` 排在 `signals` 前面——
#   所以輪到這裡時 SIGNAL_REGISTRY 已經有 2 筆、不是空的，
#   → 判斷成立 → **其餘 18 個訊號永遠不會被載入**。
#
#   症狀是全部股票的訊號欄都顯示「-」，沒有任何錯誤訊息。
#   更陰險的是：只要測試腳本的 import 順序剛好相反（signals 先、targets 後），
#   就會顯示「已註冊 20 個訊號」一切正常——測試順序把真實順序的 bug 蓋掉了。
#
# load_default_signal_modules() 內部第一件事就是 reset_registry()（清空再全部
# 重載），而且 target_price.py 也在它的載入範圍內，所以無條件呼叫是安全且冪等的。
_, _load_errors = module_loader.load_default_signal_modules()
if _load_errors:
    log.warning("有 %d 個訊號模組載入失敗：%s", len(_load_errors), _load_errors)
log.info("已註冊 %d 個訊號模組", len(SIGNAL_REGISTRY))
if len(SIGNAL_REGISTRY) < 15:
    # 正常應該有 20 個。少於 15 幾乎一定是載入出了問題，而不是你真的刪了訊號檔。
    log.warning(
        "⚠️ 只註冊到 %d 個訊號，預期約 20 個——請確認 signal_module/ 是否完整複製過來",
        len(SIGNAL_REGISTRY),
    )

__all__ = [
    "SIGNAL_PRIORITY", "SIGNAL_PRIORITY_DEFAULT",
    "GENERALIZED_THREE_METHOD_LABELS",
    "get_signal_registry", "prepare_signal_dataframe", "run_stock_signals",
    "compute_historical_signals", "get_chart_history",
]

# 訊號優先等級：數字越小越重要（1 > 2 > 3）。同一天同等級的訊號一起觸發就一起顯示；
# 等級不同時只顯示等級數字最小（最重要）的那些。
# key 對應 signal_module 各檔案 register_signal() 裡的 label。
#
# ⚠️ 這張表是 signal_module/priority.py 的複本，而且已經漂移了
# ------------------------------------------------------------------
# 真實來源是 priority.py 的 _LABEL_TO_PRIORITY（那邊還兼任舊 repo「訊號編輯」
# 頁面的滑桿來源）。這裡當初複製了一份，之後 priority.py 新增的 label 沒有跟上：
# 「進入買入區間」「觸及停損價格」在那邊是等級 1，在這裡卻不存在 → 落到預設 3。
# 症狀跟手冊裡「漲幅達標」那個案例一樣：沒有錯誤訊息，只是等級悄悄不對。
#
# 這裡補上缺的那兩個，讓兩張表一致。
#（「漲幅達標」在 priority.py 那邊同樣沒登記，兩邊都是預設 3，所以是一致的、
#  不在這次改動範圍——那是手冊 P1 提到的既有問題。）
# 真正的解法是直接吃 priority.py 的表
# （import 後讀 signal_module.base.SIGNAL_PRIORITY），但那要連 module_loader
# 的載入時序一起處理，不在這次改動範圍內——先讓值正確。
SIGNAL_PRIORITY = {
    "布林縮窄突破": 1,
    "反向島狀": 1,
    "下降趨勢線突破": 1,
    "進入買入區間": 1,       # ← 補上，原本落到預設 3
    "觸及停損價格": 1,       # ← 補上，原本落到預設 3
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
    volume_val: float | None = None,
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

    ── volume_val（新增：修正「今天成交量永遠是 0」的 bug）──
    這裡以前組「今天」這一根 K 棒時，Volume 欄位不管三七二十一都寫死 0——
    不管即時源是富邦還是 yfinance，K 線圖跟主表格的「今日成交量」／均量
    永遠是 0（甚至可能讓吃 Volume 的訊號模組，例如量縮、爆量突破，誤判）。
    因為當時完全沒有接任何即時成交量的資料源。

    現在由呼叫端（core/signals.py 的 run_stock_signals／get_chart_history，
    或 server/hub.py 的 _compute_row）依富邦 REST／tick／yfinance fast_info
    的順序湊出一個值傳進來，這裡只負責把它併進「今天」這一列：
      - 併回已存在的歷史列（should_merge_into_last_row，例如歷史資料已經同步
        到今天、或非交易日回看最近一個交易日）：跟歷史本來的量取較大值——
        歷史下載回來的量若已經是當天定案的量就直接用；若歷史那筆還沒同步、
        量偏舊或是 0，用即時湊出來的值頂上去。
      - 新增一列（平日盤中、歷史還沒有今天這一天）：沒有歷史量可比，直接用
        volume_val；完全湊不到值（三層來源都失敗）就只能是 0，跟以前一樣，
        但至少不會蓋掉真的抓得到的量。
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
        candidate_vols = [v for v in [real_today.get("Volume"), volume_val] if v is not None and pd.notna(v)]

        merged_high = max(candidate_highs) if candidate_highs else high_val
        merged_low = min(candidate_lows) if candidate_lows else low_val
        merged_open = real_open if pd.notna(real_open) else open_val
        merged_volume = max(candidate_vols) if candidate_vols else 0

        work = work.iloc[:-1]
        today_ts = real_date          # 沿用資料庫裡「真實」的交易日日期
        open_val, high_val, low_val = merged_open, merged_high, merged_low
        volume_val = merged_volume
        # close_val 維持傳入的即時價：盤中即時反映，非交易時間通常等於當天實際收盤。
    else:
        # 平日盤中、資料庫還沒有這一天 → 用真實交易日日期新增一根
        today_ts = pd.Timestamp(ref_date)
        volume_val = volume_val if (volume_val is not None and pd.notna(volume_val)) else 0

    today_row = pd.DataFrame([{
        "Date": today_ts, "Open": open_val, "High": high_val,
        "Low": low_val, "Close": close_val, "Volume": volume_val,
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
    target_entry: dict | None = None,
    volume_val: float | None = None,
):
    """
    對單一股票跑過全部已註冊訊號。

    回傳 (hit_list, display_text)
      hit_list      依優先等級排序的命中清單
                    [{"label","kind","priority","detail"}, ...]
      display_text  套用優先等級規則後的顯示文字（同等級一起顯示）

    任何一個訊號模組拋例外都只跳過該模組，不影響其他訊號——這是原版行為，
    對「使用者自己上傳的訊號檔」這種情境是必要的容錯。

    ── target_entry：一個從搬家以來就靜默失效的訊號 ──
    `signal_module/target_price.py` 註冊了兩個訊號（進入買入區間、觸及停損價格），
    它們從 `ctx.params["target_price"]` 讀這檔的目標價設定。但這裡原本只傳
    `{"rise_threshold": ...}`，所以那兩個訊號**每一次都走「未設定目標價」那條
    early return，永遠 hit=False**——表格訊號欄看不到、Telegram 也推不到，
    而且完全不報錯（因為 hit=False 是合法結果，不是例外）。

    target_entry 就是 `target_price_list.json` 裡這一檔的那一筆
    （由 server/hub.py 從已經載好的 target_table 取出來傳進來，不重讀檔案）。
    傳 None 時行為與修改前完全相同。

    volume_val：今天的即時累積成交量（呼叫端湊出來的，見
    prepare_signal_dataframe 的說明）。不傳就是 None，今天這一根量會退回 0，
    跟修這個 bug 之前的行為一樣——不會因為少傳這個參數就整支掛掉。
    """
    try:
        df_ind = prepare_signal_dataframe(
            df, open_val, high_val, low_val, close_val,
            price_ref_date=price_ref_date, volume_val=volume_val,
        )
    except Exception as e:
        log.debug("%s 準備訊號資料失敗：%s", symbol, e)
        return [], "-"

    scan_date = df_ind.index[-1]
    params: dict = {"rise_threshold": rise_threshold}
    # 只有真的有這檔的目標價設定才放進去。放 None 進去不會出錯
    # （target_price.py 的 _get_target_price_config 有 isinstance 檢查），
    # 但留著會讓「有沒有設定」在除錯時分不出來。
    if target_entry:
        params["target_price"] = target_entry
    ctx = ModuleSignalContext(
        code=symbol, name=name, df=df_ind, scan_date=scan_date,
        params=params,
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


def _format_trend_segment(tier_info: dict | None, dates: list, window_start_idx: int) -> dict | None:
    """
    把 core/trendlines.py 算出來的位置索引轉成「可以直接畫線」的兩個端點：
    from = 這條線在圖表可見範圍內的起點（如果真正的錨點在可見範圍之前，就沿著
           同一條線裁到可見範圍的第一天，價位用同一條直線方程式重算，線本身沒變、
           只是不畫超出圖外的那一段）；
    to   = 這條線延伸到「最新一天」的價位，也就是「這條線現在在哪裡」。
    """
    if not tier_info:
        return None
    x1 = tier_info["anchor1_idx"]
    y1 = tier_info["anchor1_price"]
    if x1 < window_start_idx:
        x1 = window_start_idx
        y1 = round(tier_info["slope"] * x1 + tier_info["intercept"], 2)
    return {
        "tier_label": tier_info["tier_label"],
        "from": {"date": dates[x1], "price": y1},
        "to": {"date": dates[tier_info["current_idx"]], "price": tier_info["current_price"]},
    }


def compute_historical_signals(
    symbol: str,
    name: str,
    df_ind: pd.DataFrame,
    days: int = 90,
    rise_threshold: float = 3.0,
    hidden_labels: set | None = None,
    historical_suppress_labels: set | None = None,
) -> dict:
    """
    K 線訊號圖用：把過去 N 個交易日的訊號判定「重新演一遍」，回傳每一天的
    OHLCV + 均線 + 量能均線 + KD + 當天命中的訊號清單，以及上升／下降趨勢線，
    讓前端畫在蠟燭圖上。

    df_ind：已經是 signal_module 格式的資料——index=Date 字串（由舊到新排序）、
    欄位含 Open/High/Low/Close/Volume 以及 add_indicators() 算好的 MA/K/D 等技術
    指標。呼叫端（get_chart_history）負責準備這份資料，包含「要不要合併今天的
    即時開高低收」都在那邊決定——這支只管「拿現成的指標資料逐日重跑訊號＋算
    趨勢線」，職責單純一點，也方便之後如果要對「歷史某一天」重算時直接重用。

    ── 跟 run_stock_signals() 的差異 ──
    那支只回傳「今天」單一天的結果；這支對過去 N 天的每一天都重新判定一次，
    單純把 scan_date 往回移動，重複利用同一份指標與同一份 dates/date_to_idx
    （這正是 SignalContext 設計 dates/date_to_idx 快取的目的：同一檔股票在同一次
    掃描中會建立很多個 SignalContext，讓每個都能共用同一份已算好的索引）。

    hidden_labels：使用者在設定頁勾掉、完全不想在圖上看到的訊號名稱——不管哪一天
    命中都直接濾掉。
    historical_suppress_labels：這幾個訊號雜訊多（例如「漲幅達標」幾乎天天可能觸發、
    「廣義上升/下降三法」本來就是原版拿掉單獨推播的雜訊訊號），只有「最新一天」
    （通常是今天）才顯示，過去的日子上不畫，避免整條圖被同樣幾個標籤洗版。

    任何一個訊號模組拋例外都只跳過該模組，不影響其他訊號或其他天——跟
    run_stock_signals() 同一個容錯原則。
    """
    work = df_ind
    # 5 日量均：只是給圖表看的（跟舊 Streamlit 版的量能子圖一致），
    # 不影響任何訊號判定，所以刻意不放進共用的 add_indicators()。
    if "VolMA5" not in work.columns:
        work = work.copy()
        work["VolMA5"] = work["Volume"].rolling(5, min_periods=1).mean()

    dates = list(work.index)
    if not dates:
        return {"bars": [], "trendlines": {"resistance": {}, "support": {}}}
    date_to_idx = {d: i for i, d in enumerate(dates)}

    hidden = hidden_labels or set()
    suppress = historical_suppress_labels or set()
    last_date = dates[-1]

    window = dates[-days:] if days > 0 else dates
    params = {"rise_threshold": rise_threshold}

    bars = []
    for scan_date in window:
        ctx = ModuleSignalContext(
            code=symbol, name=name, df=work, scan_date=scan_date,
            params=params, dates=dates, date_to_idx=date_to_idx,
        )
        hits = []
        for key, cfg in SIGNAL_REGISTRY.items():
            try:
                result = cfg["func"](ctx)
            except Exception:
                continue
            if not getattr(result, "hit", False):
                continue
            label = cfg["label"]
            if label in hidden:
                continue
            if label in suppress and scan_date != last_date:
                continue
            hits.append({
                "label": label,
                "kind": cfg.get("kind", "buy"),
                "priority": SIGNAL_PRIORITY.get(label, SIGNAL_PRIORITY_DEFAULT),
                "detail": result.detail,
                # 「下降趨勢線突破」這類訊號會動態附加是哪個等級（例如 "(短期、中長期)"）——
                # K 線圖同時畫了短/中短/中長期三條趨勢線，把這個帶出去，前端才能讓
                # 標記文字跟畫的線對得起來，不用另外猜是哪一條線觸發的。
                "sub_label": getattr(result, "sub_label", "") or None,
            })
        hits.sort(key=lambda h: h["priority"])

        row = work.loc[scan_date]
        bars.append({
            "date": scan_date,
            "open": row["Open"], "high": row["High"], "low": row["Low"], "close": row["Close"],
            "volume": row["Volume"],
            "k": row.get("K"), "d": row.get("D"),
            "ma5": row.get("MA5"), "ma10": row.get("MA10"),
            "ma20": row.get("MA20"), "ma60": row.get("MA60"),
            "vol_ma5": row.get("VolMA5"), "vol_ma10": row.get("VolMA10"),
            "signals": hits,
        })

    trend = compute_trendlines(dates, work["High"], work["Low"])
    window_start_idx = max(0, len(dates) - days) if days > 0 else 0
    trendlines_out = {
        "resistance": {
            k: _format_trend_segment(v, dates, window_start_idx) for k, v in trend["resistance"].items()
        },
        "support": {
            k: _format_trend_segment(v, dates, window_start_idx) for k, v in trend["support"].items()
        },
    }
    return {"bars": bars, "trendlines": trendlines_out}


@ttl_cache(ttl=90)
def get_chart_history(
    symbol: str,
    name: str,
    days: int,
    rise_threshold: float,
    hidden_labels: tuple = (),
    historical_suppress_labels: tuple = (),
) -> dict:
    """
    compute_historical_signals() 的快取包裝層，多做一件事：把「今天」的即時開高低
    收併進歷史資料的最後一根 K 棒——跟即時盤中掃描（prepare_signal_dataframe）
    同一套邏輯，不然圖上最新一天永遠是「資料庫昨晚收盤後同步進來」的舊資料，
    盤中看起來會少一根正在走的K棒。併不進去（例如富邦連線不可用、盤前還沒有任何
    即時價）就安靜退回純歷史資料，最新一根維持資料庫裡的樣子，不會讓整支圖表掛掉。

    ⚠️ 刻意只吃可 hash 的純量／tuple 參數，DataFrame 在函式「內部」才去抓——
    ttl_cache 的 key 是拿參數直接 hash，傳 DataFrame 進來會直接讓快取整個失效
    （core/cache.py 的容錯是「不可 hash 就跳過快取」，不是報錯，但那樣等於每次
    都重算，量開圖表次數一多會很傷）。hidden_labels / historical_suppress_labels
    因此用 tuple（可 hash）傳進來，函式內部再轉成 set 給查找用。

    ttl=90 秒：跟股票列表的慢線重算週期同一個量級——K 線圖的資料本來就是「收盤價
    等級」，不需要跟報價一樣秒級更新，但也不希望使用者連續切換好幾檔時每次都
    重新掃過 20 個訊號模組。
    """
    from core import quotes
    from core.state import get_state
    from core.tradingday import get_effective_trading_reference_date

    raw = quotes.download_stock_data(symbol)
    df = quotes.normalize_ohlc(raw)
    if df.empty:
        return {"bars": [], "trendlines": {"resistance": {}, "support": {}}}

    state = get_state()
    mgr = state.fubon_manager
    ref = get_effective_trading_reference_date()

    # ── 嘗試把今天的即時價／量併進最後一根 K 棒 ──
    # 開高低容錯順序：official 今日OHLC(富邦) → db 補值(今天已收盤同步進資料庫) →
    #                 yfinance 今日OHLC → intraday high/low 追蹤(富邦 tick) → 最後退回現價。
    # 成交量容錯順序：official 今日成交量(富邦 REST → tick 流) → yfinance fast_info
    #                （沒有任何來源就是 0——這是原本就有的最後底線，不是新引入的限制）。
    #
    # ⚠️ 這裡曾經有一個 bug：只有富邦 → db → intraday tracker 三層時，
    # intraday_high/low(core/state.py)只在富邦 tick 回呼(server/hub.py 的
    # _on_tick)裡才會更新——沒有富邦連線時（realtime_source == "yfinance"，
    # 或富邦暫時斷線退避中）這三層永遠是 None，結果整根 K 棒的開高低收都退回
    # 同一個現價，看起來像是資料壞掉(不是只有真的一字漲停鎖死那天才會這樣)。
    # 中間補上 quotes.get_yfinance_today_ohlc() 這一層，直接問 yfinance 今天的
    # 官方開高低，不依賴我們自己的 tick 追蹤，兩種即時來源都能有正確的開高低。
    #
    # ⚠️ 另一個更基本的 bug：成交量欄位以前完全沒有接任何即時來源，
    # prepare_signal_dataframe() 一律寫死 0——不管富邦還是 yfinance 都一樣。
    # 這裡補上 get_official_today_volume()／yfinance fast_info 的 lastVolume。
    df_ind = None
    try:
        price, _price_source = quotes.get_last_price(symbol, df, mgr)
        ohlc = quotes.get_official_today_ohlc(mgr, symbol)
        if any(ohlc.get(k) is None for k in ("open", "high", "low")):
            db_ohlc = quotes.db.get_db_ohlc_for_date(symbol, ref.strftime("%Y-%m-%d"))
            for k in ("open", "high", "low"):
                if ohlc.get(k) is None and db_ohlc.get(k) is not None:
                    ohlc[k] = db_ohlc[k]

        volume_val = quotes.get_official_today_volume(mgr, symbol)

        # 開高低還缺，或成交量還沒湊到 → 一起問 yfinance（同一次 fast_info fetch）
        yf_ohlc = None
        if any(ohlc.get(k) is None for k in ("open", "high", "low")) or volume_val is None:
            yf_ohlc = quotes.get_yfinance_today_ohlc(symbol)
        if yf_ohlc:
            for k in ("open", "high", "low"):
                if ohlc.get(k) is None and yf_ohlc.get(k) is not None:
                    ohlc[k] = yf_ohlc[k]
            if volume_val is None and yf_ohlc.get("volume") is not None:
                volume_val = yf_ohlc["volume"]

        open_val = ohlc.get("open") if ohlc.get("open") is not None else price
        high_val = ohlc.get("high") if ohlc.get("high") is not None else (state.get_intraday_high(symbol) or price)
        low_val = ohlc.get("low") if ohlc.get("low") is not None else (state.get_intraday_low(symbol) or price)
        df_ind = prepare_signal_dataframe(
            df, open_val, high_val, low_val, price, price_ref_date=ref, volume_val=volume_val,
        )
    except Exception as e:
        log.debug("%s 合併今日即時價失敗，K 線圖最新一根改用歷史資料：%s", symbol, e)

    if df_ind is None:
        work = df.copy()
        if "Date" not in work.columns:
            work = work.reset_index().rename(columns={work.reset_index().columns[0]: "Date"})
        work["Date"] = pd.to_datetime(work["Date"], errors="coerce")
        work = work.dropna(subset=["Date"]).sort_values("Date").reset_index(drop=True)
        if work.empty:
            return {"bars": [], "trendlines": {"resistance": {}, "support": {}}}
        work = work.set_index(work["Date"].dt.strftime("%Y-%m-%d"))[
            ["Open", "High", "Low", "Close", "Volume"]
        ]
        work.index.name = "Date"
        df_ind = _sm_add_indicators(work)

    return compute_historical_signals(
        symbol, name, df_ind, days=days, rise_threshold=rise_threshold,
        hidden_labels=set(hidden_labels), historical_suppress_labels=set(historical_suppress_labels),
    )
