// Jira's text search syntax (spec 0609 R2), the value of a `~` clause: words joined by AND unless an operator says
// otherwise; "phrases"; * and ? anywhere in a word; AND && OR || NOT ! + - in capitals; parentheses; word~ for fuzzy.
// Boosts (^4) and proximity ("a b"~10) are accepted and ignored. Shared by the server and the JQL box.

export type TextNode =
  | { k: 'word' | 'phrase' | 'wild' | 'fuzzy'; w: string }
  | { k: 'and' | 'or'; items: TextNode[] }
  | { k: 'not'; item: TextNode }

export class TextQueryError extends Error {
  at: number
  constructor(message: string, at: number) { super(message); this.at = at }
}

type Tok = { t: 'word' | 'phrase' | '(' | ')' | 'and' | 'or' | 'not' | 'must'; v: string; at: number }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) { i++; continue }
    if (c === '(' || c === ')') { out.push({ t: c, v: c, at: i }); i++; continue }
    if (c === '"') {
      const j = src.indexOf('"', i + 1)
      if (j < 0) throw new TextQueryError('A phrase’s quote is not closed', i)
      out.push({ t: 'phrase', v: src.slice(i + 1, j), at: i })
      i = j + 1
      const m = /^~\d*(\.\d+)?(\^\d+(\.\d+)?)?/.exec(src.slice(i))       // proximity and boost: ignored
      if (m) i += m[0].length
      continue
    }
    if (src.startsWith('&&', i)) { out.push({ t: 'and', v: '&&', at: i }); i += 2; continue }
    if (src.startsWith('||', i)) { out.push({ t: 'or', v: '||', at: i }); i += 2; continue }
    if (c === '!' || c === '-') { out.push({ t: 'not', v: c, at: i }); i++; continue }
    if (c === '+') { out.push({ t: 'must', v: c, at: i }); i++; continue }
    const m = /^[^\s()"]+/.exec(src.slice(i))!
    const v = m[0]
    out.push({ t: v === 'AND' ? 'and' : v === 'OR' ? 'or' : v === 'NOT' ? 'not' : 'word', v, at: i })
    i += v.length
  }
  return out
}

/** A word as typed, without its boost; fuzzy (word~), a wildcard (* or ?), or a plain word. Special characters
 *  aren't indexed (as in Jira), so they only separate words. Null: nothing left to search for. */
function word(raw: string): TextNode | null {
  let w = raw.replace(/\^\d+(\.\d+)?$/, '')
  const fuzzy = /~\d*(\.\d+)?$/.exec(w)
  if (fuzzy) w = w.slice(0, fuzzy.index)
  w = w.replace(/[&|!(){}[\]^~:\\]/g, ' ').trim()
  if (!w) return null
  if (/[*?]/.test(w)) return { k: 'wild', w }
  return { k: fuzzy ? 'fuzzy' : 'word', w }
}

export function parseTextQuery(src: string): TextNode | null {
  const toks = lex(src)
  let p = 0
  const peek = () => toks[p]
  const fail = (msg: string, t = peek()): never => { throw new TextQueryError(msg, t?.at ?? src.length) }
  const unary = (): TextNode | null => {
    const t = peek()
    if (!t) return fail('Expected a word after the operator', toks[p - 1])
    if (t.t === 'not') { p++; const item = unary(); return item && { k: 'not', item } }
    if (t.t === 'must') { p++; return unary() }
    if (t.t === '(') {
      p++
      const n = or()
      if (peek()?.t !== ')') fail('Expected “)”', t)
      p++
      return n
    }
    if (t.t === 'phrase') { p++; return t.v.trim() ? { k: 'phrase', w: t.v } : null }
    if (t.t === 'word') { p++; return word(t.v) }
    return fail(t.t === ')' ? 'A “)” has no “(”' : `“${t.v}” needs a word before it`)
  }
  const and = (): TextNode | null => {
    const items: (TextNode | null)[] = [unary()]
    while (peek() && peek()!.t !== 'or' && peek()!.t !== ')') {
      if (peek()!.t === 'and') p++
      items.push(unary())
    }
    const kept = items.filter((x): x is TextNode => !!x)
    return kept.length > 1 ? { k: 'and', items: kept } : kept[0] ?? null
  }
  const or = (): TextNode | null => {
    const items = [and()]
    while (peek()?.t === 'or') { p++; items.push(and()) }
    const kept = items.filter((x): x is TextNode => !!x)
    return kept.length > 1 ? { k: 'or', items: kept } : kept[0] ?? null
  }
  if (!toks.length) return null
  const n = or()
  if (p < toks.length) fail('A “)” has no “(”')
  return n
}

/** A wildcard word as a Postgres regular expression over the text as written: * any letters, ? one. */
export function wildcardRegex(w: string): string {
  const body = [...w].map(c => c === '*' ? '\\w*' : c === '?' ? '\\w' : /\w/.test(c) ? c : /\s/.test(c) ? '\\W+' : `\\${c}`).join('')
  return `\\m${body}\\M`
}
