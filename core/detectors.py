# -*- coding: utf-8 -*-
"""
core/detectors.py
=================
盤中事件偵測器。**只計算「要不要發」，發不發得出去由 core/events.py 的三道閘門決定。**

原始碼對照：盤中訊號監控器.py
    calc_limit_prices()            → 行 489-530（原樣搬過來）
    get_day_low_rebound_signal()   → 行 1653-1735（狀態機邏輯照搬）
    即將漲停/跌停                   → 行 2857-2920

這一批（第一批）實作兩個便宜的偵測器
------------------------------------
它們只需要「現價 + 昨收 + 今日最低」，這三樣**現在都已經有了**：
現價來自富邦快線、昨收與名稱來自慢線那份 row、今日最低來自
AppState.intraday_low_tracker（本來就在逐筆追蹤，而且會自動換日重置）。

所以這一批的記憶體與 CPU 成本幾乎是零，不需要 tick 明細管線。

🚀 瞬間拉抬（第二批，已到位）
-----------------------------
它需要單筆量、內外盤、累積量與 2 秒級價格點，資料來自 core/ticks.py 的
float 陣列環形緩衝（富邦每筆成交寫入，120 秒窗）。判斷邏輯照搬
`get_entry_signal()`，唯一的改寫是把原本三次獨立的全陣列掃描合併成一次
（193 檔每秒一輪，579 次全掃 → 193 次）。
"""
from __future__ import annotations

import logging
import math
import threading
from datetime import date, datetime

from core.events import get_event_bus
from core.state import TW_TZ, get_state
from core.ticks import get_tick_store

log = logging.getLogger(__name__)

__all__ = [
    "get_price_tick_size", "calc_limit_prices",
    "DetectorEngine", "get_detector_engine",
]

# 開盤時間，用來算靜默期
SESSION_OPEN_MIN = 9 * 60

# 量能桶剛開始時已過秒數會接近 0，「預估整桶量」除下去會被放大到無限大。
# 原版用 3 秒地板擋住這個除零放大，照搬。
BUCKET_ELAPSED_FLOOR_SEC = 3.0


# =============================================================================
# 台股漲跌停價：用升降單位算，不是用百分比估
# 原始碼對照：盤中訊號監控器.py 行 489-530
# =============================================================================
def get_price_tick_size(price: float) -> float:
    """依台股股價級距回傳最小升降單位（元）。"""
    if price < 10:
        return 0.01
    if price < 50:
        return 0.05
    if price < 100:
        return 0.1
    if price < 500:
        return 0.5
    if price < 1000:
        return 1.0
    return 5.0


def calc_limit_prices(yesterday_close) -> tuple:
    """
    依昨收算今日的**實際**漲停價與跌停價。

    為什麼不直接用「漲幅 >= 9.5%」判斷：台股漲跌停是先算 ±10% 再依級距取整，
    取整之後的實際漲幅**不會剛好是 10%**。例如昨收 33.05：
        漲停 = floor(36.355 / 0.05) * 0.05 = 36.35 → 實際漲幅 9.98%
    用百分比估會在邊緣一直判錯。這是原版累積出來的做法，原樣保留。

    漲停無條件捨去、跌停無條件進位（都是往中間靠）。昨收無效回傳 (None, None)。
    """
    if yesterday_close is None:
        return None, None
    try:
        yesterday_close = float(yesterday_close)
    except (TypeError, ValueError):
        return None, None
    if yesterday_close <= 0:
        return None, None

    raw_up = yesterday_close * 1.1
    raw_down = yesterday_close * 0.9
    tick_up = get_price_tick_size(raw_up)
    tick_down = get_price_tick_size(raw_down)

    # 1e-6 是浮點數防呆：36.355 / 0.05 在二進位裡可能是 727.0999999，
    # 直接 floor 會少一檔。原版就有這個補正，照搬。
    limit_up = math.floor(raw_up / tick_up + 1e-6) * tick_up
    limit_down = math.ceil(raw_down / tick_down - 1e-6) * tick_down
    return round(limit_up, 2), round(limit_down, 2)


