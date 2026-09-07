/**
 * 應用進入點。
 *
 * 啟動流程刻意分成三段，因為 Render 免費方案會休眠：
 *
 *   1. 先打 /api/health 把後端叫醒（最久約 1 分鐘），畫面顯示「喚醒中」
 *   2. 醒了才建 WebSocket，並抓一次全量 /api/rows
 *   3. 之後靠 WebSocket 收增量（快線報價 300ms、慢線整列 20 秒）
 *
 * 這個「喚醒中」的畫面正是把前端放 Vercel 換來的 —— 如果前端跟後端一起放
 * Render，休眠時你連頁面都打不開，只會看到一分鐘白畫面。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, wakeBackend } from './lib/api'
import { QuoteSocket } from './lib/ws'
import { useStore } from './store'
import { MonitorTable } from './components/MonitorTable'
import { StatusBar } from './components/StatusBar'
import { LoginDialog } from './components/LoginDialog'

export default function App() {
  const { setRows, applyQuotes, setStatus, setConn, setError, conn, wakeAttempt, setWakeAttempt } = useStore()
  const [loginOpen, setLoginOpen] = useState(false)
  const socketRef = useRef<QuoteSocket | null>(null)

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [setStatus, setError])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      setConn('waking')
      const awake = await wakeBackend((n) => !cancelled && setWakeAttempt(n))
      if (cancelled) return
      if (!awake) {
        setConn('error')
        setError('無法喚醒後端服務。請確認 Render 服務正在執行，或稍後重試。')
        return
      }

      setConn('connecting')
      try {
        const [{ rows }] = await Promise.all([api.rows(), refreshStatus()])
        if (!cancelled) setRows(rows)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }

      const sock = new QuoteSocket({
        onOpen: () => {
          setConn('open')
          setError(null)
        },
        onClose: () => setConn('closed'),
        onError: (msg) => {
          setConn('error')
          setError(msg)
        },
        onMessage: (msg) => {
          switch (msg.type) {
            case 'hello':
              if (msg.rows?.length) setRows(msg.rows)
              if (msg.status) setStatus(msg.status)
              break
            case 'quotes':
              applyQuotes(msg.data)
              break
            case 'rows':
              setRows(msg.data)
              break
          }
        },
      })
      socketRef.current = sock
      sock.connect()
    })()

    return () => {
      cancelled = true
      socketRef.current?.close()
    }
  }, [applyQuotes, refreshStatus, setConn, setError, setRows, setStatus, setWakeAttempt])

  // 狀態列每 15 秒更新一次（訂閱數、最後資料時間這些不需要即時）
  useEffect(() => {
    const t = setInterval(refreshStatus, 15_000)
    return () => clearInterval(t)
  }, [refreshStatus])

  const handleRefresh = useCallback(async () => {
    try {
      const { rows } = await api.refreshRows()
      setRows(rows)
      await refreshStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [refreshStatus, setError, setRows])

  if (conn === 'waking') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-sm text-zinc-400">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-emerald-400" />
        <div>正在喚醒後端服務…</div>
        <div className="text-xs text-zinc-600">
          Render 免費方案休眠後冷啟動約需一分鐘（第 {wakeAttempt} 次嘗試）
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <StatusBar onLogin={() => setLoginOpen(true)} onRefresh={handleRefresh} />
      <MonitorTable />
      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} onSuccess={refreshStatus} />
    </div>
  )
}
