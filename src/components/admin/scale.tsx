import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { api, errorMessage } from '../../api/client'
import { Loading, LoadError } from '../ui'
import { sprintDeps } from '../../api/sprints'
import { href } from '../../router'

// Pieces for lists that can be long (thousands of projects, tens of thousands of people): never list everything; show
// a count that opens a searchable list loaded a page at a time from the server.

export interface Page<T> { items: T[]; next: string | null; total?: number }

/** Search the server as you type, a page at a time ("Load more"), and say how many there are in all. `path` takes
 *  `query`, `cursor` and `limit`; it answers `{ items, next, total? }`. */
export function PagedList<T>({ path, row, idOf, searchLabel = 'Search', empty = 'Nothing here.', limit = 50, extra }: {
  path: string; row: (t: T) => ReactNode; idOf: (t: T) => string; searchLabel?: string; empty?: string; limit?: number
  /** More query parameters (filters), which reload the list when they change */
  extra?: Record<string, string>
}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<T[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [total, setTotal] = useState<number | undefined>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const url = (cursor?: string | null) => {
    const p = new URLSearchParams({ limit: String(limit), ...(extra ?? {}) })
    if (q.trim()) p.set('query', q.trim())
    if (cursor) p.set('cursor', cursor)
    return `${path}${path.includes('?') ? '&' : '?'}${p}`
  }
  const load = (more = false) => {
    const mine = ++seq.current
    setBusy(true); setError('')
    api<Page<T>>('GET', url(more ? next : null)).then(r => {
      if (mine !== seq.current) return
      setItems(xs => (more ? [...(xs ?? []), ...r.items] : r.items)); setNext(r.next); setTotal(r.total); setBusy(false)
    }, e => { if (mine === seq.current) { setError(errorMessage(e)); setBusy(false) } })
  }
  const key = JSON.stringify(extra ?? {})
  useEffect(() => { const t = setTimeout(() => load(), q ? 200 : 0); return () => clearTimeout(t) }, [q, path, key])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="paged">
      <input className="input" placeholder={searchLabel} aria-label={searchLabel} value={q} onChange={e => setQ(e.target.value)} />
      {total !== undefined && items && <p className="muted sm" role="status">{q.trim() ? `${items.length.toLocaleString()}${next ? '+' : ''} matching` : `Showing ${items.length.toLocaleString()} of ${total.toLocaleString()}`}</p>}
      {error && <LoadError error={error} onRetry={() => load(!!items?.length && !!next)} />}
      {!items && !error && <Loading />}
      {items && !items.length && <p className="muted">{q.trim() ? 'Nothing matches.' : empty}</p>}
      {items && items.length > 0 && <ul className="paged-items">{items.map(t => <li key={idOf(t)}>{row(t)}</li>)}</ul>}
      {next && !error && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => load(true)}>{busy ? 'Loading…' : 'Load more'}</button>}
    </div>
  )
}

/** A panel from the right edge, for a long list next to the page it belongs to (Escape or the scrim closes it). */
export function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="side-scrim" onClick={onClose} />
      <aside ref={ref} tabIndex={-1} className="side-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="side-panel-hdr"><h2 className="modal-title">{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="side-panel-body">{children}</div>
      </aside>
    </>
  )
}

/** "400 projects", which opens the list of them. Nothing to open when there are none. */
export function CountLink({ count, one, many, label, onOpen }: { count: number; one: string; many: string; label?: string; onOpen: () => void }) {
  const text = label ?? `${count.toLocaleString()} ${count === 1 ? one : many}`
  if (!count) return <span className="muted">{text}</span>
  return <button type="button" className="count-link" onClick={e => { e.stopPropagation(); onOpen() }}>{text}</button>
}

