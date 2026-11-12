// A brand colour and the shades the app draws with (spec 0702 R4). Shared by the server (to check a colour) and the web
// app (to apply it).

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const hex = (c: number[]) => `#${c.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
const mix = (a: string, b: string, t: number) => { const [x, y] = [rgb(a), rgb(b)]; return hex(x.map((v, i) => v + (y[i]! - v) * t)) }

/** WCAG relative luminance, and the contrast of two colours (1 to 21). */
const luminance = (c: string) => {
  const [r, g, b] = rgb(c).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

export const BRAND_DEFAULT = '#368727'
export const isHexColor = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c)
/** White text on it is readable (WCAG AA, 4.5:1). */
export const brandReadable = (c: string) => isHexColor(c) && contrast(c, '#FFFFFF') >= 4.5

/** The app's shades of a brand colour, for the light theme and the dark one. */
export function brandShades(c: string) {
  return {
    light: { brand: c, hover: mix(c, '#000000', 0.22), press: mix(c, '#000000', 0.36), soft: mix(c, '#FFFFFF', 0.9), border: mix(c, '#FFFFFF', 0.55) },
    dark: { brand: mix(c, '#FFFFFF', 0.15), hover: mix(c, '#FFFFFF', 0.28), press: mix(c, '#FFFFFF', 0.5), soft: mix(c, '#000000', 0.72), border: mix(c, '#000000', 0.45) },
  }
}
