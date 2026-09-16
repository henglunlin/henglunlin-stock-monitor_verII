# -*- coding: utf-8 -*-
"""
core/notify.py
==============
推播分派層。**「這一則要發給誰、用什麼格式」的唯一決定點。**

為什麼要多這一支
----------------
core/events.py 的檔頭講過同一個道理：同一件事有兩條路徑自己判斷，就會出現
「一邊有一邊沒有」而且你不知道要查哪邊。推播現在有兩條管道（Telegram 與 LINE）
與兩種格式（HTML 與純文字），如果讓 server/hub.py 自己在迴圈裡寫
「if line_enabled: ... if tg_enabled: ...」，hub.py 會越來越厚，而且格式邏輯
會跟排程邏輯纏在一起。

所以分工是：
    core/telegram.py     怎麼發 Telegram（HTML）
    core/line.py         怎麼發 LINE（純文字／Flex）
    core/recipients.py   發給誰（多人名單，Telegram 個人 chat_id／LINE 建議用群組）
    core/notify.py       ← 這裡：把「怎麼發」跟「發給誰」接起來、成敗怎麼回報
    server/hub.py         只管「什麼時候該發」

職責分離的現況（2026-09-15 改成多人名單後）
--------------------------------------------
    盤中定時彙整推播  → LINE ＋ Telegram，各自依 recipients 名單裡勾了
                        `digest` 的對象逐一發送
    盤中即時事件      → 同樣依名單分派（recipients 裡勾 `intraday` 的對象），
                        預設名單裡的 LINE 對象不勾這項——見下方額度警告
    'push' 指令強制推 → 只回 .env 設定的那個 Telegram 對象（輪詢 getUpdates
                        天生只認得一條對話，不是名單機制的範圍）

⚠️ LINE 的字數與則數都是有價的
------------------------------
LINE 免費方案每月約 200 則，而且是「發給幾個獨立對象就扣幾則」——分段也是
「一段算一則」。所以 LINE 那份刻意**每檔最多只列 `line_max_signals_per_stock`
個訊號**（預設 2，取優先等級最高的前兩個）；Telegram 不限制，仍然列完整清單
當當日紀錄。這是刻意的不對稱，不是漏改。

如果 LINE 對象是「群組」而不是個人，一次推播不管群組裡幾個人通常只算 1 則
（LINE 的計費對象是 `to` 這個目標本身，不是目標裡的成員數）——這是
core/recipients.py 建議「LINE 用群組」而不是一個個朋友加的主要原因。
"""
from __future__ import annotations

import logging
from datetime import datetime

from core import config, line, recipients, telegram
from core.state import TW_TZ, get_state

log = logging.getLogger(__name__)

__all__ = [
    "push_digest", "push_text", "push_test", "push_event", "digest_targets", "sorted_labels",
]


# =============================================================================
# 排版
# =============================================================================
def sorted_labels(hits: list) -> list[str]:
    """
    把一檔的命中清單依優先等級排好，回傳 label 清單。

    ⚠️ 刻意不用 row['signal_text']：那個欄位只保留「最高優先等級的那一群」
    （見 core/signals.py 的 display_text），所以一檔同時命中「進入買入區間(1)」
    與「漲停(2)」時，signal_text 只會有前者。推播要的是完整清單，
    要砍也應該由這裡決定砍幾個，而不是被顯示邏輯順便砍掉。
    """
    if not hits:
        return []
    ordered = sorted(hits, key=lambda h: h.get("priority", 99))
    out: list[str] = []
    for h in ordered:
        label = h.get("label")
        if label and label not in out:
            kind = "買" if h.get("kind", "buy") == "buy" else "賣"
            out.append(f"{label}({kind})")
    return out


def _slot_label(slot: str | None) -> str:
    """訊息標題的時段標籤。強制推播沒有時段，就用當下時間。"""
    return slot or datetime.now(TW_TZ).strftime("%H:%M")


def format_telegram(entries: list[dict], slot: str | None) -> str:
    """Telegram：沿用原本的 HTML 排版，訊號列完整清單。"""
    lines = []
    for e in entries:
        labels = "、".join(e["labels"]) or "-"
        lines.append(
            f"<b>{e['code']} {e['name']}</b>  {e['price']}  "
            f"({e['pct']:+.2f}%)\n　{labels}"
        )
    head = f"📈 <b>訊號通知</b> · {_slot_label(slot)}"
    return head + "\n\n" + "\n\n".join(lines)


