import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown, Plus, Columns3, Ban } from 'lucide-react'
import {
  useStore, userOf, projectOf, blockersOf, indexOf, timeAgo, uid,
  type Issue, type Priority, type Project, type NewIssue,
} from '../data/store'
import { useApp, useNavList } from '../appContext'
import BulkBar from './BulkBar'
import {
  Avatar, Checkbox, Picker, Popover, Toggle, TypeIcon, PriorityIcon, PRIORITY_META, PRIORITIES, TYPE_META,
  statusOptions, priorityOptions, userOptions, formatDate, isOverdue,
} from './ui'
import { ProjectIcon } from './ProjectView'
import { fieldText } from './CustomFields'
import { loggedMinutes, formatDuration } from '../data/time'

export type TableGroup = 'status' | 'assignee' | 'priority' | 'epic' | 'project' | 'none'
type Col = `f:${string}` | 'type' | 'key' | 'project' | 'status' | 'assignee' | 'priority' | 'labels' | 'estimate' | 'logged' | 'due' | 'updated'
type SortKey = 'rank' | 'key' | 'title' | 'status' | 'assignee' | 'priority' | 'estimate' | 'due' | 'updated'

const COL_LABEL: Record<Col, string> = {
  type: 'Type', key: 'Key', project: 'Project', status: 'Status', assignee: 'Assignee', priority: 'Priority',
  labels: 'Labels', estimate: 'Points', logged: 'Time logged', due: 'Due', updated: 'Updated',
}
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }

interface Group { key: string; label: React.ReactNode; color?: string; items: Issue[]; defaults?: Partial<NewIssue> }

