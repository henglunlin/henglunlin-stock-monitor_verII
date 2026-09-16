/**
 * 手機版個股詳情：從底部滑出的 sheet，取代桌面版置中的 Modal。
 *
 * 內容跟桌面版 StockDetail 大部分共用同一批展示元件（LineChart / SignalBadges /
 * TargetScale 本來就是純陳列元件，不含任何桌面版特有的排版假設），這裡只是
 * 換一個更適合單手操作的外層容器：貼底、可滑掉、標題精簡成一行。
 *
 * K 線訊號圖（3 輪問答定案）：比照桌面版 StockDetail 加「盤中走勢／K 線訊號」
 * 分頁切換，K 線分頁直接重用同一顆 KLineChart.tsx（含它自帶的回看天數／只顯示
 * 今日訊號控制列，手機版不另外精簡），一樣用 React.lazy 延後載入圖表函式庫，
 * 不拖累每次開站的主 bundle；切股票時跟桌面版一樣回到「盤中走勢」分頁。
 *
 * 目標價編輯（3 輪問答定案）：桌面版的 🎯 目標價編輯器是多檔表格，手機版只需要
 * 「當前這一檔」，所以另外做了 TargetMiniForm 這個單檔精簡表單，取代原本只能
 * 唯讀顯示的「買入區間」區塊——沒設定時顯示「+ 設定目標價」，已設定時顯示
 * TargetScale + 「編輯」按鈕，點了才展開表單。
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { pctOf, useStore } from '../store'
import type { IntradaySeries } from '../types'
import { LineChart } from '../components/LineChart'
import { SignalBadges } from '../components/SignalBadges'
import { TargetScale } from '../components/TargetScale'
import { TargetMiniForm } from './TargetMiniForm'

const KLineChart = lazy(() => import('../components/KLineChart').then((m) => ({ default: m.KLineChart })))

type ChartTab = 'intraday' | 'kline'

function Field({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${tone ?? 'text-zinc-200'}`}>{value}</div>
    </div>
  )
}

export function StockSheet({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const { rows, quotes, status } = useStore()
  const [series, setSeries] = useState<IntradaySeries | null>(null)
  const [tab, setTab] = useState<ChartTab>('intraday')
  const [editingTarget, setEditingTarget] = useState(false)
  const row = rows.find((r) => r.symbol === symbol)

  // 切股票時回到「盤中走勢」分頁、收起編輯表單——K 線圖是比較重的評估動作，
  // 不該每開一檔都預設觸發；目標價表單也不該帶著上一檔的編輯狀態跑到下一檔。
  useEffect(() => {
    setTab('intraday')
    setEditingTarget(false)
  }, [symbol])

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
          <div className="mb-2 flex gap-1 text-xs">
            {(
              [
                ['intraday', '盤中走勢'],
                ['kline', 'K 線訊號'],
              ] as [ChartTab, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`rounded border px-2 py-1 ${
                  tab === k
                    ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                    : 'border-transparent text-zinc-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'intraday' ? (
            <LineChart
              points={series?.points ?? []}
              baseline={row.yesterday_close}
              height={220}
              fixedSession={fixedSession}
            />
          ) : (
            <Suspense fallback={<div className="py-10 text-center text-xs text-zinc-500">載入 K 線圖元件中…</div>}>
              <KLineChart symbol={symbol} defaultDays={status?.settings.chart_history_days ?? 90} />
            </Suspense>
          )}

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

          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-zinc-500">
              <span>買入區間</span>
              {!editingTarget && (
                <button
                  onClick={() => setEditingTarget(true)}
                  className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-400"
                >
                  {row.target ? '✏️ 編輯' : '+ 設定目標價'}
                </button>
              )}
            </div>
            {editingTarget ? (
              <TargetMiniForm
                symbol={symbol}
                onSaved={() => setEditingTarget(false)}
                onCancel={() => setEditingTarget(false)}
              />
            ) : row.target ? (
              <TargetScale target={row.target} price={price} />
            ) : (
              <p className="text-xs text-zinc-600">尚未設定目標價</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
