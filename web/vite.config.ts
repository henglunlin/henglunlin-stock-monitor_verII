import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// 開發時：Vite dev server 在 5173，後端在 8000，是跨來源。
// 這裡設 proxy 讓 /api 與 /ws 都轉發到後端，開發時就不會踩到 CORS；
// 正式環境前端在 Vercel、後端在 Render，那時才真的跨來源，
// 由 FastAPI 的 CORSMiddleware（ALLOWED_ORIGINS）處理。
//
// ⚠️ 為什麼一定要寫 127.0.0.1 而不是 localhost
// ============================================
// Node 17 之後改變了 DNS 解析順序（verbatim 成為預設），`localhost` 會
// **先解析成 IPv6 的 ::1**。而 uvicorn 預設只綁 IPv4 的 127.0.0.1，
// 兩邊對不上就會出現：
//
//     [vite] http proxy error: /api/health
//     AggregateError [ECONNREFUSED]: at internalConnectMultiple (node:net:...)
//
// 這在 Windows 上特別容易中。寫死 127.0.0.1 就完全沒有這個模糊地帶。
// 若你的後端跑在別的位址／port，設環境變數 VITE_BACKEND 覆蓋即可，例如：
//     VITE_BACKEND=http://127.0.0.1:9000 npm run dev
export default defineConfig(({ mode }) => {
  // 用 '.' 而不是 process.cwd()——後者需要 @types/node，這裡沒必要多裝一個型別套件
  const env = loadEnv(mode, '.', '')
  const backend = env.VITE_BACKEND || 'http://127.0.0.1:8000'
  const wsBackend = backend.replace(/^http/, 'ws')

  return {
    plugins: [
      react(),
      tailwindcss(),
      // 手機版的 PWA 支援（Round 3 定案：用套件而不是手刻 manifest + service worker）。
      // 只影響 build 產出多一份 manifest.webmanifest 與一支 sw.js，桌面版行為不變。
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png', 'favicon.ico'],
        manifest: {
          name: '台股監控',
          short_name: '台股監控',
          description: '台股即時報價、訊號與分類監控',
          start_url: '/',
          display: 'standalone',
          background_color: '#09090b',
          theme_color: '#09090b',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // 只快取靜態資源；API／WebSocket 一律走網路，避免看到過期報價
          globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
          navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/ws': { target: wsBackend, ws: true },
      },
    },
    build: {
      // server/main.py 會去 mount repo 根目錄的 web/dist
      outDir: 'dist',
      sourcemap: false,
    },
  }
})
