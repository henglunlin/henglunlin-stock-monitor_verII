/**
 * 應用進入點。
 *
 * 啟動流程刻意分成三段，因為 Render 免費方案會休眠：
 *   1. 先打 /api/health 把後端叫醒（最久約 1 分鐘），畫面顯示「喚醒中」
 *   2. 醒了才建 WebSocket，並抓一次全量 /api/rows
 *   3. 之後靠 WebSocket 收增量（快線報價 300ms、慢線整列 20 秒）
 *
 * ── 版面：儀表板是主畫面，其餘都是浮動視窗 ──
 *
 *   狀態列 ─ 工具列 ─ 加權指數 ─ 【儀表板（滿版，自己捲）】
 *                                       ↓ 點卡片
 *                            分類清單（浮動）─ 點一列 → 個股詳情（浮動）
 *
 * ⚠️ 這裡踩過一個坑：一開始把儀表板跟表格塞進「同一個」捲動容器，
 * 結果表頭下方出現一大塊空白 —— 因為 virtualizer 預設假設自己的清單
 * 從捲動容器頂端開始，但上面墊著約 500px 高的儀表板，那段沒被計入。
 * 現在表格活在浮動視窗裡，天生就擁有自己的捲動區，結構上不可能再犯同一個錯。
 *
 * 浮動視窗同時只有一個（store 的 modal 是單一值）。個股詳情關掉時會回到
 * 它的來源清單而不是回到儀表板——不然每看一檔就要重點一次分類。
 */
import { useCallback, useEffect, useRef } from 'react'
import { api, wakeBackend } from './lib/api'
import { QuoteSocket } from './lib/ws'
import { useStore } from './store'
import { MonitorTable } from './components/MonitorTable'
import { SummaryDashboard } from './components/SummaryDashboard'
import { StatusBar } from './components/StatusBar'
import { Toolbar } from './components/Toolbar'
import { TaiexPanel } from './components/TaiexPanel'
import { Modal } from './components/Modal'
import { Marquee } from './components/Marquee'
import { EventStreamPanel } from './components/EventStreamPanel'
import { GroupEditor } from './components/GroupEditor'
import { SettingsDialog } from './components/SettingsDialog'
import { StockDetail } from './components/StockDetail'
import { LoginDialog } from './components/LoginDialog'

export default function App() {
  const {
    setRows, applyQuotes, setStatus, setConn, setError,
    conn, wakeAttempt, setWakeAttempt, modal, openModal, closeModal, paused,
    setEvents, pushEvents,
  } = useStore()
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
        setError('無法喚醒後端服務。請確認後端正在執行，或稍後重試。')
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
          // 暫停只凍結「會一直跳的東西」（報價與整列）。
          // 事件流不擋——暫停是為了看清楚某一列，不是為了錯過剛觸發的訊號。
          if (useStore.getState().paused && (msg.type === 'quotes' || msg.type === 'rows')) return
          switch (msg.type) {
            case 'hello':
              if (msg.rows?.length) setRows(msg.rows)
              if (msg.status) setStatus(msg.status)
              // 中途連進來的瀏覽器也要看得到今天已經發生過的事，
              // 否則重新整理一次跑馬燈就空了
              if (msg.events) setEvents(msg.events)
              break
            case 'events':
              pushEvents(msg.data)
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
  }, [applyQuotes, refreshStatus, setConn, setError, setRows, setStatus, setWakeAttempt,
      setEvents, pushEvents])

  // 狀態列每 15 秒更新一次（訂閱數、最後資料時間這些不需要即時）
  useEffect(() => {
    if (paused) return
    const t = setInterval(refreshStatus, 15_000)
    return () => clearInterval(t)
  }, [refreshStatus, paused])

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
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <StatusBar />
      <Toolbar onRefresh={handleRefresh} />
      <Marquee />
      <TaiexPanel />
      <SummaryDashboard />

      {/* 分類清單（modal.name 為 null 時代表「全部股票」） */}
      <Modal
        open={modal.kind === 'group'}
        onClose={closeModal}
        size="xl"
        title={modal.kind === 'group' ? (modal.name ?? '全部股票') : ''}
        subtitle="點任一列展開個股即時走勢　·　點欄位標題可排序"
      >
        {modal.kind === 'group' && <MonitorTable groupFilter={modal.name} />}
      </Modal>

      {/* 個股詳情：關掉時回到來源清單 */}
      {modal.kind === 'detail' && (
        <StockDetail
          symbol={modal.symbol}
          onClose={() =>
            modal.from === 'none' ? closeModal() : openModal({ kind: 'group', name: modal.from })
          }
        />
      )}

      <EventStreamPanel open={modal.kind === 'events'} onClose={closeModal} />
      <GroupEditor open={modal.kind === 'groups'} onClose={closeModal} />
      <SettingsDialog open={modal.kind === 'settings'} onClose={closeModal} />
      <LoginDialog open={modal.kind === 'login'} onClose={closeModal} onSuccess={refreshStatus} />
    </div>
  )
}
