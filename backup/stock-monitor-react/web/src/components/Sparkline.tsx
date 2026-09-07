/**
 * 每列內嵌的迷你走勢圖。
 *
 * 用 Canvas 而不是 SVG，也不用圖表套件 —— 因為這是「一列一張圖」的情境：
 * 兩百檔就是兩百張。SVG 會產生幾千個 DOM 節點拖垮捲動，圖表套件更重。
 * Canvas 一張圖就是一個節點，畫完就是點陣，捲動完全不受影響。
 *
 * 這正是 Streamlit 做不到的事：那邊每列塞一張 Plotly 圖，幾十檔就會卡死。
 */
import { useEffect, useRef } from 'react'

interface Props {
  data: number[]
  /** 台股慣例：漲紅跌綠 */
  up: boolean
  width?: number
  height?: number
}

export function Sparkline({ data, up, width = 88, height = 26 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || data.length < 2) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, height)

    const min = Math.min(...data)
    const max = Math.max(...data)
    const range = max - min || 1
    const pad = 3
    const usable = height - pad * 2
    const step = width / (data.length - 1)
    const x = (i: number) => i * step
    const y = (v: number) => pad + (1 - (v - min) / range) * usable

    const stroke = up ? '#ef4444' : '#10b981'
    const fill = up ? 'rgba(239,68,68,0.14)' : 'rgba(16,185,129,0.14)'

    // 面積填色，讓走勢方向一眼可辨
    ctx.beginPath()
    ctx.moveTo(x(0), y(data[0]))
    data.forEach((v, i) => ctx.lineTo(x(i), y(v)))
    ctx.lineTo(x(data.length - 1), height)
    ctx.lineTo(x(0), height)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()

    // 線
    ctx.beginPath()
    ctx.moveTo(x(0), y(data[0]))
    data.forEach((v, i) => ctx.lineTo(x(i), y(v)))
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.25
    ctx.lineJoin = 'round'
    ctx.stroke()

    // 終點加一個點，強調「現在在哪」
    ctx.beginPath()
    ctx.arc(x(data.length - 1), y(data[data.length - 1]), 1.8, 0, Math.PI * 2)
    ctx.fillStyle = stroke
    ctx.fill()
  }, [data, up, width, height])

  if (data.length < 2) {
    return <div style={{ width, height }} className="opacity-25 text-[10px] leading-[26px]">—</div>
  }
  return <canvas ref={ref} style={{ width, height }} aria-hidden />
}
