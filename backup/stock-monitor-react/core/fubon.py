# -*- coding: utf-8 -*-
"""
core/fubon.py
=============
富邦 Neo WebSocket 即時報價管理器。

這支檔案是整次搬家最重要、也最幸運的一塊：原本 0_💻_monitor.py 行 246-429 的
`FubonRealtimeManager` **完全沒有任何 st.* 呼叫**，本身就是乾淨的、有 RLock 保護的
純 Python 類別。所以核心邏輯是原樣搬過來的，沒有改寫。

相對於原版新增的三件事（都是新架構才需要的）
--------------------------------------------
1. **髒資料集合（_dirty）**
   原版把價格累積在 self.prices，畫面每 3 秒整份撈走重畫。新架構要用 WebSocket
   推送，如果每筆 tick 都推、幾百檔一起跳會直接淹掉瀏覽器。所以這裡記錄「上次
   排空之後有哪些代碼變動過」，由 server 端每 200-500ms 呼叫 drain_dirty()，
   只推變動的那幾檔。這是節流的基礎。

2. **on_tick 回呼掛勾**
   讓上層（server）可以在每筆報價進來時做事——例如更新當日最高／最低價追蹤。
   刻意用回呼而不是直接 import core.state，這樣 core/fubon.py 不依賴狀態層，
   測試時可以單獨跑。

3. **login_from_env()**
   原版是在 Streamlit 側邊欄手動輸入身分證／密碼／憑證密碼。搬到 Render 之後
   要能無人啟動，所以多一條從環境變數登入的路。**手動登入的路徑保留**，
   憑證不想上雲的話就走那條。

⚠️ 憑證安全
-----------
login() 會把 pfx 解碼後寫成暫存檔（富邦 SDK 只吃檔案路徑，這是它的限制）。
close() 會刪掉它。除此之外，憑證與密碼不會出現在任何 log 或 API 回應裡。
"""
from __future__ import annotations

import base64
import copy
import json
import logging
import os
import tempfile
import threading
from datetime import datetime
from typing import Callable
from zoneinfo import ZoneInfo

import pandas as pd

from core import config
from core.symbols import symbol_to_code

log = logging.getLogger(__name__)

TW_TZ = ZoneInfo("Asia/Taipei")

# ===== 富邦 SDK 引入（跟原版一樣，載不到就降級，不讓整個服務起不來）=====
try:
    from fubon_neo.sdk import FubonSDK
except Exception:  # pragma: no cover
    FubonSDK = None

__all__ = ["FubonRealtimeManager", "TW_TZ"]


