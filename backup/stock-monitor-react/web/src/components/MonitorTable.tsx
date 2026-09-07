/**
 * 監控主表格。
 *
 * 三個 Streamlit 做不到的地方，全部集中在這支檔案：
 *
 * 1. **虛擬捲動** —— 只渲染畫面內看得到的十幾列，兩百檔跟二十檔一樣順。
 *    原版每次 rerun 都在 Python 端重算全部標的再重繪整張表，檔數越多越慢。
 *
 * 2. **只有變動的格子會閃** —— 快線進來只更新價格那一格並閃一下顏色，
 *    捲軸不跳、其他欄位紋風不動。原版是整塊 fragment 重繪。
 *
 * 3. **每列內嵌走勢圖與買入區間量尺** —— 原版要看走勢得另開 Plotly 圖，一次一檔。
 *
 * 版面設定（排序、欄位）存 localStorage，關掉再開還在 —— 原版綁在 session_state，
 * 重新整理就沒了。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { pctOf, useStore } from '../store'
import type { Row } from '../types'
import { Sparkline } from './Sparkline'
import { SignalBadges } from './SignalBadges'
import { TargetScale } from './TargetScale'

const SORT_KEY = 'monitor.sorting.v1'

/** 疊合快線報價後的一列，交給表格排序與渲染 */
interface ViewRow extends Row {
  livePrice: number
  livePct: number
}

function loadSorting(): SortingState {
  try {
    const raw = localStorage.getItem(SORT_KEY)
    if (raw) return JSON.parse(raw) as SortingState
  } catch {
    /* localStorage 在無痕視窗或封鎖 cookie 時會丟例外，忽略即可 */
  }
  return [{ id: 'livePct', desc: true }]
}

export function MonitorTable() {
  const { rows, quotes, flash, select, selected } = useStore()
  const [sorting, setSorting] = useState<SortingState>(loadSorting)
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
      rows.map((r) => {
        const livePrice = quotes[r.code] ?? r.price
        return { ...r, livePrice, livePct: pctOf(r, livePrice) }
      }),
    [rows, quotes],
  )

  const columns = useMemo<ColumnDef<ViewRow>[]>(
    () => [
      {
        accessorKey: 'code',
        header: '代碼',
        size: 72,
        cell: (c) => <span className="font-mono text-zinc-400">{c.getValue<string>()}</span>,
      },
      { accessorKey: 'name', header: '名稱', size: 92 },
      {
        id: 'spark',
        header: '走勢',
        size: 96,
        enableSorting: false,
        cell: ({ row }) => <Sparkline data={row.original.spark ?? []} up={row.original.livePct >= 0} />,
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
              className={`font-mono tabular-nums transition-colors duration-500 ${
                fresh ? (f.dir === 'up' ? 'bg-rose-500/30' : 'bg-emerald-500/30') : ''
              } rounded px-1`}
            >
              {row.original.livePrice.toFixed(2)}
            </span>
          )
        },
      },
      {
        accessorKey: 'livePct',
        header: '漲跌%',
        size: 80,
        cell: ({ row }) => {
          const v = row.original.livePct
          return (
            <span className={`font-mono tabular-nums ${v > 0 ? 'text-rose-400' : v < 0 ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {v > 0 ? '+' : ''}
              {v.toFixed(2)}%
            </span>
          )
        },
      },
      {
        accessorKey: 'k',
        header: 'K / D',
        size: 82,
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
        size: 220,
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
    [flash],
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const tableRows = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 46,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()

  if (rows.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-zinc-500">
        尚無資料。後端每 20 秒會重算一次，或按上方「重新計算」立刻觸發。
      </div>
    )
  }

  return (
    <div ref={parentRef} className="h-[calc(100vh-96px)] overflow-auto">
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
          {items.length > 0 && items[0].start > 0 && <tr style={{ height: items[0].start }} />}
          {items.map((vi) => {
            const row = tableRows[vi.index]
            const r = row.original
            const isSel = selected === r.symbol
            return (
              <tr
                key={row.id}
                onClick={() => select(isSel ? null : r.symbol)}
                className={`border-b border-zinc-900 hover:bg-zinc-900/60 ${isSel ? 'bg-zinc-800/70' : ''} ${
                  r.error ? 'opacity-40' : ''
                }`}
                style={{ height: 46 }}
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
          {items.length > 0 && (
            <tr style={{ height: virtualizer.getTotalSize() - items[items.length - 1].end }} />
          )}
        </tbody>
      </table>
    </div>
  )
}
