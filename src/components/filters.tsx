import { useState } from 'react'
import { Search, X, Filter } from 'lucide-react'
import { useStore, blockersOf, type Issue, type IssueType, type User } from '../data/store'
import { Avatar, Popover, TYPE_META, TypeIcon, Checkbox } from './ui'

type Quick = 'mine' | 'recent' | 'due' | 'blocked'
const QUICK: { id: Quick; label: string }[] = [
  { id: 'mine',    label: 'Only my items' },
  { id: 'recent',  label: 'Recently updated' },
  { id: 'due',     label: 'Due this week' },
  { id: 'blocked', label: 'Blocked' },
]
const WEEK = 7 * 86_400_000

/** The filter toolbar shared by Board, List and Backlog: text search, people, quick filters and types. */
export function useFilters(people: User[]) {
  const { state } = useStore()
  const [query, setQuery]   = useState('')
  const [userIds, setUsers] = useState<Set<string>>(new Set())
  const [quick, setQuick]   = useState<Set<Quick>>(new Set())
  const [types, setTypes]   = useState<Set<IssueType>>(new Set())

  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const n = new Set(set)
    if (n.has(v)) n.delete(v); else n.add(v)
    apply(n)
  }

  const extraCount = [...quick].filter(q => q !== 'mine').length + types.size + (userIds.has('none') ? 1 : 0)
  const active = !!query.trim() || userIds.size > 0 || quick.size > 0 || types.size > 0
  const clear = () => { setQuery(''); setUsers(new Set()); setQuick(new Set()); setTypes(new Set()) }

  const apply = (issues: Issue[]) => {
    const q = query.trim().toLowerCase()
    const now = Date.now()
    return issues.filter(i =>
      (!q || i.title.toLowerCase().includes(q) || i.key.toLowerCase().includes(q) || i.labels.some(l => l.toLowerCase().includes(q))) &&
      (userIds.size === 0 || userIds.has(i.assigneeId ?? 'none')) &&
      (types.size === 0 || types.has(i.type)) &&
      (!quick.has('mine') || i.assigneeId === state.me?.id) &&
      (!quick.has('recent') || now - i.updatedAt < 2 * 86_400_000) &&
      (!quick.has('due') || (!!i.dueDate && new Date(i.dueDate + 'T23:59').getTime() - now < WEEK)) &&
      (!quick.has('blocked') || blockersOf(state, i).length > 0))
  }

  const shown = people.slice(0, 5)
  const extra = people.slice(5)

  const toolbar = (
    <div className="filters">
      <label className="search-field">
        <Search size={14} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search this view" aria-label="Search this view" />
        {query && <button className="icon-btn sm" onClick={() => setQuery('')} aria-label="Clear search"><X size={12} /></button>}
      </label>

      <div className="avatar-stack" role="group" aria-label="Filter by assignee">
        {shown.map(u => (
          <button key={u.id} className={`avatar-filter${userIds.has(u.id) ? ' on' : ''}`} onClick={() => toggle(userIds, u.id, setUsers)}
            title={u.name} aria-pressed={userIds.has(u.id)} aria-label={`Filter by ${u.name}`}>
            <Avatar user={u} size={28} />
          </button>
        ))}
        {extra.length > 0 && (
          <Popover title="More people" className="avatar-more" trigger={<>+{extra.length}</>} align="left" width={240}>
            {extra.map(u => (
              <label key={u.id} className="check-row">
                <Checkbox checked={userIds.has(u.id)} onChange={() => toggle(userIds, u.id, setUsers)} label={u.name} />
                <Avatar user={u} size={20} />{u.name}
              </label>
            ))}
          </Popover>
        )}
      </div>

      <button className={`chip${quick.has('mine') ? ' chip-on' : ''}`} aria-pressed={quick.has('mine')} onClick={() => toggle(quick, 'mine', setQuick)}>
        Only my items
      </button>

      <Popover title="Filter" align="left" width={260} className={`chip${extraCount ? ' chip-on' : ''}`}
        trigger={<><Filter size={13} />Filter{extraCount ? ` · ${extraCount}` : ''}</>}>
        <div className="section-label">Quick filters</div>
        {QUICK.filter(f => f.id !== 'mine').map(f => (
          <label key={f.id} className="check-row">
            <Checkbox checked={quick.has(f.id)} onChange={() => toggle(quick, f.id, setQuick)} label={f.label} />{f.label}
          </label>
        ))}
        <div className="section-label" style={{ marginTop: 8 }}>Type</div>
        {(Object.keys(TYPE_META) as IssueType[]).map(t => (
          <label key={t} className="check-row">
            <Checkbox checked={types.has(t)} onChange={() => toggle(types, t, setTypes)} label={TYPE_META[t].label} />
            <TypeIcon type={t} size={13} />{TYPE_META[t].label}
          </label>
        ))}
        <div className="section-label" style={{ marginTop: 8 }}>Assignee</div>
        <label className="check-row">
          <Checkbox checked={userIds.has('none')} onChange={() => toggle(userIds, 'none', setUsers)} label="Unassigned" />
          <Avatar size={20} />Unassigned
        </label>
      </Popover>

      {active && <button className="link" onClick={clear}>Clear filters</button>}
    </div>
  )

  return { apply, toolbar, active, clear }
}
