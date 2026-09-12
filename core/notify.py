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
    core/telegram.py  怎麼發 Telegram（HTML）
    core/line.py      怎麼發 LINE（純文字／Flex）
    core/notify.py    ← 這裡：發給誰、發什麼、成敗怎麼回報
    server/hub.py     只管「什麼時候該發」

職責分離的現況（依 Phase 收斂結論）
-----------------------------------
    盤中定時彙整推播  → LINE ＋ Telegram（內容一致，只換格式）
    盤中即時事件      → 只走 Telegram（維持原行為，hub._push_events）
    'push' 指令強制推 → 只回 Telegram（你在哪下指令就在哪收回覆）

⚠️ LINE 的字數是有價的
---------------------
LINE 免費方案每月 200 則，而分段是「一段算一則」。所以 LINE 那份刻意
**每檔最多只列 `line_max_signals_per_stock` 個訊號**（預設 2，取優先等級最高的
前兩個）；Telegram 不限制，仍然列完整清單當當日紀錄。這是刻意的不對稱，
不是漏改。
"""
from __future__ import annotations

import logging
from datetime import datetime

from core import line, telegram
from core.state import TW_TZ, get_state

log = logging.getLogger(__name__)

__all__ = ["push_digest", "push_test", "digest_targets", "sorted_labels"]


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
        try:
            result["telegram"] = telegram.send_message(format_telegram(entries, slot))
        except Exception as e:
            log.warning("Telegram 彙整推播失敗（已忽略）：%s", e)
            result["telegram"] = False

    if want.get("line"):
        max_sig = int(getattr(s, "line_max_signals_per_stock", 2) or 2)
        fmt = getattr(s, "line_message_format", "text")
        try:
            if fmt == "flex":
                alt = f"📈 訊號通知 {_slot_label(slot)} · {len(entries)} 檔"
                result["line"] = line.send_flex(alt, format_line_flex(entries, slot, max_sig))
            else:
                result["line"] = line.send_text(format_line_text(entries, slot, max_sig))
        except Exception as e:
            log.warning("LINE 彙整推播失敗（已忽略）：%s", e)
            result["line"] = False

    log.info(
        "彙整推播 %d 檔 · slot=%s · TG=%s · LINE=%s",
        len(entries), slot or "-", result["telegram"], result["line"],
    )
    return result


def push_test(channel: str) -> dict:
    """
    設定頁「發一則測試訊息」用。channel: "line" | "telegram"。

    刻意走與正式推播完全相同的函式（line.send_text / telegram.send_message），
    這樣測試通過就真的代表正式推播會通——不然測試就沒有意義。
    """
    stamp = datetime.now(TW_TZ).strftime("%m/%d %H:%M:%S")
    if channel == "line":
        if not line.line_configured():
            return {"ok": False, "reason": "LINE 未設定（缺 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_TO）"}
        ok = line.send_text(f"✅ 測試訊息\n\n台股監控器 LINE 推播設定正常。\n{stamp}")
        return {"ok": ok, "detail": line.last_status()}
    if channel == "telegram":
        if not telegram.telegram_configured():
            return {"ok": False, "reason": "Telegram 未設定（缺 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID）"}
        ok = telegram.send_message(f"✅ <b>測試訊息</b>\n\n台股監控器 Telegram 推播設定正常。\n{stamp}")
        return {"ok": ok}
    return {"ok": False, "reason": f"未知的管道：{channel}"}
