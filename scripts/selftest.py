# -*- coding: utf-8 -*-
"""
本地環境自我檢測。

    python scripts/selftest.py

不需要富邦憑證、不需要盤中、不需要網路（全程走本地 SQLite）。
一路綠燈代表後端環境是好的，可以往下做前端。

每一項失敗都會告訴你「怎麼修」，不會只丟一個 traceback。
"""
from __future__ import annotations

import importlib
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

PASS, FAIL, WARN = "  [OK]  ", "  [!!]  ", "  [--]  "
failures: list[str] = []


def ok(msg: str) -> None:
    print(PASS + msg)


def bad(msg: str, fix: str) -> None:
    print(FAIL + msg)
    print(f"         → 怎麼修：{fix}")
    failures.append(msg)


def warn(msg: str, note: str = "") -> None:
    print(WARN + msg)
    if note:
        print(f"         {note}")


def section(title: str) -> None:
    print(f"\n{'=' * 62}\n{title}\n{'=' * 62}")


# =============================================================================
section("1. Python 與套件")
# =============================================================================
v = sys.version_info
if v >= (3, 11):
    ok(f"Python {v.major}.{v.minor}.{v.micro}")
else:
    bad(
        f"Python {v.major}.{v.minor} 太舊",
        "需要 3.11 以上（Render 也是用 3.11）。裝新版後重建虛擬環境。",
    )

for mod, hint in [
    ("fastapi", "pip install -r server/requirements.txt"),
    ("uvicorn", "pip install -r server/requirements.txt"),
    ("pandas", "pip install pandas"),
    ("yfinance", "pip install yfinance"),
    ("requests", "pip install requests"),
]:
    try:
        m = importlib.import_module(mod)
        ok(f"{mod} {getattr(m, '__version__', '')}")
    except ImportError:
        bad(f"缺少套件 {mod}", hint)

try:
    importlib.import_module("fubon_neo")
    ok("fubon_neo SDK 已安裝")
except ImportError:
    warn(
        "fubon_neo SDK 未安裝",
        "非致命：服務仍會啟動，只是拿不到即時報價。\n"
        "         安裝：pip install ./fubon_neo-2.2.8-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl\n"
        "         ⚠️ 這個 whl 是 Linux 版。Windows 本機請改用富邦官網下載的 Windows 版 SDK。",
    )

# =============================================================================
section("2. 必要檔案（這些要從 monitor repo 複製過來）")
# =============================================================================
REQUIRED = [
    ("signal_module/base.py", "訊號模組核心", True),
    ("signal_module/module_loader.py", "訊號模組載入器", True),
    ("TWstocklistname2.txt", "股票代碼與名稱對照表", True),
    ("twse_ohlcv.db", "歷史 OHLCV 資料庫（38MB）", True),
    ("stock_groups.json", "股票分組", False),
    ("target_price_list.json", "目標價清單", False),
    ("trendline_levels.json", "趨勢線預算結果", False),
]
for rel, desc, required in REQUIRED:
    p = ROOT / rel
    if p.exists():
        size = p.stat().st_size
        ok(f"{rel:<38} {desc}（{size:,} bytes）")
    elif required:
        bad(
            f"找不到 {rel}（{desc}）",
            f"從 henglunlin-stock-monitor-FUBAN 複製 {rel} 到這個 repo 的相同位置。",
        )
    else:
        warn(f"找不到 {rel}（{desc}）", "非必要，缺了只是該功能不作用。")

n_signals = len(list((ROOT / "signal_module").glob("*.py"))) if (ROOT / "signal_module").exists() else 0
if n_signals >= 20:
    ok(f"signal_module/ 共 {n_signals} 支 .py")
elif n_signals:
    warn(f"signal_module/ 只有 {n_signals} 支 .py", "monitor repo 有 24 支，確認是不是漏複製了。")

