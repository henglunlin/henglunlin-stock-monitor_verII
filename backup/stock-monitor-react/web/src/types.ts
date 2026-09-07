/**
 * 後端資料型別。
 *
 * 這份目前是手寫的，跟 server/api.py 的 Pydantic model 對應。
 * 之後可以改成從 FastAPI 的 /openapi.json 自動產生
 * （`npx openapi-typescript http://localhost:8000/openapi.json -o src/types.gen.ts`），
 * 那樣後端改欄位前端會立刻編譯失敗，而不是上線才看到一片 undefined。
 * 但那要等欄位定下來再做，Phase 1 階段還在調整，太早導入會綁手綁腳。
 */

/** 單一命中的訊號 */
export interface SignalHit {
  label: string
  /** buy = 買進訊號（紅），sell = 賣出訊號（綠，台股習慣） */
  kind: 'buy' | 'sell'
  /** 1 最重要，3 最次要 */
  priority: number
  detail: string
}

/** 目標價評估結果（後端算好的，前端不重算任何數字） */
export interface TargetInfo {
  symbol: string
  target_price: number
  buy_low: number
  buy_high: number
  stop_loss: number | null
  price: number
  zone: 'stop_loss' | 'in_buy_zone' | 'below' | 'above'
  /** 現價在「停損 → 買入上緣」軸上的相對位置 0~1，畫量尺直接用 */
  position: number | null
}

/** 監控表格的一列 */
export interface Row {
  symbol: string
  code: string
  name: string
  /** 最近 30 根收盤價，畫 sparkline 用 */
  spark: number[]
  price: number
  pct: number
  yesterday_close: number
  open: number | null
  high: number | null
  low: number | null
  ma_range: string
  ma_trend: string
  k: number
  d: number
  price_source: string
  signals: SignalHit[]
  signal_text: string
  target: TargetInfo | null
  updated_at: string
  /** 這一檔計算失敗時才有 */
  error?: string
}

export interface FubonStatus {
  logged_in: boolean
  login_time: string | null
  connected: boolean
  subscribed_count: number
  last_message_at: string | null
  error: string | null
}

export interface Settings {
  realtime_source: string
  history_source: string
  post_market_enabled: boolean
  post_market_source: string
  refresh_sec: number
  broadcast_interval_ms: number
  tg_push_enabled: boolean
  scheduled_push_enabled: boolean
  sync_groups_to_github: boolean
  rise_threshold: number
}

export interface Status {
  trading_date: string
  server_time: string
  fubon: FubonStatus
  groups: Record<string, number>
  tracked_symbols: number
  notified_today: number
  settings: Settings
}

/** WebSocket 收到的訊息 */
export type WsMessage =
  | { type: 'hello'; rows: Row[]; status: Status }
  | { type: 'quotes'; data: Record<string, number> }
  | { type: 'rows'; data: Row[] }
  | { type: 'pong' }

export type ConnState = 'waking' | 'connecting' | 'open' | 'closed' | 'error'
