/**
 * 全域狀態（Zustand）。
 *
 * 設計重點：**報價與整列資料分開存放。**
 *
 * rows   來自慢線（每 20 秒），含指標、訊號、目標價，重
 * quotes 來自快線（每 300ms），只有 {代碼: 價格}，輕
 *
 * 表格渲染時把兩者疊起來：價格優先取 quotes，其餘欄位取 rows。
 * 這樣快線進來只會讓「價格那一格」重繪，不會動到整列 —— 這就是
 * 「只有變動的格子會閃」的實作方式，也是跟 Streamlit 整頁重跑最根本的差別。
 */
import { create } from 'zustand'
import type { ConnState, Row, Status } from './types'

interface AppStore {
  rows: Row[]
  /** 快線覆蓋的即時價 */
  quotes: Record<string, number>
  /** 每檔上次變動的方向與時間戳，用來決定閃紅還是閃綠 */
  flash: Record<string, { dir: 'up' | 'down'; at: number }>
  status: Status | null
  conn: ConnState
  wakeAttempt: number
  error: string | null
  selected: string | null

  setRows: (rows: Row[]) => void
  applyQuotes: (data: Record<string, number>) => void
  setStatus: (s: Status) => void
  setConn: (c: ConnState) => void
  setWakeAttempt: (n: number) => void
  setError: (e: string | null) => void
  select: (symbol: string | null) => void
  /** 疊合後的當前價 */
  priceOf: (row: Row) => number
}

export const useStore = create<AppStore>((set, get) => ({
  rows: [],
  quotes: {},
  flash: {},
  status: null,
  conn: 'waking',
  wakeAttempt: 0,
  error: null,
  selected: null,

  setRows: (rows) => set({ rows }),

  applyQuotes: (data) =>
    set((state) => {
      const quotes = { ...state.quotes }
      const flash = { ...state.flash }
      const now = Date.now()
      for (const [code, price] of Object.entries(data)) {
        const prev = quotes[code]
        if (prev !== undefined && prev !== price) {
          flash[code] = { dir: price > prev ? 'up' : 'down', at: now }
        }
        quotes[code] = price
      }
      return { quotes, flash }
    }),

  setStatus: (status) => set({ status }),
  setConn: (conn) => set({ conn }),
  setWakeAttempt: (wakeAttempt) => set({ wakeAttempt }),
  setError: (error) => set({ error }),
  select: (selected) => set({ selected }),

  priceOf: (row) => {
    const q = get().quotes[row.code]
    return q !== undefined ? q : row.price
  },
}))

/** 依疊合後的價格重算漲跌幅（後端算的是慢線當下的，快線進來要跟著動） */
export function pctOf(row: Row, price: number): number {
  if (!row.yesterday_close) return row.pct
  return ((price / row.yesterday_close - 1) * 100)
}