# =============================================================================
section("3. 環境變數")
# =============================================================================
try:
    from core import config

    ok(f"REPO_ROOT = {config.REPO_ROOT}")
    if (ROOT / ".env").exists():
        ok(".env 存在（已自動載入）")
    else:
        warn(".env 不存在", "複製 .env.example 成 .env 再填。本地測試可以先不填。")

    checks = [
        ("FUBON_PFX_BASE64", config.get_secret_or_default("FUBON_PFX_BASE64"), "沒設就無法登入富邦，其餘功能不受影響"),
        ("APP_SHARED_TOKEN", config.APP_SHARED_TOKEN, "本地留空會自動放行；正式部署務必要設"),
        ("TELEGRAM_BOT_TOKEN", config.TELEGRAM_BOT_TOKEN, "沒設就不會推播"),
        ("GITHUB_TOKEN", config.get_secret_or_default("GITHUB_TOKEN"), "沒設就無法把分組同步回 GitHub"),
    ]
    for name, value, note in checks:
        if value:
            ok(f"{name} 已設定（{len(value)} 字元）")
        else:
            warn(f"{name} 未設定", note)
    ok(f"ALLOWED_ORIGINS = {config.ALLOWED_ORIGINS}")
except Exception:
    bad("core.config 匯入失敗", "看下面的 traceback")
    traceback.print_exc()

# =============================================================================
section("4. core/ 模組")
# =============================================================================
for mod in [
    "core.cache", "core.config", "core.state", "core.symbols", "core.tradingday",
    "core.db", "core.quotes", "core.indicators", "core.signals",
    "core.groups", "core.targets", "core.telegram", "core.fubon",
]:
    try:
        importlib.import_module(mod)
        ok(mod)
    except Exception as e:
        bad(f"{mod} 匯入失敗：{e}", "多半是缺套件或缺 signal_module/，看上面幾節")

# =============================================================================
section("5. 資料層（離線，走本地 SQLite）")
# =============================================================================
try:
    from core import db
    from core.symbols import get_stock_name, load_stock_lookup_maps
    from core.tradingday import today_str

    m = load_stock_lookup_maps()
    n = len(m["code_to_name"])
    if n > 1000:
        ok(f"股票對照表載入 {n} 檔（例：2330 = {get_stock_name('2330.TW')}）")
    else:
        bad(f"股票對照表只有 {n} 筆", "確認 TWstocklistname2.txt 完整")

    if db.db_available():
        hist = db.download_history_from_db("2330.TW", today_str(), False)
        price, dstr = db.get_db_latest_price("2330.TW")
        ok(f"twse_ohlcv.db 查詢正常：2330 有 {len(hist)} 筆歷史，最新收盤 {price} @ {dstr}")
        import datetime as _dt
        stale = (_dt.date.today() - _dt.date.fromisoformat(dstr)).days
        if stale > 5:
            warn(f"資料庫最新一筆是 {stale} 天前", "跑一次同步 workflow 或從 monitor repo 重新複製 twse_ohlcv.db")
    else:
        bad("找不到 twse_ohlcv.db", "從 monitor repo 複製過來（38MB）")
except Exception as e:
    bad(f"資料層測試失敗：{e}", "看 traceback")
    traceback.print_exc()

# =============================================================================
section("6. 訊號模組")
# =============================================================================
try:
    # ⚠️ 先 import server.hub，強制走「跟正式服務完全一樣」的 import 順序。
    # 曾經有一個 bug：core/targets.py 比 core/signals.py 先被 import，
    # 導致訊號註冊被跳過、只剩 2 個。如果這裡只 import core.signals，
    # 順序跟真實情況相反，就會顯示「20 個，一切正常」而完全測不出來。
    import server.hub  # noqa: F401
    from core.signals import SIGNAL_PRIORITY, get_signal_registry

    reg = get_signal_registry()
    if len(reg) >= 15:
        labels = [c["label"] for c in reg.values()]
        ok(f"已註冊 {len(reg)} 個訊號")
        print(f"         {'、'.join(labels[:9])}…")
        unknown = [l for l in labels if l not in SIGNAL_PRIORITY]
        if unknown:
            warn(f"這些訊號沒有在 SIGNAL_PRIORITY 裡：{unknown}", "會被當成最低優先等級 3，通常沒問題")
    else:
        bad(f"只註冊到 {len(reg)} 個訊號", "確認 signal_module/ 完整複製過來了")
