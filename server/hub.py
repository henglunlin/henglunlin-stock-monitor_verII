# -*- coding: utf-8 -*-
"""
server/hub.py
=============
報價中樞：管理富邦連線、組出每一列的完整資料、把變動推給所有連著的瀏覽器。

這支檔案取代了原本 `render_live_monitor()`（354 行的 Streamlit fragment）
所做的「資料流」工作。畫面的部分交給 React，這裡只負責資料。

兩種節奏，這是整個新架構的核心設計
----------------------------------
原本 Streamlit 每 3 秒把「所有東西」重算一次——報價、技術指標、22 個訊號模組、
整張表重繪。檔數一多就是這樣拖垮的。

新架構拆成快慢兩線：

  【快線】每 300ms
      manager.drain_dirty() 拿到「這 300ms 內有變動的代碼」，只推那幾檔的價格。
      沒變動就完全不發。成本趨近於零，所以可以跑得很密。

  【慢線】每 20 秒（可調）
      重新計算技術指標、跑訊號模組、比對目標價——這些是貴的運算，
      而且它們的輸入（日線歷史）根本不會在幾秒內改變，沒有必要每 3 秒算一次。

前端收到快線就更新價格那一格，收到慢線就更新整列。這就是「只有變動的格子會閃」
的來源，也是為什麼幾百檔不會卡。
"""
from __future__ import annotations

import asyncio
import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

import pandas as pd

from core import groups as core_groups
from core import quotes, targets, telegram
from core.detectors import get_detector_engine
from core.events import get_event_bus
from core.fubon import FubonRealtimeManager
from core.indicators import compute_indicators
from core.signals import GENERALIZED_THREE_METHOD_LABELS, run_stock_signals
from core.state import TW_TZ, get_state
from core.symbols import get_stock_name
from core.tradingday import get_effective_trading_reference_date

log = logging.getLogger(__name__)

FETCH_MAX_WORKERS = 8          # 沿用原版常數
# 慢線間隔改由 Settings.row_refresh_sec 控制（見 _row_loop），這裡只留預設值。


def json_safe(value: Any) -> Any:
    """
    把 pandas / numpy 的值轉成 JSON 合法的東西。

    ⚠️ 為什麼一定要有這一層
    ----------------------
    Starlette 的 JSONResponse 是用 `json.dumps(..., allow_nan=False)` 序列化的，
    所以**回應裡只要有任何一個 NaN 或 Infinity，整個請求就會炸成 HTTP 500**，
    而且錯誤訊息是沒頭沒尾的 "Internal Server Error"，很難查。

    真實資料一定會有 NaN：某檔當天沒有開高低、歷史資料筆數不足算不出 KD、
    停牌、剛上市……只要 207 檔裡有一檔中獎，整張表就都拿不到。
    用兩三檔乾淨的股票測試永遠測不出這個問題。

    順便處理 numpy 型別（np.float64 / np.int64）——那些 json 也不認得。
    """
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    # numpy 純量：有 .item() 可以轉回 Python 原生型別
    if hasattr(value, "item") and hasattr(value, "dtype"):
        try:
            return json_safe(value.item())
        except Exception:
            return None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    try:
        if pd.isna(value):        # pd.NaT、pd.NA
            return None
    except (TypeError, ValueError):
        pass
    return value


