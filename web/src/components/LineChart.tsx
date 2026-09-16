/**
 * 盤中走勢圖（加權指數與單檔詳情共用）。
 *
 * 一樣是 Canvas，一樣沒有圖表套件。理由跟 Sparkline 那支不同：這裡只有一張圖，
 * 效能不是問題；不裝套件是因為需要的東西很少（一條線、一條昨收基準線、
 * 一個 hover 十字線），而最小的圖表套件也要 40KB 以上，還會帶進它自己的
 * 一套配色與字體，跟這個介面對不起來。
 *
 * ── 兩個一定要做對的細節 ──
 *
 * 1. **Y 軸絕對不能從 0 開始。**
 *    加權指數是兩萬多點的絕對值，當日震盪通常只有一兩百點。從 0 起算會把
 *    一整天的漲跌壓成貼齊頂端的一條直線。這是原版 Streamlit 註解裡就寫過的坑，
 *    照搬過來：以資料範圍為主，上下各留 15% 邊界。
 *
 * 2. **X 軸固定 09:00–13:30。**
 *    不然早上十點的圖會把兩小時的資料拉滿整個寬度，看起來像跑了一整天。
 *    固定範圍，才能一眼看出「現在走到哪裡了」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Point } from '../types'

/** 交易時段：09:00 = 540 分，13:30 = 810 分 */
const SESSION_START_MIN = 9 * 60
const SESSION_END_MIN = 13 * 60 + 30

