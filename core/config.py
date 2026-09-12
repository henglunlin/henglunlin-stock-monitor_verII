# -*- coding: utf-8 -*-
"""
core/config.py
==============
取代 st.secrets。所有設定改從環境變數讀取，在 Render 就是 Environment /
Secret Files，本機開發就是 .env。

呼叫端沿用原本的 get_secret_or_default(key, default) 簽名，所以 monitor 裡
既有的呼叫一個字都不用改。

.env 範例（本機開發用；正式環境請設在 Render 的 Environment 裡，不要 commit）
---------------------------------------------------------------------------
    FUBON_ID=A123456789
    FUBON_PASSWORD=xxxxx
    FUBON_CERT_PASSWORD=xxxxx
    FUBON_PFX_BASE64=MIIK...            # 原本放在 st.secrets["fubon"]["pfx_base64"]
    TELEGRAM_BOT_TOKEN=123456:ABC...
    TELEGRAM_CHAT_ID=-1001234567890
    LINE_CHANNEL_ACCESS_TOKEN=xxxxx      # LINE Developers → Messaging API 長期權杖
    LINE_TO=Uxxxxxxxxxxxxxxxx            # 你的 userId，或群組 groupId
    GITHUB_TOKEN=github_pat_xxx
    GITHUB_OWNER=henglunlin
    GITHUB_REPO=henglunlin-stock-monitor-FUBAN
    GITHUB_BRANCH=main
    APP_SHARED_TOKEN=隨便一組長字串      # 前端要帶這個才給資料
    ALLOWED_ORIGINS=https://xxx.vercel.app,http://localhost:5173
"""
from __future__ import annotations

import os
from pathlib import Path

__all__ = [
    "get_secret_or_default", "get_bool", "get_int", "get_list",
    "FubonCredentials", "fubon_credentials", "github_repo_config",
    "scanner_repo_config", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
    "LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO",
    "APP_SHARED_TOKEN", "ALLOWED_ORIGINS", "REPO_ROOT",
]

