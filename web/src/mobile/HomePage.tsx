/**
 * 手機版「總覽」分頁。桌面版的儀表板整版都是分類卡牆，手機螢幕塞不下——
 * 這裡改成由上到下捲動的摘要：連線狀態、加權指數、整體統計、熱門分類前幾名、
 * 最新盤中訊號預覽。想看完整分類熱力圖或完整事件流，各自有專屬分頁。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { TaiexSnapshot } from '../types'
import { LineChart } from '../components/LineChart'
import { computeGroupStats, tierOf } from './heat'

function ago(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`
  return `${Math.floor(diff / 3600)} 小時前`
}

export function HomePage({ onOpenStock }: { onOpenStock: (symbol: string) => void }) {
  const { rows, quotes, status, conn, events, setMobileTab } = useStore()
  const [taiex, setTaiex] = useState<TaiexSnapshot | null>(null)
  const [, tick] = useState(0)

  const loadTaiex = useCallback(async () => {
    try {
      setTaiex(await api.taiex())
    } catch (e) {
      setTaiex({ available: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    if (conn !== 'open') return
    loadTaiex()
    const t = setInterval(loadTaiex, 20_000)
    return () => clearInterval(t)
  }, [conn, loadTaiex])

  // 每秒重繪，讓「最後資料 N 秒前」跟得上
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const threshold = status?.settings.rise_threshold ?? 5
  const hot = status?.settings.dashboard_hot_ratio ?? 60
  const groupOrder = useMemo(() => (status?.groups ? Object.keys(status.groups) : []), [status])

  const stats = useMemo(
    () => computeGroupStats(rows, quotes, groupOrder, threshold),
    [rows, quotes, groupOrder, threshold],
  )

  const totals = useMemo(
    () =>
      stats.reduce(
        (acc, g) => ({
          hit: acc.hit + g.hit,
          up: acc.up + g.up,
          down: acc.down + g.down,
          total: acc.total + g.total,
        }),
        { hit: 0, up: 0, down: 0, total: 0 },
      ),
    [stats],
  )

  const topGroups = useMemo(
    () => [...stats].sort((a, b) => b.ratio - a.ratio || b.hit - a.hit).slice(0, 5),
    [stats],
  )

  const recentEvents = useMemo(() => events.slice(0, 5), [events])

  const fubon = status?.fubon
  const change = taiex?.change ?? null
  const taiexUp = (change ?? 0) >= 0
  const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-4 pt-3">
      {/* 連線狀態 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              conn === 'open' ? 'bg-emerald-400' : conn === 'error' ? 'bg-rose-500' : 'bg-amber-400 animate-pulse'
            }`}
          />
          {conn === 'open' ? '已連線' : conn === 'waking' ? '喚醒中' : conn === 'connecting' ? '連線中' : conn === 'closed' ? '已斷線' : '連線異常'}
        </span>
        <span>富邦 {fubon?.connected ? `已訂閱 ${fubon.subscribed_count} 檔` : '未連線'}</span>
        <span>最後資料 {ago(fubon?.last_message_at)}</span>
      </div>

      {/* 加權指數 */}
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold text-zinc-200">📈 加權指數</h2>
          {taiex?.available && (
            <span className="text-xs tabular-nums">
              <span className="text-zinc-100">{fmt(taiex.last ?? 0)}</span>{' '}
              <span className={taiexUp ? 'text-rose-400' : 'text-emerald-400'}>
                {taiexUp ? '+' : ''}
                {(taiex.change_pct ?? 0).toFixed(2)}%
              </span>
            </span>
          )}
        </div>
        <div className="mt-2">
          {!taiex ? (
            <div className="h-[110px] animate-pulse rounded bg-zinc-900/50" />
          ) : !taiex.available ? (
            <div className="rounded border border-sky-900/50 bg-sky-950/30 px-3 py-2.5 text-xs text-sky-300">
              {taiex.reason}
            </div>
          ) : (
            <LineChart points={taiex.points ?? []} baseline={taiex.prev_close ?? null} height={110} valueFormat={fmt} />
          )}
        </div>
      </div>

      {/* 整體統計 */}
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
        <h2 className="text-[13px] font-semibold text-zinc-200">📌 整體統計</h2>
        <div className="mt-2 flex items-baseline gap-4 text-xs">
          <span>
            合計 <b className="tabular-nums text-white">{totals.total}</b> 檔次
          </span>
          <span className="text-rose-400">
            達標 <b className="tabular-nums">{totals.hit}</b>
          </span>
          <span className="text-amber-400">
            上漲 <b className="tabular-nums">{totals.up}</b>
          </span>
          <span className="text-emerald-500">
            下跌 <b className="tabular-nums">{totals.down}</b>
          </span>
        </div>
        <p className="mt-1 text-[10px] text-zinc-600">
          統計門檻：漲幅 ≥ {threshold}%　·　達標 ≥ {hot}% 轉紅
        </p>
      </div>

      {/* 熱門分類前 5 名 */}
      <div className="mb-3">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold text-zinc-200">🔥 熱門分類</h2>
          <button onClick={() => setMobileTab('groups')} className="text-[11px] text-zinc-500">
            看全部 ›
          </button>
        </div>
        {topGroups.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            尚無分類資料
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topGroups.map((g) => {
              const t = tierOf(g.ratio, hot)
              return (
                <button
                  key={g.name}
                  onClick={() => setMobileTab('groups')}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left ${t.border} ${t.bg}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{g.name}</span>
                  <span className={`shrink-0 rounded px-1.5 py-[1px] text-[10px] font-semibold tabular-nums ${t.badge}`}>
                    {g.ratio.toFixed(0)}%
                  </span>
                  <span className={`shrink-0 font-mono text-sm tabular-nums ${t.accent}`}>
                    {g.hit}
                    <span className="text-zinc-600"> /{g.total}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 最新盤中訊號 */}
      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold text-zinc-200">🔔 最新訊號</h2>
          <button onClick={() => setMobileTab('signals')} className="text-[11px] text-zinc-500">
            看全部 ›
          </button>
        </div>
        {recentEvents.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            今天還沒有盤中事件
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {recentEvents.map((e) => (
              <button
                key={e.id}
                onClick={() => onOpenStock(e.symbol)}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-left text-xs hover:bg-zinc-900/60"
              >
                <span className="shrink-0 font-mono tabular-nums text-zinc-600">{e.time}</span>
                <span className="shrink-0 text-zinc-300">{e.label}</span>
                <span className="shrink-0 font-mono text-zinc-500">{e.code}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-100">{e.name}</span>
                {e.pct != null && (
                  <span className={`shrink-0 font-mono tabular-nums ${e.pct > 0 ? 'text-rose-400' : e.pct < 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {e.pct > 0 ? '+' : ''}
                    {e.pct.toFixed(2)}%
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
