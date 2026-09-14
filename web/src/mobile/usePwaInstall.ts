/**
 * PWA 安裝提示。桌面版完全用不到這個——`beforeinstallprompt` 只有在符合
 * PWA 安裝條件（manifest + service worker + https，見 vite.config.ts 的
 * VitePWA 設定）的環境才會觸發，這裡只是把瀏覽器原生事件包成 React 狀態，
 * 方便設定頁畫一顆「加入主畫面」按鈕。
 */
import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function usePwaInstall() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches,
  )

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  async function promptInstall() {
    if (!deferred) return
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    if (outcome === 'accepted') setInstalled(true)
    setDeferred(null)
  }

  return { canInstall: !!deferred && !installed, installed, promptInstall }
}
