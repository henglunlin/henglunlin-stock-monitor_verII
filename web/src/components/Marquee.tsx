/**
 * 盤中訊號跑馬燈。
 *
 * ⚠️ 它刻意**不會橫向捲動**，雖然叫跑馬燈。
 * ----------------------------------------
 * 會捲動的字讀不了：你不能掃視，只能等它捲過來，而且捲到一半想看清楚就來不及了。
 * 看盤時你要的是「掃一眼就知道剛剛發生什麼」，那需要字是靜止的。
 *
 * 所以這裡的「動」發生在**新訊號進來的那一刻**：最新一則插到最前面、其餘往後推，
 * 新的那則閃一下（1.2 秒的高亮）。動態感有了，可讀性沒有犧牲。每一則都能點，
 * 點了直接開該檔的個股詳情。
 *
 * 三欄並列：一列只放一則會浪費掉寬螢幕左右兩大片空白，而訊號密集的時候
 * 三則根本不夠看。改成三欄之後同時看得到 9 則，而每一則仍然是完整一行、
 * 不截斷關鍵欄位。視窗變窄會自動降成兩欄、單欄。
 *
 * 排列順序是**由左至右、再換行**（最新的在左上角），跟閱讀方向一致。
 *
 * 只顯示 marquee=true 的事件（後端 core/events.py 的 MARQUEE_LEVELS 決定，
 * 目前是拉抬／反彈／即將漲停／已觸及漲停）。預警與跌停只進事件流面板——
 * 跑馬燈是「一眼就要看懂」的地方，放太多種類等於沒有跑馬燈。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { EventLevel, MarketEvent } from '../types'

/** 每一種訊號的視覺。識別不只靠顏色——每一則前面都有 emoji 標籤與文字。 */
const TONE: Record<EventLevel, { border: string; bg: string; text: string }> = {
  limit_up_hit: { border: 'border-rose-400/70', bg: 'bg-rose-500/[0.14]', text: 'text-rose-300' },
  limit_up: { border: 'border-rose-500/45', bg: 'bg-rose-500/[0.08]', text: 'text-rose-400' },
  entry: { border: 'border-amber-500/50', bg: 'bg-amber-500/[0.08]', text: 'text-amber-300' },
  rebound: { border: 'border-sky-500/45', bg: 'bg-sky-500/[0.07]', text: 'text-sky-300' },
  limit_down_hit: { border: 'border-emerald-400/60', bg: 'bg-emerald-500/[0.10]', text: 'text-emerald-300' },
  limit_down: { border: 'border-emerald-500/40', bg: 'bg-emerald-500/[0.06]', text: 'text-emerald-400' },
  warning: { border: 'border-zinc-700', bg: 'bg-transparent', text: 'text-zinc-400' },
}

/** 三欄 × 三列。訊號密集時 3 則不夠看，9 則剛好是一眼掃得完的量 */
const SHOW = 9
const FLASH_MS = 1200

function Line({ e, fresh, onClick }: { e: MarketEvent; fresh: boolean; onClick: () => void }) {
  const t = TONE[e.level] ?? TONE.warning
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-baseline gap-2.5 rounded border px-2.5 py-1 text-left text-xs transition-colors duration-500 ${t.border} ${
        fresh ? 'bg-zinc-100/[0.10]' : t.bg
      } hover:bg-zinc-800/70`}
    >
      <span className="shrink-0 font-mono tabular-nums text-zinc-600">{e.time}</span>
      <span className={`shrink-0 font-medium ${t.text}`}>{e.label}</span>
      <span className="shrink-0 font-mono text-zinc-500">{e.code}</span>
      <span className="shrink-0 font-medium text-zinc-100">{e.name}</span>
      {e.pct != null && (
        <span
          className={`shrink-0 font-mono tabular-nums ${
            e.pct > 0 ? 'text-rose-400' : e.pct < 0 ? 'text-emerald-400' : 'text-zinc-500'
          }`}
        >
          {e.pct > 0 ? '+' : ''}
          {e.pct.toFixed(2)}%
        </span>
      )}
      <span className="truncate text-zinc-400">{e.text}</span>
    </button>
  )
}

export function Marquee() {
  const { events, openModal } = useStore()
  const shown = events.filter((e) => e.marquee).slice(0, SHOW)
  const [freshId, setFreshId] = useState<number | null>(null)
  const lastTop = useRef<number | null>(null)

  // 最上面那則換人時閃一下。用 id 比對而不是陣列長度——
  // 事件到達 500 上限之後長度就不再變了，但內容還是一直在換。
  useEffect(() => {
    const top = shown[0]?.id ?? null
    if (top !== null && top !== lastTop.current) {
      lastTop.current = top
      setFreshId(top)
      const t = setTimeout(() => setFreshId(null), FLASH_MS)
      return () => clearTimeout(t)
    }
  }, [shown])

  const total = events.length

  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-zinc-800 bg-zinc-900/30 px-4 py-2">
      <div className="flex shrink-0 items-baseline gap-2 pt-1">
        <span className="text-xs font-semibold text-zinc-300">🔔 盤中訊號</span>
      </div>

      {shown.length === 0 ? (
        <div className="min-w-0 flex-1 px-2.5 py-1 text-xs text-zinc-500">
          目前沒有盤中訊號。偵測器每秒掃描一次，觸發時會出現在這裡。
        </div>
      ) : (
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((e) => (
            <Line
              key={e.id}
              e={e}
              fresh={e.id === freshId}
              onClick={() => openModal({ kind: 'detail', symbol: e.symbol, from: 'none' })}
            />
          ))}
        </div>
      )}

      <button
        onClick={() => openModal({ kind: 'events' })}
        className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        title="展開完整事件流（含預警與跌停）"
      >
        全部訊號 {total > 0 && <span className="font-mono tabular-nums text-zinc-500">{total}</span>}
      </button>
    </div>
  )
}
