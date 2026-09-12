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
  /** 今日斷線次數。雲端跨海連線本來就會抖，重點是有沒有自動接回來 */
  disconnect_count: number
  /** 半開連線被抓到的次數。這種斷法不會觸發斷線回呼，disconnect_count 會是 0 */
  stale_count: number
  reconnect_count: number
  reconnect_fail_count: number
  /** 登入 session 失效：重連救不回來，要重新登入 */
  session_dead: boolean
  last_reconnect_at: string | null
  last_reconnect_error: string | null
}

/**
 * /api/debug/github 的回應。
 * **刻意不含 token 本身**，只有長度與前四碼 —— 足夠判斷「有沒有貼錯／多引號」，
 * 又不會在畫面或截圖上洩漏出去。
 */
export interface GithubDebug {
  token_present: boolean
  token_len: number
  token_prefix: string
  token_looks_quoted: boolean
  token_valid?: boolean
  owner?: string
  repo?: string
  branch?: string
  verdict?: string
}

/** /api/debug/fubon 的一筆連線事件 */
export interface ConnLogEntry {
  time: string
  kind: string
  detail: string
}

/** /api/debug/fubon：連線黑盒子。斷線是偶發的，靠這個才不用再靠截圖猜 */
export interface FubonDebug {
  available: boolean
  reason?: string
  logged_in?: boolean
  connected?: boolean
  subscribed_count?: number
  tick_count?: number
  seconds_since_last_message?: number | null
  is_stale?: boolean
  disconnect_count?: number
  stale_count?: number
  reconnect_count?: number
  reconnect_fail_count?: number
  session_dead?: boolean
  last_reconnect_error?: string | null
  error?: string | null
  watchdog?: Record<string, number | boolean>
  history?: ConnLogEntry[]
}

/** GET /api/debug/line。設定頁的「LINE 推送狀態」區塊吃這個 */
export interface LineDebug {
  configured: boolean
  has_token: boolean
  has_target: boolean
  /** 收件對象的尾四碼。用來確認「是不是我以為的那個對象」 */
  target_tail: string
  at: string | null
  ok: boolean | null
  status: number | null
  messages: number
  /** 失敗原因。LINE 的狀態碼只說 400/401/429，真正原因在這裡 */
  error: string | null
  /** 目前定時彙整實際會送到哪些管道（兩層閘門都算進去了） */
  digest_targets: { telegram: boolean; line: boolean }
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
  /** Toolbar 的兩顆總開關。關掉該管道就一則都不發 */
  tg_push_enabled: boolean
  line_push_enabled: boolean
  scheduled_push_enabled: boolean
  /** 定時推播時段，格式 "HH:MM" */
  push_slots: string[]
  /** 定時彙整要送哪些管道（下層閘門，還要看上面兩顆總開關） */
  digest_to_telegram: boolean
  digest_to_line: boolean
  /** LINE 訊息格式。'text' = 純文字（預設）、'flex' = 卡片 */
  line_message_format: 'text' | 'flex'
  /** LINE 每檔最多列幾個訊號（省月額度）。Telegram 不受限 */
  line_max_signals_per_stock: number
  /** 盤中事件要推 Telegram 的最低優先權。即時事件刻意不走 LINE */
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
  fubon_watchdog_enabled: boolean
  fubon_stale_sec: number
  fubon_watchdog_interval_sec: number
  fubon_ws_ping_sec: number
  fubon_ws_ping_timeout_sec: number
  fubon_connect_timeout_sec: number
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