def format_line_text(entries: list[dict], slot: str | None, max_signals: int = 2) -> str:
    """
    LINE：純文字。沒有 HTML，所以層次全靠 emoji、全形空白與 ▍樣式的行首記號。

    每檔最多列 max_signals 個訊號（依優先等級），超出的用「+N」帶過——
    LINE 是手機上即時掃一眼的地方，不是完整紀錄，完整紀錄在 Telegram。
    """
    blocks = []
    for e in entries:
        labels = e["labels"][:max_signals]
        extra = len(e["labels"]) - len(labels)
        sig = "、".join(labels) if labels else "-"
        if extra > 0:
            sig += f" +{extra}"
        blocks.append(
            f"▍{e['code']} {e['name']}\n"
            f"　{e['price']:.2f}　{e['pct']:+.2f}%\n"
            f"　{sig}"
        )
    head = f"📈 訊號通知 · {_slot_label(slot)}"
    tail = f"— 共 {len(entries)} 檔 · {datetime.now(TW_TZ):%m/%d %H:%M}"
    return head + "\n\n" + "\n\n".join(blocks) + "\n\n" + tail


# Flex 的 body 區塊數量有上限，而且 JSON 整包 50KB。40 檔以內一張 bubble 放得下，
# 超過就截斷並在最後一列標明——切 carousel 的複雜度不值得為這個情境付。
FLEX_MAX_ROWS = 40


def format_line_flex(entries: list[dict], slot: str | None, max_signals: int = 2) -> dict:
    """
    LINE：Flex 卡片。回傳 `contents`（bubble），altText 由呼叫端另外組。

    這是設定頁 `line_message_format = "flex"` 時才走的路徑，預設不走。
    """
    shown = entries[:FLEX_MAX_ROWS]
    rows = []
    for e in shown:
        labels = e["labels"][:max_signals]
        extra = len(e["labels"]) - len(labels)
        sig = "、".join(labels) if labels else "-"
        if extra > 0:
            sig += f" +{extra}"
        up = (e["pct"] or 0) >= 0
        rows.append({
            "type": "box", "layout": "vertical", "spacing": "xs", "margin": "md",
            "contents": [
                {
                    "type": "box", "layout": "horizontal",
                    "contents": [
                        {"type": "text", "text": f"{e['code']} {e['name']}",
                         "size": "sm", "weight": "bold", "color": "#13171C", "flex": 5},
                        {"type": "text", "text": f"{e['price']:.2f}　{e['pct']:+.2f}%",
                         "size": "sm", "align": "end", "flex": 4,
                         # 台股習慣：漲紅跌綠
                         "color": "#C1272D" if up else "#137A5E"},
                    ],
                },
                {"type": "text", "text": sig, "size": "xs", "color": "#77818F", "wrap": True},
            ],
        })

    if len(entries) > len(shown):
        rows.append({
            "type": "text", "margin": "md", "size": "xs", "color": "#77818F",
            "text": f"…另有 {len(entries) - len(shown)} 檔，請看網頁",
        })

    return {
        "type": "bubble", "size": "mega",
        "header": {
            "type": "box", "layout": "vertical", "backgroundColor": "#1B4F79",
            "paddingAll": "12px",
            "contents": [{
                "type": "text", "color": "#FFFFFF", "weight": "bold", "size": "sm",
                "text": f"📈 訊號通知 · {_slot_label(slot)}　{len(entries)} 檔",
            }],
        },
        "body": {"type": "box", "layout": "vertical", "spacing": "none", "contents": rows},
    }


# =============================================================================
# 分派
# =============================================================================
def digest_targets() -> dict:
    """
    現在定時彙整會送到哪些管道。設定頁與 /api/debug/line 顯示用，
    也是 hub 判斷「兩條管道都關了就不用算」的依據。

    Toolbar 的兩顆總開關（tg_push_enabled / line_push_enabled）是上層閘門，
    設定頁的 digest_to_* 勾選是下層閘門，兩層都要開才會發。
    """
    s = get_state().settings
    return {
        "telegram": bool(
            getattr(s, "tg_push_enabled", True)
            and getattr(s, "digest_to_telegram", True)
            and telegram.telegram_configured()
        ),
        "line": bool(
            getattr(s, "line_push_enabled", True)
            and getattr(s, "digest_to_line", True)
            and line.line_configured()
        ),
    }


