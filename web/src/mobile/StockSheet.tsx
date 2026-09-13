/**
 * 手機版個股詳情：從底部滑出的 sheet，取代桌面版置中的 Modal。
 *
 * 內容跟桌面版 StockDetail 完全共用同一批展示元件（LineChart / SignalBadges /
 * TargetScale 本來就是純陳列元件，不含任何桌面版特有的排版假設），這裡只是
 * 換一個更適合單手操作的外層容器：貼底、可滑掉、標題精簡成一行。
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { pctOf, useStore } from '../store'
import type { IntradaySeries } from '../types'
import { LineChart } from '../components/LineChart'
import { SignalBadges } from '../components/SignalBadges'
import { TargetScale } from '../components/TargetScale'

function Field({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${tone ?? 'text-zinc-200'}`}>{value}</div>
    </div>
  )
}

export function StockSheet({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const { rows, quotes } = useStore()
  const [series, setSeries] = useState<IntradaySeries | null>(null)
  const row = rows.find((r) => r.symbol === symbol)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .intraday(symbol)
        .then((d) => !cancelled && setSeries(d))
        .catch(() => !cancelled && setSeries({ symbol, source: '取得失敗', points: [] }))
    load()
    const t = setInterval(load, 20_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [symbol])

  // 開著時鎖住底層捲動，跟桌面版 Modal 的行為一致
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  if (!row) return null

  const price = quotes[row.code] ?? row.price
  const pct = pctOf(row, price)
  const up = pct >= 0
  const tone = pct > 0 ? 'text-rose-400' : pct < 0 ? 'text-emerald-400' : 'text-zinc-400'
  const fixedSession = series?.source === '富邦分鐘K'

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/70" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-zinc-700 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex shrink-0 justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-zinc-700" />
        </div>
        <div className="flex shrink-0 items-start gap-3 px-4 pb-3 pt-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-zinc-400">{row.code}</span>
              <span className="font-semibold text-zinc-100">{row.name}</span>
              <span className={`font-mono text-base ${tone}`}>{price.toFixed(2)}</span>
              <span className={`font-mono text-sm ${tone}`}>
                {up ? '+' : ''}
                {pct.toFixed(2)}%
              </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-zinc-500">
              走勢來源：{series?.source ?? '讀取中'}　·　更新於 {row.updated_at?.slice(11) ?? '—'}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="關閉"
            className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400"
          >
            關閉
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
          <LineChart
            points={series?.points ?? []}
            baseline={row.yesterday_close}
            height={220}
            fixedSession={fixedSession}
          />

          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
            <Field label="昨收" value={row.yesterday_close?.toFixed(2) ?? '—'} />
            <Field label="開盤" value={row.open?.toFixed(2) ?? '—'} />
            <Field label="最高" value={row.high?.toFixed(2) ?? '—'} tone="text-rose-400/90" />
            <Field label="最低" value={row.low?.toFixed(2) ?? '—'} tone="text-emerald-400/90" />
            <Field label="K / D" value={`${row.k} / ${row.d}`} />
            <Field label="MA 位置" value={row.ma_range} />
            <Field
              label="均線排列"
              value={row.ma_trend}
              tone={row.ma_trend === '多頭' ? 'text-rose-400' : row.ma_trend === '空頭' ? 'text-emerald-400' : undefined}
            />
            <Field label="所屬分類" value={row.groups?.join('、') || '—'} />
          </div>

          <div className="mt-4">
            <div className="mb-1.5 text-[11px] text-zinc-500">買賣訊號</div>
            <SignalBadges signals={row.signals ?? []} />
          </div>

          {row.target && (
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] text-zinc-500">買入區間</div>
              <TargetScale target={row.target} price={price} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