# =============================================================================
# 偵測引擎
# =============================================================================
class DetectorEngine:
    """
    每檔股票一份很小的狀態（反彈的武裝旗標、今天有沒有報過觸價漲停）。
    由 hub 的偵測線每秒呼叫一次 scan()。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._day: date = datetime.now(TW_TZ).date()
        # {code: {"rebound_armed": bool, "rebound_ref_low": float|None,
        #         "limit_up_hit": bool, "limit_down_hit": bool}}
        self._st: dict = {}
        self.last_scan_ms: float = 0.0
        self.scanned: int = 0

    def _ensure_today(self) -> None:
        today = datetime.now(TW_TZ).date()
        if today != self._day:
            log.info("偵測引擎換日 %s → %s，重置", self._day, today)
            self._day = today
            self._st.clear()

    def _state_of(self, code: str) -> dict:
        return self._st.setdefault(code, {
            "rebound_armed": True,
            "rebound_ref_low": None,
            "limit_up_hit": False,
            "limit_down_hit": False,
            "entry_dbg": None,
        })

    # ------------------------------------------------------------------
    def scan(self, rows: list, price_of) -> list:
        """
        掃一輪，回傳這輪真的要送出去的事件（已經過三道閘門）。

        rows      慢線最近一次算出來的整列（提供昨收、名稱、分類）
        price_of  callable(code) -> float | None，取當下的即時價（快線的值）

        ⚠️ 這支要夠快。193 檔 × 每秒一次，而 Render 免費只有 0.1 CPU。
        所以裡面沒有 pandas、沒有排序、沒有字串格式化（除非真的要發事件）。
        """
        started = datetime.now().timestamp()
        app = get_state()
        bus = get_event_bus()
        s = app.settings
        now = datetime.now(TW_TZ)
        now_ts = now.timestamp()
        now_min = now.hour * 60 + now.minute

        # 反彈的開盤靜默期：09:00 起算 N 分鐘內不報反彈。
        # 理由見檔頭——開盤第一筆 tick 必然就是當時的今日最低。
        silence = max(0, int(s.rebound_open_silence_min))
        rebound_muted = silence > 0 and SESSION_OPEN_MIN <= now_min < SESSION_OPEN_MIN + silence

        out = []
        scanned = 0

        with self._lock:
            self._ensure_today()

            for row in rows:
                if row.get("error"):
                    continue
                code = row.get("code")
                symbol = row.get("symbol")
                if not code or not symbol:
                    continue

                price = price_of(code)
                if price is None:
                    price = row.get("price")
                yc = row.get("yesterday_close")
                if price is None or not yc:
                    continue

                scanned += 1
                st = self._state_of(code)
                name = row.get("name") or code
                groups = row.get("groups") or []
                pct = (price / yc - 1) * 100

                # ── 🔺 即將漲停 / 🔻 即將跌停 ──
                ev = self._check_limit(bus, st, s, symbol, code, name, groups,
                                       price, pct, yc, now_ts)
                if ev:
                    out.append(ev)

                # ── 🚀 瞬間拉抬（含 ⚠️ 預警）──
                # 放在反彈前面：拉抬的優先權較高，先發的話 30 秒優先權窗
                # 會把同一波的反彈壓掉，避免同一件事報兩則。
                ev = self._check_entry(bus, st, s, symbol, code, name,
                                       groups, price, pct, now_ts)
                if ev:
                    out.append(ev)

                # ── 📈 瞬間反彈 ──
                if not rebound_muted:
                    ev = self._check_rebound(bus, st, s, app, symbol, code, name,
                                            groups, price, pct, now_ts)
                    if ev:
                        out.append(ev)

        self.last_scan_ms = (datetime.now().timestamp() - started) * 1000
        self.scanned = scanned
        return out

    # ------------------------------------------------------------------
    def _check_limit(self, bus, st, s, symbol, code, name, groups,
                     price, pct, yesterday_close, now_ts):
        """
        兩層，沿用原版：

          1. **真的觸到漲停價** —— 整天只報一次（key 帶日期，不帶時間）。
             已經漲停鎖死的股票不該每 30 分鐘再提醒你一次。
          2. **接近漲停**（漲幅 >= limit_approach_pct）—— 30 分鐘冷卻。
        """
        limit_up, limit_down = calc_limit_prices(yesterday_close)
        # 浮點數比較的容差：跳動單位的一半就夠，不會誤判也不會漏判
        eps = get_price_tick_size(price) * 0.5
        today_str = datetime.now(TW_TZ).strftime("%Y%m%d")

        if limit_up is not None and price >= limit_up - eps:
            if st["limit_up_hit"]:
                return None
            ev = bus.emit(
                level="limit_up_hit", symbol=symbol, code=code, name=name, groups=groups,
                price=price, pct=pct,
                text=f"已觸及漲停價 {limit_up:.2f}（昨收 {yesterday_close:.2f}）",
                signal_key=f"{code}_limit_up_hit_{today_str}",
                cooldown_sec=0, now_ts=now_ts,
            )
            # ⚠️ 旗標只有在「真的發出去了」才立起來。
            # 之前寫成先立旗標再 emit，結果 emit 被閘門擋下時旗標已經是 True，
            # 這檔今天就再也不會報漲停了——一則被吞掉等於永久遺失。
            if ev:
                st["limit_up_hit"] = True
            return ev

        if limit_down is not None and price <= limit_down + eps:
            if st["limit_down_hit"]:
                return None
            ev = bus.emit(
                level="limit_down_hit", symbol=symbol, code=code, name=name, groups=groups,
                price=price, pct=pct,
                text=f"已觸及跌停價 {limit_down:.2f}（昨收 {yesterday_close:.2f}）",
                signal_key=f"{code}_limit_down_hit_{today_str}",
                cooldown_sec=0, now_ts=now_ts,
            )
            if ev:
                st["limit_down_hit"] = True
            return ev

        approach = float(s.limit_approach_pct)
        if pct >= approach:
            return bus.emit(
                level="limit_up", symbol=symbol, code=code, name=name, groups=groups,
                price=price, pct=pct,
                text=(f"漲幅 {pct:+.2f}% 已達 {approach:.1f}%"
                      + (f"，距漲停價 {limit_up:.2f} 還有 {(limit_up - price):.2f} 元"
                         if limit_up else "")),
                signal_key=f"{code}_limit_up_{int(now_ts // 60)}",
                cooldown_sec=int(s.limit_cooldown_sec), now_ts=now_ts,
            )

        if pct <= -approach:
            return bus.emit(
                level="limit_down", symbol=symbol, code=code, name=name, groups=groups,
                price=price, pct=pct,
                text=(f"跌幅 {pct:+.2f}% 已達 -{approach:.1f}%"
                      + (f"，距跌停價 {limit_down:.2f} 還有 {(price - limit_down):.2f} 元"
                         if limit_down else "")),
                signal_key=f"{code}_limit_down_{int(now_ts // 60)}",
                cooldown_sec=int(s.limit_cooldown_sec), now_ts=now_ts,
            )
        return None

    # ------------------------------------------------------------------
    def _check_rebound(self, bus, st, s, app, symbol, code, name, groups,
                       price, pct, now_ts):
        """
        現價相對「今日最低」的反彈幅度。

        ── 重新武裝的機制（原版的 last_signal_day_low，這裡改寫得更明確）──
        報過一次之後就卸除武裝，要滿足兩個條件之一才會重新武裝：
          (a) 今日最低又被更新了（真的又跌下去創新低，是新的一波）
          (b) 反彈幅度回落到門檻的一半以下（漲上去又拉回，重新蓄力）

        沒有這個機制的話，一檔反彈 5% 之後只要價格繼續在高檔震盪，
        每次冷卻結束就會再報一次同一件事。
        """
        low = app.get_intraday_low(code) or app.get_intraday_low(symbol)
        if not low or low <= 0:
            return None

        rebound = (price / low - 1) * 100
        threshold = float(s.rebound_pct)

        # (a) 又創新低 → 重新武裝
        ref = st.get("rebound_ref_low")
        if ref is None or low < ref - 1e-9:
            st["rebound_ref_low"] = low
            st["rebound_armed"] = True

        # (b) 回落到門檻一半以下 → 重新武裝
        if rebound < threshold * 0.5:
            st["rebound_armed"] = True

        if rebound < threshold or not st["rebound_armed"]:
            return None

        # 這裡刻意跟漲停的旗標相反：**不管 emit 有沒有被閘門擋下都卸除武裝**。
        # 因為這個旗標的語意是「這一段反彈已經處理過」，不是「訊息送出去了」。
        # 被 30 秒優先權窗擋下時，代表同一檔已經有更重要的訊號送到你眼前了；
        # 被冷卻擋下時，代表這檔剛剛才報過反彈。兩種情況都不該等冷卻結束再補一則。
        # （漲停那個旗標是「整天一次」的鎖，性質不同，所以必須 emit 成功才立。）
        st["rebound_armed"] = False
        return bus.emit(
            level="rebound", symbol=symbol, code=code, name=name, groups=groups,
            price=price, pct=pct,
            text=(f"今日最低 {low:.2f} → 現價 {price:.2f}，"
                  f"反彈 {rebound:+.2f}%（門檻 {threshold:.1f}%）"),
            signal_key=f"{code}_rebound_{int(now_ts // 10)}_{low:.2f}",
            cooldown_sec=int(s.rebound_cooldown_sec), now_ts=now_ts,
        )

    # ------------------------------------------------------------------
    # 🚀 瞬間拉抬
    # 原始碼對照：盤中訊號監控器.py 的 get_entry_signal()（行 1299-1651）
    # ------------------------------------------------------------------
    def _check_entry(self, bus, st, s, symbol, code, name, groups, price, pct, now_ts):
        bucket = max(5, int(s.entry_bucket_sec))
        track = max(bucket, int(s.entry_track_sec))

        # 早退：這檔最近一整個桶都沒有成交，量比與短線漲幅一定不成立。
        # 盤中任一秒真正在動的通常只有幾十檔，這一行就把大部分工作跳掉了。
        last = get_tick_store().last_tick_ts(code)
        if last is None or now_ts - last > bucket:
            return None

        agg = get_tick_store().aggregate(code, now_ts, bucket, track, (2, 5, 10, bucket))
        if agg is None:
            return None

        # 桶的邊界對齊絕對時間（不是「從現在往回推」），所有股票的桶因此是同步的，
        # 「本桶 vs 前一桶」才是公平的比較。沿用原版。
        # 桶剛開始時已過秒數接近 0，除下去會把預估量放大到無限大——
        # 原版用 3 秒地板擋住這個除零放大，照搬。
        elapsed = max(BUCKET_ELAPSED_FLOOR_SEC, now_ts - agg["bucket_start"])
        cur_vol, cur_buy = agg["cur_vol"], agg["cur_buy"]
        cur_ticks, prev_vol = agg["cur_ticks"], agg["prev_vol"]

        # 「預估整桶量」= 目前累積量 ÷ 已過秒數 × 整桶秒數。
        # 這是原版的關鍵設計：不必等 30 秒結束才判斷量能放大，第 5 秒就看得出來。
        projected = cur_vol / elapsed * bucket

        enough_ticks = cur_ticks >= int(s.entry_min_ticks)
        volume_ratio = None
        if prev_vol > 0:
            volume_ratio = projected / prev_vol
            volume_ok = (volume_ratio >= float(s.entry_volume_ratio)
                         and cur_vol >= int(s.entry_min_volume)
                         and enough_ticks)
        else:
            # 前一桶完全沒量（剛開盤、冷門股剛醒），只要本桶量夠就算放大
            volume_ok = cur_vol >= int(s.entry_min_volume) and enough_ticks

        buy_ratio = (cur_buy / cur_vol) if cur_vol > 0 else None
        buy_ok = buy_ratio is not None and buy_ratio >= float(s.entry_buy_pressure)

        def move(sec):
            base = agg["ago"].get(sec)
            return (price / base - 1) * 100 if base and base > 0 else None

        m2, m5, m10, m30 = move(2), move(5), move(10), move(bucket)
        momentum_ok = (
            (m2 is not None and m2 >= float(s.entry_early_2s_pct))
            or (m5 is not None and m5 >= float(s.entry_early_5s_pct))
            or (m10 is not None and m10 >= float(s.entry_early_10s_pct))
            or (m30 is not None and m30 >= float(s.entry_price_move_pct))
        )

        lo, hi = agg["low"], agg["high"]
        rise_from_low = (price / lo - 1) * 100 if lo else None
        # 0.998 而不是 1.0：要的是「摸到前高」，不是「必須嚴格突破」。沿用原版。
        near_high = bool(hi and price >= hi * 0.998)
        low_rebound = rise_from_low is not None and rise_from_low >= float(s.entry_price_move_pct)
        position_ok = near_high or low_rebound

        # 把條件存起來給診斷端點用——訊號沒出來時要看得到是哪一項卡住
        st["entry_dbg"] = {
            "volume_ratio": volume_ratio, "cur_vol": cur_vol, "prev_vol": prev_vol,
            "projected": projected, "ticks": cur_ticks, "buy_ratio": buy_ratio,
            "m2": m2, "m5": m5, "m10": m10, "m30": m30,
            "low": lo, "high": hi, "rise_from_low": rise_from_low,
            "volume_ok": volume_ok, "buy_ok": buy_ok,
            "momentum_ok": momentum_ok, "position_ok": position_ok,
        }

        def detail(kind):
            head = (f"{kind}｜預估{bucket}秒量 {projected:.0f} / 前{bucket}秒量 {prev_vol:.0f}"
                    f"｜量比 {volume_ratio:.2f}x") if volume_ratio else (
                   f"{kind}｜預估{bucket}秒量 {projected:.0f}（前一桶無量）")
            parts = [head]
            if buy_ratio is not None:
                parts.append(f"外盤 {buy_ratio * 100:.0f}%")
            for label, v in (("2秒", m2), ("5秒", m5), ("10秒", m10)):
                if v is not None:
                    parts.append(f"{label} {v:+.2f}%")
            return "｜".join(parts)

        if volume_ok and buy_ok and momentum_ok and position_ok:
            extra = (f"｜突破{track}秒高點 {hi:.2f}" if near_high
                     else f"｜自{track}秒低點拉抬 {rise_from_low:+.2f}%")
            return bus.emit(
                level="entry", symbol=symbol, code=code, name=name, groups=groups,
                price=price, pct=pct, text=detail("量增價漲") + extra,
                signal_key=f"{code}_entry_{int(now_ts // 5)}_v{int(cur_vol)}_p{price}",
                cooldown_sec=int(s.entry_cooldown_sec), now_ts=now_ts,
            )

        # ⚠️ 預警 = 拉抬扣掉「位置條件」。它比拉抬鬆很多，所以只進事件流不上跑馬燈，
        # 而且一定要有自己的冷卻（原版沒有，193 檔會炸）。
        short_move = (
            (m2 is not None and m2 >= float(s.entry_early_2s_pct))
            or (m5 is not None and m5 >= float(s.entry_early_5s_pct))
            or (m10 is not None and m10 >= float(s.entry_early_10s_pct))
        )
        if volume_ok and buy_ok and short_move:
            return bus.emit(
                level="warning", symbol=symbol, code=code, name=name, groups=groups,
                price=price, pct=pct, text=detail("量增") + "｜尚未突破高點或自低點拉抬",
                signal_key=f"{code}_warn_{int(now_ts // 5)}_v{int(cur_vol)}",
                cooldown_sec=int(s.warning_cooldown_sec), now_ts=now_ts,
            )
        return None

    # ------------------------------------------------------------------
    def diagnostics(self, rows: list, price_of, sample: int = 8) -> dict:
        """
        給 /api/debug/detector 用。

        ⚠️ 這支存在的理由很具體：**訊號沒出來時，你要分得出是「真的沒訊號」
        還是「壞了」。** 我們踩過一次「所有訊號都是 —」而完全沒有錯誤訊息的坑，
        原因是模組載入順序，查了很久。這次先把每個條件當下的實際值攤開。
        """
        app = get_state()
        s = app.settings
        now = datetime.now(TW_TZ)
        now_min = now.hour * 60 + now.minute
        silence = max(0, int(s.rebound_open_silence_min))

        items = []
        for row in rows[:sample]:
            if row.get("error"):
                continue
            code = row.get("code")
            price = price_of(code) or row.get("price")
            yc = row.get("yesterday_close")
            low = app.get_intraday_low(code) or app.get_intraday_low(row.get("symbol", ""))
            up, down = calc_limit_prices(yc)
            items.append({
                "code": code,
                "name": row.get("name"),
                "price": price,
                "yesterday_close": yc,
                "pct": (price / yc - 1) * 100 if (price and yc) else None,
                "intraday_low": low,
                "rebound_pct": (price / low - 1) * 100 if (price and low) else None,
                "limit_up_price": up,
                "limit_down_price": down,
                "armed": self._st.get(code, {}).get("rebound_armed"),
                "limit_up_reported": self._st.get(code, {}).get("limit_up_hit"),
                # 拉抬的每一項條件當下的實際值。訊號整天不出來時先看這裡——
                # 尤其 buy_ratio：抓不到內外盤的話它會是 null，而外盤占比是
                # fail-closed 的，拉抬就永遠不會觸發，而且不會報錯。
                "entry": self._st.get(code, {}).get("entry_dbg"),
            })

        tick_stats = get_tick_store().stats()
        return {
            "scan_ms": round(self.last_scan_ms, 2),
            "scanned": self.scanned,
            "tracked_lows": len(app.intraday_low_tracker),
            "ticks": tick_stats,
            "rebound_muted_now": silence > 0 and SESSION_OPEN_MIN <= now_min < SESSION_OPEN_MIN + silence,
            "thresholds": {
                "rebound_pct": s.rebound_pct,
                "rebound_cooldown_sec": s.rebound_cooldown_sec,
                "rebound_open_silence_min": s.rebound_open_silence_min,
                "limit_approach_pct": s.limit_approach_pct,
                "limit_cooldown_sec": s.limit_cooldown_sec,
                "entry_volume_ratio": s.entry_volume_ratio,
                "entry_buy_pressure": s.entry_buy_pressure,
                "entry_bucket_sec": s.entry_bucket_sec,
                "entry_track_sec": s.entry_track_sec,
                "entry_min_volume": s.entry_min_volume,
            },
            "sample": items,
        }


_engine: DetectorEngine | None = None
_engine_lock = threading.Lock()


def get_detector_engine() -> DetectorEngine:
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = DetectorEngine()
    return _engine
