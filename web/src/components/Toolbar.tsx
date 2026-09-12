/**
 * 頂部工具列。把 Streamlit 版散在主畫面上方與側邊欄的開關集中到一條。
 *
 * ── 「啟用自動更新 / 刷新秒數」在新架構下代表什麼 ──
 *
 * 原版那個 3 秒是「整頁重跑」的間隔，而整頁重跑同時做了兩件事：
 * 抓最新報價、重算所有指標與訊號。新架構把這兩件事拆開了，所以一個開關
 * 變成兩個，各自對應它真正控制的東西：
 *
 *   暫停畫面更新  → 前端不再套用推送進來的報價，畫面凍結。
 *                   要細看某一列、或截圖的時候用；WebSocket 仍然連著，
 *                   解除暫停立刻跳回最新，不用重連。
 *   慢線秒數      → 後端重算指標與訊號的間隔（真的送到後端存起來）。
 *
 * 快線（報價推送）沒有開關，因為它幾乎不花成本：只推這 300ms 內變動過的股票，
 * 沒變動就完全不發包。關掉它省不到什麼，卻會讓價格停在舊值。
 *
 * ── 推播開關只留兩顆 ──
 * 這裡只放 `LINE 推送` 與 `Telegram 推送` 兩顆管道總開關，其餘推播細節
 * （定時時段、彙整要送哪些管道、LINE 格式、即時事件門檻）全部在 ⚙️ 設定 的
 * 「🔔 推播」區。原本的 `定時推送模式` 已經搬進去了。
 *
 * 兩條管道的職責是分開的：
 *   LINE      → 盤中定時彙整（一天五個時段）
 *   Telegram  → 盤中即時事件、push 指令，以及彙整的完整紀錄那一份
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { Settings } from '../types'

function Toggle({
  on, onChange, label, hint, tone = 'emerald',
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  tone?: 'emerald' | 'amber'
}) {
  const active = tone === 'amber' ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <button
      onClick={() => onChange(!on)}
      title={hint}
      className="flex items-center gap-2 text-xs text-zinc-300 hover:text-zinc-100"
      aria-pressed={on}
    >
      <span
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors ${
          on ? active : 'bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            on ? 'translate-x-[17px]' : 'translate-x-[2px]'
          }`}
        />
      </span>
      <span className={on ? 'text-zinc-100' : 'text-zinc-400'}>{label}</span>
    </button>
  )
}

function clock(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('zh-TW', { hour12: false })
}

export function Toolbar({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { status, setStatus, paused, setPaused, openModal, lastUpdate, rows, conn } = useStore()
  const [busy, setBusy] = useState(false)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const s = status?.settings
  const fubon = status?.fubon
  const needLogin = conn === 'open' && !fubon?.logged_in

  async function patch(p: Partial<Settings>) {
    try {
      const next = await api.patchSettings(p)
      if (status) setStatus({ ...status, settings: next })
    } catch {
      /* 設定寫入失敗不該中斷看盤，狀態列的錯誤區塊會顯示連線問題 */
    }
  }

  async function manualRefresh() {
    setBusy(true)
    try {
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-zinc-800 bg-zinc-900/40 px-4 py-2">
      <button
        onClick={manualRefresh}
        disabled={busy}
        className="rounded border border-zinc-700 bg-zinc-800/70 px-2.5 py-1 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
      >
        {busy ? '重算中…' : '🔄 手動更新即時資料'}
      </button>

      <Toggle
        on={!paused}
        onChange={(v) => setPaused(!v)}
        label={paused ? '已暫停更新' : '啟用自動更新'}
        hint="暫停後畫面凍結但連線不斷，解除立刻跳回最新"
        tone={paused ? 'amber' : 'emerald'}
      />

      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        慢線秒數
        <input
          type="number"
          min={5}
          max={300}
          value={s?.row_refresh_sec ?? 20}
          onChange={(e) => patch({ row_refresh_sec: Math.max(5, Number(e.target.value) || 20) })}
          className="w-16 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-right font-mono tabular-nums text-zinc-100"
          title="後端重算技術指標與訊號的間隔。報價推送不受這個值影響。"
        />
      </label>

      {/*
        Toolbar 上只留兩顆「管道總開關」。時段、格式、要推哪些管道這些細節
        全部在 ⚙️ 設定 裡——工具列是盤中一眼要看到的地方，放五顆開關就沒人看了。
      */}
      <Toggle
        on={!!s?.line_push_enabled}
        onChange={(v) => patch({ line_push_enabled: v })}
        label="LINE 推送"
        hint="定時彙整推播走 LINE。時段與格式在 ⚙️ 設定 裡調"
      />

      <Toggle
        on={!!s?.tg_push_enabled}
        onChange={(v) => patch({ tg_push_enabled: v })}
        label="Telegram 推送"
        hint="盤中即時事件與 push 指令走 Telegram。開著時即使沒人打開網頁也會推"
      />

      <div className="ml-auto flex items-center gap-2">
        <span className="text-[11px] tabular-nums text-zinc-500">
          更新時間 {clock(lastUpdate)}　·　{rows.length} 檔
        </span>
        <button
          onClick={() => openModal({ kind: 'group', name: null })}
          className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          📋 全部股票
        </button>
        <button
          onClick={() => openModal({ kind: 'groups' })}
          className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          🛠️ 分類編輯
        </button>
        <button
          onClick={() => openModal({ kind: 'settings' })}
          className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          ⚙️ 設定
        </button>
        <button
          onClick={() => openModal({ kind: 'login' })}
          className={`rounded px-2 py-1 text-xs ${
            needLogin
              ? 'bg-amber-500 font-semibold text-zinc-900 hover:bg-amber-400'
              : 'border border-zinc-700 hover:bg-zinc-800'
          }`}
        >
          {fubon?.logged_in ? '重新登入富邦' : '登入富邦'}
        </button>
      </div>
    </div>
  )
}
