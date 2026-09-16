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

  // ⚠️ h-dvh（動態視窗高度）不是 h-screen（固定 100vh）。手機瀏覽器的網址列會
  // 隨捲動顯示/收合，100vh 算的是「網址列完全收起」時的最大高度，比實際看得到
  // 的畫面還高，會導致整個頁面被迫捲動、底部導覽列跟著被往下推、不再固定在
  // 畫面底部。2026-09-15 實測發現的問題，改用 h-dvh 會即時反映真正可視高度。
  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
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
