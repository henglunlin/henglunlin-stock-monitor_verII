/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 後端網址。本機留空走 vite proxy；Vercel 上設成 Render 的網址 */
  readonly VITE_API_BASE?: string
  /** 與後端 APP_SHARED_TOKEN 相同的字串 */
  readonly VITE_APP_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
