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

export function StatusBar() {
  const { conn, status, error, openModal, paused } = useStore()
  const [, tick] = useState(0)

  // 每秒重繪一次，讓「最後資料 N 秒前」會自己跳
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const fubon = status?.fubon
  const needLogin = conn === 'open' && !fubon?.logged_in

  // 連線健康度摘要。四種異常各有各的意義，不能只看斷線次數：
  //   斷線   —— 對方或網路正常關閉，斷線回呼有觸發
  //   假死   —— 半開連線，回呼不會觸發，只能靠「多久沒資料」抓
  //   重連   —— 看門狗接回來幾次
  //   失敗   —— 接不回來，通常代表 session 出問題
  const parts: string[] = []
  if (fubon?.disconnect_count) parts.push(`斷線 ${fubon.disconnect_count}`)
  if (fubon?.stale_count) parts.push(`假死 ${fubon.stale_count}`)
  if (fubon?.reconnect_count) parts.push(`已重連 ${fubon.reconnect_count}`)
  if (fubon?.reconnect_fail_count) parts.push(`重連失敗 ${fubon.reconnect_fail_count}`)
  const health = parts.length ? parts.join(' · ') : ''

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
        <span className="text-zinc-500 tabular-nums">tick {status?.tick_count ?? 0}</span>
        {/*
          出過事才顯示，平常不佔版面。

          ⚠️ 上一版這裡只看 disconnect_count，結果最常見的那種斷法（半開連線）
          根本不會觸發斷線回呼，那個數字一直是 0 —— 行情停了 15 分鐘，狀態列
          卻什麼都沒顯示。現在四個訊號任一個有動就顯示。
        */}
        {!!health && (
          <span
            className="rounded bg-amber-500/15 px-2 py-[2px] tabular-nums text-amber-300"
            title={
              fubon?.last_reconnect_error
                ? `最後一次重連失敗：${fubon.last_reconnect_error}`
                : fubon?.last_reconnect_at
                  ? `最後一次重連 ${fubon.last_reconnect_at.slice(11)}`
                  : '尚未成功重連'
            }
          >
            {health}
          </span>
        )}
        <span className="text-zinc-600">{status?.trading_date ?? '—'}</span>

        {paused && (
          <span className="rounded bg-amber-500/15 px-2 py-[2px] font-medium text-amber-300">
            ⏸ 畫面已暫停（連線仍在，資料照收）
          </span>
        )}
      </div>

      {(error || fubon?.error) && (
        <div className="border-t border-rose-900/50 bg-rose-950/40 px-4 py-1.5 text-xs text-rose-300">
          {error ?? fubon?.error}
        </div>
      )}
      {/*
        session 死掉跟「還沒登入」是兩件事：這是已經登入過、但登入 session 失效，
        看門狗連續重連都救不回來。帳密不放伺服器，所以只能請你重新輸入一次。
      */}
      {fubon?.session_dead && (
        <div className="flex items-center gap-2 border-t border-rose-900/50 bg-rose-950/40 px-4 py-1.5 text-xs text-rose-300">
          <span>
            富邦登入 session 已失效，自動重連救不回來（重連失敗 {fubon.reconnect_fail_count} 次）。
            需要重新登入才會恢復即時報價。
          </span>
          <button
            onClick={() => openModal({ kind: 'login' })}
            className="rounded bg-rose-500 px-2 py-0.5 font-semibold text-zinc-950 hover:bg-rose-400"
          >
            重新登入
          </button>
        </div>
      )}
      {needLogin && !error && (
        <div className="flex items-center gap-2 border-t border-amber-900/50 bg-amber-950/30 px-4 py-1.5 text-xs text-amber-300">
          <span>尚未登入富邦，畫面顯示的是歷史／備援報價，走勢欄也還是日線。</span>
          <button
            onClick={() => openModal({ kind: 'login' })}
            className="rounded bg-amber-500 px-2 py-0.5 font-semibold text-zinc-900 hover:bg-amber-400"
          >
            立即登入
          </button>
        </div>
      )}
    </div>
  )
}
