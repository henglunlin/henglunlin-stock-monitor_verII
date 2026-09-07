/**
 * 常駐連線狀態列。
 *
 * 原本 Streamlit 版的富邦連線狀態藏在側邊欄的 expander 裡，斷線你得自己去展開才發現。
 * 這裡放成常駐橫列，斷線一眼就看得到 —— 這是 Phase 0 評估裡列的「斷線韌性」改進項。
 */
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { ConnState } from '../types'

const CONN_TEXT: Record<ConnState, string> = {
  waking: '喚醒後端中',
  connecting: '連線中',
  open: '已連線',
  closed: '已斷線',
  error: '連線異常',
}

const CONN_DOT: Record<ConnState, string> = {
  waking: 'bg-amber-400 animate-pulse',
  connecting: 'bg-amber-400 animate-pulse',
  open: 'bg-emerald-400',
  closed: 'bg-zinc-500',
  error: 'bg-rose-500',
}

function ago(iso: string | null): string {
  if (!iso) return '—'
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`
  return `${Math.floor(diff / 3600)} 小時前`
}

export function StatusBar({ onLogin, onRefresh }: { onLogin: () => void; onRefresh: () => void }) {
  const { conn, status, rows, error } = useStore()
  const [, tick] = useState(0)

  // 每秒重繪一次，讓「最後資料 N 秒前」會自己跳
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const fubon = status?.fubon
  const needLogin = conn === 'open' && !fubon?.logged_in

  return (
    <div className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 text-xs">
        <div className="flex items-center gap-2 font-medium">
          <span className={`inline-block h-2 w-2 rounded-full ${CONN_DOT[conn]}`} />
          <span>{CONN_TEXT[conn]}</span>
        </div>

        <div className="flex items-center gap-2 text-zinc-400">
          <span className={`inline-block h-2 w-2 rounded-full ${fubon?.connected ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <span>富邦 {fubon?.connected ? `已訂閱 ${fubon.subscribed_count} 檔` : '未連線'}</span>
        </div>

        <span className="text-zinc-500 tabular-nums">最後資料 {ago(fubon?.last_message_at ?? null)}</span>
        <span className="text-zinc-500 tabular-nums">{rows.length} 檔</span>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 active:bg-zinc-700"
          >
            重新計算
          </button>
          <button
            onClick={onLogin}
            className={`rounded px-2 py-1 ${
              needLogin
                ? 'bg-amber-500 font-semibold text-zinc-900 hover:bg-amber-400'
                : 'border border-zinc-700 hover:bg-zinc-800'
            }`}
          >
            {fubon?.logged_in ? '重新登入富邦' : '登入富邦'}
          </button>
        </div>
      </div>

      {(error || fubon?.error) && (
        <div className="border-t border-rose-900/50 bg-rose-950/40 px-4 py-1.5 text-xs text-rose-300">
          {error ?? fubon?.error}
        </div>
      )}
      {needLogin && !error && (
        <div className="border-t border-amber-900/50 bg-amber-950/30 px-4 py-1.5 text-xs text-amber-300">
          尚未登入富邦，畫面顯示的是歷史／備援報價。點右上角「登入富邦」開始接收即時行情。
        </div>
      )}
    </div>
  )
}
