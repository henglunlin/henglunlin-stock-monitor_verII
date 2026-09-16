/**
 * 手機／桌面版切換。
 *
 * 判斷式很單純：< 768px 就是手機（含直向手機），>= 768px（含平板 768-1024px）
 * 走桌面版——這是三輪問答 Round 1 定案的斷點，桌面版本身完全不受影響。
 *
 * 「切換桌面版」是設定頁裡的手動覆蓋，例如手機橫向想暫時看桌面表格。
 * 存 localStorage，因為這是單一裝置的顯示偏好，不必也不該進後端。
 */
import { useEffect, useState } from 'react'

const BREAKPOINT = 768
const LS_FORCE_DESKTOP = 'monitor.mobile.forceDesktop.v1'

function readForceDesktop(): boolean {
  try {
    return localStorage.getItem(LS_FORCE_DESKTOP) === '1'
  } catch {
    return false
  }
}

function writeForceDesktop(v: boolean): void {
  try {
    if (v) localStorage.setItem(LS_FORCE_DESKTOP, '1')
    else localStorage.removeItem(LS_FORCE_DESKTOP)
  } catch {
    /* 存不進去就算了，這只是顯示偏好 */
  }
}

/** 目前的視窗寬度是否落在手機斷點內（<768px），會隨旋轉螢幕即時更新 */
function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < BREAKPOINT,
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${BREAKPOINT - 1}px)`)
    const onChange = () => setNarrow(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

/** 回傳目前該顯示手機版還是桌面版，以及手動覆蓋開關（設定頁「切換桌面版」用） */
export function useResponsive() {
  const narrow = useIsNarrowViewport()
  const [forceDesktop, setForceDesktopState] = useState(readForceDesktop)

  const setForceDesktop = (v: boolean) => {
    writeForceDesktop(v)
    setForceDesktopState(v)
  }

  return {
    isMobile: narrow && !forceDesktop,
    isNarrowViewport: narrow,
    forceDesktop,
    setForceDesktop,
  }
}
