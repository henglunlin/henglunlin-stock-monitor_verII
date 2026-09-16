# -*- coding: utf-8 -*-
"""
core/recipients.py
===================
多人推播名單。取代「Telegram/LINE 各自只能推給 .env 裡寫死那一個對象」的舊行為。

為什麼要多這一支，不直接塞進 core/state.py 的 Settings
--------------------------------------------------------
Settings 是「怎麼推」（時段、格式、門檻……），這裡是「推給誰」——兩件事變動頻率
不一樣：Settings 你自己調，這份名單以後可能要讓別人（其他管理者）改，所以獨立
一個檔案、獨立一把 PIN 保護，不想被「改設定」的權限模型綁在一起。

Telegram vs LINE 的名單長得不一樣，是刻意的
--------------------------------------------
Telegram 一個 Bot 天生就能對任何跟它講過話的人各別推播（同一組 BOT_TOKEN，
不同 chat_id），所以 Telegram 這邊就是一份「個人 chat_id 名單」。

LINE 免費方案每月只有約 200 則額度，且算法是「發給幾個獨立對象就扣幾則」——
對 5 個人 multicast 一次等於扣 5 則。但推到一個「群組」的 groupId，不管群組裡
有幾個人，只算 1 則。所以 LINE 這邊建議用「群組」而不是一個個朋友加：想收通知
的人自己加進對應群組，比自己維護好友清單省額度、也不用寫「自動記錄新好友」
那段程式。`kind` 欄位只是拿來在畫面上標示這筆是「個人」還是「群組」，push API
呼叫方式完全一樣（LINE 的 `to` 不分對象類型）。

跟 .env 的關係（相容舊行為）
----------------------------
`.env` 裡的 `TELEGRAM_CHAT_ID` / `LINE_TO` 是「機器人的預設收件對象」。這份名單
檔案第一次不存在時，會自動各自轉成一筆「預設（.env）」的名單項目，讓沒設定過
名單的人行為完全不變（LINE 那筆預設不勾「盤中即時訊號」，沿用原本「LINE 只發
定時彙整」的設計）。名單檔案一旦存在，往後改動都在這份檔案裡，不會再看 .env。

PIN 保護
--------
名單本身任何看得到設定頁的人都能看，但新增/刪除/修改要先給對 PIN。PIN 用
sha256 存 hash，不存明碼。還沒設定過 PIN 時（`pin_hash` 是 None）視同不需要
驗證——這是為了讓你自己第一次使用時不用先手動生一把 PIN 才能開始加名單；
想鎖起來的話呼叫 `set_pin()` 設一把即可，之後所有寫入都會要求這把 PIN。
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from pathlib import Path

from core import config

log = logging.getLogger(__name__)

__all__ = [
    "load", "list_telegram", "list_line",
    "telegram_targets", "line_targets",
    "has_pin", "set_pin", "verify_pin",
    "add_telegram", "update_telegram", "delete_telegram",
    "add_line", "update_line", "delete_line",
]

_PATH = Path(config.REPO_ROOT) / "push_recipients.json"
_lock = threading.RLock()
_cache: dict | None = None

_TELEGRAM_FIELDS = ("label", "chat_id", "intraday", "digest", "enabled")
_LINE_FIELDS = ("label", "target_id", "kind", "intraday", "digest", "enabled")


def _hash_pin(pin: str) -> str:
    # 加一段固定 salt，單純是不想讓人拿這個 hash 直接去查彩虹表——不是要做成
    # 銀行等級的密碼系統，PIN 本來就只是「擋掉不知情的人手滑亂改」這個等級的門鎖。
    return hashlib.sha256(f"verii-push-recipients:{pin}".encode("utf-8")).hexdigest()


def _bootstrap() -> dict:
    data: dict = {"pin_hash": None, "telegram": [], "line": []}
    if config.TELEGRAM_CHAT_ID:
        data["telegram"].append({
            "id": uuid.uuid4().hex[:8],
            "label": "預設（.env）",
            "chat_id": config.TELEGRAM_CHAT_ID,
            "intraday": True,
            "digest": True,
            "enabled": True,
        })
    if config.LINE_TO:
        data["line"].append({
            "id": uuid.uuid4().hex[:8],
            "label": "預設（.env）",
            "target_id": config.LINE_TO,
            "kind": "user",
            # 沿用原本「LINE 只發定時彙整、即時事件只走 Telegram」的預設行為，
            # 不要因為搬進名單檔就悄悄多發一種訊息給既有使用者。
            "intraday": False,
            "digest": True,
            "enabled": True,
        })
    return data


def _load_locked() -> dict:
    global _cache
    if _cache is not None:
        return _cache
    if _PATH.exists():
        try:
            _cache = json.loads(_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            log.error("push_recipients.json 讀取失敗，暫時改用空白名單（不會覆寫檔案）：%s", e)
            _cache = {"pin_hash": None, "telegram": [], "line": []}
            return _cache
    else:
        _cache = _bootstrap()
        _write_locked()
    _cache.setdefault("pin_hash", None)
    _cache.setdefault("telegram", [])
    _cache.setdefault("line", [])
    return _cache


def _write_locked() -> None:
    _PATH.write_text(
        json.dumps(_cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )


def load() -> dict:
    """回傳整份名單（含 pin_hash）。呼叫端自己決定要不要把 pin_hash 濾掉再往外送。"""
    with _lock:
        return _load_locked()


def list_telegram() -> list[dict]:
    with _lock:
        return list(_load_locked()["telegram"])


def list_line() -> list[dict]:
    with _lock:
        return list(_load_locked()["line"])


def telegram_targets(kind: str) -> list[str]:
    """kind: 'intraday' 或 'digest'。回傳啟用中、且該類別打勾的 chat_id 清單。"""
    with _lock:
        return [r["chat_id"] for r in _load_locked()["telegram"] if r.get("enabled", True) and r.get(kind)]


def line_targets(kind: str) -> list[str]:
    with _lock:
        return [r["target_id"] for r in _load_locked()["line"] if r.get("enabled", True) and r.get(kind)]


def has_pin() -> bool:
    with _lock:
        return bool(_load_locked().get("pin_hash"))


def verify_pin(pin: str | None) -> bool:
    with _lock:
        d = _load_locked()
        if not d.get("pin_hash"):
            return True  # 還沒設定過 PIN，第一次使用不擋
        return bool(pin) and d["pin_hash"] == _hash_pin(pin)


def set_pin(new_pin: str | None, old_pin: str | None = None) -> bool:
    """設定/變更/清除 PIN（new_pin 給 None 或空字串等於解除保護）。
    已經有 PIN 的話要先給對舊的 PIN 才能改。"""
    with _lock:
        d = _load_locked()
        if d.get("pin_hash") and not verify_pin(old_pin):
            return False
        d["pin_hash"] = _hash_pin(new_pin) if new_pin else None
        _write_locked()
        return True


def _require_pin(pin: str | None) -> None:
    if not verify_pin(pin):
        raise PermissionError("PIN 不正確")


def add_telegram(label: str, chat_id: str, intraday: bool, digest: bool, pin: str | None) -> dict:
    with _lock:
        _require_pin(pin)
        d = _load_locked()
        row = {
            "id": uuid.uuid4().hex[:8], "label": label, "chat_id": chat_id,
            "intraday": bool(intraday), "digest": bool(digest), "enabled": True,
        }
        d["telegram"].append(row)
        _write_locked()
        return row


def update_telegram(row_id: str, patch: dict, pin: str | None) -> bool:
    with _lock:
        _require_pin(pin)
        d = _load_locked()
        for r in d["telegram"]:
            if r["id"] == row_id:
                r.update({k: v for k, v in patch.items() if k in _TELEGRAM_FIELDS})
                _write_locked()
                return True
        return False


def delete_telegram(row_id: str, pin: str | None) -> bool:
    with _lock:
        _require_pin(pin)
        d = _load_locked()
        before = len(d["telegram"])
        d["telegram"] = [r for r in d["telegram"] if r["id"] != row_id]
        if len(d["telegram"]) != before:
            _write_locked()
            return True
        return False


def add_line(label: str, target_id: str, kind: str, intraday: bool, digest: bool, pin: str | None) -> dict:
    with _lock:
        _require_pin(pin)
        d = _load_locked()
        row = {
            "id": uuid.uuid4().hex[:8], "label": label, "target_id": target_id,
            "kind": kind if kind in ("user", "group", "room") else "group",
            "intraday": bool(intraday), "digest": bool(digest), "enabled": True,
        }
        d["line"].append(row)
        _write_locked()
        return row


def update_line(row_id: str, patch: dict, pin: str | None) -> bool:
    with _lock:
        _require_pin(pin)
        d = _load_locked()
        for r in d["line"]:
            if r["id"] == row_id:
                r.update({k: v for k, v in patch.items() if k in _LINE_FIELDS})
                _write_locked()
                return True
        return False


def delete_line(row_id: str, pin: str | None) -> bool:
    with _lock:
        _require_pin(pin)
        d = _load_locked()
        before = len(d["line"])
        d["line"] = [r for r in d["line"] if r["id"] != row_id]
        if len(d["line"]) != before:
            _write_locked()
            return True
        return False
