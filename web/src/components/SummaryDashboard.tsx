/**
 * 漲幅儀表板 —— 現在是**主畫面**，不再是表格上方的一條。
 *
 * 為什麼這樣安排比原版好：看盤時九成的時間你在問的是「哪一類在動」，
 * 而不是「第 87 檔的 KD 是多少」。原版把表格放主位、儀表板擠在上面，
 * 等於把一成的需求擺在九成前面。現在反過來：儀表板滿版，
 * 需要細看時點一張卡浮出那一類的清單，看完關掉回到原位。
 *
 * 三段計數的定義完全沿用原版：
 *   達標    pct >= rise_threshold（門檻來自後端 settings，不是寫死的）
 *   一般上漲 0 < pct < threshold
 *   下跌    pct < 0
 * （pct == 0 三邊都不算，跟原版一致）
 *
 * 比原版好的地方：**它是即時的**。原版每 3 秒整頁 rerun 才更新一次；
 * 這裡直接吃快線覆蓋後的價格，報價一跳卡片數字就跟著動，不用等慢線那 20 秒。
 *
 * ── 為什麼這個聚合放在前端算，不違反「公式只留在 Python」原則 ──
 * 這裡只是「數有幾檔的 pct 超過門檻」，沒有任何訊號判斷或技術指標。
 * 真正的公式（KD、訊號、買入區間）全都是後端算好送過來的，前端一個都沒重算。
 *
 * ── 卡片內的文字層級 ──
 * 分類名稱、股票代碼與名稱、三段計數的說明文字全部是**純白**——它們是資料，
 * 使用者要讀的就是這些。維持暗色的只有兩種東西：分隔符號（「|」「/」）與
 * 邊框，那些是版面元素不是資料。
 *
 * 唯一保留語意色的是漲跌幅（紅漲綠跌）與主要數字，因為那兩個的顏色**本身
 * 就是資訊**，不是裝飾。
 *
 * 達標比例改成實心徽章並依層級變色（紅／琥珀／綠框）。原本是右上角的灰色小字，
 * 在滿版 19 張卡裡等於不存在；實心底配深色字的對比遠高於彩色字配深底。
 *
 * ── 配色是驗證過的，不是挑順眼的 ──
 * 用 skill 附的 validate_palette.js 對深色底 #18181b 跑過：
 *   #e11d48 / #d97706 / #059669  → 亮度帶 PASS、對比 PASS，
 *   CVD 分離度 7.9 落在 6–8 下限帶，**僅在有次要編碼時合法**。
 * 所以比例條的每一段之間留 2px 間隙，而且下方一定同時有色點＋文字標籤＋數字——
 * 識別永遠不只靠顏色。深色階是重新選的，不是把淺色翻轉。
 */
import { useMemo, useState } from 'react'
import { pctOf, useStore } from '../store'
import type { Row } from '../types'

/** 比例條的填色：達標與一般上漲是同一色相的兩個階（有序），下跌是對比色相 */
const FILL_HIT = '#e11d48'   // rose-600
const FILL_UP = '#9f1239'    // rose-800，同色相較暗階＝「比較弱的上漲」
const FILL_DOWN = '#059669'  // emerald-600

type SortKey = 'order' | 'ratio' | 'hit'

interface GroupStat {
  name: string
  total: number
  hit: number
  up: number
  down: number
  ratio: number
  hitNames: string[]
  top3: Row[]
  top3Pct: number[]
}

/** 沿用原版 compact_name_list()：最多列 3 個，其餘用「等 N 檔」帶過 */
function compactNames(names: string[], maxShow = 3): string {
  if (names.length === 0) return '無'
  if (names.length <= maxShow) return names.join('、')
  return `${names.slice(0, maxShow).join('、')} 等${names.length}檔`
}

/**
 * 依達標比例分三級。沿用原版語意：越熱越紅、完全沒有就是綠。
 *
 * 轉紅的門檻（hot）是可設定的（設定視窗裡的「儀表板熱門門檻」，預設 60%）。
 * 下界的 0 刻意寫死——「0% = 這個分類完全沒有達標」是語意，不是可調參數。
 */
