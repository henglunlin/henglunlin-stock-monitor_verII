/**
 * 台股加權指數（TSE）即時走勢。對應 Streamlit 版的 render_taiex_chart()。
 *
 * 資料來自富邦 REST（intraday.quote + intraday.candles），後端每 15 秒快取一次，
 * 所以這裡每 20 秒抓一次不會造成額外的 REST 請求——大多數時候拿到的是快取。
 *
 * 未登入富邦時後端會回 available:false 加一句說明，這裡照著顯示。
 * 這比原版好的一點：**它不會讓整個畫面變成錯誤狀態**，只是這一塊顯示一行字。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { TaiexSnapshot } from '../types'
import { LineChart } from './LineChart'

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-[92px]">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div
        className={`font-mono text-lg font-semibold tabular-nums ${
          tone === 'up' ? 'text-rose-400' : tone === 'down' ? 'text-emerald-400' : 'text-zinc-100'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

export function TaiexPanel() {
  const { taiexOpen, setTaiexOpen, conn, status, paused } = useStore()
  const [data, setData] = useState<TaiexSnapshot | null>(null)
  const loggedIn = status?.fubon.logged_in ?? false

  const load = useCallback(async () => {
    try {
      setData(await api.taiex())
    } catch (e) {
      setData({ available: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    if (conn !== 'open' || !taiexOpen || paused) return
    load()
    const t = setInterval(load, 20_000)
    return () => clearInterval(t)
  }, [conn, taiexOpen, paused, loggedIn, load])

  const change = data?.change ?? null
  const up = (change ?? 0) >= 0
  const sign = up ? '+' : ''
  const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <section className="shrink-0 border-b border-zinc-800">
      <button
        onClick={() => setTaiexOpen(!taiexOpen)}
        className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-zinc-900/60"
      >
        <span className="w-3 text-zinc-500">{taiexOpen ? '▾' : '▸'}</span>
        <h2 className="text-[13px] font-semibold text-zinc-200">📈 台股加權指數（TSE）即時走勢</h2>
        {data?.available && (
          <span className="text-xs tabular-nums text-zinc-500">
            {fmt(data.last ?? 0)}{' '}
            <span className={up ? 'text-rose-400' : 'text-emerald-400'}>
              {sign}
              {(data.change_pct ?? 0).toFixed(2)}%
            </span>
          </span>
        )}
      </button>

      {taiexOpen && (
        <div className="px-4 pb-3">
          {!data ? (
            <div className="h-[180px] animate-pulse rounded-lg bg-zinc-900/50" />
          ) : !data.available ? (
            <div className="rounded-lg border border-sky-900/50 bg-sky-950/30 px-3 py-2.5 text-xs text-sky-300">
              {data.reason}
            </div>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap gap-6">
                <Metric label="加權指數" value={fmt(data.last ?? 0)} />
                <Metric
                  label="漲跌"
                  value={change === null ? '—' : `${sign}${fmt(change)}`}
                  tone={change === null ? undefined : up ? 'up' : 'down'}
                />
                <Metric
                  label="漲跌幅"
                  value={data.change_pct == null ? '—' : `${sign}${data.change_pct.toFixed(2)}%`}
                  tone={data.change_pct == null ? undefined : up ? 'up' : 'down'}
                />
              </div>
              <LineChart
                points={data.points ?? []}
                baseline={data.prev_close ?? null}
                height={180}
                valueFormat={fmt}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
