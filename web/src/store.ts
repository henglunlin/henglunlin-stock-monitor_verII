/**
 * 全域狀態（Zustand）。
 *
 * 設計重點一：**報價與整列資料分開存放。**
 *
 * rows   來自慢線（預設每 20 秒），含指標、訊號、目標價，重
 * quotes 來自快線（每 300ms），只有 {代碼: 價格}，輕
 *
 * 表格渲染時把兩者疊起來：價格優先取 quotes，其餘欄位取 rows。
 * 這樣快線進來只會讓「價格那一格」重繪，不會動到整列 —— 這就是
 * 「只有變動的格子會閃」的實作方式，也是跟 Streamlit 整頁重跑最根本的差別。
 *
 * 設計重點二：**盤中走勢的線尾自己會長。**
 *
 * 後端每 20 秒送一次取樣過的盤中序列（row.intraday）。但價格格子每 300ms 就在跳，
 * 如果走勢線要等 20 秒才動一次，兩個欄位看起來會互相矛盾。
 *
 * 所以這裡多存一份 tail：快線進來時往後接一個點，收到新的 rows 就清掉
 * （因為那份 intraday 已經把這段時間涵蓋進去了）。畫圖時 intraday.concat(tail)。
 * 後端仍然是唯一的真相來源，tail 只是補上「最後 20 秒」那一段。
 */
import { create } from 'zustand'
import type { ConnState, EventLevel, MarketEvent, Row, Status } from './types'

/** localStorage 讀寫都要包 try/catch：無痕視窗或封鎖 cookie 時會直接丟例外 */
function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存不進去就算了，這只是使用便利性，不是功能 */
  }
}

const LS_GROUPED = 'monitor.grouped.v1'
const LS_COLLAPSED = 'monitor.collapsed.v1'
const LS_TAIEX = 'monitor.taiex.v1'

/** tail 每檔最多留這麼多點，超過就丟掉最舊的（20 秒後 rows 會來把它清空） */
const TAIL_MAX = 12
/** tail 的取樣間隔（毫秒）。跟後端的 20 秒不同——tail 要的就是那段細節 */
const TAIL_SAMPLE_MS = 2000

/** 前端保留的事件數。後端環形緩衝是 500，這裡沒必要更多 */
const MAX_EVENTS = 500

/** 目前疊在最上層的浮動視窗。同時只會有一個。 */
export type ModalKind =
  | { kind: 'none' }
  /** 某個分類的股票清單；name 為 null 代表「全部股票」 */
  | { kind: 'group'; name: string | null }
  /**
   * 單檔詳情。`from` 記住是從哪裡點進來的，關掉時回到那裡：
   *   分類名稱 → 回到那個分類的清單（不然每看一檔就要重點一次分類）
   *   null      → 回到「全部股票」清單
   *   'none'    → 直接關掉回儀表板（從跑馬燈或事件流點進來的情況）
   */
  | { kind: 'detail'; symbol: string; from: string | null | 'none' }
  | { kind: 'settings' }
  | { kind: 'login' }
  /** 股票分類編輯器 */
  | { kind: 'groups' }
  /** 完整事件流面板 */
  | { kind: 'events' }

interface AppStore {
  rows: Row[]
  /** 快線覆蓋的即時價 */
  quotes: Record<string, number>
  /** 每檔上次變動的方向與時間戳，用來決定閃紅還是閃綠 */
  flash: Record<string, { dir: 'up' | 'down'; at: number }>
  /** 慢線那包 intraday 之後累積的點，見檔頭說明 */
  tail: Record<string, number[]>
  status: Status | null
  conn: ConnState
  wakeAttempt: number
  error: string | null
  lastUpdate: number

  /** 盤中事件流，最新的在前面 */
  events: MarketEvent[]
  /** 事件流面板的種類篩選；空集合代表全部 */
  eventFilter: Set<EventLevel>

  /** 暫停畫面更新：快線照收但不套用，畫面凍結方便細看（Streamlit 版「啟用自動更新」的等價物） */
  paused: boolean
  /** 目前的浮動視窗 */
  modal: ModalKind
  /** 加權指數走勢是否展開 */
  taiexOpen: boolean

  /** 分類清單視窗裡：是否依分類分區顯示 */
  grouped: boolean
  collapsed: Record<string, boolean>
  scrollTo: string | null

  setRows: (rows: Row[]) => void
  applyQuotes: (data: Record<string, number>) => void
  setStatus: (s: Status) => void
  setConn: (c: ConnState) => void
  setWakeAttempt: (n: number) => void
  setError: (e: string | null) => void
  setPaused: (v: boolean) => void
  setEvents: (e: MarketEvent[]) => void
  pushEvents: (e: MarketEvent[]) => void
  toggleEventFilter: (level: EventLevel) => void
  clearEventFilter: () => void
  openModal: (m: ModalKind) => void
  closeModal: () => void
  setTaiexOpen: (v: boolean) => void
  setGrouped: (v: boolean) => void
  toggleCollapsed: (name: string) => void
  setAllCollapsed: (v: boolean, names: string[]) => void
  requestScrollTo: (name: string | null) => void
  /** 疊合後的當前價 */
  priceOf: (row: Row) => number
  /** 疊合後的盤中走勢（後端序列 + 本地線尾） */
  seriesOf: (row: Row) => number[]
}

