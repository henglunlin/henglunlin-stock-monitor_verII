/**
 * 手機版「自選」分頁。
 *
 * Round 2 定案：這裡沒有獨立的個人自選清單概念，範圍是「所有分類股票的聯集、
 * 去重後」——功能上等同桌面版工具列的「📋 全部股票」。之所以不做真正的個人
 * 自選，是因為現有後端（stock_groups.json）本來就沒有這個概念，硬做一個
 * 前端專屬的清單只會多一份跟後端對不上的狀態。
 */
import { useMemo, useState } from 'react'
import { pctOf, useStore } from '../store'
import type { Row, SignalHit } from '../types'
import { Sparkline } from '../components/Sparkline'
import { SignalBadges } from '../components/SignalBadges'

type SortKey = 'pct_desc' | 'pct_asc' | 'code'

/** 手機版螢幕窄，一檔最多秀 3 種訊號（取優先等級最高的前 3 個），其餘的不擠進來 */
function topSignals(signals: SignalHit[] | undefined, max = 3): SignalHit[] {
  if (!signals || signals.length === 0) return []
  return [...signals].sort((a, b) => a.priority - b.priority).slice(0, max)
}

export function WatchlistPage({ onOpenStock }: { onOpenStock: (symbol: string) => void }) {
  const { rows, quotes, seriesOf, flash, status } = useStore()
  const [sortKey, setSortKey] = useState<SortKey>('pct_desc')
  const threshold = status?.settings.rise_threshold ?? 5

  const list = useMemo(() => {
    // 聯集去重：一檔股票不管屬於幾個分類，這裡只出現一次
    const seen = new Set<string>()
    const out: (Row & { livePrice: number; livePct: number })[] = []
    for (const r of rows) {
      if (!r.groups || r.groups.length === 0) continue
      if (seen.has(r.symbol)) continue
      seen.add(r.symbol)
      const livePrice = quotes[r.code] ?? r.price
      out.push({ ...r, livePrice, livePct: pctOf(r, livePrice) })
    }
    if (sortKey === 'pct_desc') out.sort((a, b) => b.livePct - a.livePct)
    else if (sortKey === 'pct_asc') out.sort((a, b) => a.livePct - b.livePct)
    else out.sort((a, b) => a.code.localeCompare(b.code))
    return out
  }, [rows, quotes, sortKey])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-2 text-[11px]">
        <span className="text-zinc-500">{list.length} 檔（所有分類聯集去重）</span>
        <div className="ml-auto flex gap-1">
          {(
            [
              ['pct_desc', '漲幅 ▼'],
              ['pct_asc', '漲幅 ▲'],
              ['code', '代碼'],
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

      <div className="min-h-0 flex-1 overflow-auto">
        {list.length === 0 ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-xs text-zinc-500">
            尚無資料。確認分類已加入股票，或到「分類」分頁查看。
          </div>
        ) : (
          list.map((r) => {
            const f = flash[r.code]
            const fresh = f && Date.now() - f.at < 800
            const hit = r.livePct >= threshold
            const live = seriesOf(r)
            const useIntraday = live.length >= 2
            const signals = topSignals(r.signals)
            return (
              <button
                key={r.symbol}
                onClick={() => !r.error && onOpenStock(r.symbol)}
                className={`flex w-full flex-col gap-1.5 border-b border-zinc-900 px-3 py-2.5 text-left ${
                  r.error ? 'opacity-40' : 'active:bg-zinc-900/60'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-16 shrink-0">
                    <div className="font-mono text-xs text-zinc-500">{r.code}</div>
                    <div className="truncate text-xs text-zinc-200">{r.name}</div>
                  </div>
                  <div className="ml-auto shrink-0 text-right">
                    <div
                      className={`rounded px-1 font-mono text-sm tabular-nums transition-colors duration-500 ${
                        fresh ? (f!.dir === 'up' ? 'bg-rose-500/30' : 'bg-emerald-500/30') : ''
                      }`}
                    >
                      {r.livePrice.toFixed(2)}
                    </div>
                    <div
                      className={`font-mono text-xs tabular-nums ${
                        r.livePct > 0 ? 'text-rose-400' : r.livePct < 0 ? 'text-emerald-400' : 'text-zinc-500'
                      } ${hit ? 'font-semibold' : ''}`}
                    >
                      {r.livePct > 0 ? '+' : ''}
                      {r.livePct.toFixed(2)}%
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-[72px] shrink-0">
                    <Sparkline
                      data={useIntraday ? live : r.spark ?? []}
                      up={r.livePct >= 0}
                      baseline={useIntraday ? r.yesterday_close : null}
                      width={72}
                      height={24}
                    />
                  </span>
                  {/* 沒有訊號的股票（大多數）就不畫這排，避免 198 檔的清單被空白徽章塞滿 */}
                  {signals.length > 0 && (
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <SignalBadges signals={signals} />
                    </div>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
