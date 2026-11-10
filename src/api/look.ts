// Look and feel (spec 0702): the site title, logo, favicon and brand colour, loaded before anyone signs in and applied to
// the whole app (CSS variables for both themes, the browser tab's icon). Without a server, Strand's own.
import { useEffect, useState } from 'react'
import { API_PREFIX, API_URL, api, apiEnabled } from './client'
import { BRAND_DEFAULT, brandShades } from '../../server/src/shared/brand.ts'

export interface Look { siteTitle: string; showTitle: boolean; brandColor: string; logo: string | null; favicon: string | null }
export const DEFAULT_LOOK: Look = { siteTitle: 'Strand', showTitle: true, brandColor: BRAND_DEFAULT, logo: null, favicon: null }

let current = DEFAULT_LOOK
const listeners = new Set<(l: Look) => void>()
/** An image's full address (the API serves it under its prefix). */
export const imageUrl = (path: string | null) => (path && API_URL ? `${API_URL}${API_PREFIX}${path}` : null)

function apply(l: Look) {
  const s = brandShades(l.brandColor)
  let style = document.getElementById('brand-colours') as HTMLStyleElement | null
  if (!style) { style = document.createElement('style'); style.id = 'brand-colours'; document.head.appendChild(style) }
  const vars = (x: typeof s.light) => `--brand:${x.brand};--brand-hover:${x.hover};--brand-press:${x.press};--brand-soft:${x.soft};--brand-border:${x.border}`
  style.textContent = l.brandColor === BRAND_DEFAULT ? '' : `:root{${vars(s.light)}}[data-theme='dark']{${vars(s.dark)}}`
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (icon) { icon.dataset.original ??= icon.href; icon.href = imageUrl(l.favicon) ?? icon.dataset.original }
}

export function setLook(l: Look) { current = l; apply(l); listeners.forEach(f => f(l)) }
export function loadLook() {
  if (!apiEnabled) return Promise.resolve(current)
  return api<Look>('GET', '/api/look-and-feel').then(l => { setLook(l); return l }, () => current)
}

export function useLook() {
  const [l, setL] = useState(current)
  useEffect(() => { listeners.add(setL); return () => { listeners.delete(setL) } }, [])
  return l
}
