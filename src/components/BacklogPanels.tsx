// The backlog's Epics and Versions panels (spec 0407), as Jira's: toggles on the left; each entry filters the backlog,
// takes dropped items, and shows how much of the board's work it holds. Rendered inside the backlog's DndContext.
import { useEffect, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import { useStore, uid, type Board, type Issue, type Project, type Release } from '../data/store'
import { api, apiEnabled, errorMessage } from '../api/client'
import { canAdmin, canEdit } from '../data/access'
import { useApp } from '../appContext'
import { ReleaseDialog } from './ReleasesView'
import { Menu, plural } from './ui'
import { ALL, EPIC_COLORS, epicColor, epicTarget, panelFilter, panelTarget, planEpicDrop, planVersionDrop, versionTarget, type PanelFilter } from './panelRules'

interface Stat { issues: number; completed: number; unestimated: number; estimate: number; todo: number; inProgress: number; done: number }
interface Panels { epics: { id: string; key: string; title: string; epicColor?: string | null; projectId: string }[]; epicStats: Record<string, Stat>; versionStats: Record<string, Stat> }
const PANEL_KEY = 'jira-build:backlog-panel'

/** The panels' state for a backlog: which is open, the two filters, and what dropping items on an entry does (R4, R9).
 *  `drop` returns true when the drop was on a panel entry (handled here). */
export function usePanels() {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [open, setOpen] = usePanel()
  const [epic, setEpic] = useState<PanelFilter>(ALL)
  const [version, setVersion] = useState<PanelFilter>(ALL)
  const [refresh, setRefresh] = useState(0)
  const byId = new Map(state.issues.map(i => [i.id, i]))
  const isEpic = (id: string) => byId.get(id)?.type === 'epic'
  const apply = (list: Issue[]) => panelFilter(list, { epic, version, isEpic })
  const drop = (ids: string[], over: string) => {
    const t = panelTarget(over)
    if (!t) return false
    const moving = ids.map(id => byId.get(id)).filter((i): i is Issue => !!i)
    if (t.kind === 'epic') {
      const plan = planEpicDrop(moving, t.id, { isEpic, isSubItem: i => !!i.parentId && !isEpic(i.parentId) })
      if ('blocked' in plan) { toast(plan.blocked, { tone: 'warn' }); return true }
      for (const m of plan.moves) dispatch({ type: 'updateIssues', ids: [m.id], patch: { parentId: m.parentId ?? undefined } })
    } else for (const m of planVersionDrop(moving, t.id)) dispatch({ type: 'updateIssues', ids: [m.id], patch: { fixReleaseIds: m.fixReleaseIds } })
    setTimeout(() => setRefresh(n => n + 1), 800)                                   // the counts, once the change is saved
    return true
  }
  return { open, setOpen, epic, setEpic, version, setVersion, refresh, apply, drop }
}

/** Which panel is open, remembered in this browser (R1). */
export function usePanel() {
  const [open, setOpen] = useState<'epics' | 'versions' | null>(() => (localStorage.getItem(PANEL_KEY) as 'epics' | 'versions' | null) || null)
  const set = (p: 'epics' | 'versions' | null) => { setOpen(p); if (p) localStorage.setItem(PANEL_KEY, p); else localStorage.removeItem(PANEL_KEY) }
  return [open, set] as const
}

export default function BacklogPanels({ board, project, open, setOpen, epic, setEpic, version, setVersion, refresh, format }: {
  board: Board; project: Project; open: 'epics' | 'versions' | null; setOpen: (p: 'epics' | 'versions' | null) => void
  epic: PanelFilter; setEpic: (f: PanelFilter) => void; version: PanelFilter; setVersion: (f: PanelFilter) => void
  refresh: number; format: (n: number) => string | number
}) {
  const { dispatch } = useStore()
  const { createIssue, openIssue, toast } = useApp()
  const [data, setData] = useState<Panels | null>(null)
  const [creatingVersion, setCreatingVersion] = useState<Release | null>(null)
  useEffect(() => {
    if (!apiEnabled) return
    let live = true
    api<Panels>('GET', `/api/boards/${encodeURIComponent(board.id)}/panels`).then(d => { if (live) setData(d) }, e => toast(errorMessage(e), { tone: 'warn' }))
    return () => { live = false }
  }, [board.id, refresh])   // eslint-disable-line react-hooks/exhaustive-deps
  const versions = project.releases.filter(r => !r.archived && !r.released)
  const hasVersions = project.releases.some(r => !r.archived)
  const showStat = (n: number) => (board.estimation === 'time' ? format(n) : n)
  const statOf = (s?: Stat) => s ?? { issues: 0, completed: 0, unestimated: 0, estimate: 0, todo: 0, inProgress: 0, done: 0 }

  const toggles = (
    <div className="panel-toggles" role="tablist" aria-label="Backlog panels">
      <button role="tab" aria-selected={open === 'epics'} className={`panel-toggle${open === 'epics' ? ' on' : ''}`} onClick={() => setOpen(open === 'epics' ? null : 'epics')}>Epics</button>
      {hasVersions && <button role="tab" aria-selected={open === 'versions'} className={`panel-toggle${open === 'versions' ? ' on' : ''}`} onClick={() => setOpen(open === 'versions' ? null : 'versions')}>Versions</button>}
    </div>
  )
  if (!open || (open === 'versions' && !hasVersions)) return toggles

  const rename = (id: string, now: string) => {
    const name = prompt('Epic name', now)?.trim()
    if (name && name !== now) dispatch({ type: 'updateIssues', ids: [id], patch: { title: name } })
  }
  const color = (id: string, c: string) => { dispatch({ type: 'updateIssues', ids: [id], patch: { epicColor: c } }); setData(d => d && { ...d, epics: d.epics.map(e => (e.id === id ? { ...e, epicColor: c } : e)) }) }
  const markDone = (id: string, title: string) => {
    dispatch({ type: 'updateIssues', ids: [id], patch: { epicStatus: 'Done' } })
    setData(d => d && { ...d, epics: d.epics.filter(e => e.id !== id) })
    if (epic.kind === 'one' && epic.id === id) setEpic({ kind: 'all' })
    toast(`${title} marked as Done`)
  }
  const renameVersion = (r: Release) => {
    const name = prompt('Version name', r.name)?.trim()
    if (name && name !== r.name) dispatch({ type: 'updateProject', id: project.id, patch: { releases: project.releases.map(x => (x.id === r.id ? { ...x, name } : x)) } })
  }

  return (
    <div className="backlog-panel-wrap">
      {toggles}
      <aside className="backlog-panel" aria-label={open === 'epics' ? 'Epics' : 'Versions'}>
        <div className="backlog-panel-hdr">
          <b>{open === 'epics' ? 'Epics' : 'Versions'}</b>
          {open === 'epics' && canEdit(project) && <button className="btn btn-ghost btn-sm" onClick={() => createIssue({ projectId: project.id, type: 'epic' })}><Plus size={13} />Create epic</button>}
          {open === 'versions' && canAdmin(project) && <button className="btn btn-ghost btn-sm" onClick={() => setCreatingVersion({ id: uid(), name: '', description: '', released: false })}><Plus size={13} />Create version</button>}
        </div>
        {open === 'epics' ? <>
          <Entry id={null} target={epicTarget(null)} label="All issues" active={epic.kind === 'all'} onClick={() => setEpic({ kind: 'all' })} plain />
          <Entry id={null} target={epicTarget(null)} label="Issues without epics" active={epic.kind === 'none'} onClick={() => setEpic({ kind: 'none' })} stat={statOf(data?.epicStats.none)} droppable />
          {!data ? <p className="muted sm">Loading…</p> : !data.epics.length ? <p className="muted sm" style={{ padding: 8 }}>No open epics.</p> : data.epics.map(e => (
            <Entry key={e.id} id={e.id} target={epicTarget(e.id)} label={e.title} color={epicColor({ key: e.key, epicColor: e.epicColor ?? undefined })} droppable
              active={epic.kind === 'one' && epic.id === e.id} onClick={() => setEpic(epic.kind === 'one' && epic.id === e.id ? { kind: 'all' } : { kind: 'one', id: e.id })}
              stat={statOf(data.epicStats[e.id])} show={showStat}
              menu={<Menu title={`Actions for ${e.title}`} className="icon-btn sm" trigger={<MoreHorizontal size={14} />} items={[
                { label: 'Edit name', onClick: () => rename(e.id, e.title) },
                { label: 'View epic details', onClick: () => openIssue(e.id) },
                { label: 'Create issue in epic', onClick: () => createIssue({ projectId: project.id, parentId: e.id }) },
                // Jira's Mark as Done: the Epic Status, not the workflow (spec 0716); the epic leaves the panel
                ...(canEdit(project) ? [{ label: 'Mark as Done', onClick: () => markDone(e.id, e.title) }] : []),
                ...Object.entries(EPIC_COLORS).map(([k, hex], n) => ({ label: `Colour ${n + 1}`, icon: <span className="epic-swatch" style={{ background: hex }} />, divider: n === 0, onClick: () => color(e.id, k) })),
              ]} />} />
          ))}
        </> : <>
          <Entry id={null} target={versionTarget(null)} label="All issues" active={version.kind === 'all'} onClick={() => setVersion({ kind: 'all' })} plain />
          <Entry id={null} target={versionTarget(null)} label="Issues without versions" active={version.kind === 'none'} onClick={() => setVersion({ kind: 'none' })} stat={statOf(data?.versionStats.none)} droppable />
          {versions.map(r => (
            <Entry key={r.id} id={r.id} target={versionTarget(r.id)} label={r.name} droppable
              sub={[r.startDate && `Start ${r.startDate}`, r.releaseDate && `Release ${r.releaseDate}`].filter(Boolean).join(' · ')}
              active={version.kind === 'one' && version.id === r.id} onClick={() => setVersion(version.kind === 'one' && version.id === r.id ? { kind: 'all' } : { kind: 'one', id: r.id })}
              stat={statOf(data?.versionStats[r.id])} show={showStat}
              menu={canAdmin(project) ? <Menu title={`Actions for ${r.name}`} className="icon-btn sm" trigger={<MoreHorizontal size={14} />} items={[{ label: 'Edit name', onClick: () => renameVersion(r) }]} /> : undefined} />
          ))}
        </>}
      </aside>
      {creatingVersion && <ReleaseDialog release={creatingVersion} isNew onClose={() => setCreatingVersion(null)}
        onSave={r => { dispatch({ type: 'updateProject', id: project.id, patch: { releases: [...project.releases, r] } }); toast(`Created ${r.name}`); setCreatingVersion(null) }} />}
    </div>
  )
}

/** One entry: click to filter; drop items on it; expand for Jira's counts (R2, R7). */
function Entry({ target, label, sub, color, active, onClick, stat, show = n => n, menu, droppable, plain }: {
  id: string | null; target: string; label: string; sub?: string; color?: string; active: boolean; onClick: () => void
  stat?: Stat; show?: (n: number) => string | number; menu?: React.ReactNode; droppable?: boolean; plain?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const drop = useDroppable({ id: target, disabled: !droppable })
  const total = stat ? stat.todo + stat.inProgress + stat.done : 0
  return (
    <div ref={drop.setNodeRef} className={`panel-entry${active ? ' active' : ''}${drop.isOver ? ' drop-over' : ''}`} style={color ? { borderLeftColor: color } : undefined}>
      <div className="panel-entry-row">
        {!plain && <button className="icon-btn sm" aria-label={`${expanded ? 'Hide' : 'Show'} details of ${label}`} onClick={() => setExpanded(v => !v)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
        <button className="panel-entry-name" aria-pressed={active} onClick={onClick}>{label}</button>
        {menu}
      </div>
      {sub && <div className="muted sm" style={{ paddingLeft: 26 }}>{sub}</div>}
      {stat && !plain && stat.issues > 0 && (
        <span className="release-bar panel-bar" title={`${show(stat.done)} done · ${show(stat.inProgress)} in progress · ${show(stat.todo)} to do`}>
          {total > 0 ? <>
            <span style={{ flex: stat.done, background: 'var(--success)' }} /><span style={{ flex: stat.inProgress, background: 'var(--info)' }} /><span style={{ flex: stat.todo, background: 'var(--border-strong)' }} />
          </> : <span style={{ flex: 1, background: 'var(--border-strong)' }} />}
        </span>
      )}
      {expanded && stat && (
        <dl className="panel-stats">
          <dt>Issues</dt><dd>{stat.issues}</dd><dt>Completed</dt><dd>{stat.completed}</dd>
          <dt>Unestimated</dt><dd>{stat.unestimated}</dd><dt>Estimate</dt><dd>{show(stat.estimate)}</dd>
        </dl>
      )}
      {!expanded && stat && !plain && <div className="muted sm" style={{ paddingLeft: 26 }}>{plural(stat.issues, 'issue')}</div>}
    </div>
  )
}
