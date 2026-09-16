/**
 * 股票分類編輯器。
 *
 * 左欄分類清單、右欄該分類的股票膠囊，加一個會查代碼與名稱的快速新增框。
 *
 * ── 兩個跟 Streamlit 版刻意不同的地方 ──
 *
 * 1. **明確按儲存，不是每個動作立刻寫檔。**
 *    原版是按下「刪除分類」就直接寫進磁碟並 rerun，誤點救不回來。這裡所有編輯
 *    都先改在本地草稿上，右上角顯示「未儲存」，關視窗會攔截。後端在真正寫檔前
 *    還會自動留一份備份快照。
 *
 * 2. **搜尋而不是打字。**
 *    原版是一個 textarea，每行一檔代碼。這裡打「台積」或「2330」都能查，
 *    Enter 直接加入——那 2,173 檔的對照表本來就在後端記憶體裡，查詢成本是零。
 *    （仍然保留貼上大量代碼的路徑：貼進搜尋框的多筆逗號／換行文字會一次全部解析。）
 *
 * 存檔之後後端會同步訂閱：新增的訂閱、移除的退訂。退訂拿不到訂閱 id 時會走
 * 重連重訂的退路，那會有 2–3 秒沒有報價——所以存檔結果會把實際數字回報出來。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { SymbolHit } from '../types'
import { Modal } from './Modal'

type Groups = Record<string, string[]>

/** 把貼上的多筆文字拆成代碼陣列（逗號、全形逗號、換行都算分隔） */
function parseBulk(text: string): string[] {
  return text
    .replace(/，/g, ',')
    .split(/[\n,]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

function Chip({ symbol, name, onRemove }: { symbol: string; name?: string; onRemove: () => void }) {
  const code = symbol.split('.')[0]
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 py-1 pl-2 pr-1 text-xs">
      <span className="font-mono text-zinc-400">{code}</span>
      <span className="text-zinc-200">{name ?? ''}</span>
      <button
        onClick={onRemove}
        aria-label={`移除 ${code}`}
        className="rounded px-1 text-zinc-600 hover:bg-zinc-800 hover:text-rose-400"
      >
        ✕
      </button>
    </span>
  )
}

export function GroupEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { rows, setStatus } = useStore()
  const [draft, setDraft] = useState<Groups>({})
  const [original, setOriginal] = useState<Groups>({})
  const [selected, setSelected] = useState<string>('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SymbolHit[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // GitHub 同步診斷的結果文字（按下錯誤訊息旁的診斷鈕才會有）
  const [diag, setDiag] = useState<string>('')
  const searchRef = useRef<HTMLInputElement>(null)

  // 代碼 → 名稱。先用 rows 裡現成的，查不到再靠搜尋結果補。
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

  // 開啟時抓一次最新的分組。不用 store 裡的 status.groups——那只有檔數沒有代碼。
  useEffect(() => {
    if (!open) return
    setMsg(null)
    api
      .groups()
      .then(({ groups }) => {
        setDraft(groups)
        setOriginal(groups)
        setSelected((s) => (s && groups[s] ? s : Object.keys(groups)[0] ?? ''))
      })
      .catch((e) => setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
  }, [open])

  // 搜尋去抖動 200ms：每打一個字就打一次 API 沒有必要，而且會讓結果亂跳
  useEffect(() => {
    const q = query.trim()
    if (q.length < 1 || parseBulk(q).length > 1) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      api.searchSymbols(q).then(({ results }) => setHits(results)).catch(() => setHits([]))
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  const members = draft[selected] ?? []

  const addSymbol = useCallback(
    (symbol: string) => {
      if (!selected) return
      setDraft((d) => {
        const cur = d[selected] ?? []
        if (cur.includes(symbol)) return d
        return { ...d, [selected]: [...cur, symbol] }
      })
      setQuery('')
      setHits([])
      searchRef.current?.focus()
    },
    [selected],
  )

  function addBulk() {
    const parts = parseBulk(query)
    if (parts.length === 0 || !selected) return
    // 多筆貼上走本地正規化（3/6/8 開頭是上櫃 .TWO，其餘 .TW），跟後端規則一致
    const normalized = parts.map((p) =>
      p.includes('.') ? p : /^[368]/.test(p) ? `${p}.TWO` : `${p}.TW`,
    )
    setDraft((d) => {
      const cur = d[selected] ?? []
      const merged = [...cur]
      for (const s of normalized) if (!merged.includes(s)) merged.push(s)
      return { ...d, [selected]: merged }
    })
    setQuery('')
  }

  function addGroup() {
    const name = window.prompt('新分類名稱')?.trim()
    if (!name) return
    if (draft[name]) {
      setMsg({ kind: 'err', text: '分類名稱已存在' })
      return
    }
    setDraft((d) => ({ ...d, [name]: [] }))
    setSelected(name)
  }

  function renameGroup() {
    if (!selected) return
    const name = window.prompt('改成什麼名稱？', selected)?.trim()
    if (!name || name === selected) return
    if (draft[name]) {
      setMsg({ kind: 'err', text: '分類名稱已存在' })
      return
    }
    // 重建物件以保留原本的順序——分類順序決定儀表板卡片的排列
    setDraft((d) => {
      const out: Groups = {}
      for (const [k, v] of Object.entries(d)) out[k === selected ? name : k] = v
      return out
    })
    setSelected(name)
  }

  function deleteGroup() {
    if (!selected) return
    if (Object.keys(draft).length <= 1) {
      setMsg({ kind: 'err', text: '至少要保留一個分類' })
      return
    }
    if (!window.confirm(`確定刪除分類「${selected}」？（按儲存後才會真的寫入）`)) return
    setDraft((d) => {
      const out = { ...d }
      delete out[selected]
      return out
    })
    setSelected(Object.keys(draft).filter((k) => k !== selected)[0] ?? '')
  }

  function move(dir: -1 | 1) {
    const keys = Object.keys(draft)
    const i = keys.indexOf(selected)
    const j = i + dir
    if (i < 0 || j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    setDraft(Object.fromEntries(keys.map((k) => [k, draft[k]])))
  }

  async function save() {
    setBusy(true)
    setMsg(null)
    try {
      const res = await api.saveGroups(draft)
      setOriginal(res.groups)
      setDraft(res.groups)
      const sub = res.subscription
      setMsg({
        kind: res.ok ? 'ok' : 'err',
        text:
          res.message +
          (sub ? `　訂閱：新增 ${sub.added}、退訂 ${sub.removed}${sub.reconnected ? '（走重連重訂）' : ''}` : ''),
      })
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
      const { groups } = await api.reloadGroupsFromGithub()
      setDraft(groups)
      setOriginal(groups)
      setSelected(Object.keys(groups)[0] ?? '')
      setMsg({ kind: 'ok', text: '已從 GitHub 重新載入' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'stock_groups.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  function requestClose() {
    if (dirty && !window.confirm('有未儲存的變更，關閉會捨棄。確定關閉嗎？')) return
    onClose()
  }

  const totalStocks = useMemo(
    () => new Set(Object.values(draft).flat()).size,
    [draft],
  )

  return (
    <Modal
      open={open}
      onClose={requestClose}
      size="lg"
      title="🛠️ 股票分類編輯"
      subtitle={`${Object.keys(draft).length} 個分類　·　${totalStocks} 檔（去重後）`}
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
          {/*
            同步失敗時直接把診斷按在錯誤旁邊。

            「請確認 GITHUB_TOKEN / OWNER / REPO」這種訊息等於沒說 —— token 失效、
            權限不足、repo 名稱打錯、分支不存在，四種原因的處理方式完全不同，
            但長得一模一樣。這顆按鈕會實際去問 GitHub，回報到底是哪一種。
            **不會顯示 token 本身**，只有長度與前四碼，足夠判斷有沒有貼錯。
          */}
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

      <div className="flex min-h-0 flex-1">
        {/* 左：分類清單 */}
        <div className="flex w-56 shrink-0 flex-col border-r border-zinc-800">
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {Object.entries(draft).map(([name, list]) => (
              <button
                key={name}
                onClick={() => setSelected(name)}
                className={`flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-xs ${
                  name === selected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                <span className="truncate">{name}</span>
                <span className="shrink-0 font-mono tabular-nums text-zinc-600">{list.length}</span>
              </button>
            ))}
          </div>
          <div className="flex shrink-0 flex-wrap gap-1 border-t border-zinc-800 p-2 text-[11px]">
            <button onClick={addGroup} className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
              ＋ 新增
            </button>
            <button onClick={renameGroup} className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
              改名
            </button>
            <button
              onClick={deleteGroup}
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-rose-400 hover:bg-zinc-800"
            >
              刪除
            </button>
            <button onClick={() => move(-1)} className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
              ↑
            </button>
            <button onClick={() => move(1)} className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800">
              ↓
            </button>
          </div>
        </div>

        {/* 右：該分類的股票 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-zinc-800 p-3">
            <div className="relative">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  if (parseBulk(query).length > 1) addBulk()
                  else if (hits[0]) addSymbol(hits[0].symbol)
                }}
                placeholder="⚡ 快速新增：打代碼或名稱（如 2330 或 台積），Enter 加入；也可貼上多筆"
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600"
              />
              {hits.length > 0 && (
                <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-xl">
                  {hits.map((h) => {
                    const already = members.includes(h.symbol)
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
                          {already ? '已在此分類' : h.symbol}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            {parseBulk(query).length > 1 && (
              <div className="mt-1.5 text-[11px] text-zinc-500">
                偵測到 {parseBulk(query).length} 筆，按 Enter 或
                <button onClick={addBulk} className="ml-1 rounded border border-zinc-700 px-1.5 hover:bg-zinc-800">
                  一次全部加入
                </button>
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!selected ? (
              <div className="text-xs text-zinc-600">先在左邊選一個分類。</div>
            ) : members.length === 0 ? (
              <div className="text-xs text-zinc-600">這個分類還沒有股票，用上面的搜尋框加入。</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {members.map((sym) => (
                  <Chip
                    key={sym}
                    symbol={sym}
                    name={nameOf[sym.split('.')[0]]}
                    onRemove={() =>
                      setDraft((d) => ({ ...d, [selected]: d[selected].filter((x) => x !== sym) }))
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2 text-[11px]">
            <button onClick={exportJson} className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">
              ⬇️ 匯出 JSON
            </button>
            <button
              onClick={reloadFromGithub}
              disabled={busy}
              className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800 disabled:opacity-40"
            >
              ♻️ 從 GitHub 重讀
            </button>
            <span className="ml-auto text-zinc-600">
              存檔前會自動留一份備份快照
            </span>
          </div>
        </div>
      </div>
    </Modal>
  )
}
