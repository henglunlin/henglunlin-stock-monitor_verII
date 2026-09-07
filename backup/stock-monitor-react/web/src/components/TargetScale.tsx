/**
 * 買入區間量尺。
 *
 * 把停損、買入下緣、目標價、買入上緣、現價全部畫在同一條軸上，
 * 取代原本 Streamlit 的四個分開數字欄位 —— 那個要在腦中比大小，這個一眼就知道。
 *
 * 所有數字都是後端 core/targets.py 的 evaluate_target_price() 算好的，
 * 前端一個都不重算。這是「訊號公式只留在 Python」原則的一部分。
 */
import type { TargetInfo } from '../types'

const ZONE_LABEL: Record<TargetInfo['zone'], string> = {
  stop_loss: '已跌破停損',
  in_buy_zone: '在買入區間',
  below: '低於買入區間',
  above: '高於買入區間',
}

const ZONE_CLASS: Record<TargetInfo['zone'], string> = {
  stop_loss: 'text-rose-400',
  in_buy_zone: 'text-emerald-400',
  below: 'text-sky-400',
  above: 'text-zinc-400',
}

export function TargetScale({ target, price }: { target: TargetInfo | null; price: number }) {
  if (!target) return <span className="text-zinc-600 text-xs">—</span>

  const lo = target.stop_loss ?? target.buy_low * 0.95
  const hi = target.buy_high * 1.02
  const span = hi - lo || 1
  const at = (v: number) => `${Math.min(Math.max(((v - lo) / span) * 100, 0), 100)}%`

  return (
    <div className="w-full min-w-[150px]">
      <div className="relative h-[7px] rounded-sm bg-zinc-800">
        {/* 買入區間 */}
        <div
          className="absolute inset-y-0 rounded-sm bg-emerald-500/35"
          style={{ left: at(target.buy_low), right: `calc(100% - ${at(target.buy_high)})` }}
        />
        {/* 停損線 */}
        {target.stop_loss !== null && (
          <div className="absolute inset-y-[-2px] w-px bg-rose-500" style={{ left: at(target.stop_loss) }} />
        )}
        {/* 目標價（中心） */}
        <div className="absolute inset-y-[-2px] w-px bg-emerald-300/70" style={{ left: at(target.target_price) }} />
        {/* 現價 */}
        <div
          className="absolute top-1/2 h-[11px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-100 ring-1 ring-zinc-900"
          style={{ left: at(price) }}
        />
      </div>
      <div className={`mt-1 flex justify-between text-[10px] tabular-nums ${ZONE_CLASS[target.zone]}`}>
        <span>{ZONE_LABEL[target.zone]}</span>
        <span className="text-zinc-500">
          {target.buy_low} – {target.buy_high}
        </span>
      </div>
    </div>
  )
}