except Exception as e:
    bad(f"訊號模組載入失敗：{e}", "看 traceback")
    traceback.print_exc()

# =============================================================================
section("7. 完整算一列（離線）")
# =============================================================================
try:
    from core.state import get_state
    from server.hub import hub

    S = get_state()
    S.settings.post_market_enabled = True     # 全程走 SQLite，不打網路
    S.settings.post_market_source = "db"
    S.stock_groups = {"自測": ["2330.TW", "2317.TW"]}

    rows = hub.compute_all_rows()
    good = [r for r in rows if "error" not in r]
    for r in rows:
        if "error" in r:
            warn(f"{r['symbol']} 計算失敗：{r['error']}")
        else:
            print(f"         {r['code']} {r['name']:<7} 價 {r['price']:>9} "
                  f"漲跌 {r['pct']:>6}%  KD {r['k']}/{r['d']}  "
                  f"{r['ma_range']:<8} {r['ma_trend']}  訊號 {r['signal_text']}")
    if len(good) == len(rows) and rows:
        ok(f"{len(good)} 檔全部算出，每列 {len(good[0])} 個欄位")
        # 前端會直接讀這幾個 key，缺一個就是整欄空白。在這裡擋比在瀏覽器裡查快得多。
        need = {"symbol", "code", "name", "groups", "spark", "intraday", "price",
                "pct", "yesterday_close", "k", "d", "signals", "target"}
        missing = need - set(good[0])
        if missing:
            bad(f"回傳缺少欄位：{sorted(missing)}", "前端對應的欄位會整欄空白")
        else:
            ok("前端需要的欄位齊全（含 intraday 盤中走勢）")

        # 盤中走勢的取樣邏輯：同一個 20 秒窗內只留一個點，且一定保留最後一點
        S.record_tick("2330.TW", 100.0)
        S.record_tick("2330.TW", 101.0)
        S.record_tick("2330.TW", 102.0)
        series = S.series_of("2330.TW")
        if series and series[-1] == 102.0 and len(series) == 1:
            ok("盤中走勢取樣正確（同一取樣窗內只留最新值）")
        else:
            warn(f"盤中走勢取樣結果非預期：{series}")
    elif good:
        warn(f"{len(good)}/{len(rows)} 檔算出", "部分失敗通常是那幾檔在資料庫裡沒資料")
    else:
        bad("一列都算不出來", "看上面的錯誤訊息")
except Exception as e:
    bad(f"整合測試失敗：{e}", "看 traceback")
    traceback.print_exc()

