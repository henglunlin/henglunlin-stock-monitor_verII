/**
 * 富邦登入表單。
 *
 * 依 Phase 0 的決定：憑證（pfx）放在後端環境變數，身分證／密碼／憑證密碼
 * 由這裡輸入，一天一次。所以這個表單要好按、好找 —— Render 冷啟動後會需要重登。
 *
 * 三個欄位都不存進 localStorage、不預填、送出後立刻清空。
 * 密碼只在這一次請求裡存在。
 */
import { forwardRef, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

export function LoginDialog({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [id, setId] = useState('')
  const [pwd, setPwd] = useState('')
  const [certPwd, setCertPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const firstField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setErr(null)
      setTimeout(() => firstField.current?.focus(), 50)
    }
  }, [open])

  if (!open) return null

  const clear = () => {
    setId('')
    setPwd('')
    setCertPwd('')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      await api.fubonLogin(id, pwd, certPwd)
      clear()
      onSuccess()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">登入富邦 WebSocket</h2>
        <p className="mt-1 text-xs text-zinc-400">
          憑證已存在伺服器端，這裡只需要帳密。資料不會儲存，送出後即清除。
        </p>

        <div className="mt-4 space-y-3">
          <Field ref={firstField} label="身分證字號" value={id} onChange={setId} autoComplete="off" />
          <Field label="富邦登入密碼" value={pwd} onChange={setPwd} type="password" />
          <Field label="憑證密碼" value={certPwd} onChange={setCertPwd} type="password" />
        </div>

        {err && (
          <div className="mt-3 rounded border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">{err}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              clear()
              onClose()
            }}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !id || !pwd || !certPwd}
            className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-emerald-500"
          >
            {busy ? '連線中…' : '連線'}
          </button>
        </div>
      </form>
    </div>
  )
}

interface FieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoComplete?: string
}

const Field = forwardRef<HTMLInputElement, FieldProps>(
  ({ label, value, onChange, type = 'text', autoComplete = 'off' }, ref) => (
    <label className="block">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        ref={ref}
        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500"
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  ),
)
Field.displayName = 'Field'