function minutesOf(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(label)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function LineChart({
  points,
  baseline,
  height = 220,
  /** 固定 09:00–13:30 的 X 軸。單檔用服務累積序列時關掉比較好看 */
  fixedSession = true,
  valueFormat = (v: number) => v.toFixed(2),
}: {
  points: Point[]
  baseline?: number | null
  height?: number
  fixedSession?: boolean
  valueFormat?: (v: number) => string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState<{ x: number; p: Point } | null>(null)

  // 寬度跟著容器走。ResizeObserver 而不是 window resize——側邊視窗展開收合
  // 時視窗寬度沒變，但容器寬度變了。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(200, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const clean = useMemo(
    () => points.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v)),
    [points],
  )

  const geom = useMemo(() => {
    if (clean.length === 0) return null
    const values = clean.map((p) => p.v)
    if (typeof baseline === 'number' && Number.isFinite(baseline)) values.push(baseline)
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const span = Math.max(hi - lo, Math.abs(hi) * 0.0005, 0.01)
    const padY = span * 0.15
    return { yMin: lo - padY, yMax: hi + padY }
  }, [clean, baseline])

  const PAD_L = 52
  const PAD_R = 10
  const PAD_T = 10
  const PAD_B = 22

  // 每個點的 X 位置。固定時段模式下依時間標籤定位，否則等距。
  const xs = useMemo(() => {
    const plotW = Math.max(1, width - PAD_L - PAD_R)
    if (!fixedSession || clean.length === 0) {
      const step = clean.length > 1 ? plotW / (clean.length - 1) : 0
      return clean.map((_, i) => PAD_L + i * step)
    }
    const span = SESSION_END_MIN - SESSION_START_MIN
    return clean.map((p, i) => {
      const mm = minutesOf(p.t)
      if (mm === null) return PAD_L + (plotW * i) / Math.max(1, clean.length - 1)
      const ratio = Math.min(1, Math.max(0, (mm - SESSION_START_MIN) / span))
      return PAD_L + plotW * ratio
    })
  }, [clean, width, fixedSession])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !geom || clean.length === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const plotH = height - PAD_T - PAD_B
    const y = (v: number) => PAD_T + (1 - (v - geom.yMin) / (geom.yMax - geom.yMin)) * plotH

    const last = clean[clean.length - 1].v
    const ref = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : null
    const up = ref !== null ? last >= ref : last >= clean[0].v
    const stroke = up ? '#ef4444' : '#10b981'
    const fill = up ? 'rgba(239,68,68,0.10)' : 'rgba(16,185,129,0.10)'

    // ── 格線與 Y 軸刻度（5 條）──
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    for (let i = 0; i <= 4; i++) {
      const v = geom.yMin + ((geom.yMax - geom.yMin) * i) / 4
      const yy = y(v)
      ctx.beginPath()
      ctx.moveTo(PAD_L, yy)
      ctx.lineTo(width - PAD_R, yy)
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = 'rgba(161,161,170,0.75)'
      ctx.textAlign = 'right'
      ctx.fillText(valueFormat(v), PAD_L - 6, yy)
    }

    // ── X 軸時間刻度：固定時段時每 30 分鐘一格 ──
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    if (fixedSession) {
      const plotW = width - PAD_L - PAD_R
      const span = SESSION_END_MIN - SESSION_START_MIN
      for (let m = SESSION_START_MIN; m <= SESSION_END_MIN; m += 30) {
        const xx = PAD_L + (plotW * (m - SESSION_START_MIN)) / span
        ctx.beginPath()
        ctx.moveTo(xx, PAD_T)
        ctx.lineTo(xx, height - PAD_B)
        ctx.strokeStyle = 'rgba(255,255,255,0.04)'
        ctx.stroke()
        const hh = String(Math.floor(m / 60)).padStart(2, '0')
        const mi = String(m % 60).padStart(2, '0')
        ctx.fillStyle = 'rgba(113,113,122,0.9)'
        ctx.fillText(`${hh}:${mi}`, xx, height - PAD_B + 5)
      }
    } else if (clean.length > 1) {
      for (const i of [0, Math.floor(clean.length / 2), clean.length - 1]) {
        ctx.fillStyle = 'rgba(113,113,122,0.9)'
        ctx.fillText(clean[i].t.slice(0, 5), xs[i], height - PAD_B + 5)
      }
    }

    // ── 昨收基準線 ──
    if (ref !== null) {
      const yy = y(ref)
      ctx.beginPath()
      ctx.setLineDash([4, 3])
      ctx.moveTo(PAD_L, yy)
      ctx.lineTo(width - PAD_R, yy)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(212,212,216,0.8)'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      ctx.fillText('昨收', PAD_L + 4, yy - 2)
    }

    // ── 面積 + 線 ──
    ctx.beginPath()
    ctx.moveTo(xs[0], y(clean[0].v))
    clean.forEach((p, i) => ctx.lineTo(xs[i], y(p.v)))
    ctx.lineTo(xs[xs.length - 1], height - PAD_B)
    ctx.lineTo(xs[0], height - PAD_B)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()

    ctx.beginPath()
    ctx.moveTo(xs[0], y(clean[0].v))
    clean.forEach((p, i) => ctx.lineTo(xs[i], y(p.v)))
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.6
    ctx.lineJoin = 'round'
    ctx.stroke()

    // ── hover 十字線 ──
    if (hover) {
      const hx = hover.x
      const hy = y(hover.p.v)
      ctx.beginPath()
      ctx.moveTo(hx, PAD_T)
      ctx.lineTo(hx, height - PAD_B)
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(hx, hy, 3, 0, Math.PI * 2)
      ctx.fillStyle = stroke
      ctx.fill()
    }
  }, [clean, xs, geom, baseline, width, height, hover, fixedSession, valueFormat])

  function onMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (clean.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - mx)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setHover({ x: xs[best], p: clean[best] })
  }

  if (clean.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-lg border border-dashed border-zinc-800 text-xs text-zinc-600"
      >
        目前沒有走勢資料
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      />
      {hover && (
        <div
          className="pointer-events-none absolute top-1 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-[11px] tabular-nums text-zinc-200 shadow-lg"
          style={{
            left: Math.min(Math.max(hover.x - 40, 0), Math.max(0, width - 96)),
          }}
        >
          <span className="text-zinc-500">{hover.p.t.slice(0, 5)}</span>{' '}
          <span className="font-mono">{valueFormat(hover.p.v)}</span>
        </div>
      )}
    </div>
  )
}
