// A directory in memory, for tests and the browser journeys (spec 0712): it reads the real filter strings, pages its
// results, and, like a real one, accepts an empty password as an anonymous bind (so Strand must never send one).
import { AndFilter, EqualityFilter, FilterParser, GreaterThanEqualsFilter, NotFilter, OrFilter, PresenceFilter, SubstringFilter, type Filter } from 'ldapts'
import { attr as values, type Connect, type Entry } from './ldap.ts'

export interface FakeDirectory {
  host: string
  /** DN → password (DNs compared ignoring case) */
  passwords: Record<string, string>
  entries: Entry[]
  /** Unreachable for now */
  down?: boolean
  /** Searches whose filter contains this fail (the connection works) */
  failSearches?: string
  /** What happened, for tests to check: every bind's DN and every search's filter */
  log?: { binds: string[]; searches: string[] }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matches(f: Filter, e: Entry): boolean {
  if (f instanceof AndFilter) return f.filters.every(x => matches(x, e))
  if (f instanceof OrFilter) return f.filters.some(x => matches(x, e))
  if (f instanceof NotFilter) return !matches(f.filter, e)
  if (f instanceof PresenceFilter) return values(e, f.attribute).length > 0
  if (f instanceof EqualityFilter) return values(e, f.attribute).some(v => v.toLowerCase() === String(f.value).toLowerCase())
  if (f instanceof GreaterThanEqualsFilter) return values(e, f.attribute).some(v => Number(v) >= Number(f.value))   // uSNChanged (spec 0713)
  if (f instanceof SubstringFilter) {
    const re = new RegExp(`^${esc(f.initial ?? '')}.*${(f.any ?? []).map(a => `${esc(a)}.*`).join('')}${esc(f.final ?? '')}$`, 'i')
    return values(e, f.attribute).some(v => re.test(v))
  }
  throw new Error(`The fake directory can’t evaluate ${f.constructor.name}`)
}

export const fakeConnect = (dir: FakeDirectory): Connect => async s => {
  if (dir.down || s.host !== dir.host) throw new Error(`connect ECONNREFUSED ${s.host}:${s.port}`)
  const password = (dn: string) => Object.entries(dir.passwords).find(([d]) => d.toLowerCase() === dn.toLowerCase())?.[1]
  return {
    async bind(dn, pw) {
      dir.log?.binds.push(dn)
      if (pw === '') return                                                  // anonymous: a real directory says yes too
      if (password(dn) !== pw) throw new Error('Invalid credentials')
    },
    async *search(base, filter, attributes, pageSize) {
      dir.log?.searches.push(filter)
      if (dir.failSearches && filter.includes(dir.failSearches)) throw new Error('Operations error')
      const f = FilterParser.parseString(filter)
      const found = dir.entries.filter(e => e.dn.toLowerCase().endsWith(base.toLowerCase()) && matches(f, e))
        .map(e => Object.fromEntries(Object.entries(e).filter(([k]) => k === 'dn' || attributes.some(a => a.toLowerCase() === k.toLowerCase()))) as Entry)
      for (let i = 0; i < found.length; i += pageSize) yield found.slice(i, i + pageSize)
      if (!found.length) yield []
    },
    async close() {},
  }
}