class QuoteHub:
    """全服務唯一一份。由 server/main.py 的 lifespan 建立與關閉。"""

    def __init__(self) -> None:
        self._clients: set = set()
        self._clients_lock = threading.Lock()
        self._tasks: list = []
        self._pool = ThreadPoolExecutor(max_workers=FETCH_MAX_WORKERS)
        self._rows: dict = {}          # {symbol: row dict}，最近一次慢線的結果
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running = False

    # ------------------------------------------------------------------
    # 生命週期
    # ------------------------------------------------------------------
    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._running = True
        state = get_state()

        # 富邦 manager：每筆 tick 順便更新當日高低點追蹤
        state.fubon_manager = FubonRealtimeManager(on_tick=self._on_tick)

        # 依使用者的決定，這裡只在環境變數「四個都齊全」時才自動登入。
        # 預設情境是只設 FUBON_PFX_BASE64，所以這裡會安靜跳過，
        # 等前端呼叫 /api/fubon/login 手動送帳密。
        if state.fubon_manager.login_from_env():
            state.fubon_logged_in = True
            state.fubon_login_time = datetime.now(TW_TZ)
            self.resubscribe()

        state.stock_groups = core_groups.load_groups()
        log.info("已載入 %d 個分組、共 %d 檔股票",
                 len(state.stock_groups), len(self.all_symbols()))

        self._tasks = [
            asyncio.create_task(self._quote_loop(), name="quote_loop"),
            asyncio.create_task(self._row_loop(), name="row_loop"),
            asyncio.create_task(self._detector_loop(), name="detector_loop"),
            asyncio.create_task(self._fubon_watchdog(), name="fubon_watchdog"),
            asyncio.create_task(self._telegram_loop(), name="telegram_loop"),
        ]

    async def stop(self) -> None:
        self._running = False
        for t in self._tasks:
            t.cancel()
        self._tasks = []
        self._pool.shutdown(wait=False)
        mgr = get_state().fubon_manager
        if mgr is not None:
            mgr.close()

    # ------------------------------------------------------------------
    # 富邦
    # ------------------------------------------------------------------
    def _on_tick(self, symbol: str, price: float) -> None:
        """
        在富邦 SDK 的接收執行緒上被呼叫，必須快。

        只做三件很便宜的事：當日高低點追蹤，以及把價格記進盤中走勢序列。
        AppState 內部有鎖，而且會自動處理換日重置。

        走勢序列是取樣過的（每檔每 20 秒一個點），所以熱門股一秒進來十筆
        也只是改寫同一個點的值——不會因為 tick 密集就變慢。
        """
        state = get_state()
        state.update_intraday_high(symbol, price)
        state.update_intraday_low(symbol, price)
        state.record_tick(symbol, price)

    def login_fubon(self, fubon_id: str, password: str, cert_password: str) -> None:
        """
        前端手動登入用。pfx 一律取自環境變數，帳密由這次呼叫帶進來、用完不留。
        """
        from core import config
        state = get_state()
        pfx = config.get_secret_or_default("FUBON_PFX_BASE64", "")
        if not pfx:
            raise RuntimeError("伺服器未設定 FUBON_PFX_BASE64，無法登入")
        if state.fubon_manager is None:
            state.fubon_manager = FubonRealtimeManager(on_tick=self._on_tick)
        state.fubon_manager.login(fubon_id, password, cert_password, pfx)
        state.fubon_logged_in = True
        state.fubon_login_time = datetime.now(TW_TZ)
        state.fubon_last_error = None
        self.resubscribe()

    def resubscribe(self) -> dict:
        """
        讓訂閱清單跟目前的分組一致：新增的訂閱、移除的退訂。

        ⚠️ 之前這裡只做訂閱不做退訂，所以你從分類裡刪掉一檔之後，富邦還是會繼續
        推它的報價，subscribed_count 只增不減直到服務重啟。不影響表格正確性
        （它已經不在 rows 裡），但會白白吃頻寬，也讓訂閱數看起來對不上。

        退訂需要訂閱 id；拿不到 id 的情況走「整條連線重來」的退路
        （約 2–3 秒沒報價，但數字會正確）。
        """
        state = get_state()
        mgr = state.fubon_manager
        if mgr is None or not state.fubon_logged_in:
            return {"added": 0, "removed": 0}

        wanted = self.all_symbols()
        wanted_codes = {s.split(".")[0].upper() for s in wanted}
        with mgr.lock:
            current = set(mgr.subscribed)
        stale = current - wanted_codes

        removed = 0
        if stale:
            result = mgr.unsubscribe_many(stale)
            removed = len(result["unsubscribed"])
            if result["no_id"]:
                log.info("%d 檔沒有訂閱 id，改走重連重訂", len(result["no_id"]))
                if mgr.reconnect_and_resubscribe(wanted):
                    return {"added": len(wanted), "removed": len(stale), "reconnected": True}

        if wanted:
            mgr.subscribe_many(wanted)
        added = len(wanted_codes - current)
        log.info("訂閱同步：新增 %d、退訂 %d，目前共 %d 檔", added, removed, len(wanted_codes))
        return {"added": added, "removed": removed}

    def all_symbols(self) -> list:
        """所有分組的股票，去重且保留原始出現順序（沿用原版語意）。"""
        seen, ordered = set(), []
        for symbols in get_state().stock_groups.values():
            for s in symbols:
                if s not in seen:
                    seen.add(s)
                    ordered.append(s)
        return ordered

    # ------------------------------------------------------------------
    # WebSocket 客戶端管理
    # ------------------------------------------------------------------
    def add_client(self, ws) -> None:
        with self._clients_lock:
            self._clients.add(ws)
        log.info("WebSocket 連入，目前 %d 個客戶端", len(self._clients))

    def remove_client(self, ws) -> None:
        with self._clients_lock:
            self._clients.discard(ws)

    def client_count(self) -> int:
        with self._clients_lock:
            return len(self._clients)

    async def _broadcast(self, payload: dict) -> None:
        with self._clients_lock:
            clients = list(self._clients)
        if not clients:
            return
        dead = []
        for ws in clients:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        if dead:
            with self._clients_lock:
                for ws in dead:
                    self._clients.discard(ws)
            log.info("清掉 %d 個已斷線的客戶端", len(dead))

    # ------------------------------------------------------------------
    # 快線：報價節流廣播
    # ------------------------------------------------------------------
    async def _quote_loop(self) -> None:
        while self._running:
            try:
                interval = max(0.05, get_state().settings.broadcast_interval_ms / 1000.0)
                mgr = get_state().fubon_manager
                if mgr is not None and self.client_count() > 0:
                    changed = mgr.drain_dirty()
                    if changed:
                        await self._broadcast({"type": "quotes", "data": json_safe(changed)})
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("quote_loop 發生例外，3 秒後續跑：%s", e)
                await asyncio.sleep(3)

    # ------------------------------------------------------------------
    # 慢線：指標與訊號重算
    # ------------------------------------------------------------------
    async def _row_loop(self) -> None:
        # 啟動後先算一次，讓第一個連進來的瀏覽器馬上有東西看
        await asyncio.sleep(1)
        while self._running:
            try:
                rows = await self._loop.run_in_executor(None, self.compute_all_rows)
                if rows:
                    self._rows = {r["symbol"]: r for r in rows}
                    await self._broadcast({"type": "rows", "data": rows})
                # 間隔改讀設定值（前端「慢線重算間隔」）。下限 5 秒是保護：
                # 193 檔的指標＋訊號重算不是免費的，設太短會讓服務一直滿載。
                await asyncio.sleep(max(5, get_state().settings.row_refresh_sec))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("row_loop 發生例外，10 秒後續跑：%s", e)
                await asyncio.sleep(10)

    # ------------------------------------------------------------------
    # 富邦連線看門狗
    # ------------------------------------------------------------------
    async def _fubon_watchdog(self) -> None:
        """
        盤中每 15 秒檢查一次富邦連線，斷了就自動重連並重新訂閱。

        ⚠️ 為什麼一定要有這個
        --------------------
        原本 `_on_disconnect()` 只寫一行 log 就結束，**沒有任何重連**。
        本機不太會遇到（路徑短又穩，而且人就坐在旁邊看得到）；但 Render 在新加坡、
        富邦在台灣，跨海連線抖動的機率高很多，加上免費方案的執行個體本來就會被
        平台搬移重啟。只要抖一次，行情就永久停掉直到手動重新登入——
        這就是「雲端會不定時斷線、本機不會」的真正原因。

        兩種斷法都要抓：
          1. **明確斷線** —— connected == False，斷線回呼有觸發
          2. **半開連線** —— TCP 沒正常關閉，回呼不會觸發，狀態一直顯示「已連線」，
             但 tick 就是不再增加。這種最難查，只能靠「多久沒收到資料」判斷。

        ── 重連不需要帳密 ──
        SDK 的登入 session 還活著（self.sdk 沒有失效），只是行情 WebSocket 掉了。
        所以重連只做 init_realtime() + connect() + 重新訂閱，**不需要重新登入**，
        也就不需要把身分證與密碼存在伺服器上——這跟原本的安全決定沒有衝突。

        ── 只在盤中運作 ──
        收盤後沒有資料是正常的，不該一直重連。08:45（試撮）到 13:35 之外直接跳過。
        """
        # 指數退避：連續失敗時拉長間隔，避免對富邦造成連線風暴
        BACKOFF = [0, 15, 30, 60, 120]
        fails = 0
        await asyncio.sleep(20)          # 等服務完全起來再開始看

        while self._running:
            try:
                state = get_state()
                s = state.settings
                interval = max(5, int(s.fubon_watchdog_interval_sec))

                if not s.fubon_watchdog_enabled or not state.fubon_logged_in:
                    fails = 0
                    await asyncio.sleep(interval)
                    continue

                now = datetime.now(TW_TZ)
                minutes = now.hour * 60 + now.minute
                # 08:45 試撮 ~ 13:35 收盤後五分鐘
                if not (8 * 60 + 45 <= minutes <= 13 * 60 + 35) or now.weekday() >= 5:
                    fails = 0
                    await asyncio.sleep(interval)
                    continue

                mgr = state.fubon_manager
                if mgr is None or mgr.sdk is None:
                    await asyncio.sleep(interval)
                    continue

                status = mgr.get_status()
                stale_sec = max(30, int(s.fubon_stale_sec))
                dead = (not status.get("connected")) or mgr.is_stale(stale_sec)

                if not dead:
                    fails = 0
                    await asyncio.sleep(interval)
                    continue

                gap = mgr.seconds_since_last_message()
                log.warning(
                    "看門狗偵測到富邦連線異常（connected=%s、距上次資料 %s 秒），開始重連",
                    status.get("connected"),
                    f"{gap:.0f}" if gap is not None else "從未收到",
                )
                wait = BACKOFF[min(fails, len(BACKOFF) - 1)]
                if wait:
                    await asyncio.sleep(wait)

                symbols = self.all_symbols()
                ok = await self._loop.run_in_executor(
                    None, mgr.reconnect_and_resubscribe, symbols,
                )
                if ok:
                    fails = 0
                    log.info("看門狗重連成功，已重新訂閱 %d 檔", len(symbols))
                else:
                    fails += 1
                    log.warning("看門狗重連失敗（連續第 %d 次），將延後再試", fails)

                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("fubon_watchdog 發生例外，30 秒後續跑：%s", e)
                await asyncio.sleep(30)

    # ------------------------------------------------------------------
    # 偵測線：盤中事件（第三條迴圈）
    # ------------------------------------------------------------------
    async def _detector_loop(self) -> None:
        """
        每秒掃一次，找出瞬間反彈與即將漲跌停。

        ── 為什麼是獨立的第三條迴圈，不是塞進既有的兩條 ──
        快線 300ms 太密（偵測器不需要那麼頻繁，白白吃 CPU）；
        慢線 20 秒太稀（拉抬用 2 秒窗，20 秒才看一次等於看不到）。

        ── 為什麼不放在 tick 回呼裡 ──
        那條是富邦 SDK 的接收執行緒。在裡面跑 193 檔的偵測器會把整條行情卡住，
        報價會開始延遲甚至掉包。tick 回呼裡只能做「加一個數字」等級的事。

        偵測本身是同步的純運算，丟到執行緒池跑，不擋事件迴圈。
        """
        await asyncio.sleep(3)          # 等第一輪慢線把 rows 算出來
        engine = get_detector_engine()
        while self._running:
            try:
                interval = max(0.2, get_state().settings.detector_interval_ms / 1000.0)
                rows = list(self._rows.values())
                if rows:
                    mgr = get_state().fubon_manager

                    def price_of(code, _mgr=mgr):
                        return _mgr.get_price(code) if _mgr is not None else None

                    events = await self._loop.run_in_executor(
                        None, engine.scan, rows, price_of,
                    )
                    if events:
                        payload = [e.to_dict() for e in events]
                        await self._broadcast({"type": "events", "data": json_safe(payload)})
                        # 畫面與 Telegram 吃同一批事件，不會有一邊有一邊沒有
                        await self._loop.run_in_executor(None, self._push_events, events)
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("detector_loop 發生例外，5 秒後續跑：%s", e)
                await asyncio.sleep(5)

    def _push_events(self, events: list) -> None:
        """把夠重要的盤中事件推去 Telegram。低於門檻的只留在畫面上。"""
        state = get_state()
        if not state.settings.tg_push_enabled or not telegram.telegram_configured():
            return
        floor = int(state.settings.tg_event_min_priority)
        for e in events:
            if e.priority < floor:
                continue
            try:
                telegram.send_message(
                    f"{e.label}\n"
                    f"<b>{e.code} {e.name}</b>"
                    + (f"｜{'、'.join(e.groups)}" if e.groups else "") + "\n"
                    f"現價 {e.price:.2f}｜漲跌 {e.pct:+.2f}%\n"
                    f"時間 {e.time}\n"
                    f"------------------\n{e.text}"
                )
            except Exception as exc:
                log.warning("推播事件失敗（已忽略）：%s", exc)

    def compute_all_rows(self) -> list:
        """
        對所有股票平行計算完整的一列。在背景執行緒跑（會有網路 I/O 與 pandas 運算）。

        ── 搬家帶來的簡化 ──
        原版的 `_fetch_symbol_for_monitor()` 開頭必須做 `add_script_run_ctx()`，
        把主執行緒的 Streamlit ScriptRunContext 掛到 worker 執行緒上，否則
        `st.session_state` 讀取和 `@st.cache_data` 都會失效。**那整段workaround
        現在完全不需要了**——core/ 的快取和狀態都是行程層級的普通 Python 物件。
        """
        symbols = self.all_symbols()
        if not symbols:
            return []

        state = get_state()
        mgr = state.fubon_manager
        price_ref_date = get_effective_trading_reference_date()
        target_table = targets.load_target_price_list()
        # ⚠️ 這裡用 signal_rise_threshold，不是 rise_threshold。
        # 前者是訊號引擎的門檻（會改變「漲幅達標」訊號的觸發），
        # 後者只是儀表板與表格的顯示門檻。兩個刻意分開，不要又合回去。
        rise_threshold = state.settings.signal_rise_threshold

        # 每一列要知道自己屬於哪些分組，前端才能做分類顯示與儀表板。
        # 一檔股票可以同時屬於多個分組（例如 2330 同時在「權值股」和「自選股」），
        # 所以是 list 不是單一字串。
        membership: dict = {}
        for gname, gsymbols in state.stock_groups.items():
            for sym in gsymbols:
                membership.setdefault(sym, []).append(gname)

        futures = {
            self._pool.submit(
                self._compute_row, sym, mgr, price_ref_date, target_table,
                rise_threshold, membership.get(sym, []),
            ): sym
            for sym in symbols
        }
        rows = []
        for fut, sym in futures.items():
            try:
                row = fut.result(timeout=30)
                if row:
                    rows.append(row)
            except Exception as e:
                log.debug("%s 計算失敗：%s", sym, e)
                rows.append({
                    "symbol": sym, "code": sym.split(".")[0], "name": get_stock_name(sym),
                    "groups": membership.get(sym, []), "error": str(e),
                })
        # 保持原始分組順序
        order = {s: i for i, s in enumerate(symbols)}
        rows.sort(key=lambda r: order.get(r["symbol"], 9999))
        # ⚠️ 一定要在這裡過一次 json_safe：往下所有出口（/api/rows、
        # WebSocket 廣播、Telegram）都吃這份資料，在源頭清乾淨最保險。
        return [json_safe(r) for r in rows]

    def _compute_row(self, symbol, mgr, price_ref_date, target_table,
                     rise_threshold, groups: list | None = None) -> dict | None:
        """
        單一股票的完整計算。組合順序沿用原版 `_fetch_symbol_for_monitor()`：
        歷史 → 即時價 → 官方開高低（富邦 REST，退回 db，再退回自己追蹤的）→ 指標 → 訊號。
        """
        raw_df = quotes.download_stock_data(symbol)
        df = quotes.normalize_ohlc(raw_df)
        if df.empty:
            raise ValueError("無法解析 OHLC 欄位格式")

        price, price_source = quotes.get_last_price(symbol, df, mgr)
        name = get_stock_name(symbol)

        # 優先富邦官方 REST 今日開高低；缺的欄位退回查 db；再缺就用自己追蹤的
        ohlc = quotes.get_official_today_ohlc(mgr, symbol)
        if any(ohlc.get(k) is None for k in ("open", "high", "low")):
            db_ohlc = quotes.db.get_db_ohlc_for_date(symbol, price_ref_date.strftime("%Y-%m-%d"))
            for k in ("open", "high", "low"):
                if ohlc.get(k) is None and db_ohlc.get(k) is not None:
                    ohlc[k] = db_ohlc[k]

        state = get_state()
        open_val = ohlc.get("open") if ohlc.get("open") is not None else price
        high_val = ohlc.get("high") if ohlc.get("high") is not None else (state.get_intraday_high(symbol) or price)
        low_val = ohlc.get("low") if ohlc.get("low") is not None else (state.get_intraday_low(symbol) or price)

        data = compute_indicators(df, price, price_ref_date=price_ref_date)

        hit_list, signal_text = run_stock_signals(
            symbol, name, df, open_val, high_val, low_val, price,
            rise_threshold=rise_threshold, price_ref_date=price_ref_date,
        )

        # ── 每列的迷你走勢圖有兩條資料，前端優先畫盤中那條 ──
        #
        # intraday：今天的盤中走勢，來自 AppState 累積的 tick 序列（每 20 秒一點）。
        #   這是使用者真正想看的東西——「這檔現在是往上衝還是在回檔」。
        #   只取 40 點：迷你圖只有 96px 寬，畫更多點也是疊在同一個像素上。
        #
        # spark：最近 30 根日線收盤，盤前／假日／尚未登入富邦時的後備。
        #   沒有這條的話，開盤前整欄會是空的，看起來像壞掉。
        try:
            intraday = state.series_of(symbol, limit=40)
        except Exception:
            intraday = []
        try:
            spark = [round(float(v), 2) for v in df["Close"].tail(30).tolist()]
        except Exception:
            spark = []

        return {
            "symbol": symbol,
            "code": symbol.split(".")[0],
            "name": name,
            "groups": groups or [],
            "spark": spark,
            "intraday": intraday,
            "price": data["price"],
            "pct": data["pct"],
            "yesterday_close": data["yesterday_close"],
            "open": open_val,
            "high": high_val,
            "low": low_val,
            "ma_range": data["ma_range"],
            "ma_trend": data["ma_trend"],
            "k": data["k"],
            "d": data["d"],
            "price_source": price_source,
            "signals": hit_list,
            "signal_text": signal_text,
            "target": targets.evaluate_target_price(symbol, price, target_table),
            "updated_at": datetime.now(TW_TZ).isoformat(timespec="seconds"),
        }

    def latest_rows(self) -> list:
        """給剛連上的客戶端當第一包資料。再過一次 json_safe 當保險。"""
        return [json_safe(r) for r in self._rows.values()]

    # ------------------------------------------------------------------
    # Telegram
    # ------------------------------------------------------------------
    async def _telegram_loop(self) -> None:
        """
        取代原本寫在 render_live_monitor() 裡的推播邏輯。

        最大的差別：**這裡不需要有人開著網頁**。原版推播綁在 Streamlit fragment 上，
        頁面沒開就不推；現在它是 server 的背景任務，開著就會跑。
        """
        TARGET_SLOTS = [(9, 40), (10, 0), (11, 0), (12, 0), (13, 0)]
        while self._running:
            try:
                state = get_state()
                if not state.settings.tg_push_enabled or not telegram.telegram_configured():
                    await asyncio.sleep(30)
                    continue

                # 收到 'push' 指令 → 清空去重、強制推一次
                forced = await self._loop.run_in_executor(None, telegram.poll_push_command)
                if forced:
                    state.clear_notified()
                    telegram.send_message("🤖 <b>收到指令，開始為您掃描並強制推播強勢股…</b>")

                should_push = forced
                if state.settings.scheduled_push_enabled and not forced:
                    now = datetime.now(TW_TZ)
                    for hh, mm in TARGET_SLOTS:
                        key = f"{now:%Y%m%d}-{hh:02d}{mm:02d}"
                        if now.hour == hh and now.minute == mm and not state.slot_processed(key):
                            state.mark_slot_processed(key)
                            should_push = True
                            break

                if should_push:
                    await self._loop.run_in_executor(None, self._push_signals)

                await asyncio.sleep(20)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("telegram_loop 發生例外，30 秒後續跑：%s", e)
                await asyncio.sleep(30)

    def _push_signals(self) -> None:
        """
        把目前命中的訊號整理成一則訊息推出去。

        沿用原版兩條規則：
          1. 每檔股票每天只推一次（AppState.notified_stocks 去重，會自動換日重置）
          2. 廣義上升／下降三法單獨出現時不推，跟其他訊號一起命中才推
        """
        state = get_state()
        lines = []
        for row in self.latest_rows():
            hits = row.get("signals") or []
            if not hits:
                continue
            labels = {h["label"] for h in hits}
            if labels and labels <= GENERALIZED_THREE_METHOD_LABELS:
                continue                      # 只有三法 → 雜訊，跳過
            key = f"{row['symbol']}:{row.get('signal_text', '')}"
            if state.already_notified(key):
                continue
            state.mark_notified(key)
            lines.append(
                f"<b>{row['code']} {row['name']}</b>  {row['price']}  "
                f"({row['pct']:+.2f}%)\n　{row.get('signal_text', '-')}"
            )
        if lines:
            telegram.send_message("📈 <b>訊號通知</b>\n\n" + "\n\n".join(lines))
            log.info("Telegram 推播 %d 檔", len(lines))


hub = QuoteHub()