# =============================================================================
section("7b. 盤中事件偵測")
# =============================================================================
try:
    from core.detectors import calc_limit_prices, get_detector_engine
    from core.events import get_event_bus

    # 漲跌停價要用台股升降單位取整，不是用百分比估
    up, down = calc_limit_prices(33.05)
    if (up, down) == (36.35, 29.75):
        ok(f"漲跌停價計算正確（昨收 33.05 → 漲停 {up} 跌停 {down}，實際漲幅 {(up/33.05-1)*100:.2f}%）")
    else:
        bad(f"漲跌停價算錯：得到 {up}/{down}，應為 36.35/29.75", "檢查 get_price_tick_size 的級距")

    S.settings.rebound_open_silence_min = 0
    bus, eng = get_event_bus(), get_detector_engine()
    bus.clear(); eng._st.clear(); S.intraday_low_tracker.clear()

    trow = [{"symbol": "2330.TW", "code": "2330", "name": "台積電",
             "groups": ["自測"], "price": 100.0, "yesterday_close": 100.0}]
    px = {"2330": 100.0}

    S.update_intraday_low("2330", 95.0)
    px["2330"] = 99.0
    got = eng.scan(trow, lambda c: px.get(c))
    if [e.level for e in got] == ["rebound"]:
        ok("瞬間反彈觸發（今日最低 95 → 99，+4.21%）")
    else:
        bad(f"反彈沒觸發：{[e.level for e in got]}", "檢查 core/detectors.py 的 _check_rebound")

    if not eng.scan(trow, lambda c: px.get(c)):
        ok("同一波不會重複發（去重與冷卻生效）")
    else:
        warn("同一波重複發了，冷卻可能沒作用")

    # 「接近漲停」之後緊接著「觸價」不可以被優先權窗吞掉
    bus.clear(); eng._st.clear()
    px["2330"] = 107.6
    eng.scan(trow, lambda c: px.get(c))
    px["2330"] = 110.0
    hit = eng.scan(trow, lambda c: px.get(c))
    if [e.level for e in hit] == ["limit_up_hit"]:
        ok("接近漲停後鎖上漲停，觸價事件仍然發得出來")
    else:
        bad(f"觸價事件被吞掉了：{[e.level for e in hit]}",
            "limit_up_hit 的優先權必須高於 limit_up，見 core/events.py 的 PRIORITY")

    # 🚀 瞬間拉抬：量增 + 全外盤 + 急拉 + 突破高點
    import time as _t
    from core.ticks import SIDE_BUY, SIDE_SELL, _Series, get_tick_store
    store = get_tick_store()
    bus.clear(); eng._st.clear(); store._s.clear()
    now = _t.time()
    ser = store._s.setdefault("2330", _Series())
    for ago in range(59, 30, -2):
        ser.append(now - ago, 100.0, 2, SIDE_SELL)       # 前一桶：小量內盤
    for ago in range(28, 8, -2):
        ser.append(now - ago, 100.0, 12, SIDE_BUY)       # 本桶：量放大
    for ago, px, v in ((6, 100.3, 20), (4, 100.8, 25), (2, 101.3, 30), (0.5, 101.6, 30)):
        ser.append(now - ago, px, v, SIDE_BUY)           # 最後 6 秒陡升 1.6%
    got = eng.scan(trow, lambda c: 101.6)
    if [e.level for e in got] == ["entry"]:
        d = eng._st["2330"]["entry_dbg"]
        ok(f"瞬間拉抬觸發（量比 {d['volume_ratio']:.2f}x、外盤 {d['buy_ratio']*100:.0f}%、"
           f"10秒 {d['m10']:+.2f}%）")
    else:
        bad(f"拉抬沒觸發：{[e.level for e in got]}",
            "看 /api/debug/detector 的 entry 欄位，找出是哪一項條件卡住")

    # 內外盤抓不到時必須 fail-closed（拉抬與預警都不能發）
    # ⚠️ 這裡要一併清掉 intraday_low_tracker：前面反彈那段留下的今日最低 95
    # 會讓這檔同時滿足反彈條件，斷言若寫成「完全沒有事件」就會誤判。
    bus.clear(); eng._st.clear(); store._s.clear(); S.intraday_low_tracker.clear()
    ser = store._s.setdefault("2330", _Series())
    for ago in range(59, 30, -2):
        ser.append(now - ago, 100.0, 2, 0.0)
    for ago in range(28, 8, -2):
        ser.append(now - ago, 100.0, 12, 0.0)            # side=0：抓不到內外盤
    for ago, px, v in ((6, 100.3, 20), (4, 100.8, 25), (2, 101.3, 30), (0.5, 101.6, 30)):
        ser.append(now - ago, px, v, 0.0)
    levels = [e.level for e in eng.scan(trow, lambda c: 101.6)]
    if "entry" not in levels and "warning" not in levels:
        ok("抓不到內外盤時，拉抬與預警都不觸發（fail-closed）")
    else:
        bad(f"內外盤未知卻發了 {levels}", "外盤占比條件應該是 fail-closed")

    # 193 檔的掃描成本，這是 Render 免費方案 0.1 CPU 夠不夠的依據
    bus.clear(); eng._st.clear(); store._s.clear()
    many = [{"symbol": f"{1000+i}.TW", "code": str(1000+i), "name": f"股{i}",
             "groups": ["自測"], "price": 100.0, "yesterday_close": 100.0} for i in range(193)]
    mp = {r["code"]: 101.0 for r in many}
    for i in range(193):                                  # 最壞情況：每檔都塞滿逐筆明細
        sr = store._s.setdefault(str(1000 + i), _Series())
        for j in range(1200):
            sr.append(now - 119 + j * 0.099, 100.0 + (j % 20) * 0.01, 3.0, SIDE_BUY)
    spans = []
    for _ in range(20):
        t0 = _t.perf_counter(); eng.scan(many, lambda c: mp.get(c)); spans.append((_t.perf_counter()-t0)*1000)
    spans.sort()
    st_ = store.stats()
    ok(f"193 檔最壞情況掃描 p50 {spans[10]:.1f}ms、p95 {spans[18]:.1f}ms"
       f"（逐筆緩衝 {st_['buffered_ticks']:,} 筆 / {st_['approx_bytes']/1048576:.1f} MB）")
    if spans[18] > 40:
        warn(f"p95 {spans[18]:.0f}ms 偏高", "Render 免費只有 0.1 CPU，每秒一次的話會吃掉大半預算")
    bus.clear(); eng._st.clear(); store._s.clear()
