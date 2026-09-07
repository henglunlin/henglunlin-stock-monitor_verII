/**
 * WebSocket 客戶端：心跳保活 + 指數退避自動重連。
 *
 * ⚠️ 心跳不是可選的
 * ------------------
 * Render 免費方案 15 分鐘沒有 inbound 流量就休眠，而官方明確說明
 * **WebSocket 訊息算 inbound 流量**。所以這個每 30 秒的 ping 是
 * 「盤中服務不會睡著」的唯一機制，拿掉的話你午休回來就會發現斷線了。
 *
 * 重連用指數退避（1s → 2s → 4s … 上限 30s），避免後端還在冷啟動時
 * 前端瘋狂重試把它打爆。
 */
import type { WsMessage } from '../types'
import { wsUrl } from './api'

const HEARTBEAT_MS = 30_000
const MAX_BACKOFF_MS = 30_000

export interface WsHandlers {
  onMessage: (msg: WsMessage) => void
  onOpen?: () => void
  onClose?: () => void
  onError?: (e: string) => void
}

export class QuoteSocket {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private stopped = false

  constructor(private handlers: WsHandlers) {}

  connect(): void {
    this.stopped = false
    this.cleanup()
    try {
      this.ws = new WebSocket(wsUrl())
    } catch (e) {
      this.handlers.onError?.(String(e))
      this.scheduleRetry()
      return
    }

    this.ws.onopen = () => {
      this.attempt = 0
      this.handlers.onOpen?.()
      this.heartbeat = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping')
      }, HEARTBEAT_MS)
    }

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage
        if (msg.type === 'pong') return
        this.handlers.onMessage(msg)
      } catch {
        /* 收到不是 JSON 的東西就忽略，不要因此斷線 */
      }
    }

    this.ws.onerror = () => {
      this.handlers.onError?.('WebSocket 連線錯誤')
    }

    this.ws.onclose = (ev) => {
      this.stopHeartbeat()
      this.handlers.onClose?.()
      // 4401 = 後端拒絕 token，重連也沒用，直接停手
      if (ev.code === 4401) {
        this.handlers.onError?.('存取權杖不正確（請確認 VITE_APP_TOKEN 與後端一致）')
        return
      }
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS)
    this.attempt += 1
    this.retry = setTimeout(() => this.connect(), delay)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  private cleanup(): void {
    this.stopHeartbeat()
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null
      try {
        this.ws.close()
      } catch {
        /* 已經關了 */
      }
      this.ws = null
    }
  }

  close(): void {
    this.stopped = true
    this.cleanup()
  }
}
