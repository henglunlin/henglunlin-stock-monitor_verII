/**
 * 手機版單檔目標價編輯（取代 StockSheet 裡原本的「買入區間」區塊）。
 *
 * 跟桌面版 TargetEditor.tsx 是同一份資料（target_price_list.json，經
 * api.targets()/api.saveTargets() 讀寫），但這裡只處理「當前這一檔」——
 * 開啟時抓一次完整字典、記住其他檔案的原始內容，儲存/移除時只改動這一檔、
 * 把完整字典寫回去，不會動到其他檔案已經設定好的目標價。
 *
 * ── 跟桌面版刻意不同的地方（3 輪問答定案，手機情境比較單純）──
 *   - 沒有「未儲存變更」關閉拖截：只有一檔資料，誤按關閉的代價很低，
 *     拖截彈窗在小螢幕上反而更煩人。
 *   - 沒有「從 GitHub 重讀」：那是多檔批次編輯情境才需要的救援按鈕，
 *     單檔表單用不到。
 *   - 含「移除」：可以直接從手機清掉這一檔的目標價設定。
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { TargetEntry } from '../types'

const DEFAULT_ENTRY: TargetEntry = {
  target_price: 0,
  low_pct: 5,
  high_pct: 5,
  stop_loss: null,
  enabled: true,
}

function numOrUndef(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  )
}

export function TargetMiniForm({
  symbol,
  onSaved,
  onCancel,
}: {
  symbol: string
  onSaved: () => void
  onCancel: () => void
}) {
  const [full, setFull] = useState<Record<string, TargetEntry> | null>(null)
  const [entry, setEntry] = useState<TargetEntry>(DEFAULT_ENTRY)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .targets()
      .then(({ targets }) => {
        if (cancelled) return
        setFull(targets)
        setEntry(targets[symbol] ?? { ...DEFAULT_ENTRY })
      })
      .catch((e) => !cancelled && setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [symbol])

  function update(patch: Partial<TargetEntry>) {
    setEntry((e) => ({ ...e, ...patch }))
  }

  async function save() {
    // 目標買入價格 <= 0（或空白）的話，後端存檔時會直接跳過、不報錯——
    // 這裡先攔一次，不然使用者以為存進去了，其實被安靜濾掉（跟桌面版同一個坑）。
    if (!(entry.target_price > 0)) {
      setMsg({ kind: 'err', text: '目標買入價格必須大於 0' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const merged = { ...(full ?? {}), [symbol]: entry }
      const res = await api.saveTargets(merged)
      if (res.ok) {
        onSaved()
      } else {
        setMsg({ kind: 'err', text: res.message })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setMsg(null)
    try {
      const merged = { ...(full ?? {}) }
      delete merged[symbol]
      const res = await api.saveTargets(merged)
      if (res.ok) {
        onSaved()
      } else {
        setMsg({ kind: 'err', text: res.message })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="text-xs text-zinc-600">讀取目標價設定中…</p>
  }

  const hasEntry = !!full?.[symbol]

  return (
    <div className="space-y-2.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <Row label="啟用">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
          title="關閉後，這檔股票即使符合買入區間/停損條件也不會有任何提醒"
        />
      </Row>
      <Row label="目標買入價格">
        <input
          type="number"
          min={0}
          step="0.01"
          value={entry.target_price}
          onChange={(e) => update({ target_price: numOrUndef(e.target.value) ?? 0 })}
          className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
        />
      </Row>
      <div className="flex gap-3">
        <Row label="買入(L)%">
          <input
            type="number"
            min={0}
            step="0.1"
            value={entry.low_pct}
            onChange={(e) => update({ low_pct: numOrUndef(e.target.value) ?? 5 })}
            className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
          />
        </Row>
        <Row label="買入(U)%">
          <input
            type="number"
            min={0}
            step="0.1"
            value={entry.high_pct}
            onChange={(e) => update({ high_pct: numOrUndef(e.target.value) ?? 5 })}
            className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
          />
        </Row>
      </div>
      <Row label="停損價格（選填）">
        <input
          type="number"
          min={0}
          step="0.01"
          placeholder="選填"
          value={entry.stop_loss ?? ''}
          onChange={(e) => update({ stop_loss: numOrUndef(e.target.value) ?? null })}
          className="w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono tabular-nums text-zinc-100 placeholder:text-zinc-600"
        />
      </Row>

      {msg && <p className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>{msg.text}</p>}

      <div className="flex gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy}
          className="flex-1 rounded bg-emerald-600 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? '儲存中…' : '💾 儲存'}
        </button>
        {hasEntry && (
          <button
            onClick={remove}
            disabled={busy}
            className="rounded border border-rose-800 px-3 py-1.5 text-xs text-rose-300 disabled:opacity-40"
          >
            移除
          </button>
        )}
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 disabled:opacity-40"
        >
          取消
        </button>
      </div>
    </div>
  )
}
