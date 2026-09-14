/**
 * 手機版「設定」分頁。
 *
 * 只放手機情境下真的會用到的項目：推播總開關、慢線秒數、省電模式、
 * 切換回桌面版、PWA 安裝、以及（Round 3 定案）富邦登入的行內表單。
 * 其餘細節設定（時段、格式、偵測參數、連線黑盒子……）留在桌面版的
 * ⚙️ 設定視窗——那些是「調校」而不是「盤中常用」，手機上不必重複一份。
 */
import { useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { Settings } from '../types'
import { useResponsive } from './useResponsive'
import { usePwaInstall } from './usePwaInstall'

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-zinc-800 px-4 py-4 last:border-b-0">
      <h3 className="text-[13px] font-semibold text-zinc-200">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Toggle({
  on, onChange, label, hint,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <button onClick={() => onChange(!on)} className="flex w-full items-center justify-between gap-3 py-1.5 text-left">
      <span>
        <span className={`block text-xs ${on ? 'text-zinc-100' : 'text-zinc-400'}`}>{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">{hint}</span>}
      </span>
      <span className={`relative inline-flex h-[20px] w-9 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
        <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
      </span>
    </button>
  )
}

function LoginForm() {
  const [id, setId] = useState('')
  const [pwd, setPwd] = useState('')
  const [certPwd, setCertPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      await api.fubonLogin(id, pwd, certPwd)
      setId('')
      setPwd('')
      setCertPwd('')
      setMsg({ kind: 'ok', text: '✅ 已送出登入請求' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <input
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="身分證字號"
        autoComplete="off"
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
      />
      <input
        value={pwd}
        onChange={(e) => setPwd(e.target.value)}
        placeholder="富邦登入密碼"
        type="password"
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
      />
      <input
        value={certPwd}
        onChange={(e) => setCertPwd(e.target.value)}
        placeholder="憑證密碼"
        type="password"
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
      />
      {msg && (
        <p className={`text-xs ${msg.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'}`}>{msg.text}</p>
      )}
      <button
        type="submit"
        disabled={busy || !id || !pwd || !certPwd}
        className="w-full rounded bg-emerald-600 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? '連線中…' : '登入富邦'}
      </button>
      <p className="text-[11px] leading-relaxed text-zinc-600">憑證已存在伺服器端，這裡只需要帳密。資料不會儲存，送出後即清除。</p>
    </form>
  )
}

export function SettingsPage() {
  const { status, setStatus, powerSave, setPowerSave } = useStore()
  const { forceDesktop, setForceDesktop } = useResponsive()
  const { canInstall, installed, promptInstall } = usePwaInstall()
  const s = status?.settings
  const fubon = status?.fubon

  async function patch(p: Partial<Settings>) {
    try {
      const next = await api.patchSettings(p)
      const cur = useStore.getState().status
      if (cur) setStatus({ ...cur, settings: next })
    } catch {
      /* 設定寫入失敗不該中斷看盤 */
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section title="🔔 推播總開關" hint="細節時段與格式請到桌面版 ⚙️ 設定調整">
        <Toggle
          on={!!s?.line_push_enabled}
          onChange={(v) => patch({ line_push_enabled: v })}
          label="LINE 推送"
          hint="定時彙整推播"
        />
        <Toggle
          on={!!s?.tg_push_enabled}
          onChange={(v) => patch({ tg_push_enabled: v })}
          label="Telegram 推送"
          hint="盤中即時事件與 push 指令"
        />
      </Section>

      <Section title="⚙️ 更新節奏">
        <label className="flex items-center justify-between gap-3 py-1.5 text-xs text-zinc-400">
          慢線秒數（指標與訊號重算間隔）
          <input
            type="number"
            min={5}
            max={300}
            value={s?.row_refresh_sec ?? 20}
            onChange={(e) => patch({ row_refresh_sec: Math.max(5, Number(e.target.value) || 20) })}
            className="w-16 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-right font-mono tabular-nums text-zinc-100"
          />
        </label>
        <Toggle
          on={powerSave}
          onChange={setPowerSave}
          label="省電模式"
          hint="開啟後報價更新會節流成每 1~3 秒才套用一次畫面，較省電但價格跳動會變得比較不即時"
        />
      </Section>

      <Section title="📱 顯示">
        <Toggle
          on={forceDesktop}
          onChange={setForceDesktop}
          label="切換桌面版"
          hint="在這台裝置上強制顯示桌面版介面（表格、浮動視窗），重新整理後仍會維持這個選擇"
        />
        <div className="mt-2 flex items-center justify-between gap-3 py-1">
          <span>
            <span className="block text-xs text-zinc-100">加入主畫面（PWA）</span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-600">
              {installed ? '已安裝，可從主畫面直接開啟' : canInstall ? '把這個網頁加到手機主畫面，開啟時全螢幕、離線也能看到快取畫面' : '此瀏覽器目前不支援，或已經安裝過'}
            </span>
          </span>
          {canInstall && (
            <button onClick={promptInstall} className="shrink-0 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white">
              安裝
            </button>
          )}
        </div>
      </Section>

      <Section title="📡 富邦登入" hint="重連不需要重新輸入帳密，只有登入 session 失效才需要">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className={`h-2 w-2 rounded-full ${fubon?.logged_in ? 'bg-emerald-400' : 'bg-rose-500'}`} />
          <span className={fubon?.logged_in ? 'text-emerald-400' : 'text-rose-400'}>
            {fubon?.logged_in ? '已登入' : '尚未登入'}
          </span>
          {fubon?.connected && <span className="text-zinc-500">· 已訂閱 {fubon.subscribed_count} 檔</span>}
        </div>
        <LoginForm />
      </Section>
    </div>
  )
}
