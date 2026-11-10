// The announcement banner's text (spec 0701 R3): plain text whose https:// addresses become links. Never HTML.

export type Part = { text: string } | { href: string }

/** The text split into plain parts and links (https only; a trailing full stop or bracket stays text). */
export function announcementParts(text: string): Part[] {
  const out: Part[] = []
  let last = 0
  for (const m of text.matchAll(/https:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) })
    out.push({ href: m[0] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** A short fingerprint of the text: a closed banner stays closed until it changes (R4). */
export function fingerprint(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(36)
}
