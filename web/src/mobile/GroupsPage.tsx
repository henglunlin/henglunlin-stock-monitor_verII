/**
 * 手機版「分類」分頁：完整的分類熱力圖（桌面版 SummaryDashboard 的手機版）。
 *
 * 桌面版點卡片會浮出一個獨立視窗顯示該分類的股票清單；手機版改成原地展開
 * 一個手風琴——螢幕窄，多開一層「視窗蓋視窗」在手機上比在桌面上更容易迷路。
 */
import { useMemo, useState } from 'react'
import { pctOf, useStore } from '../store'
import type { SignalHit } from '../types'
import { SignalBadges } from '../components/SignalBadges'
import { computeGroupStats, tierOf } from './heat'

type SortKey = 'order' | 'ratio' | 'hit'

/** 展開後的個股清單一行空間有限，最多秀 2 個訊號（取優先等級最高的前 2 個） */
function topSignals(signals: SignalHit[] | undefined, max = 2): SignalHit[] {
  if (!signals || signals.length === 0) return []
  return [...signals].sort((a, b) => a.priority - b.priority).slice(0, max)
}

export function GroupsPage({ onOpenStock }: { onOpenStock: (symbol: string) => void }) {
  const { rows, quotes, status } = useStore()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('hit')
  const threshold = status?.settings.rise_threshold ?? 5
  const hot = status?.settings.dashboard_hot_ratio ?? 60
  const groupOrder = useMemo(() => (status?.groups ? Object.keys(status.groups) : []), [status])

  // computeGroupStats 回傳的順序已經是分類原始順序，這裡只在切到其他排序時才重排
  const statsInOrder = useMemo(
    () => computeGroupStats(rows, quotes, groupOrder, threshold),
    [rows, quotes, groupOrder, threshold],
  )
  const stats = useMemo(() => {
    if (sortKey === 'order') return statsInOrder
    const out = [...statsInOrder]
    if (sortKey === 'ratio') out.sort((a, b) => b.ratio - a.ratio || b.hit - a.hit)
    else out.sort((a, b) => b.hit - a.hit || b.ratio - a.ratio)
    return out
  }, [statsInOrder, sortKey])

  const members = useMemo(() => {
    if (!expanded) return []
    return rows
      .filter((r) => r.groups?.includes(expanded) && !r.error)
      .map((r) => {
        const livePrice = quotes[r.code] ?? r.price
        return { ...r, livePrice, livePct: pctOf(r, livePrice) }
      })
      .sort((a, b) => b.livePct - a.livePct)
  }, [rows, quotes, expanded])

  if (stats.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-zinc-500">
        尚無分類資料。確認 stock_groups.json 有內容，或到「設定」手動更新即時資料。
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-4 pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-500">
        <span>
          統計門檻：漲幅 ≥ {threshold}%　·　達標 ≥ {hot}% 轉紅　·　點分類展開股票清單
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-zinc-600">排序</span>
          {(
            [
              ['order', '分類順序'],
              ['ratio', '達標比例'],
              ['hit', '達標檔數'],
            ] as [SortKey, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSortKey(k)}
              className={`rounded border px-1.5 py-0.5 ${
                sortKey === k ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-transparent text-zinc-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {stats.map((g) => {
          const t = tierOf(g.ratio, hot)
          const open = expanded === g.name
          return (
            <div key={g.name} className={`rounded-lg border ${t.border} ${t.bg}`}>
              <button
                onClick={() => setExpanded(open ? null : g.name)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
              >
                <span className="w-3 shrink-0 text-zinc-500">{open ? '▾' : '▸'}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{g.name}</span>
                <span className={`shrink-0 rounded px-1.5 py-[2px] text-[11px] font-semibold tabular-nums ${t.badge}`}>
                  {g.ratio.toFixed(0)}%
                </span>
                <span className={`shrink-0 font-mono text-lg tabular-nums ${t.accent}`}>
                  {g.hit}
                  <span className="text-sm text-zinc-600"> /{g.total}</span>
                </span>
              </button>

              {/* 該分類前三名漲幅，不管手風琴有沒有展開都顯示——跟桌面版儀表板卡片一樣 */}
              {g.top3.length > 0 && (
                <div className="border-t border-dashed border-zinc-800/70 px-3 py-1.5 text-[11px] leading-relaxed text-zinc-100">
                  {g.top3.map((r, i) => (
                    <span key={r.symbol}>
                      {i > 0 && <span className="text-zinc-700"> | </span>}
                      <span className="font-mono text-white">{r.code}</span>{' '}
                      <span className="text-white">{r.name}</span>{' '}
                      <span
                        className={`font-mono tabular-nums ${
                          g.top3Pct[i] > 0 ? 'text-rose-400' : g.top3Pct[i] < 0 ? 'text-emerald-400' : ''
                        }`}
                      >
                        {g.top3Pct[i] > 0 ? '+' : ''}
                        {g.top3Pct[i].toFixed(1)}%
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {open && (
                <div className="border-t border-zinc-800/70">
                  {members.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-zinc-500">這個分類目前沒有算得出結果的股票。</div>
                  ) : (
                    members.map((r) => {
                      const signals = topSignals(r.signals)
                      return (
                        <button
                          key={r.symbol}
                          onClick={() => onOpenStock(r.symbol)}
                          className="flex w-full flex-col gap-1 border-b border-zinc-900/70 px-3 py-2 text-left last:border-b-0 active:bg-zinc-900/60"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono text-xs text-zinc-500">{r.code}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-zinc-100">{r.name}</span>
                            <span className="shrink-0 font-mono text-xs tabular-nums text-zinc-300">{r.livePrice.toFixed(2)}</span>
                            <span
                              className={`shrink-0 font-mono text-xs tabular-nums ${
                                r.livePct > 0 ? 'text-rose-400' : r.livePct < 0 ? 'text-emerald-400' : 'text-zinc-500'
                              }`}
                            >
                              {r.livePct > 0 ? '+' : ''}
                              {r.livePct.toFixed(2)}%
                            </span>
                          </div>
                          {/* 沒有訊號的股票不畫這行，避免展開的清單被空白徽章撐長 */}
                          {signals.length > 0 && (
                            <div className="pl-2">
                              <SignalBadges signals={signals} />
                            </div>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
