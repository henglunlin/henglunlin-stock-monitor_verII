/**
 * 目標價編輯器（買入區間 + 停損）。
 *
 * 取代舊 Streamlit 版 pages/2_🎯_目標價編輯.py 的表格編輯頁面，風格與行為
 * 刻意比照 GroupEditor.tsx：本地草稿 + 明確按儲存（不是每個動作立刻寫檔）、
 * 存檔前後端會自動留一份備份快照、可以從 GitHub 重讀。
 *
 * 資料格式跟 target_price_list.json 一致，只存「原始輸入」四個欄位
 * （中心價、買入價格(L)%、買入價格(U)%、停損價格）——買入區間的絕對值
 * 一律由後端 core/targets.py 的 compute_buy_zone() 現算，這裡不重算、
 * 也不顯示換算後的絕對值，避免前端另外維護一份可能漂移的公式
 * （沿用 TargetScale.tsx 已經寫明的「訊號公式只留在 Python」原則）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { SymbolHit, TargetEntry } from '../types'
import { Modal } from './Modal'

type Targets = Record<string, TargetEntry>

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

export function TargetEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { rows, setStatus } = useStore()
  const [draft, setDraft] = useState<Targets>({})
  const [original, setOriginal] = useState<Targets>({})
  const [order, setOrder] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SymbolHit[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [diag, setDiag] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const nameOf = useMemo(() => {
    const m: Record<string, string> = {}
    for (const r of rows) m[r.code] = r.name
    for (const h of hits) m[h.code] = h.name
    return m
  }, [rows, hits])

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  )

  // 開啟時抓一次最新的目標價設定
  useEffect(() => {
    if (!open) return
    setMsg(null)
    api
      .targets()
      .then(({ targets }) => {
        setDraft(targets)
        setOriginal(targets)
        setOrder(Object.keys(targets))
      })
      .catch((e) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
  }, [open])

  // 搜尋去抖動 200ms，跟 GroupEditor 一致
  useEffect(() => {
    const q = query.trim()
    if (q.length < 1) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      api.searchSymbols(q).then(({ results }) => setHits(results)).catch(() => setHits([]))
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  function addSymbol(symbol: string) {
    setDraft((d) => (d[symbol] ? d : { ...d, [symbol]: { ...DEFAULT_ENTRY } }))
    setOrder((o) => (o.includes(symbol) ? o : [...o, symbol]))
    setQuery('')
    setHits([])
    searchRef.current?.focus()
  }

  function removeSymbol(symbol: string) {
    setDraft((d) => {
      const out = { ...d }
      delete out[symbol]
      return out
    })
    setOrder((o) => o.filter((s) => s !== symbol))
  }

  function updateEntry(symbol: string, patch: Partial<TargetEntry>) {
    setDraft((d) => ({ ...d, [symbol]: { ...d[symbol], ...patch } }))
  }

  async function save() {
    // target_price <= 0（或空白）的股票，後端驗證時會直接跳過、不報錯——
    // 這裡先攔一次，不然使用者以為存進去了，其實那一筆被安靜濾掉。
    const invalid = order.filter((s) => !(draft[s]?.target_price > 0))
    if (invalid.length > 0) {
      setMsg({
        kind: 'err',
        text: `這些股票還沒填目標買入價格（必須大於 0），請填妥或移除後再儲存：${invalid
          .map((s) => s.split('.')[0])
          .join('、')}`,
      })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await api.saveTargets(draft)
      setOriginal(res.targets)
      setDraft(res.targets)
      setOrder(Object.keys(res.targets))
      setMsg({ kind: res.ok ? 'ok' : 'err', text: res.message })
      try {
        setStatus(await api.status())
      } catch {
        /* 狀態抓不到不影響存檔結果 */
      }
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function reloadFromGithub() {
    if (dirty && !window.confirm('有未儲存的變更，從 GitHub 重讀會覆蓋掉。要繼續嗎？')) return
    setBusy(true)
    try {
      const { targets } = await api.reloadTargetsFromGithub()
      setDraft(targets)
      setOriginal(targets)
      setOrder(Object.keys(targets))
      setMsg({ kind: 'ok', text: '已從 GitHub 重新載入' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  function requestClose() {
    if (dirty && !window.confirm('有未儲存的變更，關閉會捨棄。確定關閉嗎？')) return
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      size="lg"
      title="🎯 目標價編輯"
      subtitle={`${order.length} 檔設定了目標價　·　買入區間 = 中心價 ×（1 ± 百分比）`}
      actions={
        <>
          {dirty && (
            <span className="rounded bg-amber-500/15 px-2 py-1 text-[11px] text-amber-300">
              有未儲存的變更
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty || busy}
            className="rounded bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? '儲存中…' : '💾 儲存'}
          </button>
        </>
      }
    >
      {msg && (
        <div
          className={`shrink-0 border-b px-4 py-2 text-xs ${
            msg.kind === 'ok'
              ? 'border-emerald-900/50 bg-emerald-950/30 text-emerald-300'
              : 'border-rose-900/50 bg-rose-950/40 text-rose-300'
          }`}
        >
          {msg.text}
          {msg.kind === 'err' && msg.text.includes('GitHub') && (
            <div className="mt-2">
              <button
                onClick={async () => {
                  setDiag('診斷中…')
                  try {
                    const d = await api.githubDebug()
                    setDiag(
                      `${d.verdict ?? '（無結論）'}　`
                      + (d.token_present
                        ? `token 長度 ${d.token_len}、開頭 ${d.token_prefix}`
                        : 'token 未設定')
                      + `　目標 ${d.owner ?? '?'}/${d.repo ?? '?'}@${d.branch ?? '?'}`,
                    )
                  } catch (e) {
                    setDiag(e instanceof Error ? e.message : String(e))
                  }
                }}
                className="rounded border border-rose-800 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/40"
              >
                🔍 診斷同步失敗的原因
              </button>
              {diag && <div className="mt-1.5 leading-relaxed text-[11px] text-zinc-300">{diag}</div>}
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-zinc-800 p-3">
          <div className="relative">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hits[0]) addSymbol(hits[0].symbol)
              }}
              placeholder="⚡ 新增一檔：打代碼或名稱（如 2330 或 台積），Enter 加入"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
            />
            {hits.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-xl">
                {hits.map((h) => {
                  const already = !!draft[h.symbol]
                  return (
                    <button
                      key={h.symbol}
                      onClick={() => !already && addSymbol(h.symbol)}
                      disabled={already}
                      className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-zinc-800 disabled:opacity-40"
                    >
                      <span className="font-mono text-zinc-400">{h.code}</span>
                      <span className="text-zinc-100">{h.name}</span>
                      <span className="ml-auto text-[10px] text-zinc-600">
                        {already ? '已設定目標價' : h.symbol}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {order.length === 0 ? (
            <div className="p-6 text-center text-xs text-zinc-600">
              還沒有股票設定目標價，用上面的搜尋框新增。
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-zinc-900">
                <tr>
                  {['啟用', '股票', '目標買入價格', '買入(L)%', '買入(U)%', '停損價格', ''].map((h) => (
                    <th
                      key={h}
                      className="border-b border-zinc-800 px-2.5 py-2 text-left font-medium text-zinc-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {order.map((symbol) => {
                  const entry = draft[symbol]
                  if (!entry) return null
                  const code = symbol.split('.')[0]
                  return (
                    <tr key={symbol} className="border-b border-zinc-900 hover:bg-zinc-900/50">
                      <td className="px-2.5 py-1.5">
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          onChange={(e) => updateEntry(symbol, { enabled: e.target.checked })}
                          title="關閉後，這檔股票即使符合買入區間/停損條件也不會有任何提醒"
                        />
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-1.5">
                        <span className="font-mono text-zinc-400">{code}</span>
                        <span className="ml-1.5 text-zinc-200">{nameOf[code] ?? ''}</span>
                      </td>
                      <td className="px-2.5 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={entry.target_price}
                          onChange={(e) =>
                            updateEntry(symbol, { target_price: numOrUndef(e.target.value) ?? 0 })
                          }
                          className="w-24 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-100"
                        />
                      </td>
                      <td className="px-2.5 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={entry.low_pct}
                          onChange={(e) =>
                            updateEntry(symbol, { low_pct: numOrUndef(e.target.value) ?? 5 })
                          }
                          className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-100"
                        />
                      </td>
                      <td className="px-2.5 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={entry.high_pct}
                          onChange={(e) =>
                            updateEntry(symbol, { high_pct: numOrUndef(e.target.value) ?? 5 })
                          }
                          className="w-20 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-100"
                        />
                      </td>
                      <td className="px-2.5 py-1.5">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder="選填"
                          value={entry.stop_loss ?? ''}
                          onChange={(e) =>
                            updateEntry(symbol, { stop_loss: numOrUndef(e.target.value) ?? null })
                          }
                          className="w-24 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-100 placeholder:text-zinc-600"
                        />
                      </td>
                      <td className="px-2.5 py-1.5">
                        <button
                          onClick={() => removeSymbol(symbol)}
                          aria-label={`移除 ${code}`}
                          className="rounded px-1.5 py-0.5 text-zinc-600 hover:bg-zinc-800 hover:text-rose-400"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2 text-[11px]">
          <button
            onClick={reloadFromGithub}
            disabled={busy}
            className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 disabled:opacity-40"
          >
            ♻️ 從 GitHub 重讀
          </button>
          <span className="ml-auto text-zinc-600">存檔前會自動留一份備份快照</span>
        </div>
      </div>
    </Modal>
  )
}
