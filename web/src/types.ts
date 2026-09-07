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
  /** 這檔屬於哪些分類（一檔可同時屬於多個分類） */
  groups: string[]
  /** 最近 30 根「日線」收盤價。盤前／假日／未登入時的後備走勢 */
  spark: number[]
  /** 今天的「盤中」走勢（每 20 秒一點，最多 40 點）。優先畫這條 */
  intraday: number[]
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
  /** 快線：報價推送節流間隔（毫秒） */
  broadcast_interval_ms: number
  /** 慢線：指標與訊號的重算間隔（秒） */
  row_refresh_sec: number
  /** 偵測線：盤中事件掃描間隔（毫秒） */
  detector_interval_ms: number
  tg_push_enabled: boolean
  scheduled_push_enabled: boolean
  /** 盤中事件要推 Telegram 的最低優先權 */
  tg_event_min_priority: number
  sync_groups_to_github: boolean
  /** 儀表板／表格的顯示門檻 */
  rise_threshold: number
  /** 訊號引擎的門檻。刻意跟上面分開：UI 歸 UI、訊號歸訊號 */
  signal_rise_threshold: number
  /** 儀表板卡片轉紅的達標比例（%） */
  dashboard_hot_ratio: number
  rebound_pct: number
  rebound_cooldown_sec: number
  rebound_open_silence_min: number
  limit_approach_pct: number
  limit_cooldown_sec: number
  entry_bucket_sec: number
  entry_track_sec: number
  entry_volume_ratio: number
  entry_min_volume: number
  entry_min_ticks: number
  entry_buy_pressure: number
  entry_price_move_pct: number
  entry_early_2s_pct: number
  entry_early_5s_pct: number
  entry_early_10s_pct: number
  entry_cooldown_sec: number
  warning_cooldown_sec: number
}

/** 盤中事件的種類。數字越大越重要（見 core/events.py 的 PRIORITY） */
export type EventLevel =
  | 'limit_up_hit'
  | 'limit_down_hit'
  | 'limit_up'
  | 'limit_down'
  | 'entry'
  | 'rebound'
  | 'warning'

export interface MarketEvent {
  id: number
  ts: number
  time: string
  level: EventLevel
  priority: number
  label: string
  symbol: string
  code: string
  name: string
  groups: string[]
  price: number | null
  pct: number | null
  text: string
  /** 是否上跑馬燈。由後端決定，前端不重新判斷 */
  marquee: boolean
}

export interface SymbolHit {
  code: string
  name: string
  symbol: string
}

export interface Status {
  trading_date: string
  server_time: string
  fubon: FubonStatus
  groups: Record<string, number>
  tick_count: number
  tracked_symbols: number
  notified_today: number
  settings: Settings
}

/** 走勢圖的一點 */
export interface Point {
  t: string
  v: number
}

export interface TaiexSnapshot {
  available: boolean
  reason?: string
  last?: number
  prev_close?: number | null
  change?: number | null
  change_pct?: number | null
  points?: Point[]
}

export interface IntradaySeries {
  symbol: string
  source: string
  points: Point[]
}

/** /api/debug/ws 的回應 */
export interface WsDebug {
  available: boolean
  reason?: string
  connected?: boolean
  logged_in?: boolean
  subscribed_count?: number
  tick_count?: number
  pending_dirty?: number
  last_message_at?: string | null
  error?: string | null
  series_symbols?: number
  subscribed_sample?: string[]
  price_sample?: Record<string, number>
  recent_messages?: { symbol: string; time: string; raw: unknown }[]
}

/** /api/debug/detector 的回應 */
export interface DetectorDebug {
  scan_ms?: number
  scanned?: number
  rows?: number
  rebound_muted_now?: boolean
  detector_interval_ms?: number
  ticks?: {
    symbols: number
    buffered_ticks: number
    approx_bytes: number
    total_recorded: number
  }
  thresholds?: Record<string, number>
  event_counts?: Record<string, number>
  sample?: unknown[]
}

/** WebSocket 收到的訊息 */
export type WsMessage =
  | { type: 'hello'; rows: Row[]; status: Status; events?: MarketEvent[] }
  | { type: 'events'; data: MarketEvent[] }
  | { type: 'quotes'; data: Record<string, number> }
  | { type: 'rows'; data: Row[] }
  | { type: 'pong' }

export type ConnState = 'waking' | 'connecting' | 'open' | 'closed' | 'error'
