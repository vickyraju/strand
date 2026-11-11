// Jira's wiki markup (descriptions, comments and multi-line fields from Jira DC's REST) as Strand's Markdown (spec 0805).
// Pure: the importer gives it a way to name people mentioned as [~username]. What it doesn't recognise stays as text.

const EMOTICONS: [string, string][] = [
  ['(/)', '✅'], ['(x)', '❌'], ['(!)', '⚠️'], ['(?)', '❓'], ['(i)', 'ℹ️'], ['(y)', '👍'], ['(n)', '👎'], ['(on)', '💡'], ['(off)', '💡'],
  ['(*)', '⭐'], ['(+)', '➕'], ['(-)', '➖'], [':)', '🙂'], [':(', '🙁'], [':D', '😃'], [';)', '😉'], [':P', '😛'],
]

/** Splits on `sep` outside [links] and {{monospace}} (a table cell's | inside a link is part of the link). */
function splitCells(row: string, sep: '|' | '||'): string[] {
  const out: string[] = []
  let cur = '', depth = 0
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!
    if (c === '[' || row.startsWith('{{', i)) depth++
    if ((c === ']' || row.startsWith('}}', i)) && depth > 0) depth--
    if (depth === 0 && row.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; continue }
    cur += c
  }
  out.push(cur)
  return out
}

export function wikiToMarkdown(src: string, o: { person?: (username: string) => string | undefined } = {}): string {
  const tokens: string[] = []
  const keep = (s: string) => `\u0000${tokens.push(s) - 1}\u0000`              // text the later steps must not touch

  const inline = (s: string): string => {
    s = s.replace(/\{\{(.+?)\}\}/g, (_, t) => keep('`' + t + '`'))
    s = s.replace(/\{color(?::[^}]*)?\}/g, '')
    s = s.replace(/\[([^\]\n]+)\]/g, (all, body: string) => {
      const [text, target] = body.includes('|') ? [body.slice(0, body.lastIndexOf('|')), body.slice(body.lastIndexOf('|') + 1).trim()] : [null, body.trim()]
      if (target.startsWith('~')) { const u = target.slice(1); return keep(`@${o.person?.(u) ?? u}`) }
      if (target.startsWith('^')) { const f = target.slice(1); return keep(`[${text ?? f}](attachment:${encodeURI(f)})`) }
      if (/^(https?|mailto|ftp):/i.test(target)) return keep(text ? `[${text}](${target})` : target)
      if (/^[A-Z][A-Z0-9_]+-\d+$/.test(target)) return keep(text ? `${text} (${target})` : target)
      return all
    })
    s = s.replace(/!([^!\s|][^!\n|]*?)(\|[^!\n]*)?!/g, (all, name: string) => {
      if (/^https?:\/\//i.test(name)) return keep(`[${name}](${name})`)
      return /\.\w{2,5}$/.test(name) ? keep(`![${name}](attachment:${encodeURI(name)})`) : all
    })
    s = s.replace(/https?:\/\/[^\s<>()\]]+/g, u => keep(u))
    // only standing on their own: {jira:PAY-1} keeps its :P
    for (const [e, u] of EMOTICONS) s = s.replace(new RegExp(`(^|\\s)${e.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}(?=$|\\s|[.,;!?])`, 'g'), `$1${u}`)
    const around = (mark: string, to: (t: string) => string) => {
      const m = mark.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&')
      s = s.replace(new RegExp(`(^|[\\s(>\\u0000"'])${m}(\\S(?:[^\\n]*?\\S)?)${m}(?=$|[\\s).,:;!?"'\\u0000])`, 'g'), (_, pre, t) => pre + to(t))
    }
    around('*', t => `**${t}**`)
    around('_', t => `*${t}*`)
    around('-', t => keep(`~~${t}~~`))                                         // kept: the subscript step reads ~
    around('+', t => t)
    around('^', t => t)
    around('~', t => t)
    around('??', t => `*— ${t}*`)
    return s.replace(/\\\\/g, '\n')
  }

  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let quote = false
  const push = (l: string) => out.push(quote ? `> ${l}` : l)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    // code and noformat: as written, fenced
    const code = /^\s*\{(code|noformat)(?::([^}|]*))?[^}]*\}(.*)$/.exec(line)
    if (code) {
      const end = `{${code[1]}}`
      const lang = code[1] === 'code' && code[2] && !code[2].includes('=') ? code[2].trim() : ''
      const body: string[] = []
      let rest = code[3]!
      while (true) {
        const at = rest.indexOf(end)
        if (at >= 0) { if (rest.slice(0, at)) body.push(rest.slice(0, at)); line = rest.slice(at + end.length); break }
        if (rest) body.push(rest)
        if (++i >= lines.length) { line = ''; break }
        rest = lines[i]!
      }
      for (const l of ['```' + lang, ...body, '```']) push(l)
      if (!line.trim()) continue
    }
    // quotes and panels: their lines quoted
    const toggle = /^\s*\{(quote|panel)(?::([^}]*))?\}(.*)$/.exec(line)
    if (toggle) {
      quote = !quote
      const title = toggle[1] === 'panel' && quote ? /title=([^|}]+)/.exec(toggle[2] ?? '')?.[1] : undefined
      if (title) push(`**${inline(title.trim())}**`)
      line = toggle[3]!
      const close = line.search(/\{(quote|panel)\}/)
      if (close >= 0) { if (line.slice(0, close).trim()) push(inline(line.slice(0, close).trim())); quote = false; line = line.slice(close).replace(/^\{(quote|panel)\}/, '') }
      if (!line.trim()) continue
    }
    const bq = /^\s*bq\.\s+(.*)$/.exec(line)
    if (bq) { out.push(`> ${inline(bq[1]!)}`); continue }
    const h = /^\s*h([1-6])\.\s+(.*)$/.exec(line)
    if (h) { push(`${'#'.repeat(Math.min(3, Number(h[1])))} ${inline(h[2]!)}`); continue }
    if (/^\s*-{4,}\s*$/.test(line)) { push('---'); continue }
    const li = /^\s*([*#]+|-)\s+(.*)$/.exec(line)
    if (li) {
      const marks = li[1]!, depth = marks === '-' ? 1 : marks.length
      push(`${'  '.repeat(depth - 1)}${marks.endsWith('#') ? '1.' : '-'} ${inline(li[2]!)}`)
      continue
    }
    // tables: a heading row (||) and cell rows (|); a table without a heading row takes its first row as one
    if (/^\s*\|/.test(line)) {
      const rows: { head: boolean; cells: string[] }[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const r = lines[i]!.trim(), head = r.startsWith('||')
        const cells = splitCells(r.replace(head ? /^\|\||\|\|$/g : /^\||\|$/g, ''), head ? '||' : '|').map(c => inline(c.trim()).replace(/\n/g, ' '))
        rows.push({ head, cells }); i++
      }
      i--
      const width = Math.max(...rows.map(r => r.cells.length))
      const row = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`
      push(row(rows[0]!.cells)); push(row(Array(width).fill('---')))
      for (const r of rows.slice(1)) push(row(r.cells))
      continue
    }
    push(inline(line))
  }
  let md = out.join('\n')
  while (/\u0000\d+\u0000/.test(md)) md = md.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]!)   // kept text can hold kept text
  return md.replace(/\n{3,}/g, '\n\n').trim()
}