def push_digest(
    entries: list[dict],
    slot: str | None = None,
    *,
    channels: dict | None = None,
) -> dict:
    """
    發一則定時彙整推播。

    entries: [{"code","name","price","pct","labels":[str, ...]}, ...]
             已經去重、已經排序好的清單。這支不做篩選——篩什麼是 hub 的事。
    slot:    時段標籤（"11:00"）。None 代表不是排程觸發的。
    channels: 覆寫要發的管道，例如強制推播只給 {"telegram": True, "line": False}。
             不給就照 digest_targets()。

    回傳 {"telegram": bool|None, "line": bool|None, "count": n}
    （None = 這次沒有要發這條管道）。任一條失敗不影響另一條。
    """
    if not entries:
        return {"telegram": None, "line": None, "count": 0}

    s = get_state().settings
    want = channels if channels is not None else digest_targets()
    result: dict = {"telegram": None, "line": None, "count": len(entries)}

    if want.get("telegram"):
        text = format_telegram(entries, slot)
        targets = recipients.telegram_targets("digest")
        oks = []
        for chat_id in targets:
            try:
                oks.append(telegram.send_message(text, chat_id=chat_id))
            except Exception as e:
                log.warning("Telegram 彙整推播失敗（已忽略，chat_id=%s）：%s", chat_id, e)
                oks.append(False)
        # 名單是空的（沒人勾這個類別）不算失敗，只是沒有人要收——回 None 比回 False
        # 更準確，False 會讓設定頁誤以為推播壞了。
        result["telegram"] = (all(oks) if oks else None)

    if want.get("line"):
        max_sig = int(getattr(s, "line_max_signals_per_stock", 2) or 2)
        fmt = getattr(s, "line_message_format", "text")
        targets = recipients.line_targets("digest")
        oks = []
        for target_id in targets:
            try:
                if fmt == "flex":
                    alt = f"📈 訊號通知 {_slot_label(slot)} · {len(entries)} 檔"
                    oks.append(line.send_flex(alt, format_line_flex(entries, slot, max_sig), to=target_id))
                else:
                    oks.append(line.send_text(format_line_text(entries, slot, max_sig), to=target_id))
            except Exception as e:
                log.warning("LINE 彙整推播失敗（已忽略，target=%s）：%s", target_id, e)
                oks.append(False)
        result["line"] = (all(oks) if oks else None)

    log.info(
        "彙整推播 %d 檔 · slot=%s · TG=%s(%d 人) · LINE=%s(%d 個對象)",
        len(entries), slot or "-",
        result["telegram"], len(recipients.telegram_targets("digest")) if want.get("telegram") else 0,
        result["line"], len(recipients.line_targets("digest")) if want.get("line") else 0,
    )
    return result


def push_text(text: str, *, channels: dict | None = None) -> dict:
    """
    發一則純通知（不是彙整）。給「掃完沒有命中」這種狀態訊息用。

    存在的理由：原本 `_push_signals` 遇到空清單是直接 return，什麼都不發。
    排程觸發時那樣是對的（沒訊號本來就不該吵你），但**手動下指令時那樣很糟**——
    你分不出來是「跑完沒東西」還是「根本沒跑」。盤後測試幾乎一定是空的，
    所以手動觸發一定要有回音。

    Telegram 吃 HTML，LINE 吃純文字，所以這裡讓呼叫端給同一段純文字，
    Telegram 那份自己包一層 <b>。
    """
    want = channels if channels is not None else digest_targets()
    result: dict = {"telegram": None, "line": None}
    if want.get("telegram"):
        oks = []
        for chat_id in recipients.telegram_targets("digest"):
            try:
                oks.append(telegram.send_message(f"<b>{text}</b>", chat_id=chat_id))
            except Exception as e:
                log.warning("Telegram 通知失敗（已忽略，chat_id=%s）：%s", chat_id, e)
                oks.append(False)
        result["telegram"] = (all(oks) if oks else None)
    if want.get("line"):
        oks = []
        for target_id in recipients.line_targets("digest"):
            try:
                oks.append(line.send_text(text, to=target_id))
            except Exception as e:
                log.warning("LINE 通知失敗（已忽略，target=%s）：%s", target_id, e)
                oks.append(False)
        result["line"] = (all(oks) if oks else None)
    return result


