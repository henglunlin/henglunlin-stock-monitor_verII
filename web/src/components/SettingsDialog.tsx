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
import type { DetectorDebug, Settings, WsDebug } from '../types'
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
