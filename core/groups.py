# -*- coding: utf-8 -*-
"""
core/groups.py
==============
股票分組（stock_groups.json）的讀寫、備份與 GitHub 同步。

原始碼對照：0_💻_monitor.py 行 731-886

搬家時的改動
------------
1. `st.sidebar.warning/success` 等 UI 訊息 → **改成回傳結果物件**。
   原本這些函式直接把成功／失敗畫到側邊欄，現在它們回傳 `SyncResult`，
   由 API 層決定要怎麼呈現給前端。這是「core 不碰 UI」的必要條件。
2. `st.session_state["sync_groups_to_github"]` → `AppState.settings.sync_groups_to_github`
3. 檔案路徑改用 core.config 的絕對路徑

⚠️ Render 免費方案沒有持久磁碟
------------------------------
`save_groups()` 寫入的本機 stock_groups.json **重新部署就會回到 repo 裡的版本**。
所以在 Render 上，「同步到 GitHub」不是可選功能，而是**唯一真正持久的存檔方式**。
API 層應該把 sync_groups_to_github 預設打開，並在同步失敗時明確告訴前端。
"""
from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime

import requests

from core import config
from core.state import TW_TZ, get_state
from core.symbols import normalize_symbols_from_text

log = logging.getLogger(__name__)

BACKUP_DIR = str(config.REPO_ROOT / "backups")

DEFAULT_STOCK_GROUPS = {
    "權值股": [
        "2330.TW", "00981A.TW", "2449.TW", "2317.TW", "3711.TW",
        "6488.TWO", "2327.TW", "6176.TW", "2303.TW", "5347.TWO",
    ],
    "自選股1": [
        "3008.TW", "3035.TW", "4566.TW", "4956.TW", "6456.TW",
        "4749.TWO", "6271.TW", "6290.TWO", "4919.TW",
    ],
    "低軌衛星": ["6285.TW", "2313.TW"],
    "ABF": ["4958.TW", "3037.TW", "8046.TW", "3189.TW", "8996.TW", "5439.TWO", "8358.TWO"],
    "記憶體": ["6770.TW", "2408.TW", "2344.TW", "8271.TW", "4967.TW", "3260.TWO", "2451.TW"],
    "CCL": ["2383.TW", "6274.TWO", "6213.TW", "8039.TW"],
    "CPO": ["4979.TWO", "3163.TWO", "4977.TW", "3081.TWO", "3450.TW", "6442.TW"],
}

__all__ = [
    "DEFAULT_STOCK_GROUPS", "SyncResult",
    "load_groups", "save_groups", "persist_groups",
    "validate_and_normalize_group_json", "fetch_groups_from_github",
    "upload_file_to_repo", "upload_groups_to_github",
    "save_backup_snapshot", "list_backup_files",
]


@dataclass
class SyncResult:
    """取代原本直接寫進側邊欄的成功／警告訊息。"""
    saved_local: bool = False
    pushed_self: bool = False
    pushed_scanner: bool = False
    attempted_push: bool = False
    message: str = ""

    @property
    def ok(self) -> bool:
        # 「本 repo 成功就算整體成功」——沿用原版判定
        return self.saved_local and (not self.attempted_push or self.pushed_self)


# =============================================================================
# 驗證
# =============================================================================
def validate_and_normalize_group_json(data) -> dict:
    if not isinstance(data, dict) or not data:
        raise ValueError("JSON 格式錯誤：最外層必須是非空物件（dict）")
    validated = {}
    for group_name, symbols in data.items():
        group_name = str(group_name).strip()
        if not group_name:
            raise ValueError("JSON 格式錯誤：分類名稱不可為空")
        if isinstance(symbols, list):
            raw_text = "\n".join(str(x) for x in symbols)
        elif isinstance(symbols, str):
            raw_text = symbols
        else:
            raise ValueError(f"JSON 格式錯誤：分類「{group_name}」的股票清單必須是 list 或 string")
        validated[group_name] = normalize_symbols_from_text(raw_text)
    if not validated:
        raise ValueError("JSON 內容為空")
    return validated


# =============================================================================
# 本機讀寫
# =============================================================================
def load_groups() -> dict:
    """讀本機 stock_groups.json，讀不到就回預設分組。"""
    path = config.GROUPS_FILE
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return validate_and_normalize_group_json(json.load(f))
        except Exception as e:
            log.warning("讀取 %s 失敗，改用預設分組：%s", path, e)
    return json.loads(json.dumps(DEFAULT_STOCK_GROUPS))  # deep copy


