# -*- coding: utf-8 -*-
"""
server/main.py
==============
FastAPI 進入點。

    本機開發：  uvicorn server.main:app --reload --port 8000
    Render：    uvicorn server.main:app --host 0.0.0.0 --port $PORT

這支檔案只做四件事，全部都是接線，沒有商業邏輯：
    1. 啟動／關閉時建立與收掉 QuoteHub
    2. CORS（前端在 Vercel，後端在 Render，是跨來源）
    3. WebSocket 端點
    4. 服務 React 打包好的靜態檔（如果 web/dist 存在）

⚠️ 為什麼 CORS 一定要設
-----------------------
前端在 https://xxx.vercel.app，後端在 https://xxx.onrender.com，瀏覽器視為
不同來源，預設會擋。開發時 Vite dev server 在 localhost:5173，同樣是跨來源——
所以這個設定你在開發第一天就會需要，不是上線才要處理的事。
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from core import config
from server.api import router as api_router
from server.hub import hub

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
log = logging.getLogger("server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("啟動中…")
    await hub.start()
    log.info("就緒。允許的來源：%s", config.ALLOWED_ORIGINS)
    if not config.APP_SHARED_TOKEN:
        log.warning("⚠️ 未設定 APP_SHARED_TOKEN，API 目前不設防。正式部署請務必設定。")
    yield
    log.info("關閉中…")
    await hub.stop()


app = FastAPI(
    title="台股監控 API",
    description="富邦 WebSocket 即時報價 + 訊號模組，供 React 前端使用",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


# =============================================================================
# WebSocket
# =============================================================================
@app.websocket("/ws/quotes")
async def ws_quotes(websocket: WebSocket, token: str = Query(default="")):
    """
    報價推送通道。

    認證走 query string 而不是 header，因為瀏覽器原生的 WebSocket API
    不允許自訂 header——這是規範限制，不是偷懶。

    訊息格式（server → client）：
        {"type": "hello",  "rows": [...], "status": {...}}   連上時的第一包
        {"type": "quotes", "data": {"2330": 1090.0, ...}}    快線，每 300ms，只含變動
        {"type": "rows",   "data": [ {...}, ... ]}           慢線，每 20 秒，完整列
        {"type": "pong"}                                      回應心跳

    訊息格式（client → server）：
        "ping"      前端每 30 秒送一次。這不只是保活——Render 免費方案
                    15 分鐘沒有 inbound 流量就休眠，而官方明確說明
                    WebSocket 訊息算 inbound 流量。所以這個心跳是
                    「盤中服務不會睡著」的關鍵，不能省。
    """
    expected = config.APP_SHARED_TOKEN
    if expected and token != expected:
        await websocket.close(code=4401, reason="token 不正確")
        return

    await websocket.accept()
    hub.add_client(websocket)

    from core.state import get_state
    try:
        await websocket.send_json({
            "type": "hello",
            "rows": hub.latest_rows(),
            "status": get_state().snapshot_status(),
        })
        while True:
            msg = await websocket.receive_text()
            if msg == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.debug("WebSocket 異常關閉：%s", e)
    finally:
        hub.remove_client(websocket)


# =============================================================================
# 靜態檔：React 打包產物
# =============================================================================
class SPAStaticFiles(StaticFiles):
    """
    單頁應用的靜態檔服務。

    ⚠️ 為什麼不能只用 `StaticFiles(html=True)`
    ------------------------------------------
    `html=True` 只會在「請求的是目錄」時回 index.html，**未知路徑仍然回 404**。
    對 SPA 來說這是錯的：使用者在 /settings 按重新整理、或直接貼一個深層網址，
    瀏覽器會向伺服器要 /settings，伺服器上根本沒有那個檔案。

    正確行為是「找不到檔案就回 index.html」，讓前端路由自己去解析路徑。
    這個坑在本機開發時完全看不出來（Vite dev server 已經幫你處理了），
    上線才會被發現，所以在這裡先擋掉。
    """

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


# 掛在最後，讓 /api 與 /ws 的路由優先比對。
_DIST = Path(config.REPO_ROOT) / "web" / "dist"
if _DIST.exists():
    app.mount("/", SPAStaticFiles(directory=str(_DIST), html=True), name="web")
    log.info("已掛載前端靜態檔：%s", _DIST)
else:
    @app.get("/")
    async def root():
        return {
            "service": "台股監控 API",
            "note": "前端尚未建置（找不到 web/dist）。API 文件在 /docs。",
            "docs": "/docs",
            "health": "/api/health",
        }
