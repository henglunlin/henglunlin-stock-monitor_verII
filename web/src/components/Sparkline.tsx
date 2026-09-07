/**
 * 每列內嵌的迷你走勢圖。
 *
 * 用 Canvas 而不是 SVG，也不用圖表套件 —— 因為這是「一列一張圖」的情境：
 * 兩百檔就是兩百張。SVG 會產生幾千個 DOM 節點拖垮捲動，圖表套件更重。
 * Canvas 一張圖就是一個節點，畫完就是點陣，捲動完全不受影響。
 *
 * 這正是 Streamlit 做不到的事：那邊每列塞一張 Plotly 圖，幾十檔就會卡死。
 */
import { useEffect, useMemo, useRef } from 'react'

interface Props {
  /** 後端會把 NaN 轉成 null，所以這裡要能吃 (number | null)[] */
  data: (number | null)[]
  /** 台股慣例：漲紅跌綠 */
  up: boolean
  /**
   * 參考線（畫盤中走勢時傳昨收）。
   *
   * 盤中走勢一定要有這條線才讀得懂：沒有它，一檔從 -3% 拉回到 -1% 的股票
   * 看起來會跟一檔從 +1% 漲到 +3% 的一模一樣——因為迷你圖是自動縮放的，
   * 畫的是「相對起伏」，不是絕對位置。有了昨收基準線，「在平盤上或下」
   * 才看得出來。日線走勢不需要（那條線的 30 天區間沒有單一基準）。
   */
  baseline?: number | null
  width?: number
  height?: number
}

export function Sparkline({ data, up, baseline, width = 88, height = 26 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  // 後端把 NaN 轉成 null 了，畫圖前先濾掉——留著會讓 Math.min 算出 0
  const clean = useMemo(
    () => data.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
    [data],
  )

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || clean.length < 2) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    // 有基準線時它必須落在可視範圍內，否則畫不出來也就失去意義
    const hasBase = typeof baseline === 'number' && Number.isFinite(baseline)
    const pool = hasBase ? [...clean, baseline as number] : clean
    const min = Math.min(...pool)
    const max = Math.max(...pool)
    const range = max - min || 1
    const pad = 3
    const usable = height - pad * 2
    const step = width / (clean.length - 1)
    const x = (i: number) => i * step
    const y = (v: number) => pad + (1 - (v - min) / range) * usable

    const stroke = up ? '#ef4444' : '#10b981'
    const fill = up ? 'rgba(239,68,68,0.14)' : 'rgba(16,185,129,0.14)'

    if (hasBase) {
      ctx.beginPath()
      ctx.setLineDash([2, 2])
      ctx.moveTo(0, y(baseline as number))
      ctx.lineTo(width, y(baseline as number))
      ctx.strokeStyle = 'rgba(161,161,170,0.45)'   // zinc-400 半透明
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
    }

    // 面積填色，讓走勢方向一眼可辨
    ctx.beginPath()
    ctx.moveTo(x(0), y(clean[0]))
    clean.forEach((v, i) => ctx.lineTo(x(i), y(v)))
    ctx.lineTo(x(clean.length - 1), height)
    ctx.lineTo(x(0), height)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()

    // 線
    ctx.beginPath()
    ctx.moveTo(x(0), y(clean[0]))
    clean.forEach((v, i) => ctx.lineTo(x(i), y(v)))
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    ctx.stroke()

    // 終點加一個點，強調「現在在哪」
    ctx.beginPath()
    ctx.arc(x(clean.length - 1), y(clean[clean.length - 1]), 1.8, 0, Math.PI * 2)
    ctx.fillStyle = stroke
    ctx.fill()
  }, [clean, up, baseline, width, height])

  if (clean.length < 2) {
    return <div style={{ width, height }} className="opacity-25 text-[10px] leading-[26px]">—</div>
  }
  return <canvas ref={ref} style={{ width, height }} aria-hidden />
}