# 專案根目錄。原本 monitor 用相對路徑讀 stock_groups.json / twse_ohlcv.db，
# 在 Streamlit 下剛好 cwd 就是 repo 根目錄所以能動；FastAPI 的 cwd 不一定，
# 所以這裡明確算出來，讓所有檔案路徑都以它為基準。
REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv_once() -> None:
    """
    極簡 .env 載入器（不想為了這件事多裝 python-dotenv）。
    已存在的環境變數優先，不會被 .env 覆蓋——正式環境的設定永遠贏。
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        pass


_load_dotenv_once()


def get_secret_or_default(key: str, default: str = "") -> str:
    """跟原本 monitor 裡同名函式的簽名一致，直接取代即可。"""
    value = os.environ.get(key)
    return value if value not in (None, "") else default


def get_bool(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "y", "on")


def get_int(key: str, default: int) -> int:
    try:
        return int(str(os.environ.get(key, "")).strip())
    except Exception:
        return default


def get_list(key: str, default: list | None = None) -> list:
    """逗號分隔的設定，例如 ALLOWED_ORIGINS。"""
    raw = os.environ.get(key, "")
    items = [x.strip() for x in raw.split(",") if x.strip()]
    return items if items else list(default or [])


# =============================================================================
# 富邦憑證
# =============================================================================
class FubonCredentials:
    """
    富邦登入所需的四個欄位。

    原本是在 Streamlit 側邊欄手動輸入 id / password / cert_password，
    只有 pfx_base64 放在 secrets。搬到 Render 之後要能無人啟動，所以四個
    全部改從環境變數讀。

    如果你不想把身分證跟密碼放上雲，把 FUBON_ID / FUBON_PASSWORD /
    FUBON_CERT_PASSWORD 留空即可——is_complete() 會是 False，服務照常啟動，
    只是不會自動登入，改由前端呼叫 /api/fubon/login 手動送入（跟現在的
    側邊欄輸入等價，一天輸入一次）。
    """

    __slots__ = ("fubon_id", "password", "cert_password", "pfx_base64")

    def __init__(self, fubon_id: str, password: str, cert_password: str, pfx_base64: str):
        self.fubon_id = fubon_id
        self.password = password
        self.cert_password = cert_password
        self.pfx_base64 = pfx_base64

    def is_complete(self) -> bool:
        return bool(self.fubon_id and self.password and self.cert_password and self.pfx_base64)

    def missing(self) -> list:
        names = {
            "FUBON_ID": self.fubon_id,
            "FUBON_PASSWORD": self.password,
            "FUBON_CERT_PASSWORD": self.cert_password,
            "FUBON_PFX_BASE64": self.pfx_base64,
        }
        return [k for k, v in names.items() if not v]

    def __repr__(self) -> str:
        # 絕對不要在 log 裡印出密碼——Render 的 log 是可以被看到的
        return (
            f"<FubonCredentials id={'set' if self.fubon_id else 'empty'} "
            f"pwd={'set' if self.password else 'empty'} "
            f"cert_pwd={'set' if self.cert_password else 'empty'} "
            f"pfx={len(self.pfx_base64)}chars>"
        )


def fubon_credentials() -> FubonCredentials:
    return FubonCredentials(
        fubon_id=get_secret_or_default("FUBON_ID", ""),
        password=get_secret_or_default("FUBON_PASSWORD", ""),
        cert_password=get_secret_or_default("FUBON_CERT_PASSWORD", ""),
        pfx_base64=get_secret_or_default("FUBON_PFX_BASE64", ""),
    )


# =============================================================================
# GitHub（沿用 monitor 原本的兩組設定）
# =============================================================================
def github_repo_config() -> dict:
    """本 repo（henglunlin-stock-monitor-FUBAN）。"""
    return {
        "token": get_secret_or_default("GITHUB_TOKEN", ""),
        "owner": get_secret_or_default("GITHUB_OWNER", "henglunlin"),
        "repo": get_secret_or_default("GITHUB_REPO", "henglunlin-stock-monitor-FUBAN"),
        "branch": get_secret_or_default("GITHUB_BRANCH", "main"),
    }


def scanner_repo_config() -> dict:
    """掃描器 repo（stock-scanner-FUBAN），分組存檔要同步推一份過去。"""
    return {
        "token": get_secret_or_default("SCANNER_GITHUB_TOKEN", "")
        or get_secret_or_default("GITHUB_TOKEN", ""),
        "owner": get_secret_or_default("SCANNER_GITHUB_OWNER", "henglunlin"),
        "repo": get_secret_or_default("SCANNER_GITHUB_REPO", "stock-scanner-FUBAN"),
        "branch": get_secret_or_default("SCANNER_GITHUB_BRANCH", "main"),
    }


# =============================================================================
# 其他常用設定
# =============================================================================
TELEGRAM_BOT_TOKEN = get_secret_or_default("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = get_secret_or_default("TELEGRAM_CHAT_ID", "")

# LINE Messaging API（定時彙整推播走這條；即時事件仍走 Telegram）
#
# ⚠️ 不要用 LINE Notify —— 它已於 2025-03-31 終止服務。
# 取得方式：LINE Developers Console → 建一個 Messaging API channel →
#   LINE_CHANNEL_ACCESS_TOKEN：Messaging API 分頁最下面的「長期存取權杖」
#   LINE_TO：你自己的 userId（把 bot 加好友後由 webhook 取得），或群組的 groupId
#
# 跟 Telegram 一樣走 get_secret_or_default（不清引號）——權杖是長字串，
# 萬一值不小心帶了引號會變成 401，這時去看 /api/debug/line 的 error 欄。
LINE_CHANNEL_ACCESS_TOKEN = get_secret_or_default("LINE_CHANNEL_ACCESS_TOKEN", "")
LINE_TO = get_secret_or_default("LINE_TO", "")

# 前端必須在 header 帶這個 token 才拿得到資料。Render 的網址是公開的，
# 加上自動登入富邦之後，沒有這道防線等於把持股攤在網路上。
APP_SHARED_TOKEN = get_secret_or_default("APP_SHARED_TOKEN", "")

ALLOWED_ORIGINS = get_list(
    "ALLOWED_ORIGINS",
    ["http://localhost:5173", "http://127.0.0.1:5173"],
)

# 檔案路徑一律以 REPO_ROOT 為基準（原本是相對 cwd，換成 FastAPI 後會失效）
GROUPS_FILE = str(REPO_ROOT / get_secret_or_default("GROUPS_FILE", "stock_groups.json"))
TARGET_PRICE_FILE = str(REPO_ROOT / get_secret_or_default("TARGET_PRICE_FILE", "target_price_list.json"))
STOCK_NAME_FILE = str(REPO_ROOT / get_secret_or_default("STOCK_NAME_FILE", "TWstocklistname2.txt"))
TWSE_DB_PATH = str(REPO_ROOT / get_secret_or_default("TWSE_DB_PATH", "twse_ohlcv.db"))
TRENDLINE_FILE = str(REPO_ROOT / get_secret_or_default("TRENDLINE_FILE", "trendline_levels.json"))
