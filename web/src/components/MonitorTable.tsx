/**
 * 監控主表格（含分類分區顯示）。
 *
 * 三個 Streamlit 做不到的地方：
 *
 * 1. **虛擬捲動** —— 只渲染畫面內看得到的十幾列，兩百檔跟二十檔一樣順。
 * 2. **只有變動的格子會閃** —— 快線進來只更新價格那一格，捲軸不跳。
 * 3. **每列內嵌走勢圖與買入區間量尺** —— 原版要看走勢得另開 Plotly 圖，一次一檔。
 *
 * ── 分組顯示怎麼跟虛擬捲動共存 ──
 * 沒有用 TanStack 的 grouping API（它跟 virtualizer 併用很麻煩），改成把
 * 「分類標題」和「股票列」壓平成同一個一維陣列，再對這個陣列做虛擬捲動。
 * 標題和列高度不同，交給 estimateSize 依型別回傳即可。
 *
 * 一檔股票可以同時屬於多個分類（例如 2330 同時在「權值股」和「自選股」），
 * 那它就會在兩個分區各出現一次——這跟 Streamlit 版的行為一致。
 *
 * 排序是全域的：先用 TanStack 排好，再依分類切開，所以每個分區裡仍然照著
 * 你選的排序欄位排。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Row as TanRow,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { pctOf, useStore } from '../store'
import type { Row } from '../types'
import { Sparkline } from './Sparkline'
import { SignalBadges } from './SignalBadges'
import { TargetScale } from './TargetScale'

const SORT_KEY = 'monitor.sorting.v1'
const HEADER_H = 34
const ROW_H = 46

interface ViewRow extends Row {
  livePrice: number
  livePct: number
}

type Item =
  | { kind: 'group'; name: string; total: number; hit: number; down: number }
  /** groupName：同一檔股票可能出現在多個分區，key 必須把分區帶進去才會唯一 */
  | { kind: 'row'; row: TanRow<ViewRow>; groupName: string }

function loadSorting(): SortingState {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (raw) return JSON.parse(raw) as SortingState
  } catch {
    /* 無痕視窗或封鎖 cookie 時會丟例外 */
  }
  return [{ id: 'livePct', desc: true }]
}

/**
 * @param groupFilter 只顯示這個分類的股票（分類浮動視窗用）。
 *                    傳 null 代表「全部股票」，此時才會有分區標題與收合。
 */
