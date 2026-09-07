# -*- coding: utf-8 -*-
"""
core/cache.py
=============
取代 Streamlit 的 @st.cache_data，讓原本的快取函式可以在 FastAPI（或任何純 Python
環境）裡原樣運作。

設計目標是「呼叫端不用改」：
    原本   @st.cache_data(ttl=30, show_spinner=False)
    改成   @ttl_cache(ttl=30, show_spinner=False)
其餘一個字都不用動。

刻意複製的 st.cache_data 行為
--------------------------------
1. **底線開頭的參數不參與 hash。** monitor 裡好幾個函式簽名長這樣：

       @st.cache_data(ttl=15)
       def fetch_taiex_intraday(_sdk): ...

   `_sdk` 是富邦 SDK 物件，不可 hash，Streamlit 靠「底線前綴」跳過它。這裡照做，
   否則那些函式一搬過來就會炸。
2. **`show_spinner` 等 Streamlit 專屬參數照收但忽略。** 這樣呼叫端不用逐一清掉。
3. **`.clear()` 方法。** 原本 `xxx.clear()` 可以清單一函式的快取，這裡保留。

跟 st.cache_data 的差異（要知道）
--------------------------------
* Streamlit 會把回傳值序列化後存起來、每次回傳「複本」，所以呼叫端改了拿到的
  DataFrame 不會污染快取。**這裡回傳的是同一個物件**——複製整份 DataFrame 在
  盤中每秒幾百次的呼叫下太貴。呼叫端若要改資料，請自己 `.copy()`。
  （目前 monitor 的用法都是唯讀，所以沒問題，但新增程式碼時要記得。）
* 快取是行程層級（不是 per-session），這正是我們要的：整個服務共用一份，
  不會再出現「每個瀏覽器分頁各自抓一次富邦」的老問題。
"""
from __future__ import annotations

import functools
import threading
import time
from typing import Any, Callable

__all__ = ["ttl_cache", "clear_all_caches"]

# 所有被裝飾過的函式，供 clear_all_caches() 一次清空（例如收盤後重置）
_REGISTRY: list = []
_REGISTRY_LOCK = threading.Lock()

# 單一函式的快取筆數上限。防止像 get_stock_name(symbol) 這種
# 「參數空間等於全市場」的函式無限長大吃光 Render 的 512MB。
DEFAULT_MAX_ENTRIES = 2048


def _make_key(args: tuple, kwargs: dict, arg_names: tuple) -> tuple:
    """
    產生 hash key，跳過名稱以底線開頭的參數（比照 st.cache_data）。

    arg_names 是函式的位置參數名稱清單，用來判斷第 i 個位置參數該不該跳過。
    """
    key_parts = []
    for i, value in enumerate(args):
        name = arg_names[i] if i < len(arg_names) else ""
        if name.startswith("_"):
            continue
        key_parts.append(value)
    for name in sorted(kwargs):
        if name.startswith("_"):
            continue
        key_parts.append((name, kwargs[name]))
    return tuple(key_parts)


def ttl_cache(
    ttl: float | None = None,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    **_streamlit_kwargs: Any,
) -> Callable:
    """
    TTL 快取裝飾器。

    ttl          幾秒後過期。None 表示永不過期（等同 st.cache_data 不給 ttl）。
    max_entries  快取筆數上限，超過時丟掉最舊的。
    **_streamlit_kwargs
                 吞掉 show_spinner / persist / hash_funcs 之類的 Streamlit 專屬參數，
                 讓呼叫端可以原封不動搬過來。
    """

    def decorator(func: Callable) -> Callable:
        cache: dict = {}
        lock = threading.RLock()
        # 取出位置參數名稱，用來判斷底線前綴
        try:
            arg_names = tuple(func.__code__.co_varnames[: func.__code__.co_argcount])
        except Exception:
            arg_names = ()

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            try:
                key = _make_key(args, kwargs, arg_names)
                hash(key)  # 提早驗證可 hash
            except TypeError:
                # 參數不可 hash 又沒加底線前綴：直接跳過快取，不要讓整個功能掛掉。
                # 這比拋例外好——盤中不該因為快取而中斷報價。
                return func(*args, **kwargs)

            now = time.monotonic()
            with lock:
                hit = cache.get(key)
                if hit is not None:
                    value, expires_at = hit
                    if expires_at is None or now < expires_at:
                        return value
                    del cache[key]

            # 注意：實際運算刻意放在鎖外面。
            # 這代表同一個 key 在冷啟動瞬間可能被算兩次（thundering herd），
            # 但避免了「一檔股票抓 yfinance 抓 10 秒，整個服務所有執行緒都卡住」
            # 這種更嚴重的問題。對報價服務來說這個取捨是對的。
            value = func(*args, **kwargs)

            expires_at = (now + ttl) if ttl else None
            with lock:
                if len(cache) >= max_entries:
                    # 丟掉最早插入的那筆（dict 保序）
                    try:
                        cache.pop(next(iter(cache)))
                    except StopIteration:
                        pass
                cache[key] = (value, expires_at)
            return value

        def clear() -> None:
            with lock:
                cache.clear()

        def cache_info() -> dict:
            with lock:
                return {"name": func.__qualname__, "entries": len(cache), "ttl": ttl}

        wrapper.clear = clear          # type: ignore[attr-defined]
        wrapper.cache_info = cache_info  # type: ignore[attr-defined]

        with _REGISTRY_LOCK:
            _REGISTRY.append(wrapper)
        return wrapper

    return decorator


def clear_all_caches() -> int:
    """清空所有 ttl_cache。回傳被清掉的函式數量。"""
    with _REGISTRY_LOCK:
        targets = list(_REGISTRY)
    for fn in targets:
        try:
            fn.clear()
        except Exception:
            pass
    return len(targets)


def all_cache_info() -> list:
    """給 /api/debug/cache 用：列出每個快取目前的筆數，方便盯記憶體。"""
    with _REGISTRY_LOCK:
        targets = list(_REGISTRY)
    out = []
    for fn in targets:
        try:
            out.append(fn.cache_info())
        except Exception:
            pass
    return sorted(out, key=lambda d: -d["entries"])
