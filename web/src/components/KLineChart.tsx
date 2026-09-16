/**
 * K 線訊號圖：日K蠟燭圖 + 均線 + 量能 + KD + 當日訊號標註。
 *
 * 用 lightweight-charts（TradingView 開源、~45KB gzip）而不是像 LineChart.tsx
 * 那樣手刻 Canvas——K 線需要蠟燭本體＋量能子圖＋KD 子圖＋十字線＋標記，
 * 這些 lightweight-charts 都原生支援（v5 開始連多子圖都是一級功能，見下），
 * 手刻的成本跟維護負擔划不來；但也不用 Plotly 那種數 MB 的重量級圖表庫。
 *
 * ── 資料來源 ──
 * 打 /api/history/:symbol，後端用跟主表格「買賣訊號」欄位同一套 signal_module
 * 訊號引擎、對過去 N 個交易日逐日重新判定一次（core/signals.py 的
 * compute_historical_signals）。前端這裡不重算任何訊號，只負責畫圖。
 *
 * ── 三個子圖（v5 的 addSeries 第三參數 paneIndex 原生支援多子圖）──
 *   pane 0：蠟燭 + MA5/10/20/60
 *   pane 1：成交量柱 + 5/10 日均量線
 *   pane 2：K / D
 *
 * ── 訊號標記 ──
 * 每天最多只標「優先等級最高」的那組訊號（跟主表格「買賣訊號」欄位同一個
 * 收斂規則），避免同一天疊多個訊號名稱把圖擠爆。買訊號畫在K棒下方（紅／向上
 * 箭頭），賣訊號畫在上方（綠／向下箭頭）——跟台股「紅漲綠跌」的既有配色一致。
 * 哪些訊號要顯示、哪些只在最新一天顯示，後端已經套過設定頁的篩選，這裡拿到
 * 什麼就畫什麼，不重複判斷。
 *
 * ── 趨勢線 ──
 * 後端 core/trendlines.py 用上緣/下緣凸包算出短期/中短期/中長期各一條下降(壓力)
 * 與上升(支撐)趨勢線，這裡各畫成一條兩點虛線、延伸到最新一天，讓人一眼看出
 * 現價相對哪一條線。缺的等級（該區間沒找到合法的線）就不畫。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart, createSeriesMarkers,
  CandlestickSeries, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type MouseEventParams,
  type SeriesMarker, type Time,
} from 'lightweight-charts'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { ChartBar, ChartHistory, SignalCatalogItem, TrendSegment } from '../types'

const DAY_OPTIONS = [60, 90, 120, 180] as const

const UP = '#ef4444'   // 紅：漲／買（台股慣例）
const DOWN = '#10b981' // 綠：跌／賣

/** 趨勢線：下降(壓力) 橘色系、上升(支撐) 青色系，短→長顏色由淺到深，方便同時分辨方向跟等級 */
const TREND_TIERS = ['short', 'mid', 'long'] as const
const TREND_COLORS: Record<'resistance' | 'support', Record<(typeof TREND_TIERS)[number], string>> = {
  resistance: { short: '#fdba74', mid: '#fb923c', long: '#c2410c' },
  support: { short: '#67e8f9', mid: '#22d3ee', long: '#0e7490' },
}

// 回看天數／只顯示今日訊號：記在瀏覽器 localStorage，換股票或重開視窗不會被重置回預設值。
// 是「使用者這台裝置的個人偏好」，刻意不是全域設定（不進 chart_history_days 那個
// 後端設定），也不分股票——跟 useResponsive.ts 的 forceDesktop 是同一種取捨。
const LS_DAYS = 'kline_days'
const LS_SHOW_HISTORICAL_SIGNALS = 'kline_show_historical_signals'

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 私密瀏覽模式或被封鎖時安靜放棄，不影響圖表本身運作 */
  }
}

function toTime(dateStr: string): Time {
  // "YYYY-MM-DD" 字串本身就是 lightweight-charts 接受的 BusinessDay 字串格式，
  // 不需要轉成 UTCTimestamp。
  return dateStr as Time
}