except Exception as e:
    bad(f"事件偵測測試失敗：{e}", "看 traceback")
    traceback.print_exc()

# =============================================================================
section("8. FastAPI 應用")
# =============================================================================
try:
    from server.main import app

    # 用 OpenAPI 來數端點，不要走 app.routes——不同 FastAPI 版本會把
    # include_router() 進來的路由包成單一節點，直接數 app.routes 會數成 0。
    api_routes = sorted(p for p in app.openapi()["paths"] if p.startswith("/api"))
    ok(f"app 建立成功，{len(api_routes)} 個 API 端點")
    print(f"         {', '.join(api_routes[:6])}…")

    ws_paths = [getattr(r, "path", None) for r in app.routes]
    if "/ws/quotes" in ws_paths:
        ok("WebSocket 端點 /ws/quotes 已註冊")
    else:
        bad("WebSocket 端點沒註冊", "檢查 server/main.py 的 @app.websocket 裝飾器")
    dist = ROOT / "web" / "dist"
    if dist.exists():
        ok(f"前端已建置：{dist}（會由 FastAPI 一併服務）")
    else:
        warn("web/dist 不存在", "還沒跑 npm run build。開發時走 Vite dev server 就好，不影響。")
except Exception as e:
    bad(f"FastAPI 應用建立失敗：{e}", "看 traceback")
    traceback.print_exc()

