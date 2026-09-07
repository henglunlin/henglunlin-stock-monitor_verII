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
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Any

from core import groups as core_groups
from core import quotes, targets, telegram
from core.fubon import FubonRealtimeManager
from core.indicators import compute_indicators
from core.signals import GENERALIZED_THREE_METHOD_LABELS, run_stock_signals
from core.state import TW_TZ, get_state
from core.symbols import get_stock_name
from core.tradingday import get_effective_trading_reference_date

log = logging.getLogger(__name__)

FETCH_MAX_WORKERS = 8          # 沿用原版常數
ROW_REFRESH_SEC = 20           # 慢線間隔：指標與訊號的重算週期


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

        只做當日高低點追蹤——AppState 內部有鎖，而且會自動處理換日重置。
        """
        state = get_state()
        state.update_intraday_high(symbol, price)
        state.update_intraday_low(symbol, price)

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

    def resubscribe(self) -> None:
        """把目前所有分組裡的股票都訂閱一次（manager 內部會跳過已訂閱的）。"""
        state = get_state()
        mgr = state.fubon_manager
        if mgr is None or not state.fubon_logged_in:
            return
        symbols = self.all_symbols()
        if symbols:
            mgr.subscribe_many(symbols)
            log.info("已送出 %d 檔訂閱", len(symbols))

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
                        await self._broadcast({"type": "quotes", "data": changed})
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
                await asyncio.sleep(ROW_REFRESH_SEC)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("row_loop 發生例外，10 秒後續跑：%s", e)
                await asyncio.sleep(10)

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
        rise_threshold = state.settings.rise_threshold

        futures = {
            self._pool.submit(
                self._compute_row, sym, mgr, price_ref_date, target_table, rise_threshold
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
                rows.append({"symbol": sym, "name": get_stock_name(sym), "error": str(e)})
        # 保持原始分組順序
        order = {s: i for i, s in enumerate(symbols)}
        rows.sort(key=lambda r: order.get(r["symbol"], 9999))
        return rows

    def _compute_row(self, symbol, mgr, price_ref_date, target_table, rise_threshold) -> dict | None:
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

        # 給前端畫每列迷你走勢圖用：最近 30 根收盤價。
        # 刻意在後端切好，不要把整份歷史丟給瀏覽器——197 檔 × 205 筆會是很大一包。
        try:
            spark = [round(float(v), 2) for v in df["Close"].tail(30).tolist()]
        except Exception:
            spark = []

        return {
            "symbol": symbol,
            "code": symbol.split(".")[0],
            "name": name,
            "spark": spark,
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
        """給剛連上的客戶端當第一包資料。"""
        return list(self._rows.values())

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
