/**
 * 推播名單（多人 Telegram / LINE）。
 *
 * 取代舊版「Telegram/LINE 各自只能推給 .env 裡寫死那一個對象」的畫面。
 * 對應後端 core/recipients.py + /api/push/recipients* 那組端點，設計理由都寫在
 * core/recipients.py 的檔頭，這裡只講畫面上的取捨：
 *
 * - **PIN 不是先驗證再解鎖，是「帶著送，錯了才知道」**：這支刻意不呼叫任何
 *   「驗證 PIN」端點（後端也沒有這種端點）——PIN 只在你真的按下新增/修改/刪除
 *   時才會連同那次請求一起送出，後端回 403 才代表錯。這樣不用多一支
 *   「純驗證」的 API，行為也更單純：PIN 對不對只在真的要改東西的那一刻才重要。
 * - **PIN 還沒設過時，畫面上完全不會出現輸入框**——沿用後端「pin_hash 是 None
 *   就不擋」的設計，讓你自己第一次用不用先想一組 PIN。
 * - LINE 的 `intraday`（盤中即時事件）打勾在畫面上特別標成警示色：一旦有 LINE
 *   對象勾了這個，且該對象是「個人」而不是「群組」，一次盤中事件掃描可能對
 *   198 檔逐一觸發，個人對象是「發一個算一則」，很容易一個上午就把月額度用完；
 *   群組不管人數多寡通常算一則，風險小很多，所以文字跟著 kind 動態變化。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { PushRecipientLine, PushRecipientTelegram, PushRecipients } from '../types'

function fieldCls(invalid?: boolean) {
  return `w-full rounded border bg-zinc-900 px-2 py-1 text-xs text-zinc-100 ${
    invalid ? 'border-rose-600' : 'border-zinc-700'
  }`
}

function MiniCheck({
  on, onChange, label, warn,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  warn?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className={warn && on ? 'accent-amber-500' : 'accent-emerald-500'}
      />
      <span className={`text-[11px] ${on ? (warn ? 'text-amber-400' : 'text-zinc-200') : 'text-zinc-500'}`}>
        {label}
      </span>
    </label>
  )
}

/** 一個文字欄位，離開欄位才送 PATCH——跟 SettingsDialog 的 SlotEditor 同一個理由：不要每個字元都打 API。 */
function EditableText({
  value, onCommit, placeholder, mono,
}: {
  value: string
  onCommit: (next: string) => void
  placeholder?: string
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setDraft(value) }, [value, dirty])
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
      onBlur={() => { setDirty(false); if (draft !== value) onCommit(draft) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className={`${fieldCls()} ${mono ? 'font-mono' : ''}`}
    />
  )
}

