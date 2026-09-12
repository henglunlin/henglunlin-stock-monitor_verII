/**
 * 設定浮動視窗。把 Streamlit 側邊欄整段搬過來：
 * 資料來源設定、漲幅門檻、富邦 WebSocket 狀態、目前資料來源狀態、WebSocket Debug。
 *
 * ── 一個跟原版不同、而且是刻意的差別 ──
 * 原版側邊欄是「每個瀏覽器分頁一份」的 session_state，你在公司電腦改了資料來源，
 * 家裡那台完全不知道。新架構是**服務層級的單一設定**：任何一台改了，
 * 其他人下次拉狀態就會看到同一份。資料來源本來就該是服務的設定，不是分頁的。
 *
 * 所以這裡沒有 PIN 唯讀模式——那是為了「多人共用同一個公開網址」設計的。
 * 新架構擋在前面的是 X-App-Token：沒有 token 的人根本連不到 API。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'
import type { DetectorDebug, FubonDebug, LineDebug, Settings, WsDebug } from '../types'
import { Modal } from './Modal'

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-zinc-800 px-5 py-4 last:border-b-0">
      <h3 className="text-[13px] font-semibold text-zinc-200">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
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

/**
 * 推播時段編輯器。
 *
 * ── 為什麼是本地草稿而不是即時 PATCH ──
 * 這一欄是逗號分隔的字串，打字過程中必然會經過「09:40,」這種還沒打完的中間狀態。
 * 如果每個字元都 PATCH，後端會收到一串半成品（`_parse_slots` 會安靜丟掉它們），
 * 而且剛好在那一秒到點的話會真的漏推一次。所以改成 blur 或按 Enter 才送——
 * 這跟 GroupEditor 明確按儲存才寫入是同一個理由。
 */
function SlotEditor({
  slots, onCommit,
}: {
  slots: string[]
  onCommit: (next: string[]) => void
}) {
  const joined = (slots || []).join(', ')
  const [draft, setDraft] = useState(joined)
  const [dirty, setDirty] = useState(false)

  // 別人（另一台裝置）改了設定就跟上，但不要蓋掉正在打的字
  useEffect(() => {
    if (!dirty) setDraft(joined)
  }, [joined, dirty])

  function commit() {
    const next = draft
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      // 只送格式正確的（HH:MM），順手把 9:40 補成 09:40
      .map((x) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(x)
        if (!m) return null
        const hh = Number(m[1])
        const mm = Number(m[2])
        if (hh > 23 || mm > 59) return null
        return `${String(hh).padStart(2, '0')}:${m[2]}`
      })
      .filter((x): x is string => x !== null)
    setDirty(false)
    onCommit(Array.from(new Set(next)))
  }

  const invalid = dirty && draft.trim() !== '' && !/^(\s*\d{1,2}:\d{2}\s*[,，]?\s*)+$/.test(draft)

  return (
    <div>
      <input
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        placeholder="09:40, 10:00, 11:00, 12:00, 13:00"
        className={`w-full rounded border bg-zinc-900 px-2 py-1 font-mono text-xs tabular-nums text-zinc-100 ${
          invalid ? 'border-rose-600' : 'border-zinc-700'
        }`}
      />
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
        逗號分隔，24 小時制 HH:MM。離開欄位或按 Enter 才送出。
        {dirty && <span className="ml-1 text-amber-500">尚未儲存</span>}
        {invalid && <span className="ml-1 text-rose-400">格式不符的項目會被略過</span>}
      </p>
    </div>
  )
}

/**
 * LINE 推播狀態與測試。
 *
 * 這一區存在的理由跟「連線黑盒子」一樣：LINE 推播失敗時你不會在畫面上看到任何
 * 東西（推播是背景任務），只能靠這裡看最後一次的結果。`error` 欄位是查問題的
 * 唯一線索——LINE 回的狀態碼只說 400/401/429，真正原因（token 過期、對象 id 錯、
 * 月額度用盡）都在 body 裡。
 */