def save_groups(groups: dict) -> bool:
    try:
        with open(config.GROUPS_FILE, "w", encoding="utf-8") as f:
            json.dump(groups, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        log.warning("寫入 %s 失敗（Render 免費方案無持久磁碟屬正常）：%s", config.GROUPS_FILE, e)
        return False


def _ensure_backup_dir() -> None:
    os.makedirs(BACKUP_DIR, exist_ok=True)


def save_backup_snapshot(groups: dict) -> str:
    _ensure_backup_dir()
    filename = f"stock_groups_{datetime.now(TW_TZ).strftime('%Y%m%d_%H%M%S')}.json"
    file_path = os.path.join(BACKUP_DIR, filename)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(groups, f, ensure_ascii=False, indent=2)
    return file_path


def list_backup_files() -> list:
    if not os.path.exists(BACKUP_DIR):
        return []
    files = []
    for name in os.listdir(BACKUP_DIR):
        if name.lower().endswith(".json"):
            full_path = os.path.join(BACKUP_DIR, name)
            if os.path.isfile(full_path):
                files.append((name, os.path.getmtime(full_path)))
    files.sort(key=lambda x: x[1], reverse=True)
    return [name for name, _ in files]


# =============================================================================
# GitHub
# =============================================================================
def fetch_groups_from_github() -> dict:
    """
    從 raw.githubusercontent.com 讀最新版 stock_groups.json（公開 repo 免 token）。
    失敗會拋例外，由呼叫端處理。
    """
    cfg = config.github_repo_config()
    url = (
        f"https://raw.githubusercontent.com/{cfg['owner']}/{cfg['repo']}"
        f"/{cfg['branch']}/stock_groups.json"
    )
    res = requests.get(url, timeout=15)
    res.raise_for_status()
    return validate_and_normalize_group_json(res.json())


def upload_file_to_repo(file_bytes: bytes, github_path: str, commit_message: str, repo_cfg: dict) -> bool:
    """透過 GitHub Contents API 建立／更新一個檔案。"""
    token, owner, repo, branch = (
        repo_cfg["token"], repo_cfg["owner"], repo_cfg["repo"], repo_cfg["branch"]
    )
    if not token or not owner or not repo:
        return False

    github_path = github_path.strip("/")
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{github_path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    sha = None
    try:
        get_res = requests.get(url, headers=headers, params={"ref": branch}, timeout=15)
        if get_res.status_code == 200:
            sha = get_res.json().get("sha")

        payload = {
            "message": commit_message,
            "content": base64.b64encode(file_bytes).decode("utf-8"),
            "branch": branch,
        }
        if sha:
            payload["sha"] = sha

        put_res = requests.put(url, headers=headers, json=payload, timeout=30)
        return put_res.status_code in (200, 201)
    except Exception as e:
        log.warning("推送 %s 到 %s/%s 失敗：%s", github_path, owner, repo, e)
        return False


def upload_groups_to_github(
    groups: dict,
    commit_message: str = "Update stock_groups.json via monitor app",
) -> tuple:
    """
    同時推到兩個 repo：
      1. 本 repo（henglunlin-stock-monitor-FUBAN）
      2. 掃描器 repo（stock-scanner-FUBAN），讓 precompute_trendlines.py 的
         每日排程讀到一致的分組

    回傳 (ok_self, ok_scanner)。只要本 repo 成功就視為整體成功——
    掃描器那邊失敗只是警告，不擋存檔流程（沿用原版行為）。
    """
    content = json.dumps(groups, ensure_ascii=False, indent=2).encode("utf-8")
    ok_self = upload_file_to_repo(
        content, "stock_groups.json", commit_message, config.github_repo_config()
    )
    ok_scanner = upload_file_to_repo(
        content, "stock_groups.json", commit_message, config.scanner_repo_config()
    )
    return ok_self, ok_scanner


def persist_groups(groups: dict) -> SyncResult:
    """
    分組存檔的統一入口：先存本機，再依設定決定要不要推 GitHub。

    ⚠️ 搬家改動點：原本靠 st.sidebar 顯示結果，現在回傳 SyncResult 讓 API 層決定
    怎麼呈現。訊息文字保留跟原版一致，前端可以直接顯示。
    """
    result = SyncResult()
    result.saved_local = save_groups(groups)

    state = get_state()
    state.stock_groups = groups

    if not state.settings.sync_groups_to_github:
        result.message = "已存檔（未啟用 GitHub 同步）" if result.saved_local else "本機存檔失敗"
        return result

    # GitHub 同步現在預設是開的，但沒有 token 就同步不了。
    # 與其每次存檔都拋一次「同步失敗」的紅字，不如安靜退回本機模式、把原因與
    # 後果講清楚——Render 免費方案沒有持久磁碟，這件事使用者需要知道。
    if not config.github_repo_config().get("token"):
        result.message = (
            "已存檔到本機。GitHub 同步已啟用但找不到 GITHUB_TOKEN，這次略過同步"
            "——注意 Render 免費方案沒有持久磁碟，重新部署後分組會還原成 repo 裡那份。"
        )
        return result

    result.attempted_push = True
    ok_self, ok_scanner = upload_groups_to_github(groups)
    result.pushed_self, result.pushed_scanner = ok_self, ok_scanner

    if ok_self and ok_scanner:
        result.message = "已同步更新到 GitHub 的 stock_groups.json。"
    elif ok_self and not ok_scanner:
        result.message = (
            "stock_groups.json 已同步到 henglunlin-stock-monitor-FUBAN，"
            "但推送到 stock-scanner-FUBAN 失敗（請確認該 repo 的 Token 權限），不影響本機使用。"
        )
    else:
        result.message = (
            "同步 GitHub 失敗，請確認環境變數中的 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO 設定。"
        )
    return result