export function PushRecipientsPanel() {
  const [data, setData] = useState<PushRecipients | null>(null)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 新增列的暫存草稿
  const [tgLabel, setTgLabel] = useState('')
  const [tgChatId, setTgChatId] = useState('')
  const [lnLabel, setLnLabel] = useState('')
  const [lnTargetId, setLnTargetId] = useState('')
  const [lnKind, setLnKind] = useState<'group' | 'user' | 'room'>('group')

  // 設定/變更 PIN 的小表單
  const [showPinForm, setShowPinForm] = useState(false)
  const [newPin, setNewPin] = useState('')
  const [newPin2, setNewPin2] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api.pushRecipients())
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => { load() }, [load])

  const pinArg = data?.pin_set ? (pin || null) : null

  async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    setErr(null)
    try {
      const r = await fn()
      await load()
      return r
    } catch (e) {
      setErr(String(e).includes('PIN') ? '❌ PIN 不正確' : `❌ ${String(e)}`)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function addTelegram() {
    if (!tgLabel.trim() || !tgChatId.trim()) return
    const ok = await guarded(() =>
      api.addTelegramRecipient({ label: tgLabel.trim(), chat_id: tgChatId.trim(), intraday: false, digest: true }, pinArg),
    )
    if (ok) { setTgLabel(''); setTgChatId('') }
  }

  async function addLine() {
    if (!lnLabel.trim() || !lnTargetId.trim()) return
    const ok = await guarded(() =>
      api.addLineRecipient(
        { label: lnLabel.trim(), target_id: lnTargetId.trim(), kind: lnKind, intraday: false, digest: true }, pinArg,
      ),
    )
    if (ok) { setLnLabel(''); setLnTargetId('') }
  }

  async function submitPinChange() {
    if (newPin && newPin !== newPin2) {
      setErr('❌ 兩次輸入的新 PIN 不一致')
      return
    }
    const ok = await guarded(() => api.setPushPin(newPin || null, data?.pin_set ? (pin || null) : null))
    if (ok) {
      setShowPinForm(false)
      setPin(newPin)
      setNewPin('')
      setNewPin2('')
    }
  }

  if (!data) {
    return <p className="text-[11px] text-zinc-500">{err ? `❌ ${err}` : '載入中…'}</p>
  }

  return (
    <div>
      {/* PIN 輸入／設定 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {data.pin_set ? (
          <>
            <span className="text-[11px] text-zinc-500">🔒 PIN</span>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="輸入 PIN 才能新增/修改/刪除"
              className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
            />
          </>
        ) : (
          <span className="text-[11px] text-zinc-500">🔓 目前沒有設定 PIN，任何看得到這頁的人都能改名單</span>
        )}
        <button
          onClick={() => setShowPinForm((v) => !v)}
          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
        >
          {data.pin_set ? '變更 PIN' : '設定 PIN'}
        </button>
      </div>

      {showPinForm && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-900/60 p-2">
          {data.pin_set && (
            <span className="text-[11px] text-zinc-500">
              （上面已輸入現有 PIN，這裡只填新的；留白＝解除保護）
            </span>
          )}
          <input
            type="password"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            placeholder="新 PIN（留白＝取消保護）"
            className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
          />
          <input
            type="password"
            value={newPin2}
            onChange={(e) => setNewPin2(e.target.value)}
            placeholder="再輸入一次"
            className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
          />
          <button
            onClick={submitPinChange}
            disabled={busy}
            className="rounded border border-emerald-700 bg-emerald-900/30 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50"
          >
            儲存
          </button>
        </div>
      )}

      {err && <p className="mb-2 text-[11px] text-rose-400">{err}</p>}

      {/* Telegram 名單 */}
      <p className="mb-1 text-[11px] font-medium text-zinc-400">Telegram（同一個 Bot，各自的 chat_id）</p>
      <div className="mb-1 overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-left">
          <thead>
            <tr className="text-[10px] text-zinc-600">
              <th className="pb-1 pr-2 font-normal">名稱</th>
              <th className="pb-1 pr-2 font-normal">chat_id</th>
              <th className="pb-1 pr-2 font-normal">即時</th>
              <th className="pb-1 pr-2 font-normal">彙整</th>
              <th className="pb-1 pr-2 font-normal">啟用</th>
              <th className="pb-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {data.telegram.map((r) => (
              <TgRow key={r.id} row={r} pin={pinArg} onChange={() => load()} onError={setErr} setBusy={setBusy} />
            ))}
            <tr>
              <td className="py-1 pr-2">
                <input value={tgLabel} onChange={(e) => setTgLabel(e.target.value)} placeholder="標籤，例如「阿明」" className={fieldCls()} />
              </td>
              <td className="py-1 pr-2">
                <input value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} placeholder="chat_id" className={`${fieldCls()} font-mono`} />
              </td>
              <td colSpan={3} />
              <td className="py-1">
                <button
                  onClick={addTelegram}
                  disabled={busy || !tgLabel.trim() || !tgChatId.trim()}
                  className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  ＋新增
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-zinc-600">
        要拿到某人的 chat_id：請對方先傳一句話給你的 Bot（Telegram 的規定——Bot 不能主動私訊
        沒講過話的人），然後在瀏覽器打開{' '}
        <code className="font-mono break-all">
          https://api.telegram.org/bot&lt;你的 TELEGRAM_BOT_TOKEN&gt;/getUpdates
        </code>{' '}
        ，在回傳的 JSON 裡找 <code className="font-mono">message.chat.id</code>。群組也可以，把
        Bot 拉進群組後 chat_id 會是負數。
      </p>

      {/* LINE 名單 */}
      <p className="mb-1 text-[11px] font-medium text-zinc-400">
        LINE（建議用「群組」——群組不管人數，一次推播通常只算 1 則額度）
      </p>
      <div className="mb-1 overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-left">
          <thead>
            <tr className="text-[10px] text-zinc-600">
              <th className="pb-1 pr-2 font-normal">名稱</th>
              <th className="pb-1 pr-2 font-normal">ID</th>
              <th className="pb-1 pr-2 font-normal">類型</th>
              <th className="pb-1 pr-2 font-normal">即時</th>
              <th className="pb-1 pr-2 font-normal">彙整</th>
              <th className="pb-1 pr-2 font-normal">啟用</th>
              <th className="pb-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {data.line.map((r) => (
              <LineRow key={r.id} row={r} pin={pinArg} onChange={() => load()} onError={setErr} setBusy={setBusy} />
            ))}
            <tr>
              <td className="py-1 pr-2">
                <input value={lnLabel} onChange={(e) => setLnLabel(e.target.value)} placeholder="標籤，例如「家人群組」" className={fieldCls()} />
              </td>
              <td className="py-1 pr-2">
                <input value={lnTargetId} onChange={(e) => setLnTargetId(e.target.value)} placeholder="groupId / userId" className={`${fieldCls()} font-mono`} />
              </td>
              <td className="py-1 pr-2">
                <select
                  value={lnKind}
                  onChange={(e) => setLnKind(e.target.value as 'group' | 'user' | 'room')}
                  className="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-[11px] text-zinc-100"
                >
                  <option value="group">群組</option>
                  <option value="room">多人聊天室</option>
                  <option value="user">個人</option>
                </select>
              </td>
              <td colSpan={3} />
              <td className="py-1">
                <button
                  onClick={addLine}
                  disabled={busy || !lnLabel.trim() || !lnTargetId.trim()}
                  className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  ＋新增
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-600">
        怎麼拿到群組 ID：① 確認已設定 <code className="font-mono">LINE_CHANNEL_SECRET</code> 且 LINE
        Developers 的 Webhook URL 指到 <code className="font-mono">/api/line/webhook</code>（見上方
        「LINE 推送狀態」區塊）。② 把這個 LINE Bot 加進你想收通知的群組。③ 在群組裡傳一句
        「<code className="font-mono">id</code>」，Bot 會直接回傳這個群組的 ID，複製貼到上面「ID」欄位即可。
      </p>
    </div>
  )
}

