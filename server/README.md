# Phase 0 交付說明

把富邦邏輯從 Streamlit 剝出來，包成可獨立執行的 FastAPI 服務。
**完全不碰 React**，舊的 Streamlit 版一行都沒動、照常運作。

---

## 檔案結構

```
core/                    純 Python 邏輯層（Streamlit 與 FastAPI 共用，零 UI 依賴）
├─ cache.py                取代 @st.cache_data
├─ config.py               取代 st.secrets，改讀環境變數
├─ state.py                取代 st.session_state，應用層單例
├─ symbols.py              代碼正規化與查表
├─ tradingday.py           交易日與時段判斷
├─ db.py                   twse_ohlcv.db 存取
├─ quotes.py               報價取得與資料來源切換
├─ indicators.py           技術指標（MA/KD/昨收）
├─ signals.py              signal_module/ 銜接層
├─ groups.py               分組讀寫 + GitHub 同步
├─ targets.py              目標價買入區間 + 停損
└─ telegram.py             推播與指令輪詢

server/                  FastAPI 應用層（只做接線，沒有商業邏輯）
├─ main.py                 進入點、CORS、WebSocket、靜態檔
├─ api.py                  14 個 REST 端點
├─ hub.py                  報價中樞：快線 300ms／慢線 20s
├─ requirements.txt        不含 streamlit/plotly，省記憶體
└─ README.md               本檔

render.yaml              Render 部署設定
```

`signal_module/` **刻意留在原地不搬**——它已經是乾淨的純 Python，搬了會弄壞
Streamlit 版的 import。兩版共用同一份訊號公式，這正是避免公式漂移的做法。

---

## 本機執行

```bash
pip install -r server/requirements.txt
uvicorn server.main:app --reload --port 8000
```

開 http://localhost:8000/docs 看互動式 API 文件。

`.env`（放 repo 根目錄，**記得加進 .gitignore**）：

```ini
FUBON_PFX_BASE64=MIIK...          # 憑證，唯一放上雲的敏感資料
APP_SHARED_TOKEN=隨便一組長字串     # 前端存取用
ALLOWED_ORIGINS=http://localhost:5173
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
GITHUB_TOKEN=...
```

身分證／密碼／憑證密碼**刻意不放環境變數**，改由前端呼叫
`POST /api/fubon/login` 手動輸入，一天一次。

---

## 部署到 Render

1. 在 Render 建立 Web Service，指向這個 repo
2. **Region 一定要選 Singapore**——離台灣最近，比美國機房少約 200ms
3. Build Command：`pip install -r server/requirements.txt`
4. Start Command：`uvicorn server.main:app --host 0.0.0.0 --port $PORT`
5. Health Check Path：`/api/health`
6. Environment 填入上面那幾個變數

或直接用 repo 裡的 `render.yaml`（Blueprint）。

---

## 快慢兩線：這是新架構的核心

原本 Streamlit 每 3 秒把所有東西重算一次——報價、指標、22 個訊號、整張表重繪。
檔數一多就是這樣拖垮的。現在拆成兩線：

| | 間隔 | 內容 | 成本 |
|---|---|---|---|
| **快線** | 300ms | `drain_dirty()` 只推這段時間內變動過的報價，沒變動就完全不發 | 趨近於零 |
| **慢線** | 20s | 重算技術指標、跑訊號模組、比對目標價 | 貴，但輸入根本不會秒變 |

前端收到快線更新那一格，收到慢線更新整列。這就是「只有變動的格子會閃」與
「幾百檔不卡」的來源。

---

## API

| 端點 | 用途 |
|---|---|
| `GET /api/health` | **免 token**，前端用它喚醒休眠的 Render |
| `GET /api/status` | 完整狀態，給連線狀態列 |
| `POST /api/fubon/login` | 手動登入富邦 |
| `GET /PUT /api/groups` | 分組讀寫（寫入會自動正規化代碼並同步 GitHub） |
| `GET /api/rows` | 最近一次慢線的完整列 |
| `POST /api/rows/refresh` | 手動觸發重算 |
| `GET /api/targets` | 目標價清單 |
| `GET /PATCH /api/settings` | 資料來源等設定 |
| `GET /api/debug/cache` | 看快取筆數，盯記憶體用 |
| `WS /ws/quotes?token=...` | 報價推送 |

WebSocket 認證走 query string 而非 header，因為瀏覽器原生的 WebSocket API
不允許自訂 header——這是規範限制。

**前端每 30 秒要送一次 `ping`。** 這不只是保活：Render 免費方案 15 分鐘沒有
inbound 流量就休眠，而官方明確說明 WebSocket 訊息算 inbound 流量。這個心跳是
「盤中不會睡著」的關鍵，不能省。

---

## 搬家過程中處理掉的三個坑

**1. 當日狀態的換日重置**（`core/state.py`）
`intraday_low_tracker`、`notified_stocks` 這些本質上是「今天」的狀態。在 Streamlit
下它們跟著 session 死掉，你從來不用管；但 FastAPI 會連續跑好幾天不重啟——**昨天的
當日最低價會被當成今天的，Telegram 昨天推過的今天就不推了**。現在每個當日狀態都綁
交易日，讀取時自動偵測換日並重置。

**2. 底線前綴參數不參與 hash**（`core/cache.py`）
`fetch_taiex_intraday(_sdk)` 這種函式，`_sdk` 不可 hash，Streamlit 靠底線前綴跳過它。
沒複製這個行為，那些函式一搬過來就炸。

**3. Streamlit 的多執行緒 workaround 整段消失**
原版 `_fetch_symbol_for_monitor()` 開頭必須 `add_script_run_ctx()` 把 ScriptRunContext
掛到 worker 執行緒，否則 `session_state` 和 `cache_data` 會失效。現在完全不需要——
core 的快取和狀態都是普通的行程層級 Python 物件。

---

## 兩件已知、刻意不改的事

**國定假日行事曆** — `get_history_cutoff_date()` 只用星期幾判斷，春節端午會算錯一天。
原版就有這個限制，搬家階段維持行為一致，不偷偷「修好」，否則無法比對新舊版。

**盤後模式 + db 且 db 尚無今日資料時，漲跌幅會顯示 0%** — 測試時看到台積電
2410 顯示 0.00%，因為當下價格與昨收都取到 09-04 那筆。這與原版邏輯完全一致，
不是搬家造成的。要不要處理是另一個決定。

---

## 下一步（Phase 1）

```bash
npm create vite@latest web -- --template react-ts
```

前端接 `/api/rows` 拿全量、接 `/ws/quotes` 收增量，用 TanStack Table 渲染。
`server/main.py` 已經準備好服務 `web/dist`，本機開發則走 Vite dev server + CORS。
