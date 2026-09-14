/**
 * 手機版底部導覽列。五個常駐分頁，跟桌面版「浮動視窗、同時只開一個」的模式
 * 不一樣——這裡是手機使用者熟悉的分頁列，切換分頁不會有開了又關的動畫負擔。
 *
 * 重新整理一律回到「總覽」（mobileTab 預設值，見 store.ts），所以這裡故意
 * 不做任何 URL / history 同步。
 */
import { useMemo } from 'react'
import { useStore } from '../store'
import type { MobileTab } from '../store'

const TABS: { key: MobileTab; label: string; icon: string }[] = [
  { key: 'home', label: '總覽', icon: '🏠' },
  { key: 'watchlist', label: '自選', icon: '⭐' },
  { key: 'signals', label: '訊號', icon: '🔔' },
  { key: 'groups', label: '分類', icon: '🗂️' },
  { key: 'settings', label: '設定', icon: '⚙️' },
]

export function BottomNav() {
  const { mobileTab, setMobileTab, events, readEventIds } = useStore()

  // 未讀事件數：訊號分頁上的紅點數字，超過 99 就顯示 99+
  const unread = useMemo(
    () => events.filter((e) => !readEventIds.has(e.id)).length,
    [events, readEventIds],
  )

  return (
    <nav
      className="grid shrink-0 grid-cols-5 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((t) => {
        const active = mobileTab === t.key
        return (
          <button
            key={t.key}
            onClick={() => setMobileTab(t.key)}
            className={`relative flex flex-col items-center gap-0.5 py-2 text-[11px] ${
              active ? 'text-emerald-400' : 'text-zinc-500'
            }`}
          >
            <span className="text-lg leading-none">{t.icon}</span>
            <span>{t.label}</span>
            {t.key === 'signals' && unread > 0 && (
              <span className="absolute right-[22%] top-1 min-w-[16px] rounded-full bg-rose-500 px-1 text-center text-[9px] font-semibold leading-4 text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