function TgRow({
  row, pin, onChange, onError, setBusy,
}: {
  row: PushRecipientTelegram
  pin: string | null
  onChange: () => void
  onError: (e: string | null) => void
  setBusy: (b: boolean) => void
}) {
  async function patch(p: Partial<PushRecipientTelegram>) {
    setBusy(true)
    onError(null)
    try {
      await api.updateTelegramRecipient(row.id, p, pin)
      onChange()
    } catch (e) {
      onError(String(e).includes('PIN') ? '❌ PIN 不正確' : `❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  async function del() {
    setBusy(true)
    onError(null)
    try {
      await api.deleteTelegramRecipient(row.id, pin)
      onChange()
    } catch (e) {
      onError(String(e).includes('PIN') ? '❌ PIN 不正確' : `❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <tr className={row.enabled ? '' : 'opacity-40'}>
      <td className="py-1 pr-2"><EditableText value={row.label} onCommit={(v) => patch({ label: v })} /></td>
      <td className="py-1 pr-2"><EditableText value={row.chat_id} onCommit={(v) => patch({ chat_id: v })} mono /></td>
      <td className="py-1 pr-2"><MiniCheck on={row.intraday} onChange={(v) => patch({ intraday: v })} label="即時" /></td>
      <td className="py-1 pr-2"><MiniCheck on={row.digest} onChange={(v) => patch({ digest: v })} label="彙整" /></td>
      <td className="py-1 pr-2"><MiniCheck on={row.enabled} onChange={(v) => patch({ enabled: v })} label="啟用" /></td>
      <td className="py-1">
        <button onClick={del} className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:border-rose-700 hover:text-rose-400">
          刪除
        </button>
      </td>
    </tr>
  )
}

function LineRow({
  row, pin, onChange, onError, setBusy,
}: {
  row: PushRecipientLine
  pin: string | null
  onChange: () => void
  onError: (e: string | null) => void
  setBusy: (b: boolean) => void
}) {
  async function patch(p: Partial<PushRecipientLine>) {
    setBusy(true)
    onError(null)
    try {
      await api.updateLineRecipient(row.id, p, pin)
      onChange()
    } catch (e) {
      onError(String(e).includes('PIN') ? '❌ PIN 不正確' : `❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  async function del() {
    setBusy(true)
    onError(null)
    try {
      await api.deleteLineRecipient(row.id, pin)
      onChange()
    } catch (e) {
      onError(String(e).includes('PIN') ? '❌ PIN 不正確' : `❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  // 個人對象勾即時事件才是真的燒額度的組合（群組不管人數通常算 1 則）——警示只在這個組合下出現
  const riskyIntraday = row.kind === 'user'
  return (
    <tr className={row.enabled ? '' : 'opacity-40'}>
      <td className="py-1 pr-2"><EditableText value={row.label} onCommit={(v) => patch({ label: v })} /></td>
      <td className="py-1 pr-2"><EditableText value={row.target_id} onCommit={(v) => patch({ target_id: v })} mono /></td>
      <td className="py-1 pr-2">
        <select
          value={row.kind}
          onChange={(e) => patch({ kind: e.target.value as PushRecipientLine['kind'] })}
          className="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-[11px] text-zinc-100"
        >
          <option value="group">群組</option>
          <option value="room">多人聊天室</option>
          <option value="user">個人</option>
        </select>
      </td>
      <td className="py-1 pr-2">
        <MiniCheck on={row.intraday} onChange={(v) => patch({ intraday: v })} label="即時" warn={riskyIntraday} />
      </td>
      <td className="py-1 pr-2"><MiniCheck on={row.digest} onChange={(v) => patch({ digest: v })} label="彙整" /></td>
      <td className="py-1 pr-2"><MiniCheck on={row.enabled} onChange={(v) => patch({ enabled: v })} label="啟用" /></td>
      <td className="py-1">
        <button onClick={del} className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 hover:border-rose-700 hover:text-rose-400">
          刪除
        </button>
      </td>
    </tr>
  )
}