/** Follows a background job until it ends; `progress` is what the job reports (done of total). */
export function useJob(jobId: string | null, onEnd?: (status: 'done' | 'failed', result: any) => void) {
  const [job, setJob] = useState<{ status: string; progress: any; result: any; lastError: string | null } | null>(null)
  const end = useRef(onEnd)
  end.current = onEnd
  useEffect(() => {
    if (!jobId) { setJob(null); return }
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => api<any>('GET', `/api/jobs/${jobId}`).then(j => {
      if (!live) return
      setJob(j)
      if (j.status === 'done' || j.status === 'failed') end.current?.(j.status, j.result)
      else timer = setTimeout(poll, 1000)
    }, () => { if (live) timer = setTimeout(poll, 3000) })
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [jobId])
  return job
}

/** "Applying to 2,140 of 6,000 projects" with a bar. */
export function Progress({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className="progress-row" role="status">
      <span>{label}: {done.toLocaleString()} of {total.toLocaleString()}</span>
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}><div style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

interface ApplyingNow { jobId: string; name: string | null; done: number; total: number }

/** The workflow change being applied in the background (one at a time), followed to its end: `bar` shows its progress
 *  and what failed; when it ends, the projects open here are fetched again (an open board also hears it live). */
export function useApplying(onEnd?: () => void) {
  const [now, setNow] = useState<ApplyingNow | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [ended, setEnded] = useState<{ applied: number; failed: { key: string; error: string }[] } | null>(null)
  useEffect(() => { api<ApplyingNow | null>('GET', '/api/admin/workflows/applying').then(j => { if (j) { setNow(j); setJobId(j.jobId) } }, () => {}) }, [])
  const job = useJob(jobId, (status, result) => {
    setJobId(null); setNow(null)
    setEnded(status === 'done' ? result : { applied: 0, failed: [{ key: '', error: 'The change could not be applied. Try publishing it again.' }] })
    void sprintDeps.reloadAll()
    onEnd?.()
  })
  const p = job?.progress ?? (now ? { done: now.done, total: now.total } : null)
  const bar = jobId ? (
    <div className="apply-banner">{p ? <Progress label="Applying to projects" done={p.done} total={p.total} /> : <span role="status">Starting…</span>}</div>
  ) : ended ? (
    <div className={`apply-banner${ended.failed.length ? ' warn' : ''}`} role="status">
      <span>{ended.failed.length
        ? <>Applied to {ended.applied.toLocaleString()} projects. {ended.failed.length.toLocaleString()} could not be changed: {ended.failed.slice(0, 5).map(f => f.key ? `${f.key} (${f.error})` : f.error).join('; ')}{ended.failed.length > 5 ? '…' : ''}</>
        : <>Applied to {ended.applied.toLocaleString()} project{ended.applied === 1 ? '' : 's'}.</>}</span>
      <button className="btn btn-ghost btn-sm" onClick={() => setEnded(null)}>Dismiss</button>
    </div>
  ) : null
  return { busy: !!jobId, follow: (id: string) => { setEnded(null); setJobId(id) }, bar }
}

/** Every project a workflow or scheme reaches, searchable, a page at a time, in a side panel. */
export function ProjectsUsing({ what, id, name, onClose }: { what: 'workflow' | 'scheme'; id: string; name: string; onClose: () => void }) {
  return (
    <SidePanel title={`Projects using ${name}`} onClose={onClose}>
      <PagedList<{ id: string; key: string; name: string; scheme: string }>
        path={`/api/admin/${what === 'workflow' ? 'workflows' : 'workflow-schemes'}/${encodeURIComponent(id)}/projects`}
        idOf={p => p.id} searchLabel="Find a project by key or name" empty="No project uses it yet."
        row={p => <>
          <a className="mono" href={href({ name: 'project', key: p.key, tab: 'settings', sub: 'workflow' })}>{p.key}</a>
          <span style={{ flex: 1 }}>{p.name}</span>
          {what === 'workflow' && <span className="muted sm">{p.scheme}</span>}
        </>} />
    </SidePanel>
  )
}

export interface GroupRef { id: string; name: string }

/** Choose one group by searching the server (there can be thousands; the first 20 by name show while nothing is typed). */
export function GroupPicker({ value, onChange, label, placeholder = 'Find a group…', exclude = [] }: {
  value: GroupRef | null; onChange: (g: GroupRef | null) => void; label: string; placeholder?: string; exclude?: string[]
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<GroupRef[]>([])
  const [active, setActive] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    if (!open) return
    const mine = ++seq.current
    const t = setTimeout(() => api<{ items: GroupRef[] }>('GET', `/api/groups?limit=20&query=${encodeURIComponent(q.trim())}`)
      .then(r => { if (mine === seq.current) { setFound(r.items.filter(g => !exclude.includes(g.id))); setActive(0) } }, () => {}), q ? 200 : 0)
    return () => clearTimeout(t)
  }, [q, open])   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (g: GroupRef | null) => { onChange(g); setOpen(false); setQ('') }
  const listId = `gp-${label.replace(/\W+/g, '-')}`
  if (value && !open) return (
    <span className="chip-static group-chosen">{value.name}
      <button type="button" className="chip-x" aria-label={`Clear ${label}`} onClick={() => pick(null)}>×</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Change</button>
    </span>
  )
  return (
    <span className="group-picker">
      <input className="input" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={label} placeholder={placeholder}
        value={q} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onChange={e => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, found.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && found[active]) { e.preventDefault(); pick(found[active]!) }
          else if (e.key === 'Escape') setOpen(false)
        }} />
      {open && (
        <ul id={listId} role="listbox" className="picker-menu group-picker-menu">
          {found.length ? found.map((g, i) => (
            <li key={g.id} role="option" aria-selected={i === active} className={`picker-item${i === active ? ' active' : ''}`} onMouseDown={e => { e.preventDefault(); pick(g) }}>{g.name}</li>
          )) : <li className="picker-empty">{q ? 'No group matches' : 'Type to find a group'}</li>}
        </ul>
      )}
    </span>
  )
}