export function MonitorTable({ groupFilter = null }: { groupFilter?: string | null }) {
  const {
    rows, quotes, flash, openModal, seriesOf,
    grouped, collapsed, toggleCollapsed, setGrouped, setAllCollapsed,
    scrollTo, requestScrollTo, status,
  } = useStore()
  const [sorting, setSorting] = useState<SortingState>(loadSorting)
  const threshold = status?.settings.rise_threshold ?? 5
  // 篩選到單一分類時不再分區——只有一個分區，標題是多餘的
  const showGroups = groupFilter === null && grouped
  const groupOrder = useMemo(
    () => (groupFilter !== null ? [] : status?.groups ? Object.keys(status.groups) : []),
    [status, groupFilter],
  )
  const didInitialScroll = useRef(false)
  // ⚠️ 表格必須擁有「自己的」捲動容器。
  // 之前把儀表板跟表格塞在同一個捲動容器裡，virtualizer 預設假設清單從容器
  // 頂端開始，但上面墊著約 500px 高的儀表板，那段高度沒被計入 —— 結果就是
  // 表頭下方出現一大塊詭異的空白。TanStack 有 scrollMargin 可以補償，但
  // 儀表板有 19 張卡、寬度一變就重排、資料一變高度也變，要即時追一個浮動的
  // 高度太脆弱。給表格自己的捲動區，結構上就不可能算錯。
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(sorting))
    } catch {
      /* 同上 */
    }
  }, [sorting])

  // 疊合：價格取快線，其餘取慢線
  const data = useMemo<ViewRow[]>(
    () =>
      rows
        .filter((r) => groupFilter === null || r.groups?.includes(groupFilter))
        .map((r) => {
          const livePrice = quotes[r.code] ?? r.price
          return { ...r, livePrice, livePct: pctOf(r, livePrice) }
        }),
    [rows, quotes, groupFilter],
  )

  const columns = useMemo<ColumnDef<ViewRow>[]>(
    () => [
      {
        accessorKey: 'code',
        header: '代碼',
        size: 72,
        cell: (c) => <span className="font-mono text-zinc-400">{c.getValue<string>()}</span>,
      },
      { accessorKey: 'name', header: '名稱', size: 96 },
      {
        id: 'spark',
        header: '走勢',
        size: 96,
        enableSorting: false,
        // 優先畫「今天的盤中走勢」——那才是看盤時想知道的事。
        // 盤前／假日／尚未登入富邦時沒有盤中資料，退回 30 根日線收盤，
        // 否則開盤前整欄會是空的，看起來像壞掉。
        cell: ({ row }) => {
          const live = seriesOf(row.original)
          const useIntraday = live.length >= 2
          return (
            <span title={useIntraday ? '今日盤中走勢（虛線為昨收）' : '近 30 日收盤（尚無盤中資料）'}>
              <Sparkline
                data={useIntraday ? live : (row.original.spark ?? [])}
                up={row.original.livePct >= 0}
                baseline={useIntraday ? row.original.yesterday_close : null}
              />
            </span>
          )
        },
      },
      {
        accessorKey: 'livePrice',
        header: '價格',
        size: 92,
        cell: ({ row }) => {
          const f = flash[row.original.code]
          const fresh = f && Date.now() - f.at < 800
          return (
            <span
              className={`rounded px-1 font-mono tabular-nums transition-colors duration-500 ${
                fresh ? (f.dir === 'up' ? 'bg-rose-500/30' : 'bg-emerald-500/30') : ''
              }`}
            >
              {row.original.livePrice.toFixed(2)}
            </span>
          )
        },
      },
      {
        accessorKey: 'livePct',
        header: '漲跌%',
        size: 84,
        cell: ({ row }) => {
          const v = row.original.livePct
          const hit = v >= threshold
          return (
            <span
              className={`font-mono tabular-nums ${
                v > 0 ? 'text-rose-400' : v < 0 ? 'text-emerald-400' : 'text-zinc-500'
              } ${hit ? 'rounded bg-rose-500/15 px-1 font-semibold' : ''}`}
              title={hit ? `已達儀表板門檻 ${threshold}%` : undefined}
            >
              {v > 0 ? '+' : ''}
              {v.toFixed(2)}%
            </span>
          )
        },
      },
      {
        accessorKey: 'k',
        header: 'K / D',
        size: 84,
        cell: ({ row }) => (
          <span className="font-mono tabular-nums text-zinc-400">
            {row.original.k} / {row.original.d}
          </span>
        ),
      },
      {
        accessorKey: 'ma_range',
        header: 'MA 位置',
        size: 86,
        cell: (c) => <span className="text-zinc-400">{c.getValue<string>()}</span>,
      },
      {
        accessorKey: 'ma_trend',
        header: '排列',
        size: 62,
        cell: (c) => {
          const v = c.getValue<string>()
          const cls = v === '多頭' ? 'text-rose-400' : v === '空頭' ? 'text-emerald-400' : 'text-zinc-500'
          return <span className={cls}>{v}</span>
        },
      },
      {
        id: 'signals',
        header: '訊號',
        size: 230,
        enableSorting: false,
        cell: ({ row }) => <SignalBadges signals={row.original.signals ?? []} />,
      },
      {
        id: 'target',
        header: '買入區間',
        size: 170,
        enableSorting: false,
        cell: ({ row }) => <TargetScale target={row.original.target} price={row.original.livePrice} />,
      },
    ],
    [flash, threshold, seriesOf],
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const sortedRows = table.getRowModel().rows

  // 壓平成一維：分類標題 + 該分類的股票列
  const items = useMemo<Item[]>(() => {
    if (!showGroups || groupOrder.length === 0) {
      return sortedRows.map((row) => ({ kind: 'row', row, groupName: '' }) as Item)
    }
    const out: Item[] = []
    for (const name of groupOrder) {
      const members = sortedRows.filter((r) => r.original.groups?.includes(name))
      if (members.length === 0) continue
      const hit = members.filter((r) => r.original.livePct >= threshold).length
      const down = members.filter((r) => r.original.livePct < 0).length
      out.push({ kind: 'group', name, total: members.length, hit, down })
      if (!collapsed[name]) for (const row of members) out.push({ kind: 'row', row, groupName: name })
    }
    return out
  }, [sortedRows, showGroups, groupOrder, collapsed, threshold])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (items[i]?.kind === 'group' ? HEADER_H : ROW_H),
    overscan: 14,
  })

  // ⚠️ 標題列與資料列高度不同，items 一變（收合、切換分組、資料更新）
  // 就必須讓 virtualizer 重新量測，否則捲動位置會跟內容對不上。
  useEffect(() => {
    virtualizer.measure()
  }, [items, virtualizer])

  // 儀表板點某張卡 → 捲到那個分類（若已收合就先展開）
  useEffect(() => {
    if (!scrollTo) return
    if (collapsed[scrollTo]) {
      // 先展開。展開會讓 items 重算，這個 effect 會再跑一次，
      // 那時才去找索引——否則會用到展開前的過期索引，捲到錯的位置。
      toggleCollapsed(scrollTo)
      return
    }
    const idx = items.findIndex((it) => it.kind === 'group' && it.name === scrollTo)
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'start' })
    requestScrollTo(null)
  }, [scrollTo, items, collapsed, toggleCollapsed, requestScrollTo, virtualizer])

  // 資料第一次到齊時把捲軸拉回頂端，避免停在奇怪的位置
  useEffect(() => {
    if (!didInitialScroll.current && items.length > 0) {
      didInitialScroll.current = true
      virtualizer.scrollToIndex(0)
    }
  }, [items.length, virtualizer])

  const vItems = virtualizer.getVirtualItems()
  const padTop = vItems.length ? Math.max(0, vItems[0].start) : 0
  const padBottom = vItems.length
    ? Math.max(0, virtualizer.getTotalSize() - vItems[vItems.length - 1].end)
    : 0
  const allCollapsed = groupOrder.length > 0 && groupOrder.every((n) => collapsed[n])

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center px-6 text-center text-sm text-zinc-500">
        {rows.length === 0
          ? '尚無資料。後端會依「慢線秒數」定期重算，或按工具列的「手動更新即時資料」立刻觸發。'
          : `「${groupFilter}」這個分類目前沒有算得出結果的股票。`}
      </div>
    )
  }

  const colCount = table.getAllColumns().length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顯示控制列。篩選到單一分類時整條都用不到，直接不渲染 */}
      {groupFilter === null && (
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
          <button
            onClick={() => setGrouped(!grouped)}
            className={`rounded border px-2 py-1 ${
              grouped ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            {grouped ? '✓ 依分類顯示' : '依分類顯示'}
          </button>
          {grouped && (
            <button
              onClick={() => setAllCollapsed(!allCollapsed, groupOrder)}
              className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800"
            >
              {allCollapsed ? '全部展開' : '全部收合'}
            </button>
          )}
          <span className="ml-auto text-zinc-600">
            點任一列可展開個股即時走勢　·　{grouped ? `${groupOrder.length} 個分類` : `${sortedRows.length} 檔`}
          </span>
        </div>
      )}

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-zinc-900">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  style={{ width: h.getSize() }}
                  onClick={h.column.getToggleSortingHandler()}
                  className={`border-b border-zinc-800 px-3 py-2 text-left text-xs font-medium text-zinc-400 ${
                    h.column.getCanSort() ? 'cursor-pointer select-none hover:text-zinc-200' : ''
                  }`}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && <tr style={{ height: padTop }} />}

          {vItems.map((vi) => {
            const item = items[vi.index]
            if (!item) return null

            if (item.kind === 'group') {
              return (
                <tr
                  key={vi.key}
                  onClick={() => toggleCollapsed(item.name)}
                  className="cursor-pointer select-none bg-zinc-900/90 hover:bg-zinc-800/90"
                  style={{ height: HEADER_H }}
                >
                  <td colSpan={colCount} className="border-y border-zinc-800 px-3">
                    <div className="flex items-center gap-2.5 text-xs">
                      <span className="w-3 text-zinc-500">{collapsed[item.name] ? '▸' : '▾'}</span>
                      <span className="font-semibold text-zinc-200">{item.name}</span>
                      <span className="tabular-nums text-zinc-500">{item.total} 檔</span>
                      {item.hit > 0 && (
                        <span className="rounded bg-rose-500/15 px-1.5 py-[1px] tabular-nums text-rose-300">
                          達標 {item.hit}
                        </span>
                      )}
                      {item.down > 0 && (
                        <span className="tabular-nums text-emerald-500/70">下跌 {item.down}</span>
                      )}
                    </div>
                  </td>
                </tr>
              )
            }

            const row = item.row
            const r = row.original
            return (
              <tr
                key={vi.key}
                onClick={() =>
                  !r.error && openModal({ kind: 'detail', symbol: r.symbol, from: groupFilter })
                }
                className={`border-b border-zinc-900 ${
                  r.error ? 'opacity-40' : 'cursor-pointer hover:bg-zinc-900/60'
                }`}
                style={{ height: ROW_H }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-1.5 align-middle">
                    {r.error && cell.column.id !== 'code' && cell.column.id !== 'name' ? (
                      cell.column.id === 'signals' ? (
                        <span className="text-xs text-rose-400/70">{r.error}</span>
                      ) : (
                        <span className="text-zinc-700">—</span>
                      )
                    ) : (
                      flexRender(cell.column.columnDef.cell, cell.getContext())
                    )}
                  </td>
                ))}
              </tr>
            )
          })}

          {padBottom > 0 && <tr style={{ height: padBottom }} />}
        </tbody>
      </table>
      </div>
    </div>
  )
}