/** 成交量（後端給的是股數）換算成台股慣用的「張」（1 張 = 1000 股），加千分位 */
function fmtVol(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${Math.round(v / 1000).toLocaleString()}張`
}

export function KLineChart({ symbol, defaultDays }: { symbol: string; defaultDays: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const maRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const volMaRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const kdRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const trendRefs = useRef<Record<string, ISeriesApi<'Line'>>>({})
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)

  // 兩者都優先吃 localStorage 記住的上次選擇，沒有才退回 defaultDays / 預設全開
  const [days, setDaysState] = useState(() => readLS(LS_DAYS, defaultDays))
  const [data, setData] = useState<ChartHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 只顯示今日訊號：跟設定頁 chart_historical_suppress_labels（只收斂特定幾個雜訊
  // 訊號）不同，這是圖表這裡自己的開關，一鍵把「過去所有日子」的標記全部藏起來，
  // 只留最新一天——資料本來就都在 bars 裡，純前端過濾，不用重打 API。
  const [showHistoricalSignals, setShowHistoricalSignalsState] = useState(() => readLS(LS_SHOW_HISTORICAL_SIGNALS, true))
  const bars = data?.bars ?? null

  // 訊號篩選面板：哪些訊號要標在圖上，分買/賣兩組勾選。跟設定頁讀同一份
  // /api/signals/catalog、寫同一個 chart_hidden_signal_labels 設定欄位——
  // 這裡是唯一的入口，原本設定頁裡的那份清單已經搬過來，不會有兩邊互相蓋掉的問題。
  const { status, setStatus } = useStore()
  const s = status?.settings
  const [signalCatalog, setSignalCatalog] = useState<SignalCatalogItem[] | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)

  useEffect(() => {
    api.signalCatalog().then((d) => setSignalCatalog(d.signals)).catch(() => setSignalCatalog(null))
  }, [])

  const toggleHiddenSignal = useCallback(
    (label: string) => {
      const current = useStore.getState().status?.settings.chart_hidden_signal_labels ?? []
      const hidden = new Set(current)
      if (hidden.has(label)) hidden.delete(label)
      else hidden.add(label)
      api.patchSettings({ chart_hidden_signal_labels: Array.from(hidden) }).then((next) => {
        const cur = useStore.getState().status
        if (cur) setStatus({ ...cur, settings: next })
      })
    },
    [setStatus],
  )

  const hiddenSignalCount = s?.chart_hidden_signal_labels.length ?? 0

  function setDays(d: number) {
    setDaysState(d)
    writeLS(LS_DAYS, d)
  }
  function setShowHistoricalSignals(v: boolean) {
    setShowHistoricalSignalsState(v)
    writeLS(LS_SHOW_HISTORICAL_SIGNALS, v)
  }

  // 滑鼠移到K棒上要能查出「當天完整訊號明細」，但下面建圖表的 effect 只在掛載時跑
  // 一次，訂閱的 handler 閉包抓到的會是掛載當下的 bars（很快就是舊資料）——用 ref
  // 讓 handler 隨時讀得到最新一份，不用把 chart-建立 effect 也綁進 bars 依賴、
  // 每次資料一變就整個圖表拆掉重建。
  const barsRef = useRef<ChartBar[]>([])
  const [hoverBar, setHoverBar] = useState<ChartBar | null>(null)

  // days 改變時重新抓資料。symbol 換了也要重抓（切換股票不會整個元件重建，
  // 因為外層用同一個 <KLineChart> 節點在切分頁時保留狀態）。
  useEffect(() => {
    let cancelled = false
    setError(null)
    api
      .history(symbol, days)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [symbol, days])

  // ── 建立圖表：只在掛載時做一次，之後靠下面的 effect 更新資料 ──
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgba(212,212,216,0.9)',
        fontSize: 11,
        panes: { separatorColor: 'rgba(255,255,255,0.08)', separatorHoverColor: 'rgba(255,255,255,0.14)' },
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.1)', timeVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false,
      wickUpColor: UP, wickDownColor: DOWN,
    }, 0)
    candleRef.current = candle
    markersRef.current = createSeriesMarkers(candle, [])

    const maColors: Record<string, string> = {
      ma5: '#facc15', ma10: '#38bdf8', ma20: '#a78bfa', ma60: '#f472b6',
    }
    for (const [key, color] of Object.entries(maColors)) {
      maRefs.current[key] = chart.addSeries(
        LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0,
      )
    }

    const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' } }, 1)
    volRef.current = vol
    volMaRefs.current.vol_ma5 = chart.addSeries(
      LineSeries, { color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 1,
    )
    volMaRefs.current.vol_ma10 = chart.addSeries(
      LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 1,
    )

    kdRefs.current.k = chart.addSeries(
      LineSeries, { color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2,
    )
    kdRefs.current.d = chart.addSeries(
      LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 2,
    )

    // 上升(支撐) / 下降(壓力) 趨勢線：畫在主圖，各三個等級，虛線、細一點，
    // 免得跟蠟燭本體搶視覺。每條線只有兩個資料點（起點→延伸到最新一天）。
    for (const dir of ['resistance', 'support'] as const) {
      for (const tier of TREND_TIERS) {
        trendRefs.current[`${dir}_${tier}`] = chart.addSeries(
          LineSeries,
          {
            color: TREND_COLORS[dir][tier], lineWidth: 1, lineStyle: LineStyle.Dashed,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          },
          0,
        )
      }
    }

    // 三個子圖高度比例約 6:2:2——蠟燭圖是重點，量能與 KD 只是輔助判斷
    const panes = chart.panes()
    panes[0]?.setStretchFactor(6)
    panes[1]?.setStretchFactor(2)
    panes[2]?.setStretchFactor(2)

    // 滑鼠移到某一天：查出當天完整訊號明細（含後端算好的 detail 判斷理由），
    // 顯示在圖表下方的面板——只有標籤名稱看不出「為什麼」觸發，這裡補上。
    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      if (!param.time) {
        setHoverBar(null)
        return
      }
      const dateStr = String(param.time)
      setHoverBar(barsRef.current.find((b) => b.date === dateStr) ?? null)
    }
    chart.subscribeCrosshairMove(handleCrosshairMove)

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove)
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volRef.current = null
      maRefs.current = {}
      volMaRefs.current = {}
      kdRefs.current = {}
      trendRefs.current = {}
      markersRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 圖表只建立一次，資料變動走下面的 effect
  }, [])

  // ── 資料變動時灌進已建好的圖表 ──
  useEffect(() => {
    barsRef.current = bars ?? []
    if (!bars || !chartRef.current) return
    const candle = candleRef.current!

    candle.setData(
      bars.map((b) => ({ time: toTime(b.date), open: b.open, high: b.high, low: b.low, close: b.close })),
    )
    for (const key of ['ma5', 'ma10', 'ma20', 'ma60'] as const) {
      maRefs.current[key]?.setData(
        bars
          .filter((b) => b[key] != null)
          .map((b) => ({ time: toTime(b.date), value: b[key] as number })),
      )
    }
    volRef.current?.setData(
      bars.map((b) => ({
        time: toTime(b.date),
        value: b.volume,
        color: b.close >= b.open ? 'rgba(239,68,68,0.55)' : 'rgba(16,185,129,0.55)',
      })),
    )
    for (const key of ['vol_ma5', 'vol_ma10'] as const) {
      volMaRefs.current[key]?.setData(
        bars
          .filter((b) => b[key] != null)
          .map((b) => ({ time: toTime(b.date), value: b[key] as number })),
      )
    }
    for (const key of ['k', 'd'] as const) {
      kdRefs.current[key]?.setData(
        bars
          .filter((b) => b[key] != null)
          .map((b) => ({ time: toTime(b.date), value: b[key] as number })),
      )
    }

    // 訊號標記：每天只標優先等級最高的那組（bars[].signals 後端已排序），
    // 避免同一天疊很多個標籤把圖擠爆——跟主表格「買賣訊號」欄位同一個收斂邏輯。
    // showHistoricalSignals 關掉時只留最新一天，過去的日子完全不標——純前端過濾。
    const lastBarDate = bars[bars.length - 1]?.date
    const markers: SeriesMarker<Time>[] = []
    for (const b of bars) {
      if (!showHistoricalSignals && b.date !== lastBarDate) continue
      if (!b.signals || b.signals.length === 0) continue
      const topPriority = b.signals[0].priority
      const top = b.signals.filter((s) => s.priority === topPriority)
      const buy = top.filter((s) => s.kind === 'buy')
      const sell = top.filter((s) => s.kind === 'sell')
      // sub_label（例如「下降趨勢線突破」的 "(短期、中長期)"）附在標籤後面，
      // 這樣標記文字跟下面圖上畫的趨勢線等級才對得起來，不用另外猜是哪一條線。
      const labelOf = (s: (typeof top)[number]) => s.label + (s.sub_label ?? '')
      // 同一天理論上不會同時有優先等級相同的買訊號跟賣訊號，但保底各畫各的
      if (buy.length > 0) {
        markers.push({
          time: toTime(b.date), position: 'belowBar', shape: 'arrowUp', color: UP,
          text: buy.map(labelOf).join('、'),
        })
      }
      if (sell.length > 0) {
        markers.push({
          time: toTime(b.date), position: 'aboveBar', shape: 'arrowDown', color: DOWN,
          text: sell.map(labelOf).join('、'),
        })
      }
    }
    markersRef.current?.setMarkers(markers)

    // 趨勢線：缺的等級（後端沒找到合法的線）就清空該條線，不留上一次切股票時的殘影
    const trendlines = data?.trendlines
    for (const dir of ['resistance', 'support'] as const) {
      for (const tier of TREND_TIERS) {
        const seg = trendlines?.[dir]?.[tier]
        trendRefs.current[`${dir}_${tier}`]?.setData(
          seg ? [
            { time: toTime(seg.from.date), value: seg.from.price },
            { time: toTime(seg.to.date), value: seg.to.price },
          ] : [],
        )
      }
    }

    chartRef.current.timeScale().fitContent()
  }, [bars, data, showHistoricalSignals])

  const stats = useMemo(() => {
    if (!bars || bars.length === 0) return null
    const hitDays = bars.filter((b) => b.signals.length > 0).length
    return { total: bars.length, hitDays, last: bars[bars.length - 1] }
  }, [bars])

  // 趨勢線圖例：只列出後端真的算出來的等級，順便秀出「這條線現在在哪個價位」
  const trendLegend = useMemo(() => {
    const trendlines = data?.trendlines
    if (!trendlines) return []
    const items: { key: string; color: string; text: string }[] = []
    for (const dir of ['resistance', 'support'] as const) {
      for (const tier of TREND_TIERS) {
        const seg: TrendSegment | undefined = trendlines[dir]?.[tier]
        if (!seg) continue
        items.push({
          key: `${dir}_${tier}`,
          color: TREND_COLORS[dir][tier],
          text: `${dir === 'resistance' ? '壓力' : '支撐'}(${seg.tier_label}) ${seg.to.price.toFixed(2)}`,
        })
      }
    }
    return items
  }, [data])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <span>
          {stats
            ? `共 ${stats.total} 根日K・${stats.hitDays} 天有訊號・最新 ${stats.last.date}`
            : error
              ? `讀取失敗：${error}`
              : '讀取中…'}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-zinc-500">
            <input
              type="checkbox"
              checked={!showHistoricalSignals}
              onChange={(e) => setShowHistoricalSignals(!e.target.checked)}
              className="accent-emerald-500"
            />
            只顯示今日訊號
          </label>
          <span className="text-zinc-700">|</span>
          <span className="text-zinc-600">回看天數</span>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded border px-1.5 py-0.5 ${
                days === d ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-transparent text-zinc-500'
              }`}
            >
              {d}
            </button>
          ))}
          <span className="text-zinc-700">|</span>
          <div className="relative">
            <button
              onClick={() => setFilterOpen((v) => !v)}
              className={`rounded border px-1.5 py-0.5 ${
                filterOpen ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-transparent text-zinc-500'
              }`}
            >
              🔧 訊號篩選{hiddenSignalCount > 0 ? `（隱藏 ${hiddenSignalCount}）` : ''}
            </button>
            {filterOpen && (
              <>
                {/* 點面板外面收起來，不用另外裝全域 click-outside 邏輯 */}
                <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded border border-zinc-700 bg-zinc-900 p-3 text-left shadow-xl">
                  <p className="mb-2 text-[11px] leading-relaxed text-zinc-500">
                    不勾的訊號不會標在這張圖上——只影響這裡的圖，主表格「買賣訊號」欄位跟 Telegram/LINE
                    推播都不受影響。
                  </p>
                  {signalCatalog === null ? (
                    <p className="text-xs text-zinc-600">載入訊號清單中…</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div>
                        <p className="mb-1 text-[11px] font-medium text-rose-400">買進訊號</p>
                        <div className="flex flex-col gap-1">
                          {signalCatalog.filter((sig) => sig.kind === 'buy').map((sig) => {
                            const hidden = s?.chart_hidden_signal_labels.includes(sig.label) ?? false
                            return (
                              <label key={sig.key} className="flex cursor-pointer items-center gap-1.5 text-xs">
                                <input
                                  type="checkbox"
                                  checked={!hidden}
                                  onChange={() => toggleHiddenSignal(sig.label)}
                                  className="accent-rose-500"
                                />
                                <span className={hidden ? 'text-zinc-600' : 'text-rose-400'}>{sig.label}</span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                      <div>
                        <p className="mb-1 text-[11px] font-medium text-emerald-400">賣出訊號</p>
                        <div className="flex flex-col gap-1">
                          {signalCatalog.filter((sig) => sig.kind === 'sell').map((sig) => {
                            const hidden = s?.chart_hidden_signal_labels.includes(sig.label) ?? false
                            return (
                              <label key={sig.key} className="flex cursor-pointer items-center gap-1.5 text-xs">
                                <input
                                  type="checkbox"
                                  checked={!hidden}
                                  onChange={() => toggleHiddenSignal(sig.label)}
                                  className="accent-emerald-500"
                                />
                                <span className={hidden ? 'text-zinc-600' : 'text-emerald-400'}>{sig.label}</span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                  {s && s.chart_historical_suppress_labels.length > 0 && (
                    <p className="mt-3 border-t border-zinc-800 pt-2 text-[11px] leading-relaxed text-zinc-600">
                      另外，{s.chart_historical_suppress_labels.join('、')}
                      　這幾個訊號雜訊較多，預設只在最新一天顯示，過去的日子不畫。
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div ref={wrapRef} style={{ height: 420 }} className="w-full" />

      {/* 訊號明細面板：滑鼠移到K棒上查看當天完整判斷理由，不用只靠圖上小小的標籤文字猜 */}
      <div className="min-h-[52px] rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px]">
        {hoverBar ? (
          <>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-zinc-500">
              <span className="font-mono text-zinc-200">{hoverBar.date}</span>
              <span>開 {hoverBar.open.toFixed(2)}</span>
              <span>高 {hoverBar.high.toFixed(2)}</span>
              <span>低 {hoverBar.low.toFixed(2)}</span>
              <span>收 {hoverBar.close.toFixed(2)}</span>
              {hoverBar.k != null && hoverBar.d != null && (
                <span>KD {hoverBar.k.toFixed(1)} / {hoverBar.d.toFixed(1)}</span>
              )}
              <span>量 {fmtVol(hoverBar.volume)}</span>
              {(hoverBar.vol_ma5 != null || hoverBar.vol_ma10 != null) && (
                <span>
                  均量 {fmtVol(hoverBar.vol_ma5)} / {fmtVol(hoverBar.vol_ma10)}
                </span>
              )}
            </div>
            {(hoverBar.ma5 != null || hoverBar.ma10 != null || hoverBar.ma20 != null || hoverBar.ma60 != null) && (
              <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                {hoverBar.ma5 != null && (
                  <span style={{ color: '#facc15' }}>MA5 {hoverBar.ma5.toFixed(2)}</span>
                )}
                {hoverBar.ma10 != null && (
                  <span style={{ color: '#38bdf8' }}>MA10 {hoverBar.ma10.toFixed(2)}</span>
                )}
                {hoverBar.ma20 != null && (
                  <span style={{ color: '#a78bfa' }}>MA20 {hoverBar.ma20.toFixed(2)}</span>
                )}
                {hoverBar.ma60 != null && (
                  <span style={{ color: '#f472b6' }}>MA60 {hoverBar.ma60.toFixed(2)}</span>
                )}
              </div>
            )}
            {hoverBar.signals.length === 0 ? (
              <p className="text-zinc-600">這天沒有訊號</p>
            ) : (
              <ul className="space-y-0.5">
                {hoverBar.signals.map((s, i) => (
                  <li key={i} className="leading-relaxed">
                    <span className={s.kind === 'buy' ? 'text-rose-400' : 'text-emerald-400'}>
                      {s.label}{s.sub_label ?? ''}
                    </span>
                    <span className="ml-1.5 text-zinc-500">{s.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <span className="text-zinc-600">滑鼠移到K棒上查看當天完整訊號判斷理由</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500">
        <span><span style={{ color: '#facc15' }}>■</span> MA5 / K</span>
        <span><span style={{ color: '#38bdf8' }}>■</span> MA10 / D</span>
        <span><span style={{ color: '#a78bfa' }}>■</span> MA20</span>
        <span><span style={{ color: '#f472b6' }}>■</span> MA60</span>
        <span className="text-rose-400">▲ 買進訊號</span>
        <span className="text-emerald-400">▼ 賣出訊號</span>
      </div>
      {trendLegend.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-500">
          {trendLegend.map((item) => (
            <span key={item.key} style={{ color: item.color }}>
              ┄ {item.text}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
