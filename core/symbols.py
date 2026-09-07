# -*- coding: utf-8 -*-
"""
core/symbols.py
===============
股票代碼的正規化與查表工具。

這些全部是從 0_💻_monitor.py 原樣搬過來的純函式（原本就沒有任何 st.* 呼叫），
唯一的改動是 @st.cache_data → @ttl_cache，以及檔案路徑改用 core.config 的
絕對路徑（原本用相對路徑，在 FastAPI 下 cwd 不一定是 repo 根目錄）。

原始碼對照：0_💻_monitor.py 行 113-244
"""
from __future__ import annotations

import os
import re

from core import config
from core.cache import ttl_cache

__all__ = [
    "symbol_to_code", "yahoo_quote_url", "make_anchor_id",
    "load_stock_lookup_maps", "normalize_lookup_symbol", "normalize_symbol_quick",
    "build_yfinance_candidates", "normalize_symbols_from_text", "compact_name_list",
    "get_stock_name",
]


def symbol_to_code(symbol: str) -> str:
    """2330.TW → 2330"""
    return str(symbol).strip().upper().split(".")[0]


def yahoo_quote_url(symbol: str) -> str:
    raw_code = symbol_to_code(symbol)
    code = raw_code.split("/")[0]
    return f"https://tw.stock.yahoo.com/quote/{code}/technical-analysis"


@ttl_cache(ttl=86400)
def make_anchor_id(group_name: str) -> str:
    anchor = re.sub(r"[^0-9A-Za-z一-鿿]+", "-", group_name).strip("-")
    return f"group-{anchor}"


@ttl_cache(ttl=86400)
def load_stock_lookup_maps(file_path: str | None = None) -> dict:
    """
    讀 TWstocklistname2.txt，建立三張對照表。

    原本簽名的預設值是模組層級的 STOCK_NAME_FILE 相對路徑；這裡改成 None
    再回退到 config 的絕對路徑，呼叫端不帶參數的用法完全不受影響。
    """
    file_path = file_path or config.STOCK_NAME_FILE
    code_to_name: dict = {}
    code_to_symbol: dict = {}
    name_to_symbol: dict = {}
    if not os.path.exists(file_path):
        return {
            "code_to_name": code_to_name,
            "code_to_symbol": code_to_symbol,
            "name_to_symbol": name_to_symbol,
        }
    with open(file_path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            line = line.replace("﻿", "").replace("　", " ").strip()
            if "\t" in line:
                parts = [p.strip() for p in line.split("\t") if p.strip()]
            else:
                m = re.match(r"^([^\s]+)\s+(.+)$", line)
                parts = [m.group(1).strip(), m.group(2).strip()] if m else []
            if len(parts) < 2:
                continue
            raw_symbol = parts[0].upper()
            stock_name = parts[1].strip()

            symbol = raw_symbol
            code = symbol_to_code(symbol)
            if not code or not stock_name:
                continue
            code_to_name[code] = stock_name
            code_to_symbol[code] = symbol
            name_to_symbol[stock_name] = symbol
            name_to_symbol[stock_name.replace(" ", "")] = symbol
    return {
        "code_to_name": code_to_name,
        "code_to_symbol": code_to_symbol,
        "name_to_symbol": name_to_symbol,
    }


def normalize_lookup_symbol(raw_symbol: str) -> str:
    s = str(raw_symbol).strip().upper()
    if not s:
        return ""
    return s


def normalize_symbol_quick(input_text: str) -> str | None:
    """
    使用者輸入 2330 → 2330.TW。

    註：原始碼已移除「3/6/8 開頭猜 .TWO」的硬編碼邏輯，一律查表，這裡照舊。
    """
    s = str(input_text).strip().upper()
    if not s:
        return None
    if "." in s:
        return s

    if s.isdigit():
        try:
            lookup = load_stock_lookup_maps()
            code_to_symbol = lookup.get("code_to_symbol", {})
            if s in code_to_symbol:
                return code_to_symbol[s]
        except Exception:
            pass

    return s


def build_yfinance_candidates(symbol: str) -> list:
    raw = str(symbol).strip().upper()
    candidates = []

    if raw and "." in raw:
        candidates.append(raw)
    else:
        normalized = normalize_symbol_quick(raw)
        if normalized:
            candidates.append(normalized)

    result, seen = [], set()
    for item in candidates:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def normalize_symbols_from_text(text: str) -> list:
    """把使用者貼上的多行／逗號分隔文字轉成正規化後的代碼清單。"""
    if not text:
        return []
    text = text.replace("，", ",")
    lines = []
    for raw_line in text.splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        parts = [p.strip().upper() for p in raw_line.split(",") if p.strip()]
        lines.extend(parts)
    seen = set()
    result = []
    for s in lines:
        normalized = normalize_symbol_quick(s)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def compact_name_list(names, max_show: int = 3) -> str:
    names = [str(x).strip() for x in names if str(x).strip()]
    if not names:
        return "無"
    if len(names) <= max_show:
        return "、".join(names)
    return "、".join(names[:max_show]) + f" 等{len(names)}檔"


@ttl_cache(ttl=86400)
def get_stock_name(symbol: str) -> str:
    """代碼 → 股票名稱。查不到就回傳代碼本身（跟原本行為一致）。"""
    code = symbol_to_code(symbol)
    try:
        lookup = load_stock_lookup_maps()
        return lookup.get("code_to_name", {}).get(code, code)
    except Exception:
        return code
