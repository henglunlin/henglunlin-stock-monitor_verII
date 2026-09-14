/**
 * 分類熱力計算。從桌面版 SummaryDashboard.tsx 抽出來的純函式版本，讓手機版
 * 「總覽」（只取前幾名）與「分類」（全部）共用同一份邏輯，不必各自算一次、
 * 也不會兩邊算出不一致的結果。
 *
 * 這裡只是「數有幾檔的 pct 超過門檻」的聚合計數，沒有任何訊號判斷或技術指標
 * 公式——真正的公式（KD、訊號、買入區間）全是後端算好送過來的，這支沒有
 * 重算任何一個，不違反「訊號公式只留在 Python」原則。
 */
import { pctOf } from '../store'
import type { Row } from '../types'

export interface GroupStat {
  name: string
  total: number
  hit: number
  up: number
  down: number
  ratio: number
  hitNames: string[]
  top3: Row[]
  top3Pct: number[]
}

export function computeGroupStats(
  rows: Row[],
  quotes: Record<string, number>,
  groupOrder: string[],
  threshold: number,
): GroupStat[] {
  const live = rows.map((r) => {
    const price = quotes[r.code] ?? r.price
    return { row: r, pct: pctOf(r, price) }
  })

  return groupOrder.map((name) => {
    const members = live.filter((x) => x.row.groups?.includes(name) && !x.row.error)
    const hits = members.filter((x) => x.pct >= threshold)
    const ups = members.filter((x) => x.pct > 0 && x.pct < threshold)
    const downs = members.filter((x) => x.pct < 0)
    const total = members.length
    const sorted = [...members].sort((a, b) => b.pct - a.pct).slice(0, 3)
    return {
      name,
      total,
      hit: hits.length,
      up: ups.length,
      down: downs.length,
      ratio: total > 0 ? (hits.length / total) * 100 : 0,
      hitNames: hits.map((x) => x.row.name),
      top3: sorted.map((x) => x.row),
      top3Pct: sorted.map((x) => x.pct),
    }
  })
}

/** 依達標比例分三級的樣式（沿用桌面版 SummaryDashboard 的配色與門檻語意） */
export function tierOf(ratio: number, hot: number) {
  if (ratio >= hot) {
    return {
      accent: 'text-rose-400',
      border: 'border-rose-500/45',
      bg: 'bg-rose-500/[0.07]',
      badge: 'bg-rose-500 text-zinc-950',
    }
  }
  if (ratio > 0) {
    return {
      accent: 'text-amber-400',
      border: 'border-amber-500/40',
      bg: 'bg-amber-500/[0.05]',
      badge: 'bg-amber-400 text-zinc-950',
    }
  }
  return {
    accent: 'text-emerald-400',
    border: 'border-zinc-800',
    bg: 'bg-transparent',
    badge: 'border border-emerald-500/60 text-emerald-300',
  }
}