# =============================================================================
section("10. 富邦連線韌性（雲端不定時斷線的根因）")
# =============================================================================
# 這一節守的是一個很貴的教訓：症狀是「本機穩、放到 Render 就不定時斷線」，
# 找了兩輪才找到真兇 —— 不在我們的程式裡，在 fugle-marketdata 套件的
# connect() 裡面。詳見 core/fugle_patch.py 的檔頭。
try:
    import resource
    import threading as _th
    import time as _time

    from core import fugle_patch

    # --- 10a. 套件原本的 connect() 真的會 100% CPU 空轉嗎 ---
    try:
        from fugle_marketdata.websocket.client import WebSocketClient

        def _cpu():
            r = resource.getrusage(resource.RUSAGE_SELF)
            return r.ru_utime + r.ru_stime

        fugle_patch.apply(connect_timeout_sec=3)
        c = WebSocketClient(base_url="ws://127.0.0.1:9/stock/streaming", sdk_token="x")
        err = {}

        def _run():
            try:
                c.connect()
            except Exception as e:      # noqa: BLE001
                err["e"] = type(e).__name__

        t0, w0 = _cpu(), _time.time()
        th = _th.Thread(target=_run, daemon=True)
        th.start()
        th.join(timeout=10)
        burned, wall = _cpu() - t0, _time.time() - w0

        if th.is_alive():
            bad("修補後 connect() 仍然不會返回",
                "core/fugle_patch.py 沒套上？檢查 apply() 的回傳值與 log")
        elif burned > 0.5:
            bad(f"修補後 connect() 仍在燒 CPU（{wall:.1f} 秒內用掉 {burned:.2f} 秒）",
                "原版是 100%（3 秒燒 3.01 秒）。0.1 CPU 的 Render 撐不住這個。")
        else:
            ok(f"connect() 連不上時會逾時返回（{wall:.1f} 秒，CPU 只用 {burned:.3f} 秒）"
               f"，拋出 {err.get('e', '?')}")
    except ImportError:
        warn("沒裝 fugle-marketdata，跳過 connect() 空轉測試",
             "正式環境一定會裝，這裡只是本機沒有")

    # --- 10b. 重連失敗不可以把半開偵測弄瞎 ---
    from datetime import timedelta as _td

    from core.fubon import TW_TZ as _TZ
    from core.fubon import FubonRealtimeManager as _M

    def _mgr(connected=True, ago=1.0, subs=("2330",)):
        m = _M()
        m.logged_in, m.connected = True, connected
        m.subscribed = set(subs)
        m.last_message_at = datetime.now(_TZ) - _td(seconds=ago)
        m.sdk = object()
        return m

    class _DeadSDK:
        def init_realtime(self):
            raise RuntimeError("connection refused")

    m = _mgr(ago=300)
    m.sdk = _DeadSDK()
    m.reconnect_and_resubscribe(["2330.TW"])
    if m.subscribed and m.is_stale(120):
        ok("重連失敗後仍抓得到半開連線（訂閱狀態沒被提前清掉）")
    else:
        bad("重連失敗後半開偵測失效",
            "reconnect_and_resubscribe 又在連線成功前就清 subscribed 了。"
            "is_stale() 開頭是 `if not self.subscribed: return False`，一清就瞎。")

    # --- 10c. 連續失敗要收手，不能永遠重試 ---
    for _ in range(3):
        m.reconnect_and_resubscribe(["2330.TW"])
    if m.session_dead:
        ok(f"連續重連失敗 {m.reconnect_fail_count} 次後判定 session 失效，看門狗會停手")
    else:
        bad("連續重連失敗後沒有 session_dead",
            "0.1 CPU 上無限重連會把行程餓死，而且 session 死掉本來就重連不好")

    # --- 10d. 半開連線的計數要看得見 ---
    h = _mgr(connected=True, ago=300)
    if h.is_stale(120) and h.disconnect_count == 0:
        h.note_stale(300.0)
        if h.stale_count == 1 and any(e["kind"] == "stale" for e in h.conn_history()):
            ok("半開連線會記進 stale_count 與連線黑盒子（斷線回呼不會觸發，只能靠這個）")
        else:
            bad("半開連線沒被記錄", "檢查 note_stale() 與 conn_log")
    else:
        bad("半開連線判定不正確", "檢查 is_stale()")

    # --- 10e. 正常連線不可以被誤判 ---
    if not _mgr(ago=3).is_stale(120) and not _mgr(ago=999, subs=()).is_stale(120):
        ok("正常連線與尚未訂閱的狀態都不會被誤判成斷線")
    else:
        bad("is_stale 誤判", "會造成盤中無謂重連，反而把連線弄斷")
except Exception as e:
    bad(f"連線韌性測試出錯：{e}", "看 traceback")
    traceback.print_exc()

# =============================================================================
print("\n" + "=" * 62)
if failures:
    print(f"❌ {len(failures)} 項失敗，先修這些：")
    for f in failures:
        print(f"   • {f}")
    sys.exit(1)
print("✅ 全部通過。後端環境正常，可以啟動服務了：")
print("     uvicorn server.main:app --reload --port 8000")
sys.exit(0)