function tierOf(ratio: number, hot: number) {
  if (ratio >= hot) {
    return {
      accent: 'text-rose-400',
      border: 'border-rose-500/45',
      bg: 'bg-rose-500/[0.07]',
      ring: 'hover:border-rose-400/80',
      // 實心徽章：原本是灰色小字，在滿版 19 張卡裡完全看不到。
      // 實心底＋深色字的對比遠高於彩色字配深底，掃視時第一眼就會落在這裡。
      badge: 'bg-rose-500 text-zinc-950',
    }
  }
  if (ratio > 0) {
    return {
      accent: 'text-amber-400',
      border: 'border-amber-500/40',
      bg: 'bg-amber-500/[0.05]',
      ring: 'hover:border-amber-400/80',
      badge: 'bg-amber-400 text-zinc-950',
    }
  }
  return {
    accent: 'text-emerald-400',
    border: 'border-zinc-800',
    bg: 'bg-transparent',
    ring: 'hover:border-zinc-600',
    // 0% 是「沒事發生」，用外框而不是實心——實心會讓 19 張卡裡最不重要的那些
    // 反而最亮，掃視的第一眼就被帶錯地方。
    badge: 'border border-emerald-500/60 text-emerald-300',
  }
}

export function SummaryDashboard() {
  const { rows, quotes, status, openModal } = useStore()
  const [sortKey, setSortKey] = useState<SortKey>('order')
  const threshold = status?.settings.rise_threshold ?? 5
  const hot = status?.settings.dashboard_hot_ratio ?? 60

  const stats = useMemo<GroupStat[]>(() => {
    // 分組順序以後端 stock_groups 的順序為準，跟 Streamlit 一致
    const order = status?.groups ? Object.keys(status.groups) : []
    const live = rows.map((r) => {
      const price = quotes[r.code] ?? r.price
      return { row: r, pct: pctOf(r, price) }
    })

    const out = order.map((name) => {
      const members = live.filter((x) => x.row.groups?.includes(name) && !x.row.error)
      const hits = members.filter((x) => x.pct >= threshold)
      const ups = members.filter((x) => x.pct > 0 && x.pct < threshold)
      const downs = members.filter((x) => x.pct < 0)
      const total = members.length
      const sorted = [...members].sort((a, b) => b.pct - a.pct).slice(0, 3)
      return {
        name,
        total,
        hit: hits.length,
        up: ups.length,
        down: downs.length,
        ratio: total > 0 ? (hits.length / total) * 100 : 0,
        hitNames: hits.map((x) => x.row.name),
        top3: sorted.map((x) => x.row),
        top3Pct: sorted.map((x) => x.pct),
      }
    })

    if (sortKey === 'ratio') out.sort((a, b) => b.ratio - a.ratio || b.hit - a.hit)
    if (sortKey === 'hit') out.sort((a, b) => b.hit - a.hit || b.ratio - a.ratio)
    return out
  }, [rows, quotes, status, threshold, sortKey])

  const totals = useMemo(
    () =>
      stats.reduce(
        (acc, g) => ({
          hit: acc.hit + g.hit,
          up: acc.up + g.up,
          down: acc.down + g.down,
          total: acc.total + g.total,
        }),
        { hit: 0, up: 0, down: 0, total: 0 },
      ),
    [stats],
  )

  if (stats.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-zinc-500">
        尚無分類資料。確認 stock_groups.json 有內容，或按工具列的「手動更新即時資料」。
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pb-2 pt-3">
        <h2 className="text-[15px] font-semibold">📌 漲幅儀表板</h2>
        <span className="text-xs text-zinc-500">
          統計門檻：漲幅 ≥ {threshold}%　·　達標 ≥ {hot}% 轉紅　·　點卡片展開該分類清單
        </span>
        <span className="text-xs tabular-nums text-zinc-500">
          合計 {totals.total} 檔次：
          <b className="text-rose-400"> 達標 {totals.hit} </b>·  一般上漲 {totals.up} ·{' '}
          <span className="text-emerald-500/80">下跌 {totals.down}</span>
        </span>

        <div className="ml-auto flex items-center gap-1 text-[11px]">
          <span className="text-zinc-600">排序</span>
          {(
            [
              ['order', '分類順序'],
              ['ratio', '達標比例'],
              ['hit', '達標檔數'],
            ] as [SortKey, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setSortKey(k)}
              className={`rounded border px-1.5 py-0.5 ${
                sortKey === k
                  ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:bg-zinc-800/60'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 滿版卡片牆：自己捲，卡片寬度隨視窗自動排列 */}
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-3 overflow-auto px-4 pb-4">
        {stats.map((g) => {
          const t = tierOf(g.ratio, hot)
          return (
            <button
              key={g.name}
              onClick={() => openModal({ kind: 'group', name: g.name })}
              className={`flex flex-col gap-2.5 rounded-lg border p-3.5 text-left transition-colors ${t.border} ${t.bg} ${t.ring}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-white">{g.name}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-[2px] text-[11px] font-semibold tabular-nums ${t.badge}`}
                >
                  達標 {g.ratio.toFixed(0)}%
                </span>
              </div>

              {/* 主要數字：整張卡唯一上色的數值 */}
              <div className={`font-mono text-[26px] font-semibold leading-none tabular-nums ${t.accent}`}>
                {g.hit}
                <span className="text-lg text-zinc-600"> / {g.total}</span>
              </div>

              {/* 比例條：段與段之間 2px 間隙（次要編碼，CVD 下限帶的必要條件） */}
              <div className="flex h-[6px] w-full gap-[2px] overflow-hidden rounded-sm bg-zinc-800/70">
                {[
                  { n: g.hit, c: FILL_HIT },
                  { n: g.up, c: FILL_UP },
                  { n: g.down, c: FILL_DOWN },
                ]
                  .filter((s) => s.n > 0)
                  .map((s, i) => (
                    <div
                      key={i}
                      className="h-full rounded-[1px]"
                      style={{ width: `${(s.n / Math.max(g.total, 1)) * 100}%`, background: s.c }}
                    />
                  ))}
              </div>

              {/* 三段計數：數字用文字色，識別靠色點＋文字標籤，不是只靠顏色 */}
              <div className="flex flex-col gap-1 text-xs text-zinc-100">
                <div className="flex items-start gap-1.5">
                  <span className="mt-[5px] h-2 w-2 shrink-0 rounded-[2px]" style={{ background: FILL_HIT }} />
                  <span>
                    達標 <b className="tabular-nums text-white">{g.hit}</b> 檔
                    <span className="text-zinc-100">（{compactNames(g.hitNames)}）</span>
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px]" style={{ background: FILL_UP }} />
                    一般上漲 <b className="tabular-nums text-white">{g.up}</b>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px]" style={{ background: FILL_DOWN }} />
                    下跌 <b className="tabular-nums text-white">{g.down}</b>
                  </span>
                </div>
              </div>

              {/* 前三名 */}
              {g.top3.length > 0 && (
                <div className="border-t border-dashed border-zinc-800 pt-2 text-[11px] leading-relaxed text-zinc-100">
                  {g.top3.map((r, i) => (
                    <span key={r.symbol}>
                      {/* 分隔線維持暗色：它是版面元素，不是資料 */}
                      {i > 0 && <span className="text-zinc-700"> | </span>}
                      <span className="font-mono text-white">{r.code}</span>{' '}
                      <span className="text-white">{r.name}</span>{' '}
                      <span
                        className={`font-mono tabular-nums ${
                          g.top3Pct[i] > 0 ? 'text-rose-400' : g.top3Pct[i] < 0 ? 'text-emerald-400' : ''
                        }`}
                      >
                        {g.top3Pct[i] > 0 ? '+' : ''}
                        {g.top3Pct[i].toFixed(1)}%
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </section>
  )
}
