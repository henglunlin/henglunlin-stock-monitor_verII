/**
 * 訊號徽章群。
 *
 * 取代原本 Streamlit 那段 CSS hack —— 你為了把賣出訊號的標籤染綠，
 * 得寫 `span[aria-label="..."]` 加 `:has()` 去猜 Streamlit 內部的 DOM 結構，
 * 而且註解裡還記錄了「有焦點的第一個標籤沒有 aria-label」這種踩過的坑。
 *
 * 現在 DOM 是你自己的，直接給 class 就好。
 *
 * 顏色沿用台股慣例與原本的分類：買進紅、賣出綠。
 * 優先等級 1 的訊號加外框強調（那是「布林縮窄突破 / 反向島狀 / 下降趨勢線突破」）。
 */
import type { SignalHit } from '../types'

export function SignalBadges({ signals }: { signals: SignalHit[] }) {
  if (!signals || signals.length === 0) return <span className="text-zinc-600">—</span>

  const top = Math.min(...signals.map((s) => s.priority))

  return (
    <div className="flex flex-wrap gap-1">
      {signals.map((s, i) => {
        const isBuy = s.kind === 'buy'
        const isTop = s.priority === top
        const base = isBuy
          ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
          : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
        const emphasis = isTop && s.priority === 1 ? 'ring-1 ring-amber-400/60' : ''
        return (
          <span
            key={`${s.label}-${i}`}
            title={s.detail}
            className={`inline-flex items-center rounded border px-1.5 py-[1px] text-[11px] leading-4 whitespace-nowrap ${base} ${emphasis} ${
              isTop ? '' : 'opacity-45'
            }`}
          >
            {s.label}
          </span>
        )
      })}
    </div>
  )
}
