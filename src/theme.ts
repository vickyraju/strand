import { useEffect, useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
const KEY = 'forge:theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

export const getThemePref = (): ThemePref => (localStorage.getItem(KEY) as ThemePref) || 'system'

/** Apply the preference to <html data-theme>. Also called from index.html before React loads, to avoid a flash. */
export function applyTheme(pref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && media.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

export function setThemePref(pref: ThemePref) {
  localStorage.setItem(KEY, pref)
  applyTheme(pref)
  listeners.forEach(l => l())
}

export function useThemePref() {
  const pref = useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, getThemePref)
  // Follow the OS setting live when on "system"
  useEffect(() => {
    const onChange = () => { if (getThemePref() === 'system') applyTheme('system') }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return pref
}
