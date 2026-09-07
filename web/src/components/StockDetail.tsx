/**
 * 單檔詳情浮動視窗。
 *
 * 這是 Streamlit 版完全沒有的東西：原版要看一檔的走勢得另開 Plotly 圖，
 * 一次一檔，而且開了就佔掉整個版面。這裡點一列就浮出來，關掉回到原位，
 * 表格的捲動位置不會跑掉。
 *
 * 走勢優先用富邦分鐘 K（涵蓋 09:00 到現在的完整一天），拿不到才退回
 * 服務自己累積的 tick 序列——後端 core/quotes.get_symbol_intraday() 決定的，
 * 這裡只負責顯示它回報的來源。
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { pctOf, useStore } from '../store'
import type { IntradaySeries } from '../types'
import { LineChart } from './LineChart'
import { Modal } from './Modal'
import { SignalBadges } from './SignalBadges'
import { TargetScale } from './TargetScale'

function Field({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${tone ?? 'text-zinc-200'}`}>{value}</div>
    </div>
  )
}

export function StockDetail({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const { rows, quotes, paused } = useStore()
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
    if (paused) return () => { cancelled = true }
    // 分鐘 K 後端快取 20 秒，這裡同步用 20 秒，等於每次都拿到新鮮的一份
    const t = setInterval(load, 20_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [symbol, paused])

  if (!row) return null

  const price = quotes[row.code] ?? row.price
  const pct = pctOf(row, price)
  const up = pct >= 0
  const tone = pct > 0 ? 'text-rose-400' : pct < 0 ? 'text-emerald-400' : 'text-zinc-400'
  const fixedSession = series?.source === '富邦分鐘K'

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-zinc-400">{row.code}</span>
          <span>{row.name}</span>
          <span className={`font-mono text-base ${tone}`}>{price.toFixed(2)}</span>
          <span className={`font-mono text-sm ${tone}`}>
            {up ? '+' : ''}
            {pct.toFixed(2)}%
          </span>
        </span>
      }
      subtitle={`走勢來源：${series?.source ?? '讀取中'}　·　報價來源：${row.price_source}　·　更新於 ${row.updated_at?.slice(11) ?? '—'}`}
    >
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <LineChart
          points={series?.points ?? []}
          baseline={row.yesterday_close}
          height={260}
          fixedSession={fixedSession}
        />

        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
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

        <div className="mt-5">
          <div className="mb-1.5 text-[11px] text-zinc-500">買賣訊號</div>
          <SignalBadges signals={row.signals ?? []} />
        </div>

        {row.target && (
          <div className="mt-5">
            <div className="mb-1.5 text-[11px] text-zinc-500">買入區間</div>
            <div className="max-w-md">
              <TargetScale target={row.target} price={price} />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
