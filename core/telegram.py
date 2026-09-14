# -*- coding: utf-8 -*-
"""
core/telegram.py
================
Telegram 推播與指令輪詢。

原始碼對照：0_💻_monitor.py 行 887-933

搬家時的改動
------------
1. `st.error(...)` → `logging` + 回傳布林。core 不碰 UI。
2. `st.sidebar.info("👀 偷看到 N 則新訊息")` → `log.debug`。那是除錯訊息，
   不該出現在正式畫面上。
3. `st.session_state.tg_last_update_id` → `AppState.tg_last_update_id`

⚠️ 一個搬家後才成立的好處
-------------------------
原本推播邏輯寫在 `render_live_monitor()` 這個 Streamlit fragment 裡，等於
**頁面沒開就不會推**。搬到 FastAPI 之後，推播跑在 server 的背景排程裡，
不管有沒有人開著網頁都會推——這是這次改版的意外紅利，不是副作用。
"""
from __future__ import annotations

import logging

import requests

from core import config
from core.state import get_state

log = logging.getLogger(__name__)

__all__ = ["send_message", "poll_push_command", "telegram_configured"]

API_BASE = "https://api.telegram.org"


def telegram_configured() -> bool:
    return bool(config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID)


def send_message(text: str) -> bool:
    """
    送一則 HTML 格式的訊息。回傳是否成功。

    沒設定 token/chat_id 時安靜回 False——這不是錯誤，是使用者沒開這個功能。
    """
    if not telegram_configured():
        return False

    url = f"{API_BASE}/bot{config.TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": config.TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        res = requests.post(url, json=payload, timeout=5)
        if res.status_code != 200:
            log.error("Telegram 傳送失敗，API 回傳：%s", res.text)
            return False
        return True
    except Exception as e:
        log.error("Telegram 連線失敗：%s", e)
        return False


def poll_push_command() -> bool:
    """
    輪詢 getUpdates，看有沒有人傳 'push' 指令要求強制推播。

    回傳 True 代表收到指令。呼叫端（server 的排程）看到 True 就應該
    清空當日去重記錄並強制推一次——沿用原版行為。

    update_id 游標存在 AppState（跨請求共用），不是 per-session，
    所以不會像原本那樣每個瀏覽器分頁各自收一份。
    """
    if not config.TELEGRAM_BOT_TOKEN:
        return False

    state = get_state()
    url = f"{API_BASE}/bot{config.TELEGRAM_BOT_TOKEN}/getUpdates"
    params = {"timeout": 1}
    if state.tg_last_update_id:
        params["offset"] = state.tg_last_update_id + 1

    try:
        res = requests.get(url, params=params, timeout=3)
        if res.status_code != 200:
            return False
        data = res.json()
        if not (data.get("ok") and data.get("result")):
            return False

        log.debug("Telegram：收到 %d 則新訊息", len(data["result"]))
        triggered = False
        for item in data["result"]:
            state.tg_last_update_id = item["update_id"]
            message_text = item.get("message", {}).get("text", "").strip().lower()
            log.debug("Telegram 訊息內容：%s", message_text)
            if message_text == "push":
                triggered = True
        return triggered
    except Exception as e:
        log.debug("Telegram 輪詢失敗（已忽略）：%s", e)
        return False
