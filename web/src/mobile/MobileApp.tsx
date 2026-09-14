/**
 * 手機版整體外殼：頂部精簡標題列 + 分頁內容 + 底部導覽 + 個股詳情 sheet。
 *
 * 跟桌面版共用同一個 WebSocket 連線與 Zustand store，只是換一套顯示層——
 * 元件樹完全獨立（Round 2 定案），desktop 那邊的元件一行都沒有改。
 */
import { useState } from 'react'
import { useStore } from '../store'
import { BottomNav } from './BottomNav'
import { HomePage } from './HomePage'
import { WatchlistPage } from './WatchlistPage'
import { SignalsPage, type SignalFilter } from './SignalsPage'
import { GroupsPage } from './GroupsPage'
import { SettingsPage } from './SettingsPage'
import { StockSheet } from './StockSheet'

const TITLES: Record<string, string> = {
  home: '台股監控',
  watchlist: '自選',
  signals: '訊號',
  groups: '分類',
  settings: '設定',
}

export function MobileApp() {
  const { mobileTab } = useStore()
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('all')

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header
        className="shrink-0 border-b border-zinc-800 px-4 py-2.5"
        style={{ paddingTop: 'calc(0.625rem + env(safe-area-inset-top))' }}
      >
        <h1 className="text-sm font-semibold text-zinc-100">{TITLES[mobileTab] ?? '台股監控'}</h1>
      </header>

      {mobileTab === 'home' && <HomePage onOpenStock={setSelectedSymbol} />}
      {mobileTab === 'watchlist' && <WatchlistPage onOpenStock={setSelectedSymbol} />}
      {mobileTab === 'signals' && (
        <SignalsPage filter={signalFilter} onFilterChange={setSignalFilter} onOpenStock={setSelectedSymbol} />
      )}
      {mobileTab === 'groups' && <GroupsPage onOpenStock={setSelectedSymbol} />}
      {mobileTab === 'settings' && <SettingsPage />}

      <BottomNav />

      {selectedSymbol && <StockSheet symbol={selectedSymbol} onClose={() => setSelectedSymbol(null)} />}
    </div>
  )
}
