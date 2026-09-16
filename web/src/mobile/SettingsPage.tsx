/**
 * 手機版「設定」分頁。
 *
 * 只放手機情境下真的會用到的項目：推播總開關、慢線秒數、省電模式、
 * 切換回桌面版、PWA 安裝、以及（Round 3 定案）富邦登入的行內表單。
 * 其餘細節設定（時段、格式、偵測參數、連線黑盒子……）留在桌面版的
 * ⚙️ 設定視窗——那些是「調校」而不是「盤中常用」，手機上不必重複一份。
 *
 * 2026-09-16 補：使用者要求把「📦 資料來源與模式」跟「⚡ 盤中監控與觸發」
 * 這兩個桌面版才有的分頁也搬過來——資料來源切換、盤中偵測參數其實都是
 * 「出門在外也可能要臨時調」的東西（例如富邦斷線改用 yfinance、盤中訊號太吵
 * 要調高門檻），跟原本判斷「調校型設定留桌面版」的理由並不衝突：那個理由
 * 針對的是「不常改、改了也不急」的參數（推播格式細節、K 線篩選……），
 * 這兩類則常常需要即時反應，所以補進來。內容直接對應桌面版
 * SettingsDialog.tsx 同名分頁，共用同一份 Settings 型別與 API。
 *
 * 2026-09-16 再補：富邦登入區塊改成可收合——展開時（帳密＋憑證密碼三個
 * 欄位＋按鈕＋說明文字）佔的高度很大，登入後其實很少會再打開，卻一直
 * 把分頁列往下推，手機螢幕本來就小，這樣每次進設定都要先滑一段距離
 * 才看得到分頁。改成預設收合，只留狀態列（登入中/未登入的燈號）常駐，
 * 點一下才展開表單；需要重新登入或重連時才會用到，展開狀態不記憶。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { PushRecipientsPanel } from '../components/PushRecipientsPanel'
import { useStore } from '../store'
import type { DbFileInfo, DetectorDebug, Settings } from '../types'
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

function Radio({
  name, value, current, onPick, label, hint, recommended,
}: {
  name: string
  value: string
  current: string
  onPick: (v: string) => void
  label: string
  hint?: string
  recommended?: boolean
}) {
  const on = current === value
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5">
      <input
        type="radio"
        name={name}
        checked={on}
        onChange={() => onPick(value)}
        className="mt-[3px] accent-emerald-500"
      />
      <span>
        <span className={`text-xs ${on ? 'text-zinc-100' : 'text-zinc-400'}`}>{label}</span>
        {recommended && (
          <span className="ml-1.5 rounded bg-emerald-500/15 px-1.5 py-[1px] text-[10px] text-emerald-400">
            建議
          </span>
        )}
        {hint && <span className="block text-[11px] leading-relaxed text-zinc-600">{hint}</span>}
      </span>
    </label>
  )
}

function Check({
  on, onChange, label, hint,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] accent-emerald-500"
      />
      <span>
        <span className={`text-xs ${on ? 'text-zinc-100' : 'text-zinc-400'}`}>{label}</span>
        {hint && <span className="block text-[11px] leading-relaxed text-zinc-600">{hint}</span>}
      </span>
    </label>
  )
}

function StatusLine({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-900 py-1.5 text-xs last:border-b-0">
      <span className="text-zinc-500">{label}</span>
      <span className={`text-right font-mono tabular-nums ${ok === false ? 'text-rose-400' : 'text-zinc-200'}`}>
        {value}
      </span>
    </div>
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

/**
 * 「強制讀取最新資料庫」——跟桌面版 SettingsDialog.tsx 的 DbReloadPanel 是
 * 同一支功能（清 core/db.py 的三支查詢快取，不是重新打開檔案），這裡原樣搬過來。
 */
