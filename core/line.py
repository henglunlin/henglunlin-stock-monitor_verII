# -*- coding: utf-8 -*-
"""
core/line.py
============
LINE Messaging API 推播。與 core/telegram.py 平行的一支 L2 能力層模組，
介面刻意做成同形（`line_configured()` / `send_text()`），讓 core/notify.py
可以用同一套寫法對待兩條管道。

為什麼是 Messaging API 而不是 LINE Notify
-----------------------------------------
LINE Notify 已於 2025-03-31 正式終止服務，權杖不再發放也不再受理推送。
所以這裡走 Messaging API 的 push endpoint：

    POST https://api.line.me/v2/bot/message/push
    Authorization: Bearer {CHANNEL_ACCESS_TOKEN}
    {"to": "<userId|groupId|roomId>", "messages": [ ... ]}

需要兩個環境變數（跟 Telegram 一致，憑證不進 runtime_settings.json）：

    LINE_CHANNEL_ACCESS_TOKEN=...   # LINE Developers → Messaging API → 長期權杖
    LINE_TO=Uxxxxxxxx...            # 你自己的 userId，或群組的 groupId

三個必須尊重的 API 硬限制
-------------------------
1. 單則 text 上限 5000 字元 —— 超過整包 400。所以這裡切 4500 留安全邊際，
   而且**切在股票邊界**，不會把一檔切成兩半。
2. 一次 push 最多 5 則 messages —— 超過就分批呼叫。
3. 免費方案每月 200 則 —— 定時推播一天 5 則、一個月約 100 則。
   所以分段是有成本的（一段算一則），這也是 notify.py 那邊要限制
   「每檔最多 N 個訊號」的真正原因。

⚠️ 這支刻意不 import core.state
-------------------------------
跟 telegram.py 不同（它為了 update_id 游標必須讀 AppState），LINE 這邊沒有
輪詢指令的需求，所以維持對狀態層零依賴：只吃 config，好單獨測試。
最後一次推播的結果記在模組層的 `_LAST`，只給 /api/debug/line 顯示用，
不參與任何判斷邏輯。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import threading
from datetime import datetime
from typing import Any

import requests

from core import config

log = logging.getLogger(__name__)

__all__ = [
    "line_configured", "send_text", "send_flex",
    "split_text", "last_status", "TEXT_LIMIT",
    "webhook_configured", "verify_signature", "extract_commands", "reply_text",
]

API_PUSH = "https://api.line.me/v2/bot/message/push"
API_REPLY = "https://api.line.me/v2/bot/message/reply"

# 單則 text 的實際上限是 5000，留 500 字安全邊際（emoji 在 LINE 這邊算 1 字元，
# 但我們的訊息含全形空白與換行，寧可保守）。
TEXT_LIMIT = 4500
# 一次 push 呼叫最多帶幾則 message（API 硬限制 5）
MAX_MESSAGES_PER_CALL = 5

_lock = threading.Lock()
_LAST: dict = {
    "at": None,          # ISO 時間字串
    "ok": None,          # True / False / None（還沒推過）
    "status": None,      # HTTP 狀態碼
    "messages": 0,       # 這次送了幾則
    "error": None,       # 失敗原因（含 LINE 回傳的 message，那是查問題唯一線索）
}


def line_configured() -> bool:
    """token 與收件對象都有才算設定完成。缺任何一個都不算，且不是錯誤。"""
    return bool(config.LINE_CHANNEL_ACCESS_TOKEN and config.LINE_TO)


def last_status() -> dict:
    """給 /api/debug/line 用。不含 token，只有結果。"""
    with _lock:
        return {
            "configured": line_configured(),
            "has_token": bool(config.LINE_CHANNEL_ACCESS_TOKEN),
            "has_target": bool(config.LINE_TO),
            # webhook 是獨立的一件事：沒設 channel secret 只是不能從 LINE 下指令，
            # 不影響推播。分開顯示才不會讓人以為推播壞了。
            "webhook_ready": webhook_configured(),
            # 只露出尾四碼，足夠確認「是不是我以為的那個對象」又不洩漏 id
            "target_tail": (config.LINE_TO or "")[-4:],
            **_LAST,
        }


def _record(ok: bool, status: int | None, messages: int, error: str | None) -> None:
    with _lock:
        _LAST.update({
            "at": datetime.now().isoformat(timespec="seconds"),
            "ok": ok,
            "status": status,
            "messages": messages,
            "error": error,
        })


def split_text(text: str, limit: int = TEXT_LIMIT) -> list[str]:
    """
    把長文字切成多段，**優先切在空行（股票與股票之間）**。

    為什麼不直接按字元數硬切：硬切會把「3661 世芯-KY」跟它的訊號文字拆到兩則
    訊息裡，第二則開頭就是一行沒頭沒尾的訊號名稱，看的人完全不知道那是哪一檔。
    這裡先按 "\\n\\n" 拆成語意區塊再重組，只有單一區塊本身就超長時才硬切。
    """
    text = text or ""
    if len(text) <= limit:
        return [text] if text else []

    blocks = text.split("\n\n")
    parts: list[str] = []
    buf = ""
    for block in blocks:
        # 單一區塊自己就超長（正常不會發生，防呆）
        if len(block) > limit:
            if buf:
                parts.append(buf)
                buf = ""
            for i in range(0, len(block), limit):
                parts.append(block[i:i + limit])
            continue
        candidate = f"{buf}\n\n{block}" if buf else block
        if len(candidate) > limit:
            parts.append(buf)
            buf = block
        else:
            buf = candidate
    if buf:
        parts.append(buf)
    return parts


def _post(messages: list[dict]) -> bool:
    """送一批 message（最多 5 則）。回傳是否成功。"""
    headers = {
        "Authorization": f"Bearer {config.LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {"to": config.LINE_TO, "messages": messages}
    try:
        res = requests.post(API_PUSH, json=payload, headers=headers, timeout=8)
    except Exception as e:
        log.error("LINE 連線失敗：%s", e)
        _record(False, None, len(messages), f"連線失敗：{e}")
        return False

    if res.status_code != 200:
        # LINE 的錯誤 body 會說明是 token 失效(401)、對象錯誤(400)還是額度用盡(429)，
        # 一定要記下來——只看狀態碼查不出來。
        body = (res.text or "")[:300]
        log.error("LINE 傳送失敗 %s：%s", res.status_code, body)
        _record(False, res.status_code, len(messages), body)
        return False

    _record(True, 200, len(messages), None)
    return True


def send_text(text: str) -> bool:
    """
    送純文字。超長自動分段並在每段開頭標「(1/2)」，分批呼叫 API。

    沒設定 token/對象時安靜回 False——這不是錯誤，是使用者沒開這個功能
    （沿用 telegram.send_message 的約定）。
    """
    if not line_configured():
        return False
    if not text:
        return False

    parts = split_text(text)
    total = len(parts)
    if total > 1:
        parts = [f"({i + 1}/{total})\n{p}" for i, p in enumerate(parts)]

    ok = True
    for i in range(0, len(parts), MAX_MESSAGES_PER_CALL):
        batch = [{"type": "text", "text": p} for p in parts[i:i + MAX_MESSAGES_PER_CALL]]
        if not _post(batch):
            ok = False
            break                   # 失敗就停，不要把額度浪費在後續段落上
    return ok


# =============================================================================
# Webhook（收 LINE 傳進來的指令）
# =============================================================================
def webhook_configured() -> bool:
    """沒有 channel secret 就沒辦法驗簽，webhook 一律拒收。"""
    return bool(config.LINE_CHANNEL_SECRET)


def verify_signature(body: bytes, signature: str) -> bool:
    """
    驗證 LINE 的 `X-Line-Signature`：base64(HMAC-SHA256(channel_secret, 原始 body))。

    ⚠️ 三個必須做對、做錯就等於沒驗的地方
    ------------------------------------
    1. **一定要用原始 bytes**。不能先 json.loads 再 dumps 回去——鍵的順序、空白、
       Unicode 跳脫任何一點不同，算出來的 HMAC 就不一樣。所以 api.py 那邊用
       `await request.body()` 拿原始 body，不用 Pydantic model 解析。
    2. **用 compare_digest 比對**，不要用 `==`。字串比對會在第一個不同的字元就
       回傳，時間差可以被用來一個字元一個字元猜出正確簽章。
    3. **密鑰沒設就回 False（fail closed）**。這是全服務唯一不需要 X-App-Token
       的寫入端點，驗簽是它唯一的門鎖；沒鎖就不要開門。
    """
    if not webhook_configured() or not signature:
        return False
    try:
        digest = hmac.new(
            config.LINE_CHANNEL_SECRET.encode("utf-8"), body, hashlib.sha256,
        ).digest()
        expected = base64.b64encode(digest).decode("utf-8")
    except Exception as e:
        log.warning("LINE 簽章計算失敗：%s", e)
        return False
    return hmac.compare_digest(expected, signature)


def extract_commands(payload: dict) -> list[tuple[str, str]]:
    """
    從 webhook 的 payload 抽出「使用者傳來的文字指令」。

    回傳 [(小寫去空白的文字, reply_token), ...]。

    LINE 會送進來各種事件（follow / unfollow / join / postback / sticker…），
    這裡只挑 `message` 且 `type == "text"` 的，其餘安靜忽略。

    ⚠️ 在 LINE Developers 按「Verify」時送進來的是一包**沒有 events 的**請求，
    所以這裡對空 payload 必須正常回空清單，不能拋例外——否則驗證會顯示失敗。
    """
    out: list[tuple[str, str]] = []
    for ev in (payload or {}).get("events") or []:
        if not isinstance(ev, dict) or ev.get("type") != "message":
            continue
        msg = ev.get("message") or {}
        if msg.get("type") != "text":
            continue
        text = str(msg.get("text", "")).strip().lower()
        if text:
            out.append((text, ev.get("replyToken") or ""))
    return out


def reply_text(reply_token: str, text: str) -> bool:
    """
    用 reply token 回一則文字。

    為什麼盡量用 reply 而不是 push：**回覆訊息不計入每月 200 則的免費額度**，
    push 才計。指令的「收到了」這種確認訊息用 reply 發，等於不花錢。

    代價是 reply token 只能用一次，而且很快就過期，所以它只適合「馬上回」的
    確認訊息；掃描結果那種要跑一下才有的內容仍然走 push。
    """
    if not reply_token or not config.LINE_CHANNEL_ACCESS_TOKEN:
        return False
    headers = {
        "Authorization": f"Bearer {config.LINE_CHANNEL_ACCESS_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {"replyToken": reply_token, "messages": [{"type": "text", "text": text[:4900]}]}
    try:
        res = requests.post(API_REPLY, json=payload, headers=headers, timeout=5)
    except Exception as e:
        log.warning("LINE 回覆失敗（已忽略）：%s", e)
        return False
    if res.status_code != 200:
        log.warning("LINE 回覆失敗 %s：%s", res.status_code, (res.text or "")[:200])
        return False
    return True


def send_flex(alt_text: str, contents: dict[str, Any]) -> bool:
    """
    送 Flex Message。

    `alt_text` 是手機鎖定畫面通知唯一會顯示的字，所以呼叫端一定要給有意義的
    一行摘要，不能只寫「通知」。Flex 的 JSON 整包上限 50KB、carousel 最多
    12 張 bubble，超量由呼叫端（notify.py）負責先砍。
    """
    if not line_configured():
        return False
    return _post([{
        "type": "flex",
        "altText": (alt_text or "訊號通知")[:400],
        "contents": contents,
    }])