class FubonRealtimeManager:
    """
    只負責「當日即時股價」。歷史資料走 core/quotes.py 的 yfinance / SQLite 路徑。

    執行緒模型：富邦 SDK 的 _on_message 跑在它自己的執行緒，FastAPI 的 request
    與廣播迴圈跑在別的執行緒，所有共享狀態一律在 self.lock 底下存取。
    """

    def __init__(self, on_tick: Callable[[str, float], None] | None = None) -> None:
        self.sdk = None
        self.ws = None
        self.lock = threading.RLock()
        self.logged_in = False
        self.connected = False
        self.error = None
        self.prices: dict = {}
        self.messages: dict = {}
        self.subscribed: set = set()
        self.last_message_at: datetime | None = None
        self.cert_path: str | None = None

        # --- 新增：節流用的髒資料集合 ---
        self._dirty: set = set()
        # --- 新增：每筆報價的回呼（給當日高低點追蹤用）---
        self._on_tick = on_tick
        # --- 新增：統計，方便在 /api/status 觀察吞吐 ---
        self.tick_count = 0

    # ------------------------------------------------------------------
    # 登入
    # ------------------------------------------------------------------
    def login(self, fubon_id: str, fubon_password: str, cert_password: str, pfx_base64: str) -> None:
        """原樣沿用 monitor 的登入流程，僅補上 log 與憑證清理。"""
        if FubonSDK is None:
            raise RuntimeError("富邦 SDK 尚未安裝或載入失敗")

        try:
            if self.ws is not None:
                self.ws.disconnect()
        except Exception:
            pass

        with self.lock:
            self.sdk = None
            self.ws = None
            self.logged_in = False
            self.connected = False
            self.error = None
            self.prices = {}
            self.messages = {}
            self.subscribed = set()
            self.last_message_at = None
            self._dirty = set()

        pfx_base64 = str(pfx_base64).strip()
        # 支援 data:application/x-pkcs12;base64,xxx 這種貼上來的格式
        if "," in pfx_base64 and "base64" in pfx_base64[:80].lower():
            pfx_base64 = pfx_base64.split(",", 1)[1].strip()

        try:
            cert_bytes = base64.b64decode(pfx_base64, validate=True)
        except Exception as e:
            raise RuntimeError(f"pfx_base64 不是有效的 Base64 憑證資料：{e}")
        if not cert_bytes:
            raise RuntimeError("pfx_base64 解碼後是空資料")

        self._cleanup_cert()
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pfx")
        tmp.write(cert_bytes)
        tmp.close()
        self.cert_path = tmp.name

        sdk = None
        ws = None
        try:
            sdk = FubonSDK()
            login_result = sdk.login(
                fubon_id.strip().upper(),
                fubon_password,
                self.cert_path,
                cert_password,
            )
            is_success = getattr(login_result, "is_success", None)
            message = getattr(login_result, "message", None)
            if is_success is False:
                raise RuntimeError(f"富邦登入失敗：{message or login_result}")

            sdk.init_realtime()
            ws = sdk.marketdata.websocket_client.stock
            ws.on("message", self._on_message)
            # 連線／斷線事件：SDK 若不支援這些事件名稱就安靜跳過，
            # 不要因為多註冊一個 handler 就讓登入失敗。
            for event, handler in (
                ("connect", self._on_connect),
                ("disconnect", self._on_disconnect),
                ("error", self._on_error),
            ):
                try:
                    ws.on(event, handler)
                except Exception:
                    pass
            ws.connect()

            with self.lock:
                self.sdk = sdk
                self.ws = ws
                self.logged_in = True
                self.connected = True
                self.error = None
            log.info("富邦 WebSocket 登入成功")
        except Exception as e:
            try:
                if ws is not None:
                    ws.disconnect()
            except Exception:
                pass
            with self.lock:
                self.sdk = None
                self.ws = None
                self.logged_in = False
                self.connected = False
                self.error = str(e)
                self.prices = {}
                self.messages = {}
                self.subscribed = set()
                self.last_message_at = None
            self._cleanup_cert()
            log.error("富邦登入失敗：%s", e)
            raise

    def login_from_env(self) -> bool:
        """
        用環境變數自動登入。回傳 True 表示登入成功。

        四個變數沒設齊就直接回 False（不拋例外）——服務要照常起來，
        由前端呼叫 /api/fubon/login 手動送憑證，跟原本側邊欄輸入等價。
        """
        creds = config.fubon_credentials()
        if not creds.is_complete():
            log.info("未設定完整的富邦環境變數（缺 %s），跳過自動登入", ", ".join(creds.missing()))
            return False
        try:
            self.login(creds.fubon_id, creds.password, creds.cert_password, creds.pfx_base64)
            return True
        except Exception as e:
            log.error("自動登入富邦失敗：%s", e)
            return False

    # ------------------------------------------------------------------
    # 訊息處理（原樣沿用）
    # ------------------------------------------------------------------
    def _parse_message(self, message):
        if isinstance(message, str):
            try:
                return json.loads(message)
            except Exception:
                return {"raw_text": message}
        if isinstance(message, dict):
            return message
        return {"raw_unknown": str(message)}

    def _extract_symbol_price(self, msg):
        data = msg.get("data", {})
        if not isinstance(data, dict):
            data = {}
        symbol = data.get("symbol") or msg.get("symbol") or data.get("stockNo") or msg.get("stockNo")
        if symbol:
            symbol = symbol_to_code(symbol)
        price_candidates = [
            data.get("price"), data.get("tradePrice"), data.get("lastPrice"),
            data.get("close"), data.get("closePrice"),
            msg.get("price"), msg.get("tradePrice"), msg.get("lastPrice"),
            msg.get("close"), msg.get("closePrice"),
        ]
        price = None
        for p in price_candidates:
            if p is not None and pd.notna(p):
                try:
                    price = float(p)
                    break
                except Exception:
                    continue
        return symbol, price

    def _on_message(self, message):
        msg = self._parse_message(message)
        symbol, price = self._extract_symbol_price(msg)
        now = datetime.now(TW_TZ)
        with self.lock:
            self.last_message_at = now
            self.tick_count += 1
            if symbol:
                self.messages[symbol] = {"time": now, "raw": msg}
            if symbol and price is not None:
                self.prices[symbol] = price
                self._dirty.add(symbol)          # ← 新增：標記為待推送

        # 回呼放在鎖外面呼叫，避免上層的處理拖住 SDK 的接收執行緒
        if symbol and price is not None and self._on_tick is not None:
            try:
                self._on_tick(symbol, price)
            except Exception as e:
                log.warning("on_tick 回呼發生例外（已忽略）：%s", e)

    def _on_connect(self, *_args, **_kwargs):
        with self.lock:
            self.connected = True
            self.error = None
        log.info("富邦 WebSocket 已連線")

    def _on_disconnect(self, *_args, **_kwargs):
        with self.lock:
            self.connected = False
        log.warning("富邦 WebSocket 斷線")

    def _on_error(self, *args, **_kwargs):
        detail = args[0] if args else "unknown"
        with self.lock:
            self.connected = False
            self.error = f"WebSocket 錯誤：{detail}"
        log.error("富邦 WebSocket 錯誤：%s", detail)

    # ------------------------------------------------------------------
    # 訂閱（原樣沿用）
    # ------------------------------------------------------------------
    def subscribe(self, symbol: str) -> None:
        if not self.ws:
            return
        code = symbol_to_code(symbol)
        if not code or code in self.subscribed:
            return
        try:
            self.ws.subscribe({"channel": "trades", "symbol": code})
            with self.lock:
                self.subscribed.add(code)
                self.error = None
        except Exception as e:
            with self.lock:
                self.error = f"{code} WebSocket 訂閱失敗：{e}"
            log.warning("訂閱 %s 失敗：%s", code, e)

    def subscribe_many(self, symbols) -> None:
        for s in symbols:
            self.subscribe(s)

    # ------------------------------------------------------------------
    # 讀取
    # ------------------------------------------------------------------
    def get_price(self, symbol: str):
        code = symbol_to_code(symbol)
        with self.lock:
            return self.prices.get(code)

    def get_message(self, symbol: str):
        code = symbol_to_code(symbol)
        with self.lock:
            return copy.deepcopy(self.messages.get(code))

    def get_all_prices(self) -> dict:
        """整份快照，給前端剛連上時的第一包資料用。"""
        with self.lock:
            return dict(self.prices)

    def drain_dirty(self) -> dict:
        """
        取出「上次呼叫之後變動過的」代碼與價格，並清空標記。

        server 的廣播迴圈每 broadcast_interval_ms 呼叫一次。回傳空 dict 就代表
        這個週期沒有任何變動，不必發送——這是省瀏覽器 CPU 的關鍵。
        """
        with self.lock:
            if not self._dirty:
                return {}
            changed = {code: self.prices.get(code) for code in self._dirty}
            self._dirty.clear()
            return {k: v for k, v in changed.items() if v is not None}

    def get_status(self) -> dict:
        with self.lock:
            return {
                "logged_in": self.logged_in,
                "connected": self.connected,
                "error": self.error,
                "subscribed_count": len(self.subscribed),
                "last_message_at": self.last_message_at,
                "tick_count": self.tick_count,
                "pending_dirty": len(self._dirty),
            }

    # ------------------------------------------------------------------
    # 收尾
    # ------------------------------------------------------------------
    def _cleanup_cert(self) -> None:
        """刪掉解碼出來的暫存憑證檔。"""
        path = self.cert_path
        self.cert_path = None
        if not path:
            return
        try:
            os.unlink(path)
        except Exception:
            pass

    def close(self) -> None:
        """服務關閉時呼叫（FastAPI 的 lifespan shutdown）。"""
        try:
            if self.ws is not None:
                self.ws.disconnect()
        except Exception:
            pass
        with self.lock:
            self.ws = None
            self.sdk = None
            self.logged_in = False
            self.connected = False
        self._cleanup_cert()
        log.info("富邦連線已關閉")
