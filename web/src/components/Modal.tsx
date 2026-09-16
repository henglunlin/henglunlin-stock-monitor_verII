/**
 * 通用浮動視窗。
 *
 * 為什麼要自己寫而不裝一個 dialog 套件：這裡需要的行為只有四件事——
 * Esc 關閉、點背景關閉、開著時鎖住底層捲動、內容區自己捲。四十行就寫完了，
 * 而且沒有多一個 60KB 的相依。
 *
 * ⚠️ 內容區用 `min-h-0 flex-1 overflow-auto` 而不是給固定高度：
 * 裡面可能塞的是虛擬捲動的表格，它需要一個「高度由 flex 決定、而且自己會捲」
 * 的容器。給固定高度的話，視窗小的時候底部會被裁掉。
 */
import { useEffect, type ReactNode } from 'react'

const WIDTH = {
  sm: 'max-w-lg',
  md: 'max-w-3xl',
  lg: 'max-w-6xl',
  xl: 'max-w-[96rem]',
} as const

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  actions,
  size = 'md',
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  /** 標題列右側的自訂按鈕 */
  actions?: ReactNode
  size?: keyof typeof WIDTH
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // 開著的時候鎖住底層捲動，否則滾到表格底部會「穿透」去捲背後的儀表板
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className={`flex max-h-full w-full ${WIDTH[size]} flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/60`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-100">{title}</div>
            {subtitle && <div className="mt-0.5 truncate text-xs text-zinc-500">{subtitle}</div>}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {actions}
            <button
              onClick={onClose}
              aria-label="關閉"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              關閉 Esc
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
