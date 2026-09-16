"""
修掉 fugle-marketdata 2.4.x 的 `WebSocketClient.connect()`。

⚠️ 為什麼一定要修（這就是「雲端會不定時斷線、本機不會」的真正原因）
====================================================================
套件原始碼（fugle_marketdata/websocket/client.py）長這樣：

    def connect(self):
        Thread(target=self.__ws.run_forever).start()
        while True:
            if self.auth_status in [AUTHENTICATED, UNAUTHENTICATED]:
                break
        ...

`auth_status` 只有兩個地方會離開 PENDING：

  1. `__authenticate()` —— 由 **connect 事件** 觸發，也就是 TCP 要先接得起來
  2. `check_auth_status()` —— 由 `__authenticate()` 自己起的 5 秒 Timer 觸發

所以 **TCP 連不上的時候，兩個都不會發生**，`auth_status` 永遠是 PENDING，
那個 `while True` 沒有 sleep、沒有逾時、沒有離開條件 —— 它會用 100% 的
CPU 空轉到行程結束。實測（見 scripts/selftest.py 第 9 節）：

    connect() 是否返回： 否 —— 仍在跑
    3 秒內燒掉的 CPU： 3.01 秒（牆鐘 3.0 秒）

在你自己的電腦上這幾乎不會發生，因為到富邦的路徑短又穩，TCP 一次就接上；
就算真的空轉，你有 8 顆核心，一顆被吃掉你不會發現。

Render 免費方案只有 **0.1 CPU**。一條執行緒空轉就等於超用配額 10 倍，
平台會直接把整個行程重罰式限速，於是：

    行情執行緒拿不到 CPU → 收不到 tick → 看門狗判定「連線異常」→
    呼叫重連 → 重連又卡在同一個空轉迴圈 → 再多一條 100% 的執行緒 →
    整個行程更慢 → 永遠回不來

也就是說，**看門狗本身會把「短暫抖一下」放大成「整天回不來」**。
這是我上一版沒看出來的坑，抱歉。

修法
----
把 `connect()` 換成同樣語意、但

  * 迴圈會 sleep（不搶 GIL、不燒 CPU）
  * 有硬逾時（預設 20 秒），逾時就關掉 socket 並拋例外，讓上層知道要重試
  * `run_forever` 起在 **daemon** 執行緒（原本不是，會卡住行程關閉）
  * `run_forever` 帶 `ping_interval`，讓 socket 層也有 keepalive

保守起見：套件內部結構跟預期不符時就**不套用**，維持原行為並記一行 log，
不會因為套件升版改名就讓整個服務起不來。

關於 ping_timeout
-----------------
預設**只送 ping、不強制要求 pong**（ping_timeout=None）。若富邦的閘道不回
protocol-level 的 pong，強制要求會把好好的連線砍掉，比不修還糟。對方真的
掛掉的偵測交給 fubon_neo 已經開好的應用層 health check
（adapter.py: ping_interval=30s、max_missed_pongs=2）。
真的想要嚴格模式，設定裡把 fubon_ws_ping_timeout_sec 調成非 0 即可。
"""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)

_applied = False
_original_connect = None

# 這兩個值由 core/fubon.py 在套用時依設定覆寫
PING_INTERVAL_SEC: float = 20.0
PING_TIMEOUT_SEC: float | None = None
CONNECT_TIMEOUT_SEC: float = 20.0


class FugleConnectTimeout(TimeoutError):
    """connect() 在期限內沒有完成認證。"""


def _patched_connect(self) -> None:
    ws_app = getattr(self, "_WebSocketClient__ws", None)
    if ws_app is None:                       # 結構不符，退回原版
        return _original_connect(self)

    from fugle_marketdata.websocket.client import AuthenticationState as A

    kwargs: dict = {}
    if PING_INTERVAL_SEC and PING_INTERVAL_SEC > 0:
        kwargs["ping_interval"] = PING_INTERVAL_SEC
        if PING_TIMEOUT_SEC and PING_TIMEOUT_SEC > 0:
            kwargs["ping_timeout"] = PING_TIMEOUT_SEC

    threading.Thread(
        target=ws_app.run_forever,
        kwargs=kwargs,
        name="fugle-ws-recv",
        daemon=True,                          # 原版不是 daemon，會卡住行程關閉
    ).start()

    deadline = time.monotonic() + CONNECT_TIMEOUT_SEC
    done = False
    while time.monotonic() < deadline:
        if self.auth_status in (A.AUTHENTICATED, A.UNAUTHENTICATED):
            done = True
            break
        time.sleep(0.05)                      # ← 原版沒有這行，就是它在燒 CPU

    if not done:
        # 逾時：把 socket 跟 timer 收乾淨，別留下背景執行緒繼續跑
        try:
            ws_app.close()
        except Exception:
            pass
        timer = getattr(self, "auth_timer", None)
        if timer is not None:
            try:
                timer.cancel()
            except Exception:
                pass
            self.auth_timer = None
        raise FugleConnectTimeout(
            f"富邦行情 WebSocket 在 {CONNECT_TIMEOUT_SEC:.0f} 秒內沒有完成認證"
            "（多半是連不上或認證沒回應）"
        )

    # 以下維持原版語意
    if self.error is not None:
        try:
            ws_app.close()
        except Exception:
            pass
        if self.auth_timer is not None:
            self.auth_timer.cancel()
        raise self.error


def apply(
    *,
    ping_interval_sec: float = 20.0,
    ping_timeout_sec: float | None = None,
    connect_timeout_sec: float = 20.0,
) -> bool:
    """
    套用修補。回傳 True 表示有套上。可重複呼叫（只會真的套一次，但參數會更新）。
    """
    global _applied, _original_connect
    global PING_INTERVAL_SEC, PING_TIMEOUT_SEC, CONNECT_TIMEOUT_SEC

    PING_INTERVAL_SEC = float(ping_interval_sec or 0)
    PING_TIMEOUT_SEC = float(ping_timeout_sec) if ping_timeout_sec else None
    CONNECT_TIMEOUT_SEC = float(connect_timeout_sec or 20.0)

    if _applied:
        return True

    try:
        from fugle_marketdata.websocket.client import (
            AuthenticationState,
            WebSocketClient,
        )
    except Exception as e:                    # 套件不在（本機沒裝行情套件時）
        log.info("略過 fugle connect() 修補：%s", e)
        return False

    # 結構檢查：確認我們認得這個版本，不認得就不要亂動
    needed = ("AUTHENTICATED", "UNAUTHENTICATED")
    if not all(hasattr(AuthenticationState, n) for n in needed) or not hasattr(
        WebSocketClient, "connect"
    ):
        log.warning("fugle-marketdata 結構與預期不符，維持原本的 connect()")
        return False

    _original_connect = WebSocketClient.connect
    WebSocketClient.connect = _patched_connect
    _applied = True
    log.info(
        "已修補 fugle connect()：逾時 %.0fs、ping %.0fs、ping_timeout %s",
        CONNECT_TIMEOUT_SEC,
        PING_INTERVAL_SEC,
        f"{PING_TIMEOUT_SEC:.0f}s" if PING_TIMEOUT_SEC else "關閉",
    )
    return True