/** The full-featured work item table: grouping, sorting, column picker, inline edits, quick add, bulk actions. */
export default function IssueTable({ issues, id, groupBy, onGroupBy, project, showProjectColumn, emptyText }: {
  issues:             Issue[]
  /** Remembers column choices per table. */
  id:                 string
  groupBy:            TableGroup
  onGroupBy?:         (g: TableGroup) => void
  project?:           Project
  showProjectColumn?: boolean
  emptyText?:         string
}) {
  const { state, dispatch } = useStore()
  const { openIssue, toast } = useApp()
  const storageKey = `forge:table:${id}`
  const [cols, setCols] = useState<Record<Col, boolean>>(() => ({
    type: true, key: true, project: !!showProjectColumn, status: true, assignee: true, priority: true,
    labels: false, estimate: true, logged: false, due: true, updated: true,
    ...JSON.parse(localStorage.getItem(storageKey) ?? '{}'),
  }))
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(cols)) }, [cols, storageKey])
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'rank', dir: 1 })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Long groups render in pages so thousands of items stay fast
  const PAGE = 100
  const [limits, setLimits] = useState<Record<string, number>>({})
  const limitOf = (key: string) => limits[key] ?? PAGE

  // Drop selections that no longer exist (deleted, filtered out)
  useEffect(() => {
    setSelected(prev => {
      const ids = new Set(issues.map(i => i.id))
      const next = new Set([...prev].filter(id => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [issues])

  const projectFor = (i: Issue) => project ?? projectOf(state, i.projectId)!
  const statusFor  = (i: Issue) => projectFor(i).statuses.find(s => s.id === i.status)

  const sorted = useMemo(() => {
    const val = (i: Issue): string | number => {
      switch (sort.key) {
        case 'rank':     return i.rank
        case 'key':      return `${i.key.split('-')[0]}-${i.key.split('-')[1].padStart(6, '0')}`
        case 'title':    return i.title.toLowerCase()
        case 'status':   return projectFor(i).statuses.findIndex(s => s.id === i.status)
        case 'assignee': return userOf(state, i.assigneeId)?.name ?? '~'
        case 'priority': return PRIORITY_RANK[i.priority]
        case 'estimate': return i.estimate ?? -1
        case 'due':      return i.dueDate ?? '9999'
        case 'updated':  return i.updatedAt
      }
    }
    return [...issues].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir)
  }, [issues, sort, state]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups: Group[] = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', label: null, items: sorted, defaults: project ? { projectId: project.id } : undefined }]
    if (groupBy === 'status' && project) {
      return project.statuses.map(s => ({
        key: s.id, label: s.name, color: s.color, items: sorted.filter(i => i.status === s.id),
        defaults: { projectId: project.id, status: s.id },
      }))
    }
    if (groupBy === 'status') {
      const cats = [['todo', 'To do', '#A8A29E'], ['in-progress', 'In progress', '#3B82F6'], ['done', 'Done', '#16A34A']] as const
      return cats.map(([c, label, color]) => ({ key: c, label, color, items: sorted.filter(i => statusFor(i)?.category === c) }))
    }
    if (groupBy === 'assignee') {
      const ids = [...new Set(sorted.map(i => i.assigneeId ?? ''))]
      return ids.map(id => {
        const u = userOf(state, id || undefined)
        return {
          key: id || 'none', label: <><Avatar user={u} size={20} />{u?.name ?? 'Unassigned'}</>, items: sorted.filter(i => (i.assigneeId ?? '') === id),
          defaults: project ? { projectId: project.id, assigneeId: u?.id } : undefined,
        }
      }).sort((a, b) => (a.key === state.me?.id ? -1 : b.key === state.me?.id ? 1 : a.key === 'none' ? 1 : b.key === 'none' ? -1 : 0))
    }
    if (groupBy === 'priority') {
      return PRIORITIES.map(p => ({
        key: p, label: <><PriorityIcon priority={p} />{PRIORITY_META[p].label}</>, color: PRIORITY_META[p].color,
        items: sorted.filter(i => i.priority === p), defaults: project ? { projectId: project.id, priority: p } : undefined,
      }))
    }
    if (groupBy === 'project') {
      return state.projects.map(p => ({ key: p.id, label: <><ProjectIcon project={p} size={18} />{p.name}</>, color: p.color, items: sorted.filter(i => i.projectId === p.id) }))
    }
    // epic
    const byId = indexOf(state).byId
    const epicOf = (i: Issue) => {
      const parent = i.parentId ? byId.get(i.parentId) : undefined
      return parent?.type === 'epic' ? parent : undefined
    }
    const epics = [...new Set(sorted.map(i => epicOf(i)?.id ?? ''))]
    return epics.map(id => {
      const e = byId.get(id)
      return {
        key: id || 'none', label: e ? <><TypeIcon type="epic" size={13} /><span className="mono muted">{e.key}</span>{e.title}</> : 'No epic',
        color: e ? TYPE_META.epic.color : undefined, items: sorted.filter(i => (epicOf(i)?.id ?? '') === id),
        defaults: project ? { projectId: project.id, parentId: e?.id } : undefined,
      }
    })
  }, [sorted, groupBy, project, state]) // eslint-disable-line react-hooks/exhaustive-deps

  const visibleGroups = groups.filter(g => g.items.length > 0 || (groupBy === 'status' && project))
  const flat = visibleGroups.flatMap(g => collapsed.has(g.key) ? [] : g.items)
  useNavList(flat.map(i => i.id))

  const select = (id: string, on: boolean, shift: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && anchor) {
        const ids = flat.map(i => i.id)
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y)
        ids.slice(a, b + 1).forEach(x => on ? next.add(x) : next.delete(x))
      } else if (on) next.add(id); else next.delete(id)
      return next
    })
    setAnchor(id)
  }

  const headerSort = (key: SortKey, label: string, className = '') => (
    <th className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="th-btn" onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : (key === 'updated' ? -1 : 1) }))}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  )

  const quickAdd = (g: Group) => {
    if (!draft.trim() || !g.defaults?.projectId) return
    const id = uid()
    const p = state.projects.find(x => x.id === g.defaults!.projectId)!
    dispatch({ type: 'createIssue', id, issue: { title: draft.trim(), ...g.defaults, projectId: p.id } })
    toast(`Created ${p.key}-${p.nextNumber}`, { issueId: id })
    setDraft('')
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]')
    if (!row || (e.target as HTMLElement).tagName === 'INPUT') return
    const rows = [...(e.currentTarget.querySelectorAll<HTMLElement>('tr[data-id]'))]
    const i = rows.indexOf(row)
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus() }
    if (e.key === 'k' || e.key === 'ArrowUp')   { e.preventDefault(); rows[i - 1]?.focus() }
    if (e.key === 'x') { e.preventDefault(); select(row.dataset.id!, !selected.has(row.dataset.id!), e.shiftKey) }
    if (e.key === 'Escape' && selected.size) { e.stopPropagation(); setSelected(new Set()) }
  }

  const allIds = flat.map(i => i.id)
  const allSelected = allIds.length > 0 && allIds.every(id => selected.has(id))
  const customCols = (project?.fields ?? []).filter(f => cols[`f:${f.id}` as Col])
  const colCount = 2 + Object.entries(cols).filter(([k, v]) => v && !k.startsWith('f:') && (k !== 'project' || showProjectColumn)).length + customCols.length

  return (
    <div className="table-wrap">
      <div className="table-tools">
        {onGroupBy && (
          <Picker value={groupBy} title="Group by" className="btn btn-secondary btn-sm"
            options={[
              { value: 'status' as TableGroup, label: 'Status' }, { value: 'assignee' as TableGroup, label: 'Assignee' },
              { value: 'priority' as TableGroup, label: 'Priority' }, { value: 'epic' as TableGroup, label: 'Epic' },
              ...(showProjectColumn ? [{ value: 'project' as TableGroup, label: 'Project' }] : []),
              { value: 'none' as TableGroup, label: 'No grouping' },
            ]}
            onChange={onGroupBy}
            trigger={<>Group: {groupBy === 'none' ? 'None' : groupBy[0].toUpperCase() + groupBy.slice(1)}<ChevronDown size={13} /></>} />
        )}
        {sort.key !== 'rank' && <button className="btn btn-ghost btn-sm" onClick={() => setSort({ key: 'rank', dir: 1 })}>Reset to rank order</button>}
        <Popover title="Columns" className="btn btn-secondary btn-sm" trigger={<><Columns3 size={14} />Columns</>} width={220}>
          {(Object.keys(COL_LABEL) as Col[]).filter(c => c !== 'project' || showProjectColumn).map(c => (
            <label key={c} className="toggle-row">
              <span>{COL_LABEL[c]}</span>
              <Toggle on={cols[c]} onChange={on => setCols(prev => ({ ...prev, [c]: on }))} label={COL_LABEL[c]} />
            </label>
          ))}
          {(project?.fields.length ?? 0) > 0 && <div className="section-label" style={{ marginTop: 8 }}>Custom fields</div>}
          {project?.fields.map(f => (
            <label key={f.id} className="toggle-row">
              <span>{f.name}</span>
              <Toggle on={!!cols[`f:${f.id}` as Col]} onChange={on => setCols(prev => ({ ...prev, [`f:${f.id}`]: on }))} label={f.name} />
            </label>
          ))}
        </Popover>
      </div>

      <div className="table-scroll" onKeyDown={onKeyDown}>
        <table className="table" style={{ minWidth: 960 + customCols.length * 140 }}>
          <thead>
            <tr>
              <th className="col-check">
                <Checkbox checked={allSelected} indeterminate={!allSelected && selected.size > 0} label="Select all"
                  onChange={on => setSelected(on ? new Set(allIds) : new Set())} />
              </th>
              {cols.type && <th className="col-type"><span className="sr-only">Type</span></th>}
              {cols.key && headerSort('key', 'Key', 'col-key')}
              {headerSort('title', 'Title', 'col-title')}
              {cols.project && showProjectColumn && <th className="col-project">Project</th>}
              {cols.status && headerSort('status', 'Status', 'col-status')}
              {cols.assignee && headerSort('assignee', 'Assignee', 'col-assignee')}
              {cols.priority && headerSort('priority', 'Priority', 'col-priority')}
              {cols.labels && <th className="col-labels">Labels</th>}
              {cols.estimate && headerSort('estimate', 'Points', 'col-num')}
              {cols.logged && <th className="col-time">Time logged</th>}
              {cols.due && headerSort('due', 'Due', 'col-due')}
              {customCols.map(f => <th key={f.id} title={f.name} className={`col-custom${f.kind === 'number' ? ' col-num' : ''}`}><span className="cell-ellipsis">{f.name}</span></th>)}
              {cols.updated && headerSort('updated', 'Updated', 'col-updated')}
            </tr>
          </thead>
          {visibleGroups.length === 0 || (issues.length === 0 && groupBy !== 'status') ? (
            <tbody><tr><td colSpan={colCount} className="table-empty">{emptyText ?? 'No work items match.'}</td></tr></tbody>
          ) : visibleGroups.map(g => {
            const isCollapsed = collapsed.has(g.key)
            const points = g.items.reduce((n, i) => n + (i.estimate ?? 0), 0)
            const byStatus = project ? project.statuses.map(s => ({ s, n: g.items.filter(i => i.status === s.id).length })).filter(x => x.n) : []
            return (
              <tbody key={g.key} className="tgroup" style={{ ['--group-color' as string]: g.color ?? 'var(--border-strong)' }}>
                {groupBy !== 'none' && (
                  <tr className="tgroup-hdr">
                    <td colSpan={colCount}>
                      <button className="tgroup-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed(prev => {
                        const n = new Set(prev); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n
                      })}>
                        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        {g.color && groupBy === 'status' && <span className="status-dot" style={{ background: g.color }} />}
                        <span className="tgroup-label">{g.label}</span>
                        <span className="muted">{g.items.length}</span>
                      </button>
                    </td>
                  </tr>
                )}
                {!isCollapsed && g.items.slice(0, limitOf(g.key)).map(i => {
                  const p = projectFor(i)
                  const st = statusFor(i)
                  const done = st?.category === 'done'
                  const blocked = !done && blockersOf(state, i).length > 0
                  const parent = i.parentId ? indexOf(state).byId.get(i.parentId) : undefined
                  const set = (patch: Partial<Issue>) => dispatch({ type: 'updateIssues', ids: [i.id], patch })
                  return (
                    <tr key={i.id} data-id={i.id} tabIndex={0} className={selected.has(i.id) ? 'selected' : ''}
                      onClick={e => { if (e.shiftKey || e.metaKey) { select(i.id, !selected.has(i.id), e.shiftKey) } else openIssue(i.id) }}
                      onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) openIssue(i.id) }}>
                      <td className="col-check" onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selected.has(i.id)} label={`Select ${i.key}`} onChange={(on, e) => select(i.id, on, e.shiftKey)} />
                      </td>
                      {cols.type && <td className="col-type"><TypeIcon type={i.type} size={14} /></td>}
                      {cols.key && <td className={`col-key mono${done ? ' done' : ''}`}>{i.key}</td>}
                      <td className="col-title">
                        <span className="cell-title">
                          {blocked && <Ban size={13} className="text-danger" aria-label="Blocked" />}
                          <span className={done ? 'done-text' : ''}>{i.title}</span>
                          {parent && <span className="muted cell-parent">{parent.title}</span>}
                        </span>
                      </td>
                      {cols.project && showProjectColumn && <td className="col-project"><span className="cell-flex"><ProjectIcon project={p} size={16} />{p.key}</span></td>}
                      {cols.status && (
                        <td className="col-status" onClick={e => e.stopPropagation()}>
                          <Picker value={i.status} options={statusOptions(p, i.status)} onChange={s => set({ status: s })} title="Change status"
                            className={`status-cell cat-${st?.category}`} trigger={<>{st?.name}<ChevronDown size={12} /></>} />
                        </td>
                      )}
                      {cols.assignee && (
                        <td className="col-assignee" onClick={e => e.stopPropagation()}>
                          <Picker value={i.assigneeId} search options={userOptions(state.users)} onChange={a => set({ assigneeId: a })} title="Change assignee"
                            className="cell-btn" trigger={<><Avatar user={userOf(state, i.assigneeId)} size={22} /><span className="cell-ellipsis">{userOf(state, i.assigneeId)?.name ?? 'Unassigned'}</span></>} />
                        </td>
                      )}
                      {cols.priority && (
                        <td className="col-priority" onClick={e => e.stopPropagation()}>
                          <Picker value={i.priority} options={priorityOptions} onChange={pr => set({ priority: pr })} title="Change priority"
                            className="cell-btn" trigger={<><PriorityIcon priority={i.priority} />{PRIORITY_META[i.priority].label}</>} />
                        </td>
                      )}
                      {cols.labels && <td className="col-labels"><span className="cell-flex">{i.labels.slice(0, 2).map(l => <span key={l} className="tag">{l}</span>)}{i.labels.length > 2 && <span className="muted">+{i.labels.length - 2}</span>}</span></td>}
                      {cols.estimate && <td className="col-num">{i.estimate ?? ''}</td>}
                      {cols.logged && <td className="col-time muted">{loggedMinutes(i) ? `${formatDuration(loggedMinutes(i))}${i.timeEstimate ? ` / ${formatDuration(i.timeEstimate)}` : ''}` : ''}</td>}
                      {cols.due && <td className={`col-due${i.dueDate && isOverdue(i.dueDate) && !done ? ' text-danger' : ''}`}>{i.dueDate ? formatDate(i.dueDate) : ''}</td>}
                      {customCols.map(f => <td key={f.id} className={`col-custom${f.kind === 'number' ? ' col-num' : ''}`}><span className="cell-ellipsis">{fieldText(f, i.custom[f.id])}</span></td>)}
                      {cols.updated && <td className="col-updated muted">{timeAgo(i.updatedAt)}</td>}
                    </tr>
                  )
                })}
                {!isCollapsed && g.items.length > limitOf(g.key) && (
                  <tr className="tadd">
                    <td colSpan={colCount}>
                      <button className="tadd-btn" onClick={() => setLimits(l => ({ ...l, [g.key]: limitOf(g.key) + 200 }))}>
                        <ChevronDown size={14} />Show {Math.min(200, g.items.length - limitOf(g.key))} more
                        <span className="muted"> · {g.items.length - limitOf(g.key)} not shown</span>
                      </button>
                    </td>
                  </tr>
                )}
                {!isCollapsed && g.defaults?.projectId && (
                  <tr className="tadd">
                    <td colSpan={colCount}>
                      {adding === g.key ? (
                        <form className="tadd-form" onSubmit={e => { e.preventDefault(); quickAdd(g) }}>
                          <Plus size={14} className="muted" />
                          <input className="tadd-input" autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                            placeholder="What needs to be done? Press Enter to add, Esc to stop"
                            onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); setDraft('') } }}
                            onBlur={() => { if (!draft.trim()) setAdding(null) }} aria-label="New work item title" />
                        </form>
                      ) : (
                        <button className="tadd-btn" onClick={() => { setAdding(g.key); setDraft('') }}><Plus size={14} />Add item</button>
                      )}
                    </td>
                  </tr>
                )}
                {!isCollapsed && groupBy !== 'none' && g.items.length > 0 && (
                  <tr className="tsummary">
                    <td colSpan={colCount}>
                      {byStatus.length > 0 && (
                        <span className="dist-bar" title={byStatus.map(x => `${x.s.name}: ${x.n}`).join(', ')}>
                          {byStatus.map(x => <span key={x.s.id} style={{ flex: x.n, background: x.s.color }} />)}
                        </span>
                      )}
                      <span className="muted">{g.items.length} items{points ? ` · ${points} points` : ''}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            )
          })}
        </table>
      </div>

      <BulkBar ids={[...selected]} onClear={() => setSelected(new Set())} />
    </div>
  )
}