function DbReloadPanel() {
  const [info, setInfo] = useState<DbFileInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await api.dbInfo())
    } catch {
      setInfo(null)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function reload() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.reloadDb()
      setInfo(r)
      setMsg(`✅ 已清除 ${r.cleared} 項快取，下一次查詢會重新讀取檔案`)
    } catch (e) {
      setMsg(`❌ ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={reload}
          disabled={busy}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? '處理中…' : '🔄 強制讀取最新資料庫'}
        </button>
        {info && !info.exists && (
          <span className="text-[11px] text-rose-400">找不到 twse_ohlcv.db，請確認檔案存在</span>
        )}
      </div>

      {info?.exists && (
        <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-1">
          <StatusLine label="檔案大小" value={`${((info.size_bytes ?? 0) / 1048576).toFixed(1)} MB`} />
          <StatusLine label="最後修改時間" value={info.mtime ?? '—'} />
        </div>
      )}

      {msg && <p className="mt-2 text-[11px] text-zinc-300">{msg}</p>}
    </div>
  )
}

/**
 * 偵測器診斷——跟桌面版同一支 /api/debug/detector，展開才輪詢（每 5 秒），
 * 收合就停止，手機上背景分頁沒必要一直打這支。
 */
function DetectorPanel() {
  const [det, setDet] = useState<DetectorDebug | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const load = () => api.detectorDebug().then(setDet).catch(() => setDet(null))
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [open])

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        {open ? '停止並收合' : '展開（每 5 秒更新）'}
      </button>
      {open && (
        <div className="mt-3">
          {!det ? (
            <div className="text-xs text-zinc-600">讀取中…</div>
          ) : (
            <>
              <StatusLine label="每輪掃描耗時" value={`${det.scan_ms ?? '—'} ms`} />
              <StatusLine label="本輪掃描檔數" value={String(det.scanned ?? 0)} />
              <StatusLine
                label="逐筆緩衝"
                value={
                  det.ticks
                    ? `${det.ticks.symbols} 檔 / ${det.ticks.buffered_ticks.toLocaleString()} 筆 / ${(det.ticks.approx_bytes / 1048576).toFixed(1)} MB`
                    : '—'
                }
              />
              <StatusLine label="開盤靜默中" value={det.rebound_muted_now ? '是' : '否'} />
              <pre className="mt-2 max-h-56 overflow-auto rounded border border-zinc-800 bg-black/50 p-2 text-[10px] leading-relaxed text-zinc-400">
{JSON.stringify(det.sample ?? [], null, 1)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 手機版設定分頁分類，跟桌面版 SettingsDialog.tsx 用同一套分類命名/圖示，
 * 切換習慣兩邊一致。分頁按鈕上用簡短標籤（資料/顯示/盤中/推播/系統）——
 * 手機寬度放不下桌面版的完整分類名稱，完整名稱留在每個分頁裡的 Section
 * 標題與 hint 上，不會少資訊，只是分頁列本身要夠窄才能五個一排不擠爆。
 */
type TabKey = 'data' | 'display' | 'intraday' | 'notify' | 'system'

const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'data', icon: '📦', label: '資料' },
  { key: 'display', icon: '📊', label: '顯示' },
  { key: 'intraday', icon: '⚡', label: '盤中' },
  { key: 'notify', icon: '📨', label: '推播' },
  { key: 'system', icon: '🔌', label: '系統' },
]

export function SettingsPage() {
  const { status, setStatus, powerSave, setPowerSave } = useStore()
  const { forceDesktop, setForceDesktop } = useResponsive()
  const { canInstall, installed, promptInstall } = usePwaInstall()
  const [tab, setTab] = useState<TabKey>('display')
  const [loginOpen, setLoginOpen] = useState(false)
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        富邦登入不放進分頁——這是「隨時可能要優先處理」的動作（session 過期、
        出門在外要重連），跟桌面版把登入獨立成 Toolbar 按鈕、不塞進 ⚙️ 設定
        視窗是同一個理由。手機沒有 Toolbar，所以固定放在分頁上方，
        一打開設定就看得到，不用先猜它在哪一個分類裡。

        表單本身預設收合（見檔頭 2026-09-16 補充註解）——狀態列點一下展開/收合，
        登入後大部分時間根本不需要看到三個輸入欄位。
      */}
      <section className="border-b border-zinc-800 last:border-b-0">
        <button
          onClick={() => setLoginOpen(!loginOpen)}
          className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left"
        >
          <span>
            <span className="text-[13px] font-semibold text-zinc-200">📡 富邦登入</span>
            <span className="mt-1 flex items-center gap-2 text-xs">
              <span className={`h-2 w-2 rounded-full ${fubon?.logged_in ? 'bg-emerald-400' : 'bg-rose-500'}`} />
              <span className={fubon?.logged_in ? 'text-emerald-400' : 'text-rose-400'}>
                {fubon?.logged_in ? '已登入' : '尚未登入'}
              </span>
              {fubon?.connected && <span className="text-zinc-500">· 已訂閱 {fubon.subscribed_count} 檔</span>}
            </span>
          </span>
          <span className="shrink-0 text-xs text-zinc-500">{loginOpen ? '收合 ▲' : '展開 ▼'}</span>
        </button>
        {loginOpen && (
          <div className="px-4 pb-4">
            <p className="mb-2.5 text-[11px] leading-relaxed text-zinc-500">
              重連不需要重新輸入帳密，只有登入 session 失效才需要
            </p>
            <LoginForm />
          </div>
        )}
      </section>

      <div className="flex shrink-0 flex-wrap gap-1 border-b border-zinc-800 bg-zinc-900/40 px-2 py-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded px-2.5 py-1.5 text-[11px] transition-colors ${
              tab === t.key
                ? 'bg-emerald-600 font-medium text-white'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'data' && s && (
        <>
        <Section
          title="📊 即時資料（當日資料）"
          hint="13:30 前用富邦，13:30 後切到 yfinance。選 Yfinance 則全天強制使用 yfinance。"
        >
          <Radio name="rt" value="fubon" current={s.realtime_source} onPick={(v) => patch({ realtime_source: v })}
            label="富邦 WebSocket" recommended />
          <Radio name="rt" value="yfinance" current={s.realtime_source} onPick={(v) => patch({ realtime_source: v })}
            label="Yfinance" hint="富邦連不上時的後備，延遲較大" />
        </Section>

        <Section title="📋 歷史資料（當日以前的資料）">
          <Radio name="hist" value="db" current={s.history_source} onPick={(v) => patch({ history_source: v })}
            label="twse_ohlcv.db" recommended hint="本地資料庫，最快也最穩" />
          <Radio name="hist" value="yfinance" current={s.history_source} onPick={(v) => patch({ history_source: v })}
            label="Yfinance" hint="雲端環境常被限流，只在 db 缺資料時用" />
        </Section>

        <Section
          title="🌙 盤後資料（當日＋歷史資料）"
          hint="開啟後會覆蓋以上兩項設定，當日與歷史資料合併由單一來源讀取。"
        >
          <Check
            on={s.post_market_enabled}
            onChange={(v) => patch({ post_market_enabled: v })}
            label="啟用盤後資料模式"
          />
          {s.post_market_enabled && (
            <div className="mt-2 border-l-2 border-zinc-800 pl-3">
              <Radio name="pm" value="db" current={s.post_market_source} onPick={(v) => patch({ post_market_source: v })}
                label="twse_ohlcv.db" />
              <Radio name="pm" value="yfinance" current={s.post_market_source} onPick={(v) => patch({ post_market_source: v })}
                label="Yfinance" />
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-500/80">
                ⚠️ 已知限制（與桌面版一致）：db 尚無今日資料時，當下價與昨收會取到同一筆歷史收盤，
                漲跌幅因此顯示 0%。
              </p>
            </div>
          )}
        </Section>

        <Section
          title="🔄 資料庫維護"
          hint="twse_ohlcv.db 的歷史資料查詢有最長 1 小時的快取。手動跑完 update_db.py 或排程更新完之後，按這個按鈕能立刻看到最新資料，不用等快取到期、也不用重啟服務。"
        >
          <DbReloadPanel />
        </Section>
        </>
        )}

        {tab === 'display' && (
        <>
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
        </>
        )}

        {tab === 'intraday' && s && (
        <>
        <Section
          title="🔔 盤中訊號偵測"
          hint="偵測器每秒掃描一次全部股票。跑馬燈只顯示瞬間拉抬／瞬間反彈／即將漲停；預警與跌停只進事件流面板。"
        >
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-zinc-400">
              反彈門檻（%）
              <input
                type="number" step={0.5} min={0.5} max={20}
                value={s.rebound_pct}
                onChange={(e) => patch({ rebound_pct: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
              <span className="block text-[11px] text-zinc-600">現價相對今日最低</span>
            </label>
            <label className="text-xs text-zinc-400">
              反彈冷卻（秒）
              <input
                type="number" step={30} min={0} max={3600}
                value={s.rebound_cooldown_sec}
                onChange={(e) => patch({ rebound_cooldown_sec: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
            </label>
            <label className="text-xs text-zinc-400">
              開盤靜默（分）
              <input
                type="number" step={1} min={0} max={60}
                value={s.rebound_open_silence_min}
                onChange={(e) => patch({ rebound_open_silence_min: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
              <span className="block text-[11px] text-zinc-600">只套用在反彈上，設 0 關閉</span>
            </label>
            <label className="text-xs text-zinc-400">
              漲跌停預警（%）
              <input
                type="number" step={0.5} min={1} max={10}
                value={s.limit_approach_pct}
                onChange={(e) => patch({ limit_approach_pct: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
              <span className="block text-[11px] text-zinc-600">真正的漲停價另外依升降單位計算</span>
            </label>
            <label className="text-xs text-zinc-400">
              漲跌停冷卻（秒）
              <input
                type="number" step={300} min={0} max={7200}
                value={s.limit_cooldown_sec}
                onChange={(e) => patch({ limit_cooldown_sec: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
            </label>
          </div>
        </Section>

        <Section
          title="🚀 瞬間拉抬"
          hint="四個條件要同時成立：量能放大、外盤占比夠、短線有急拉、而且位置對（突破追蹤窗高點或自低點拉抬）。少了位置條件就降級成「預警」，只進事件流不上跑馬燈。"
        >
          <div className="flex flex-wrap gap-4">
            {([
              ['entry_volume_ratio', '量比門檻', 0.1, '預估本桶量 / 前一桶量'],
              ['entry_buy_pressure', '外盤占比', 0.05, '0.55 = 55%'],
              ['entry_min_volume', '本桶最小量', 1, '濾掉零星成交'],
              ['entry_price_move_pct', '30秒漲幅 / 自低點', 0.5, '位置條件也用這個值'],
              ['entry_early_2s_pct', '2 秒漲幅', 0.1, ''],
              ['entry_early_5s_pct', '5 秒漲幅', 0.1, ''],
              ['entry_early_10s_pct', '10 秒漲幅', 0.1, ''],
              ['entry_bucket_sec', '量能桶（秒）', 5, ''],
              ['entry_track_sec', '高低點追蹤（秒）', 10, ''],
              ['entry_cooldown_sec', '拉抬冷卻（秒）', 5, ''],
              ['entry_min_ticks', '本桶最少筆數', 1, ''],
              ['warning_cooldown_sec', '預警冷卻（秒）', 10, '原版沒有，193 檔一定要有'],
            ] as [keyof Settings, string, number, string][]).map(([key, label, step, note]) => (
              <label key={key} className="text-xs text-zinc-400">
                {label}
                <input
                  type="number" step={step} min={0}
                  value={s[key] as number}
                  onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<Settings>)}
                  className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
                />
                {note && <span className="block text-[11px] text-zinc-600">{note}</span>}
              </label>
            ))}
          </div>
        </Section>

        <Section
          title="🔍 偵測器診斷"
          hint="訊號一整天沒出來的時候先看這裡——分得出是「真的沒訊號」還是「壞了」。尤其外盤占比：抓不到內外盤時它會是 null，而那個條件是 fail-closed 的，拉抬會永遠不觸發而且不報錯。"
        >
          <DetectorPanel />
        </Section>
        </>
        )}

        {tab === 'notify' && (
        <>
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

        <Section
          title="👥 推播名單"
          hint="推給誰、每個人（或群組）收哪一種訊息，在這裡管理——出門在外也能改，不用等回到電腦前。表格較寬，需要的話可以左右滑動。"
        >
          <PushRecipientsPanel />
        </Section>
        </>
        )}

        {tab === 'system' && (
        <>
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
        </>
        )}
      </div>
    </div>
  )
}