function LinePanel() {
  const [data, setData] = useState<LineDebug | null>(null)
  const [busy, setBusy] = useState(false)
  const [testMsg, setTestMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.lineDebug())
    } catch {
      setData(null)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function test(channel: 'line' | 'telegram') {
    setBusy(true)
    setTestMsg(null)
    try {
      const r = await api.testPush(channel)
      setTestMsg(r.ok ? `✅ ${channel === 'line' ? 'LINE' : 'Telegram'} 已送出，去手機看看` : `❌ ${r.reason ?? '送出失敗'}`)
    } catch (e) {
      setTestMsg(`❌ ${String(e)}`)
    } finally {
      setBusy(false)
      load()
    }
  }

  const lastOk = data?.ok
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${data?.configured ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <span className={data?.configured ? 'text-zinc-200' : 'text-zinc-500'}>
            {data?.configured ? `LINE 已設定（對象 …${data.target_tail}）` : 'LINE 未設定'}
          </span>
        </span>
        <button
          onClick={() => test('line')}
          disabled={busy}
          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? '送出中…' : '📨 測試 LINE'}
        </button>
        <button
          onClick={() => test('telegram')}
          disabled={busy}
          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          📨 測試 Telegram
        </button>
      </div>

      {!data?.configured && (
        <p className="mb-2 text-[11px] leading-relaxed text-amber-500/80">
          需要在 Render 的 Environment 設 <code className="font-mono">LINE_CHANNEL_ACCESS_TOKEN</code> 與{' '}
          <code className="font-mono">LINE_TO</code>。憑證只走環境變數，不存在設定檔裡。
          （LINE Notify 已於 2025-03-31 終止服務，這裡用的是 Messaging API。）
        </p>
      )}

      {testMsg && <p className="mb-2 text-[11px] text-zinc-300">{testMsg}</p>}

      {data && (
        <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-1">
          <StatusLine
            label="定時彙整實際送往"
            value={
              [
                data.digest_targets.line ? 'LINE' : null,
                data.digest_targets.telegram ? 'Telegram' : null,
              ].filter(Boolean).join(' ＋ ') || '（兩條都不會送）'
            }
            ok={data.digest_targets.line || data.digest_targets.telegram}
          />
          <StatusLine label="最後一次 LINE 推播" value={data.at ?? '尚未推播過'} />
          <StatusLine
            label="結果"
            value={lastOk === null || lastOk === undefined ? '—' : lastOk ? `成功（${data.messages} 則）` : `失敗 ${data.status ?? ''}`}
            ok={lastOk !== false}
          />
          {data.error && (
            <p className="break-all py-1.5 text-[11px] leading-relaxed text-rose-400">
              {data.error}
            </p>
          )}
        </div>
      )}
    </div>
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

/** 每種連線事件的顏色。看一眼顏色就知道今天這條線過得好不好 */
const KIND_STYLE: Record<string, { color: string; label: string }> = {
  login: { color: 'text-emerald-300', label: '登入' },
  connect: { color: 'text-emerald-300', label: '已連線' },
  disconnect: { color: 'text-amber-300', label: '斷線' },
  stale: { color: 'text-amber-300', label: '假死' },
  error: { color: 'text-rose-300', label: '錯誤' },
  reconnect_start: { color: 'text-sky-300', label: '重連中' },
  reconnect_ok: { color: 'text-emerald-300', label: '重連成功' },
  reconnect_fail: { color: 'text-rose-300', label: '重連失敗' },
  session_dead: { color: 'text-rose-400', label: 'session 失效' },
}

/**
 * 連線黑盒子。
 *
 * 斷線幾乎都發生在沒人看畫面的時候，事後只剩一張截圖可以看，根本查不出是哪一種
 * 斷法。這裡把後端記的整條時間軸攤開：什麼時間、哪一種事件、失敗的原因是什麼。
 * 下次再斷線，打開這個截圖給我就夠了，不用再猜。
 */
function ConnLog() {
  const [data, setData] = useState<FubonDebug | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.fubonDebug())
    } catch (e) {
      setData({ available: false, reason: String(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div className="mt-3">
      <div className="flex items-center gap-3">
        <button
          onClick={load}
          className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
        >
          {loading ? '讀取中…' : '📋 連線紀錄'}
        </button>
        {data?.available && (
          <span className="text-[11px] tabular-nums text-zinc-500">
            斷線 {data.disconnect_count ?? 0} · 假死 {data.stale_count ?? 0} ·
            重連 {data.reconnect_count ?? 0} · 失敗 {data.reconnect_fail_count ?? 0}
            {data.seconds_since_last_message != null &&
              ` · 距上次資料 ${Math.round(data.seconds_since_last_message)}s`}
          </span>
        )}
      </div>

      {data && !data.available && (
        <p className="mt-2 text-[11px] text-zinc-500">{data.reason}</p>
      )}

      {data?.available && (
        <div className="mt-2 max-h-56 overflow-y-auto rounded border border-zinc-800 bg-zinc-950">
          {(data.history ?? []).length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-zinc-500">
              今天還沒有任何連線事件——這是好事，代表沒斷過。
            </p>
          ) : (
            (data.history ?? []).map((h, i) => {
              const st = KIND_STYLE[h.kind] ?? { color: 'text-zinc-300', label: h.kind }
              return (
                <div
                  key={i}
                  className="flex gap-3 border-b border-zinc-900 px-3 py-1.5 text-[11px] last:border-b-0"
                >
                  <span className="shrink-0 font-mono tabular-nums text-zinc-500">{h.time}</span>
                  <span className={`w-20 shrink-0 font-medium ${st.color}`}>{st.label}</span>
                  <span className="break-all text-zinc-400">{h.detail}</span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status, setStatus } = useStore()
  const [dbg, setDbg] = useState<WsDebug | null>(null)
  const [dbgOpen, setDbgOpen] = useState(false)
  const [det, setDet] = useState<DetectorDebug | null>(null)
  const [detOpen, setDetOpen] = useState(false)
  const s = status?.settings
  const fubon = status?.fubon

  const patch = useCallback(
    async (p: Partial<Settings>) => {
      const next = await api.patchSettings(p)
      const cur = useStore.getState().status
      if (cur) setStatus({ ...cur, settings: next })
    },
    [setStatus],
  )

  useEffect(() => {
    if (!open || !dbgOpen) return
    const load = () => api.wsDebug().then(setDbg).catch(() => setDbg(null))
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [open, dbgOpen])

  useEffect(() => {
    if (!open || !detOpen) return
    const load = () => api.detectorDebug().then(setDet).catch(() => setDet(null))
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [open, detOpen])

  if (!s) return null

  const realtimeLabel = s.post_market_enabled
    ? `盤後模式（${s.post_market_source === 'db' ? 'twse_ohlcv.db' : 'Yfinance'}）`
    : s.realtime_source === 'fubon'
      ? '富邦 WebSocket，13:30 後自動切到 yfinance'
      : 'Yfinance（全天強制）'

  return (
    <Modal open={open} onClose={onClose} title="⚙️ 設定" subtitle="設定存在後端，所有裝置共用同一份" size="md">
      <div className="min-h-0 flex-1 overflow-auto">
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
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={s.post_market_enabled}
              onChange={(e) => patch({ post_market_enabled: e.target.checked })}
              className="accent-emerald-500"
            />
            啟用盤後資料模式
          </label>
          {s.post_market_enabled && (
            <div className="mt-2 border-l-2 border-zinc-800 pl-3">
              <Radio name="pm" value="db" current={s.post_market_source} onPick={(v) => patch({ post_market_source: v })}
                label="twse_ohlcv.db" />
              <Radio name="pm" value="yfinance" current={s.post_market_source} onPick={(v) => patch({ post_market_source: v })}
                label="Yfinance" />
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-500/80">
                ⚠️ 已知限制（與原版一致）：db 尚無今日資料時，當下價與昨收會取到同一筆歷史收盤，
                漲跌幅因此顯示 0%。
              </p>
            </div>
          )}
        </Section>

        <Section
          title="📈 兩個門檻，刻意分開"
          hint="顯示門檻只影響你看到的畫面；訊號門檻會改變「漲幅達標」訊號要不要觸發。把它們綁在一起會讓「調整畫面」意外變成「改變訊號行為」。"
        >
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-zinc-400">
              顯示門檻（%）
              <input
                type="number" step={0.5} min={0} max={20}
                value={s.rise_threshold}
                onChange={(e) => patch({ rise_threshold: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
              <span className="block text-[11px] text-zinc-600">儀表板達標計數、表格漲跌%高亮</span>
            </label>
            <label className="text-xs text-zinc-400">
              訊號門檻（%）
              <input
                type="number" step={0.5} min={0} max={20}
                value={s.signal_rise_threshold}
                onChange={(e) => patch({ signal_rise_threshold: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
              <span className="block text-[11px] text-zinc-600">傳進訊號引擎（「漲幅達標」訊號）</span>
            </label>
            <label className="text-xs text-zinc-400">
              儀表板熱門門檻（%）
              <input
                type="number" step={5} min={1} max={100}
                value={s.dashboard_hot_ratio}
                onChange={(e) => patch({ dashboard_hot_ratio: Number(e.target.value) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
              <span className="block text-[11px] text-zinc-600">達標比例超過就把卡片轉紅</span>
            </label>
          </div>
        </Section>

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
          <button
            onClick={() => setDetOpen(!detOpen)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {detOpen ? '停止並收合' : '展開（每 5 秒更新）'}
          </button>
          {detOpen && (
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
                  <pre className="mt-2 max-h-72 overflow-auto rounded border border-zinc-800 bg-black/50 p-2 text-[10px] leading-relaxed text-zinc-400">
{JSON.stringify(det.sample ?? [], null, 1)}
                  </pre>
                </>
              )}
            </div>
          )}
        </Section>

        {/*
          🔔 推播。Toolbar 只留兩顆管道總開關，細節全部在這一區。

          兩條管道的職責是分開的，這不是設定失誤：
            LINE      → 盤中定時彙整（一天幾個時段，手機上掃一眼）
            Telegram  → 盤中即時事件、push 指令，加上彙整的完整紀錄那一份
          即時事件刻意不走 LINE：1 秒偵測線配 198 檔，LINE 每月 200 則的
          免費額度一個上午就會用完。
        */}
        <Section
          title="🔔 推播"
          hint="LINE 負責定時彙整、Telegram 負責即時事件。管道總開關在工具列上，這裡調細節。"
        >
          <Check
            on={s.scheduled_push_enabled}
            onChange={(v) => patch({ scheduled_push_enabled: v })}
            label="定時推送模式"
            hint="只在下面列的時段各推一次彙整訊息。關掉就只剩 Telegram 的即時事件與 push 指令。"
          />

          {s.scheduled_push_enabled && (
            <div className="mt-2 border-l-2 border-zinc-800 pl-3">
              <p className="mb-1.5 text-[11px] text-zinc-500">推播時段</p>
              <SlotEditor slots={s.push_slots} onCommit={(v) => patch({ push_slots: v })} />

              <p className="mt-3 mb-0.5 text-[11px] text-zinc-500">彙整要送往</p>
              <Check
                on={s.digest_to_line}
                onChange={(v) => patch({ digest_to_line: v })}
                label="LINE"
                hint="每檔最多列幾個訊號見下方設定，省月額度"
              />
              <Check
                on={s.digest_to_telegram}
                onChange={(v) => patch({ digest_to_telegram: v })}
                label="Telegram"
                hint="訊號列完整清單，當當日紀錄"
              />
              {!s.digest_to_line && !s.digest_to_telegram && (
                <p className="text-[11px] text-amber-500">
                  ⚠️ 兩條都沒勾，定時推播不會送出任何訊息。
                </p>
              )}
            </div>
          )}

          <div className="mt-4 border-t border-zinc-800 pt-3">
            <p className="mb-2 text-[11px] text-zinc-500">LINE 訊息格式</p>
            <div className="flex flex-wrap items-start gap-x-6">
              <div>
                <Radio
                  name="linefmt" value="text" current={s.line_message_format}
                  onPick={(v) => patch({ line_message_format: v as 'text' | 'flex' })}
                  label="純文字" recommended
                  hint="超長自動分段（切在股票邊界），相容所有 LINE 版本"
                />
                <Radio
                  name="linefmt" value="flex" current={s.line_message_format}
                  onPick={(v) => patch({ line_message_format: v as 'text' | 'flex' })}
                  label="Flex 卡片"
                  hint="排版較好，但超過 40 檔會截斷（Flex 的區塊數與 50KB 上限）"
                />
              </div>
              <label className="mt-1.5 text-xs text-zinc-400">
                每檔最多訊號數
                <input
                  type="number" min={1} max={10}
                  value={s.line_max_signals_per_stock}
                  onChange={(e) =>
                    patch({ line_max_signals_per_stock: Math.max(1, Number(e.target.value) || 2) })
                  }
                  className="ml-2 w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
                />
                <span className="block text-[11px] text-zinc-600">
                  取優先等級最高的前 N 個，其餘以 +N 帶過。只影響 LINE。
                </span>
              </label>
            </div>
          </div>

          <div className="mt-4 border-t border-zinc-800 pt-3">
            <p className="mb-2 text-[11px] text-zinc-500">即時事件（只走 Telegram）</p>
            <label className="text-xs text-zinc-400">
              最低推播等級
              <select
                value={s.tg_event_min_priority}
                onChange={(e) => patch({ tg_event_min_priority: Number(e.target.value) })}
                className="ml-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100"
              >
                <option value={1}>1 · 全部（含預警，193 檔下會很吵）</option>
                <option value={2}>2 · 瞬間反彈以上（建議）</option>
                <option value={4}>4 · 瞬間拉抬以上</option>
                <option value={6}>6 · 只有漲跌停相關</option>
                <option value={8}>8 · 只有真的觸及漲停價</option>
              </select>
              <span className="block text-[11px] text-zinc-600">
                對應 core/events.py 的 PRIORITY。跑馬燈不受這個值影響。
              </span>
            </label>
          </div>

          <div className="mt-4 border-t border-zinc-800 pt-3">
            <p className="mb-2 text-[11px] text-zinc-500">LINE 推送狀態</p>
            <LinePanel />
          </div>
        </Section>

        <Section title="⚙️ 推送節奏" hint="快線只推變動過的報價，慢線重算指標與訊號。兩者互不影響。">
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-zinc-400">
              快線間隔（毫秒）
              <input
                type="number" min={100} max={5000} step={100}
                value={s.broadcast_interval_ms}
                onChange={(e) => patch({ broadcast_interval_ms: Math.max(100, Number(e.target.value) || 300) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
            </label>
            <label className="text-xs text-zinc-400">
              慢線間隔（秒）
              <input
                type="number" min={5} max={300}
                value={s.row_refresh_sec}
                onChange={(e) => patch({ row_refresh_sec: Math.max(5, Number(e.target.value) || 20) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
            </label>
            <label className="text-xs text-zinc-400">
              偵測線間隔（毫秒）
              <input
                type="number" min={200} max={5000} step={100}
                value={s.detector_interval_ms}
                onChange={(e) => patch({ detector_interval_ms: Math.max(200, Number(e.target.value) || 1000) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
            </label>
          </div>
        </Section>

        <Section title="📡 富邦 WebSocket 狀態">
          <div className="mb-3 flex items-center gap-2 text-xs">
            <span className={`h-2 w-2 rounded-full ${fubon?.connected ? 'bg-emerald-400' : 'bg-rose-500'}`} />
            <span className={fubon?.connected ? 'text-emerald-400' : 'text-rose-400'}>
              {fubon?.connected ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <StatusLine label="已登入" value={fubon?.logged_in ? '是' : '否'} ok={fubon?.logged_in} />
          <StatusLine label="已訂閱" value={`${fubon?.subscribed_count ?? 0} 檔`} />
          <StatusLine label="累計 tick" value={String(status?.tick_count ?? 0)} />
          <StatusLine label="最後訊息" value={fubon?.last_message_at?.slice(11) ?? '—'} />
          <StatusLine label="登入時間" value={fubon?.login_time?.slice(11) ?? '—'} />
          <StatusLine label="今日斷線" value={`${fubon?.disconnect_count ?? 0} 次`} />
          <StatusLine
            label="自動重連"
            value={
              `${fubon?.reconnect_count ?? 0} 次` +
              (fubon?.last_reconnect_at ? `（最後 ${fubon.last_reconnect_at.slice(11)}）` : '')
            }
          />
          {fubon?.last_reconnect_error && (
            <div className="mt-2 rounded border border-amber-900/50 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-300">
              最後一次重連失敗：{fubon.last_reconnect_error}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={s.fubon_watchdog_enabled}
                onChange={(e) => patch({ fubon_watchdog_enabled: e.target.checked })}
                className="accent-emerald-500"
              />
              啟用連線看門狗
            </label>
            <label className="text-xs text-zinc-400">
              視為斷線的無資料秒數
              <input
                type="number" min={30} max={600} step={10}
                value={s.fubon_stale_sec}
                onChange={(e) => patch({ fubon_stale_sec: Math.max(30, Number(e.target.value) || 120) })}
                className="ml-2 w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-right font-mono tabular-nums text-zinc-100"
              />
            </label>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            看門狗盤中每 {s.fubon_watchdog_interval_sec} 秒檢查一次，斷線或超過上面的秒數沒收到任何資料就自動重連並重新訂閱。
            <b className="text-zinc-400">重連不需要重新輸入帳密</b>——登入 session 還在，只是重建行情連線。
          </p>
          {fubon?.error && (
            <div className="mt-2 rounded border border-rose-900/50 bg-rose-950/40 px-2 py-1.5 text-[11px] text-rose-300">
              {fubon.error}
            </div>
          )}
          <ConnLog />
        </Section>

        <Section title="🕐 目前資料來源狀態">
          <StatusLine label="即時資料" value={realtimeLabel} />
          <StatusLine label="歷史資料來源" value={s.history_source === 'db' ? 'twse_ohlcv.db' : 'Yfinance'} />
          <StatusLine label="交易日" value={status?.trading_date ?? '—'} />
          <StatusLine label="今日已推播" value={`${status?.notified_today ?? 0} 筆`} />
        </Section>

        <Section
          title="🔍 WebSocket Debug"
          hint="狀態顯示已連線但價格不動時，答案通常在這裡：訊息有進來，只是欄位名稱跟預期不同，抓不到價格。"
        >
          <button
            onClick={() => setDbgOpen(!dbgOpen)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {dbgOpen ? '停止並收合' : '展開（每 5 秒更新）'}
          </button>
          {dbgOpen && (
            <div className="mt-3">
              {!dbg ? (
                <div className="text-xs text-zinc-600">讀取中…</div>
              ) : !dbg.available ? (
                <div className="text-xs text-amber-400">{dbg.reason}</div>
              ) : (
                <>
                  <StatusLine label="待推送（dirty）" value={String(dbg.pending_dirty ?? 0)} />
                  <StatusLine label="有走勢資料的股票" value={`${dbg.series_symbols ?? 0} 檔`} />
                  <div className="mt-2 text-[11px] text-zinc-500">最近訊息原文：</div>
                  <pre className="mt-1 max-h-64 overflow-auto rounded border border-zinc-800 bg-black/50 p-2 text-[10px] leading-relaxed text-zinc-400">
{JSON.stringify(dbg.recent_messages ?? [], null, 1)}
                  </pre>
                </>
              )}
            </div>
          )}
        </Section>
      </div>
    </Modal>
  )
}