def push_event(html_text: str, plain_text: str) -> dict:
    """
    推一則盤中即時事件給名單裡勾了「盤中即時訊號」的對象。

    為什麼要兩份文字：Telegram 吃 HTML（`<b>` 這種標籤），LINE 是純文字，
    呼叫端（server/hub.py）已經各自組好，這裡只負責照名單分派，不做格式轉換。

    ⚠️ LINE 這邊刻意保留開關，但要記得提醒使用者額度成本
    -----------------------------------------------------
    盤中即時事件觸發頻率遠高於定時彙整（193 檔配 1 秒偵測線），LINE 免費方案
    每月只有約 200 則。如果名單裡有 LINE 對象勾了「盤中即時訊號」，很容易一個
    上午就把月額度燒完，導致定時彙整那邊也發不出去。設定頁「推播名單」在
    LINE 那欄勾即時訊號時要顯示這個警告，但這裡的程式邏輯本身不擋——
    要不要冒這個風險是使用者自己的選擇。
    """
    result: dict = {"telegram": [], "line": []}
    state = get_state()
    if state.settings.tg_push_enabled and telegram.telegram_configured():
        for chat_id in recipients.telegram_targets("intraday"):
            try:
                ok = telegram.send_message(html_text, chat_id=chat_id)
            except Exception as e:
                log.warning("Telegram 即時事件推播失敗（已忽略，chat_id=%s）：%s", chat_id, e)
                ok = False
            result["telegram"].append({"chat_id": chat_id, "ok": ok})
    if state.settings.line_push_enabled and line.line_configured():
        for target_id in recipients.line_targets("intraday"):
            try:
                ok = line.send_text(plain_text, to=target_id)
            except Exception as e:
                log.warning("LINE 即時事件推播失敗（已忽略，target=%s）：%s", target_id, e)
                ok = False
            result["line"].append({"target_id": target_id, "ok": ok})
    return result


def push_test(channel: str) -> dict:
    """
    設定頁「發一則測試訊息」用。channel: "line" | "telegram"。

    測的是 `.env` 那組預設對象（`LINE_TO` / `TELEGRAM_CHAT_ID`）能不能通，
    不是名單裡每一筆——名單可能有好幾筆，每按一次測試就全部發一輪既吵
    又浪費 LINE 的月額度。想確認名單裡某一筆特定對象收不收得到，用
    「彙整推播」或「即時事件」實際跑一次最準。

    刻意走與正式推播完全相同的函式（line.send_text / telegram.send_message），
    這樣測試通過就真的代表這組憑證會通——不然測試就沒有意義。
    """
    stamp = datetime.now(TW_TZ).strftime("%m/%d %H:%M:%S")
    if channel == "line":
        if not line.line_configured():
            return {"ok": False, "reason": "LINE 未設定（缺 LINE_CHANNEL_ACCESS_TOKEN）"}
        if not config.LINE_TO:
            return {"ok": False, "reason": ".env 沒有設定 LINE_TO，無法測試預設對象（名單裡的其他對象仍可正常推播）"}
        ok = line.send_text(f"✅ 測試訊息\n\n台股監控器 LINE 推播設定正常。\n{stamp}")
        return {"ok": ok, "detail": line.last_status()}
    if channel == "telegram":
        if not telegram.telegram_configured():
            return {"ok": False, "reason": "Telegram 未設定（缺 TELEGRAM_BOT_TOKEN）"}
        if not config.TELEGRAM_CHAT_ID:
            return {"ok": False, "reason": ".env 沒有設定 TELEGRAM_CHAT_ID，無法測試預設對象（名單裡的其他對象仍可正常推播）"}
        ok = telegram.send_message(f"✅ <b>測試訊息</b>\n\n台股監控器 Telegram 推播設定正常。\n{stamp}")
        return {"ok": ok}
    return {"ok": False, "reason": f"未知的管道：{channel}"}
