/**
 * REST 客戶端。
 *
 * 兩種執行情境：
 *  1. 本機開發 —— VITE_API_BASE 留空，走同源 /api，由 vite.config.ts 的 proxy
 *     轉發到 localhost:8000。不會踩到 CORS。
 *  2. 正式環境 —— VITE_API_BASE 指向 Render，真的跨來源，由後端的
 *     CORSMiddleware 放行 Vercel 的網域。
 */
import type { Row, Settings, Status } from '../types'

export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN ?? ''

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  // Render 的網址是公開的，沒有這個 header 後端會回 401。
  if (APP_TOKEN) h['X-App-Token'] = APP_TOKEN
  return h
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: headers(
      init.body ? { 'Content-Type': 'application/json', ...(init.headers as object) } : (init.headers as Record<string, string>) ?? {},
    ),
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* 回應不是 JSON，就用 HTTP 狀態碼當訊息 */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

/**
 * 喚醒後端。
 *
 * Render 免費方案 15 分鐘無流量就休眠，冷啟動大約 1 分鐘。這支會重試到成功，
 * 讓前端可以顯示「喚醒中…」而不是白畫面 —— 這正是把前端放 Vercel（而不是
 * 跟後端一起放 Render）換來的體驗。
 */
export async function wakeBackend(
  onAttempt?: (attempt: number) => void,
  maxAttempts = 40,
): Promise<boolean> {
  for (let i = 1; i <= maxAttempts; i++) {
    onAttempt?.(i)
    try {
      const res = await fetch(`${API_BASE}/api/health`)
      if (res.ok) return true
    } catch {
      /* 還在冷啟動，繼續等 */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

export const api = {
  status: () => request<Status>('/api/status'),
  rows: () => request<{ rows: Row[] }>('/api/rows'),
  refreshRows: () => request<{ ok: boolean; count: number; rows: Row[] }>('/api/rows/refresh', { method: 'POST' }),
  groups: () => request<{ groups: Record<string, string[]> }>('/api/groups'),
  settings: () => request<Settings>('/api/settings'),
  patchSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  fubonLogin: (fubon_id: string, password: string, cert_password: string) =>
    request<{ ok: boolean }>('/api/fubon/login', {
      method: 'POST',
      body: JSON.stringify({ fubon_id, password, cert_password }),
    }),
  resubscribe: () => request<{ ok: boolean }>('/api/fubon/resubscribe', { method: 'POST' }),
}

/** WebSocket 網址。token 走 query string —— 瀏覽器原生 WebSocket 不允許自訂 header。 */
export function wsUrl(): string {
  const base = API_BASE || window.location.origin
  const url = new URL('/ws/quotes', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (APP_TOKEN) url.searchParams.set('token', APP_TOKEN)
  return url.toString()
}
