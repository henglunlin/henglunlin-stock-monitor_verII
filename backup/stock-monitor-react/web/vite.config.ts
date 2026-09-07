import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 開發時：Vite dev server 在 5173，後端在 8000，是跨來源。
// 這裡設 proxy 讓 /api 與 /ws 都轉發到後端，開發時就不會踩到 CORS；
// 正式環境前端在 Vercel、後端在 Render，那時才真的跨來源，
// 由 FastAPI 的 CORSMiddleware（ALLOWED_ORIGINS）處理。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  build: {
    // server/main.py 會去 mount repo 根目錄的 web/dist
    outDir: 'dist',
    sourcemap: false,
  },
})
