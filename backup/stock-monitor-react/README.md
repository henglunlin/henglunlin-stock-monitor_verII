# 台股監控器 — React 版

用 React 前端取代 Streamlit，主攻**訊號顯示密度與排版自由度**。
後端沿用原本的 Python 邏輯，只是把呼叫者從 Streamlit 換成 FastAPI。

舊的 Streamlit 版留在 [`henglunlin-stock-monitor-FUBAN`](https://github.com/henglunlin/henglunlin-stock-monitor-FUBAN) 並行運作，這個 repo 不影響它。

---

## 架構

```
富邦 Neo WebSocket ─┐
                    ├─→ Render（FastAPI + 富邦 SDK）─→ WebSocket ─→ Vercel（React）
GitHub Actions ─────┘         └─→ Telegram
（排程掃描、資料同步）
```

| 元件 | 放哪 | 費用 |
|---|---|---|
| React 前端 | Vercel | 免費 |
| FastAPI + 富邦 SDK | Render（**Region 選 Singapore**） | 免費 |
| 排程掃描、資料儲存 | GitHub | 免費 |

**月成本 NT$0，不需要開自己的電腦。**

---

## 目錄

```
core/                 純 Python 邏輯層，零 UI 依賴（13 支）
server/               FastAPI 應用層，只做接線（3 支）
web/                  Vite + React + TypeScript 前端
signal_module/        訊號模組（由 GitHub Actions 從 monitor repo 單向同步）
.github/workflows/    同步排程
render.yaml           Render 部署設定
```

---

## 快速開始

**後端**

```bash
pip install -r server/requirements.txt
cp .env.example .env          # 填入 FUBON_PFX_BASE64 等
uvicorn server.main:app --reload --port 8000
```

**前端**（另開一個終端機）

```bash
cd web
npm install
npm run dev                   # http://localhost:5173
```

開發時 Vite 的 proxy 會把 `/api` 與 `/ws` 轉發到 `localhost:8000`，
所以本機不會踩到 CORS。

---

## 環境變數

`.env`（後端，**務必加進 .gitignore**）

```ini
FUBON_PFX_BASE64=MIIK...        # 憑證，唯一放上雲的敏感資料
APP_SHARED_TOKEN=一組夠長的隨機字串
ALLOWED_ORIGINS=https://你的.vercel.app,http://localhost:5173
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
GITHUB_TOKEN=
```

**身分證／密碼／憑證密碼刻意不放環境變數**，改由前端呼叫
`POST /api/fubon/login` 手動輸入，一天一次。這是為了讓帳密留在你手上。

`web/.env`（前端，部署到 Vercel 時設在 Vercel 的 Environment Variables）

```ini
VITE_API_BASE=https://你的服務.onrender.com
VITE_APP_TOKEN=跟上面 APP_SHARED_TOKEN 相同的字串
```

---

## 部署

**Render（後端）** — Region **一定要選 Singapore**，離台灣最近，比美國機房少約 200ms。
用 repo 裡的 `render.yaml`，或手動設定：

- Build：`pip install -r server/requirements.txt`
- Start：`uvicorn server.main:app --host 0.0.0.0 --port $PORT`
- Health Check：`/api/health`

**Vercel（前端）** — Root Directory 設成 `web`，其餘用預設（Vite 會被自動偵測）。

---

## 這個設計的兩個關鍵決定

### 一、快慢兩線

原本 Streamlit 每 3 秒把所有東西重算一次——報價、指標、22 個訊號、整張表重繪。
檔數一多就是這樣拖垮的。現在拆開：

| | 間隔 | 內容 |
|---|---|---|
| **快線** | 300ms | 只推這段時間內變動過的報價，沒變動就完全不發 |
| **慢線** | 20s | 重算技術指標、跑訊號、比對目標價 |

前端收到快線只更新價格那一格，收到慢線才更新整列。這是「只有變動的格子會閃」
與「幾百檔不卡」的來源。

### 二、心跳不是可選的

Render 免費方案 15 分鐘沒有 inbound 流量就休眠，而官方明確說明
**WebSocket 訊息算 inbound 流量**。前端每 30 秒送一次 `ping`，
這是盤中服務不會睡著的唯一機制，拿掉的話午休回來就會斷線。

---

## 訊號模組的同步

`signal_module/` 是從 monitor repo **單向同步**過來的複本，由
`.github/workflows/sync-from-monitor.yml` 每個交易日早上 08:00 自動更新。

**請不要在這個 repo 直接改 `signal_module/`** —— 下次同步會被覆蓋。
要改訊號請到 monitor repo 的「🛠️ 訊號編輯」頁，這邊會自動跟上。

同步的還有 `twse_ohlcv.db`、`stock_groups.json`、`target_price_list.json`、
`trendline_levels.json` 與富邦 whl。

---

## 已知限制（原版就有，刻意維持一致）

**沒有國定假日行事曆** — `get_history_cutoff_date()` 只用星期幾判斷，
春節端午會算錯一天。搬家階段維持與原版相同行為，才能比對新舊版。

**盤後模式 + db 且 db 尚無今日資料時，漲跌幅顯示 0%** — 當下價與昨收都取到
同一筆歷史收盤。與原版邏輯一致，不是新架構造成的。

---

## 進度

- [x] Phase 0 — 後端脫殼：`core/` 13 支 + `server/` 3 支
- [x] Phase 1 — React 骨架、WebSocket、虛擬捲動表格
- [x] Phase 2 — 走勢圖、買入區間量尺、訊號徽章
- [ ] Phase 3 — 左表格右詳情、K 線圖、欄位自訂、手機版
- [ ] 實機驗收：盤中登入富邦，確認 `subscribed_count` 與 `tick_count` 有在跳
