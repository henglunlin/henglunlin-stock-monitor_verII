/**
 * 完整事件流面板。跑馬燈只放最重要的三、四種，這裡放**全部**——
 * 包含只進事件流、不上跑馬燈的預警與跌停。
 *
 * 時間倒序、可依種類篩選、點任一則跳到該檔詳情。
 *
 * ⚠️ 這條流活在記憶體裡（後端環形緩衝 500 則），Render 免費方案沒有持久磁碟，
 * 服務一重啟就沒了。想要當天的完整紀錄，Telegram 才是持久的那一份——
 * 反正兩邊吃的是同一條流。
 */
import { useMemo } from 'react'
import { useStore } from '../store'
import type { EventLevel } from '../types'
import { Modal } from './Modal'

const LEVELS: { key: EventLevel; label: string; cls: string }[] = [
  { key: 'limit_up_hit', label: '🔴 漲停', cls: 'text-rose-300' },
  { key: 'limit_up', label: '🔺 即將漲停', cls: 'text-rose-400' },
  { key: 'entry', label: '🚀 瞬間拉抬', cls: 'text-amber-300' },
  { key: 'rebound', label: '📈 瞬間反彈', cls: 'text-sky-300' },
  { key: 'warning', label: '⚠️ 預警', cls: 'text-zinc-400' },
  { key: 'limit_down', label: '🔻 即將跌停', cls: 'text-emerald-400' },
  { key: 'limit_down_hit', label: '🟢 跌停', cls: 'text-emerald-300' },
]

export function EventStreamPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { events, eventFilter, toggleEventFilter, clearEventFilter, openModal } = useStore()

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const e of events) c[e.level] = (c[e.level] ?? 0) + 1
    return c
  }, [events])

  const shown = useMemo(
    () => (eventFilter.size === 0 ? events : events.filter((e) => eventFilter.has(e.level))),
    [events, eventFilter],
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="🔔 盤中事件流"
      subtitle="時間倒序　·　點任一則展開該檔詳情　·　跑馬燈只顯示其中最重要的幾種"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 px-4 py-2 text-[11px]">
        <button
          onClick={clearEventFilter}
          className={`rounded border px-2 py-0.5 ${
            eventFilter.size === 0
              ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
              : 'border-transparent text-zinc-500 hover:bg-zinc-800/60'
          }`}
        >
          全部 {events.length}
        </button>
        {LEVELS.map((l) => (
          <button
            key={l.key}
            onClick={() => toggleEventFilter(l.key)}
            className={`rounded border px-2 py-0.5 ${
              eventFilter.has(l.key)
                ? 'border-zinc-600 bg-zinc-800'
                : 'border-transparent hover:bg-zinc-800/60'
            } ${l.cls}`}
          >
            {l.label}{' '}
            <span className="font-mono tabular-nums text-zinc-600">{counts[l.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="flex h-40 items-center justify-center px-6 text-center text-xs text-zinc-600">
            {events.length === 0
              ? '今天還沒有盤中事件。偵測器每秒掃描一次，觸發時會即時出現在這裡。'
              : '目前的篩選條件沒有符合的事件。'}
          </div>
        ) : (
          <table className="w-full text-xs">
            <tbody>
              {shown.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => openModal({ kind: 'detail', symbol: e.symbol, from: 'none' })}
                  className="cursor-pointer border-b border-zinc-900 hover:bg-zinc-900/60"
                >
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono tabular-nums text-zinc-600">
                    {e.time}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 align-top">
                    <span className={LEVELS.find((l) => l.key === e.level)?.cls ?? 'text-zinc-400'}>
                      {e.label}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 align-top">
                    <span className="font-mono text-zinc-500">{e.code}</span>{' '}
                    <span className="text-zinc-100">{e.name}</span>
                    {e.groups.length > 0 && (
                      <span className="ml-1.5 text-[10px] text-zinc-600">{e.groups.join('、')}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 align-top text-right font-mono tabular-nums">
                    <span className="text-zinc-300">{e.price?.toFixed(2) ?? '—'}</span>{' '}
                    {e.pct != null && (
                      <span className={e.pct > 0 ? 'text-rose-400' : e.pct < 0 ? 'text-emerald-400' : 'text-zinc-500'}>
                        {e.pct > 0 ? '+' : ''}
                        {e.pct.toFixed(2)}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-zinc-500">{e.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  )
}
