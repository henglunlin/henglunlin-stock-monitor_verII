/**
 * 手機版「訊號」分頁。時間倒序的盤中事件流，加上已讀／未讀（僅存在這台裝置的
 * localStorage，見 store.ts 的 readEventIds）。
 *
 * 篩選 chip 只留系統真的有在追蹤的即時事件種類（三輪問答 Round 3 定案）：
 *   全部 / 未讀 / 漲跌停（漲停+跌停 4 種 level 合併）/ 急拉（拉抬+反彈合併）/ 自選異動
 * 「爆量」「目標價」沒有實作成即時事件（連桌面版 Telegram 即時推播都沒有這兩種
 * level），所以這裡沒有這兩個 chip，避免做出一個看起來能篩、其實永遠是空的按鈕。
 *
 * ⚠️「自選異動」目前功能上約等於「全部」——因為 Round 2 定案的自選範圍就是
 * 「所有分類的聯集」，而後端送出的事件本來就只會是被追蹤（＝屬於某分類）的股票。
 * 這裡仍然做成獨立 chip，一來跟规劃文件的 5 個 chip 對得上、二來將來如果自選
 * 真的變成獨立清單，這顆 chip 的邏輯已經在，不用重寫。
 */
import { useMemo } from 'react'
import { useStore } from '../store'
import type { EventLevel, MarketEvent } from '../types'

type SignalFilter = 'all' | 'unread' | 'limit' | 'surge' | 'watchlist'

const FILTERS: { key: SignalFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未讀' },
  { key: 'limit', label: '漲跌停' },
  { key: 'surge', label: '急拉' },
  { key: 'watchlist', label: '自選異動' },
]

const LIMIT_LEVELS: EventLevel[] = ['limit_up_hit', 'limit_down_hit', 'limit_up', 'limit_down']
const SURGE_LEVELS: EventLevel[] = ['entry', 'rebound']

const LEVEL_STYLE: Record<EventLevel, string> = {
  limit_up_hit: 'text-rose-300',
  limit_up: 'text-rose-400',
  entry: 'text-amber-300',
  rebound: 'text-sky-300',
  warning: 'text-zinc-400',
  limit_down: 'text-emerald-400',
  limit_down_hit: 'text-emerald-300',
}

function matches(e: MarketEvent, f: SignalFilter, readIds: Set<number>): boolean {
  switch (f) {
    case 'all':
      return true
    case 'unread':
      return !readIds.has(e.id)
    case 'limit':
      return LIMIT_LEVELS.includes(e.level)
    case 'surge':
      return SURGE_LEVELS.includes(e.level)
    case 'watchlist':
      return e.groups.length > 0
  }
}

export function SignalsPage({
  filter,
  onFilterChange,
  onOpenStock,
}: {
  filter: SignalFilter
  onFilterChange: (f: SignalFilter) => void
  onOpenStock: (symbol: string) => void
}) {
  const { events, readEventIds, markEventsRead } = useStore()

  const unreadCount = useMemo(() => events.filter((e) => !readEventIds.has(e.id)).length, [events, readEventIds])

  const shown = useMemo(
    () => events.filter((e) => matches(e, filter, readEventIds)),
    [events, filter, readEventIds],
  )

  function openStock(e: MarketEvent) {
    markEventsRead([e.id])
    onOpenStock(e.symbol)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 px-3 py-2 text-[11px]">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => onFilterChange(f.key)}
            className={`rounded border px-2 py-1 ${
              filter === f.key ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-transparent text-zinc-500'
            }`}
          >
            {f.label}
            {f.key === 'unread' && unreadCount > 0 && (
              <span className="ml-1 font-mono tabular-nums text-rose-400">{unreadCount}</span>
            )}
          </button>
        ))}
        {unreadCount > 0 && (
          <button
            onClick={() => markEventsRead(events.map((e) => e.id))}
            className="ml-auto rounded border border-zinc-700 px-2 py-1 text-zinc-400"
          >
            全部標為已讀
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-xs text-zinc-500">
            {events.length === 0 ? '今天還沒有盤中事件。偵測器每秒掃描一次，觸發時會即時出現在這裡。' : '目前的篩選條件沒有符合的事件。'}
          </div>
        ) : (
          shown.map((e) => {
            const unread = !readEventIds.has(e.id)
            return (
              <button
                key={e.id}
                onClick={() => openStock(e)}
                className="flex w-full items-start gap-2 border-b border-zinc-900 px-3 py-2.5 text-left active:bg-zinc-900/60"
              >
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${unread ? 'bg-rose-500' : 'bg-transparent'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-[11px] tabular-nums text-zinc-600">{e.time}</span>
                    <span className={`text-xs font-medium ${LEVEL_STYLE[e.level] ?? 'text-zinc-400'}`}>{e.label}</span>
                    <span className="font-mono text-xs text-zinc-500">{e.code}</span>
                    <span className={`text-xs ${unread ? 'text-zinc-100' : 'text-zinc-400'}`}>{e.name}</span>
                    {e.pct != null && (
                      <span className={`font-mono text-xs tabular-nums ${e.pct > 0 ? 'text-rose-400' : e.pct < 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                        {e.pct > 0 ? '+' : ''}
                        {e.pct.toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-500">{e.text}</div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export type { SignalFilter }