let lastTailAt = 0

export const useStore = create<AppStore>((set, get) => ({
  rows: [],
  quotes: {},
  flash: {},
  tail: {},
  status: null,
  conn: 'waking',
  wakeAttempt: 0,
  error: null,
  lastUpdate: 0,
  events: [],
  eventFilter: new Set<EventLevel>(),
  paused: false,
  modal: { kind: 'none' },
  taiexOpen: readLS<boolean>(LS_TAIEX, true),
  grouped: readLS<boolean>(LS_GROUPED, true),
  collapsed: readLS<Record<string, boolean>>(LS_COLLAPSED, {}),
  scrollTo: null,

  // 新的 rows 已經涵蓋到「後端算這包的當下」，本地 tail 的使命結束，清掉。
  setRows: (rows) => set({ rows, tail: {}, lastUpdate: Date.now() }),

  applyQuotes: (data) =>
    set((state) => {
      if (state.paused) return {}          // 暫停時整包丟掉，不累積、不補畫
      const quotes = { ...state.quotes }
      const flash = { ...state.flash }
      const now = Date.now()
      // tail 是每 TAIL_SAMPLE_MS 才長一點——快線 300ms 一次，全部都存會讓
      // 迷你圖被幾百個點塞爆，而 96px 寬根本畫不出差別。
      const grow = now - lastTailAt >= TAIL_SAMPLE_MS
      const tail = grow ? { ...state.tail } : state.tail
      if (grow) lastTailAt = now

      for (const [code, price] of Object.entries(data)) {
        const prev = quotes[code]
        if (prev !== undefined && prev !== price) {
          flash[code] = { dir: price > prev ? 'up' : 'down', at: now }
        }
        quotes[code] = price
        if (grow) {
          const buf = tail[code] ? [...tail[code], price] : [price]
          tail[code] = buf.length > TAIL_MAX ? buf.slice(buf.length - TAIL_MAX) : buf
        }
      }
      return grow ? { quotes, flash, tail, lastUpdate: now } : { quotes, flash, lastUpdate: now }
    }),

  setStatus: (status) => set({ status }),
  setConn: (conn) => set({ conn }),
  setWakeAttempt: (wakeAttempt) => set({ wakeAttempt }),
  setError: (error) => set({ error }),
  setPaused: (paused) => set({ paused }),

  // 全量覆蓋（剛連上時的 hello，或手動抓 /api/events）
  setEvents: (events) => set({ events: events.slice(0, MAX_EVENTS) }),

  // 增量：新的接在最前面。後端已經過三道閘門，這裡不再重複判斷要不要顯示。
  pushEvents: (incoming) =>
    set((state) => {
      if (!incoming.length) return {}
      // 後端重連時可能重送，用 id 去重——事件 id 是後端單調遞增的
      const seen = new Set(state.events.map((e) => e.id))
      const fresh = incoming.filter((e) => !seen.has(e.id))
      if (!fresh.length) return {}
      const merged = [...fresh.reverse(), ...state.events]
      return { events: merged.slice(0, MAX_EVENTS) }
    }),

  toggleEventFilter: (level) =>
    set((state) => {
      const next = new Set(state.eventFilter)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return { eventFilter: next }
    }),

  clearEventFilter: () => set({ eventFilter: new Set<EventLevel>() }),

  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: { kind: 'none' } }),

  setTaiexOpen: (taiexOpen) => {
    writeLS(LS_TAIEX, taiexOpen)
    set({ taiexOpen })
  },

  setGrouped: (grouped) => {
    writeLS(LS_GROUPED, grouped)
    set({ grouped })
  },

  toggleCollapsed: (name) =>
    set((state) => {
      const collapsed = { ...state.collapsed, [name]: !state.collapsed[name] }
      writeLS(LS_COLLAPSED, collapsed)
      return { collapsed }
    }),

  setAllCollapsed: (v, names) => {
    const collapsed: Record<string, boolean> = {}
    for (const n of names) collapsed[n] = v
    writeLS(LS_COLLAPSED, collapsed)
    set({ collapsed })
  },

  requestScrollTo: (scrollTo) => set({ scrollTo }),

  priceOf: (row) => {
    const q = get().quotes[row.code]
    return q !== undefined ? q : row.price
  },

  seriesOf: (row) => {
    const t = get().tail[row.code]
    const base = row.intraday ?? []
    if (base.length === 0) return t ?? []
    return t && t.length ? base.concat(t) : base
  },
}))

/** 依疊合後的價格重算漲跌幅（後端算的是慢線當下的，快線進來要跟著動） */
export function pctOf(row: Row, price: number): number {
  if (!row.yesterday_close) return row.pct
  return (price / row.yesterday_close - 1) * 100
}
