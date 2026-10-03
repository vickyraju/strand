// Attachment file contents, kept apart from the main store so the workspace JSON stays small.
// ponytail: data URLs in localStorage cap out at a few MB per browser; move to object storage with a backend.

const KEY = 'forge:files'
export const MAX_FILE  = 2 * 1024 * 1024
export const MAX_TOTAL = 10 * 1024 * 1024

function read(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}

export const fileUrl = (id: string): string | undefined => read()[id]

/** Bytes used by stored files (data URLs are ~4/3 of the original size). */
export const usedBytes = () => Object.values(read()).reduce((n, d) => n + Math.round(d.length * 0.75), 0)

export function saveFile(id: string, dataUrl: string) {
  const all = read()
  all[id] = dataUrl
  localStorage.setItem(KEY, JSON.stringify(all)) // throws QuotaExceededError when the browser is full
}

/** Drop files no longer referenced by any work item. */
export function pruneFiles(keep: Set<string>) {
  const all = read()
  const ids = Object.keys(all)
  if (ids.every(id => keep.has(id))) return
  for (const id of ids) if (!keep.has(id)) delete all[id]
  localStorage.setItem(KEY, JSON.stringify(all))
}

export const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(r.result as string)
  r.onerror = () => reject(r.error)
  r.readAsDataURL(file)
})

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`
  return `${Math.round(n / 104857.6) / 10} MB`
}
