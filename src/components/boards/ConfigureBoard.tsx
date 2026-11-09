// Configure board (Jira's board configuration): General (name, administrators, filter, Kanban's Done cut-off), Columns
// (global statuses mapped to columns, with a minimum and maximum), Swimlanes, Quick filters, Card layout, and deleting
// the board. Everyone in the project can read it; its administrators and the project's admins change it. Each section
// saves on its own; the server checks every query and says which one is wrong.
import { useEffect, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Kanban, MoveHorizontal, Plus, Trash2, X } from 'lucide-react'
import { DEFAULT_FIELDS, useStore, userOf, type Board, type CardColors, type Estimation, type Project } from '../../data/store'
import { priorityList } from '../../data/lists'
import { canAdmin } from '../../data/access'
import { api, ApiError, errorMessage } from '../../api/client'
import { lastBoard, reloadBoards, useBoard, useBoards, useJqlCount } from '../../api/boards'
import { href, navigate } from '../../router'
import { useApp } from '../../appContext'
import { FIELD_LABELS } from '../BoardView'
import JqlBox from '../JqlBox'
import { UserPicker } from '../UserPicker'
import { GroupPicker } from '../admin/scale'
import CreateBoard from './CreateBoard'
import { ConfirmDialog, Loading, LoadError, Menu, Toggle, plural, typeList } from '../ui'

type Column = Board['columns'][number]
type Named = { id: string; name: string; jql: string }
interface GStatus { id: string; name: string; category: 'todo' | 'in-progress' | 'done'; color: string }
type Save = (patch: Partial<Omit<Board, 'admins'>> & { admins?: { userIds: string[]; groupIds: string[] } }) => Promise<void>

const SECTIONS = [['general', 'General'], ['columns', 'Columns'], ['swimlanes', 'Swimlanes'], ['quick-filters', 'Quick filters'], ['card-colors', 'Card colours'], ['card-layout', 'Card layout'], ['working-days', 'Working days']] as const
const LANES: [Board['swimlanes']['by'], string, string][] = [
  ['none', 'None', 'One lane for everything'], ['queries', 'Queries', 'A lane per query you write; an item goes in the first it matches'],
  ['assignee', 'Assignees', 'A lane per person'], ['epic', 'Epics', 'A lane per epic'], ['project', 'Projects', 'A lane per project'], ['priority', 'Priority', 'A lane per priority'],
]
const newId = () => crypto.randomUUID()
/** The server's message for one field (`jql`, `quickFilters.<id>`…), else the whole error when it named none. */
const fieldError = (e: unknown, field: string) => (e instanceof ApiError && e.errors ? e.errors[field] : undefined)

/** A section's save: busy while it runs; an error stays shown until the next try. */
function useSaving(save: Save) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = async (patch: Parameters<Save>[0]) => {
    setBusy(true); setError(null)
    try { await save(patch) } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return { busy, error, run, message: error ? errorMessage(error).replace(/^[\w.-]+: /, '') : '' }   // the field path is for the form, not the reader
}

function SaveRow({ dirty, busy, message, onSave, onReset }: { dirty: boolean; busy: boolean; message: string; onSave: () => void; onReset: () => void }) {
  return (
    <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
      <button className="btn btn-primary" disabled={!dirty || busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</button>
      {dirty && !busy && <button className="btn btn-ghost" onClick={onReset}>Discard changes</button>}
      {message && <span role="alert" className="text-danger">{message}</span>}
    </div>
  )
}

export default function ConfigureBoard({ project, boardId }: { project: Project; boardId: string }) {
  const { toast } = useApp()
  const { dispatch } = useStore()
  const { board, error, reload, replace } = useBoard(boardId)
  const [statuses, setStatuses] = useState<GStatus[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    api<GStatus[]>('GET', `/api/boards/${encodeURIComponent(boardId)}/statuses`).then(setStatuses, () => setStatuses([]))
  }, [boardId, board?.jql])
  useEffect(() => { if (board && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView() }, [!!board])   // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="settings"><LoadError error={error} onRetry={reload} /></div>
  if (!board) return <div className="settings"><Loading rows={5} /></div>

  const can = board.canManage
  const save: Save = async patch => {
    replace(await api<Board>('PATCH', `/api/boards/${encodeURIComponent(board.id)}`, patch))
    toast('Board saved')
  }
  const toBoard = () => navigate(href({ name: 'project', key: project.key, tab: 'board', sub: board.id }))
  return (
    <div className="board-config">
      <div className="panel-title-row" style={{ padding: '0 28px' }}>
        <div>
          <button className="btn btn-ghost" onClick={toBoard}><ArrowLeft size={15} />Back to board</button>
          <h1 className="page-title">Configure {board.name}</h1>
          <p className="muted">{board.type === 'scrum' ? 'Scrum' : 'Kanban'} board in {project.name}. {can
            ? 'Changes apply to everyone who uses this board.'
            : 'Only its administrators and the project’s admins can change it.'}</p>
        </div>
        <button className="btn btn-secondary" onClick={toBoard}><Kanban size={15} />Open board</button>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Board settings">
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} className="settings-nav-item">{label}</a>)}
          {can && <a href="#delete" className="settings-nav-item">Delete board</a>}
        </nav>
        <div className="settings">
          <General board={board} project={project} can={can} save={save} />
          <Columns board={board} statuses={statuses} can={can} save={save} />
          <Swimlanes board={board} can={can} save={save} />
          <QuickFilters board={board} can={can} save={save} />
          <CardColorsSection board={board} project={project} can={can} save={save} />
          <CardLayout board={board} can={can} save={save} />
          <WorkingDays board={board} can={can} save={save} />
          {can && (
            <section className="panel" id="delete">
              <h2 className="panel-title">Delete board</h2>
              <p className="muted">Its work items stay where they are. A project keeps at least one board, and a board with sprints not yet completed can’t be deleted.</p>
              <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={() => setDeleting(true)}><Trash2 size={14} />Delete board</button>
            </section>
          )}
        </div>
      </div>
      {deleting && (
        <ConfirmDialog title={`Delete ${board.name}?`} action="Delete board" onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api('DELETE', `/api/boards/${encodeURIComponent(board.id)}`)
            if (lastBoard.get(project.id) === board.id) localStorage.removeItem(`strand:board:${project.id}`)
            toast(`${board.name} deleted`)
            void reloadBoards(project.key, dispatch)
            navigate(href({ name: 'project', key: project.key, tab: 'board' }))
          }}>
          <p>The board goes for everyone; its work items, and completed sprints, stay in {project.name}.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

// ── General ────────────────────────────────────────────────

function General({ board, project, can, save }: { board: Board; project: Project; can: boolean; save: Save }) {
  const initial = () => ({ name: board.name, jql: board.jql, doneDays: board.doneDays, estimation: board.estimation ?? 'points', admins: board.admins })
  const [f, setF] = useState(initial)
  useEffect(() => setF(initial()), [board])   // eslint-disable-line react-hooks/exhaustive-deps
  const { checked, run } = useJqlCount(f.jql, can)
  const s = useSaving(save)
  const dirty = JSON.stringify(f) !== JSON.stringify(initial())
  const remove = (id: string) => setF({ ...f, admins: f.admins.filter(a => a.id !== id) })
  const add = (a: Board['admins'][number]) => { if (!f.admins.some(x => x.id === a.id)) setF({ ...f, admins: [...f.admins, a] }) }
  const jqlError = fieldError(s.error, 'jql') ?? checked?.error
  return (
    <section className="panel" id="general">
      <h2 className="panel-title">General</h2>
      <label className="label" htmlFor="bc-name">Name</label>
      <input id="bc-name" className="input" value={f.name} maxLength={100} disabled={!can} onChange={e => setF({ ...f, name: e.target.value })} />

      <span className="label" style={{ marginTop: 14 }}>Administrators</span>
      <p className="hint" style={{ marginTop: 0 }}>Besides {project.name}’s admins, who can always change it.</p>
      <div className="chip-list">
        {f.admins.length === 0 && <span className="muted">No one else</span>}
        {f.admins.map(a => (
          <span key={a.id} className="chip-static">{a.kind === 'group' ? `${a.name} (group)` : a.name}
            {can && <button type="button" className="chip-x" aria-label={`Remove ${a.name}`} onClick={() => remove(a.id)}>×</button>}
          </span>
        ))}
      </div>
      {can && (
        <div className="btn-row" style={{ marginTop: 8, alignItems: 'center' }}>
          <UserPicker value={undefined} title="Add a person" allowUnassigned={false} placeholder="Add a person" className="btn btn-secondary btn-sm"
            trigger={<><Plus size={13} />Add a person</>} onChange={id => id && void api<{ id: string; name: string }[]>('GET', `/api/users?ids=${id}`)
              .then(([u]) => u && add({ kind: 'user', id: u.id, name: u.name }), () => {})} />
          <GroupPicker value={null} label="Add a group" placeholder="Add a group…" exclude={f.admins.filter(a => a.kind === 'group').map(a => a.id)}
            onChange={g => g && add({ kind: 'group', id: g.id, name: g.name })} />
        </div>
      )}

      <span className="label" style={{ marginTop: 14 }}>Filter</span>
      <p className="hint" style={{ marginTop: 0 }}>Which work items the board shows: any JQL, from this project or several.</p>
      {can ? (
        <>
          <JqlBox value={f.jql} action="Check" onChange={jql => setF({ ...f, jql })} onRun={jql => { setF({ ...f, jql }); void run(jql) }} serverError={jqlError} />
          {checked?.count !== undefined && <p className="hint" role="status">{plural(checked.count, 'work item')} match{checked.count === 1 ? 'es' : ''} now.</p>}
        </>
      ) : <div className="static-field mono">{board.jql}</div>}

      {board.type === 'kanban' && (
        <label className="settings-row" style={{ marginTop: 14 }}>
          <input type="checkbox" disabled={!can} checked={f.doneDays != null} onChange={e => setF({ ...f, doneDays: e.target.checked ? 14 : null })} />
          <span>Hide Done work items not updated for</span>
          <input className="input" type="number" min={1} max={3650} style={{ width: 80 }} aria-label="Days" disabled={!can || f.doneDays == null}
            value={f.doneDays ?? 14} onChange={e => setF({ ...f, doneDays: Math.max(1, Math.min(3650, Number(e.target.value) || 1)) })} />
          <span>days</span>
        </label>
      )}
      {board.type === 'scrum' && <>
        <label className="label" htmlFor="bc-estimation" style={{ marginTop: 14 }}>Estimation</label>
        <p className="hint" style={{ marginTop: 0 }}>What the backlog totals, sprint commitment, velocity and burndown count. A sprint keeps the one it started with.</p>
        <select id="bc-estimation" className="input" style={{ width: 'auto' }} disabled={!can} value={f.estimation}
          onChange={e => setF({ ...f, estimation: e.target.value as Estimation })}>
          <option value="points">Story points</option>
          <option value="time">Original time estimate</option>
          <option value="count">Issue count</option>
        </select>
      </>}
      {can && <SaveRow dirty={dirty} busy={s.busy} message={fieldError(s.error, 'jql') ? 'Not saved: fix the filter' : s.message} onReset={() => setF(initial())}
        onSave={() => s.run({ name: f.name.trim(), jql: f.jql.trim(), doneDays: f.doneDays, ...(board.type === 'scrum' ? { estimation: f.estimation } : {}),
          admins: { userIds: f.admins.filter(a => a.kind === 'user').map(a => a.id), groupIds: f.admins.filter(a => a.kind === 'group').map(a => a.id) } })} />}
    </section>
  )
}

// ── Columns ────────────────────────────────────────────────

function Columns({ board, statuses, can, save }: { board: Board; statuses: GStatus[] | null; can: boolean; save: Save }) {
  const [cols, setCols] = useState<Column[]>(board.columns)
  useEffect(() => setCols(board.columns), [board])
  const [dragged, setDragged] = useState<string | null>(null)
  const s = useSaving(save)
  const dirty = JSON.stringify(cols) !== JSON.stringify(board.columns)
  const byId = new Map((statuses ?? []).map(x => [x.id, x]))
  const unmapped = (statuses ?? []).filter(x => !cols.some(c => c.statusIds.includes(x.id)))
  /** Put a status in a column (null: take it off the board). */
  const moveStatus = (sid: string, to: string | null) =>
    setCols(cols.map(c => ({ ...c, statusIds: c.id === to ? [...c.statusIds.filter(x => x !== sid), sid] : c.statusIds.filter(x => x !== sid) })))
  const patch = (id: string, p: Partial<Column>) => setCols(cols.map(c => (c.id === id ? { ...c, ...p } : c)))
  const shift = (i: number, by: number) => { const next = [...cols]; const [c] = next.splice(i, 1); next.splice(i + by, 0, c!); setCols(next) }
  const num = (v: string) => (v === '' ? undefined : Math.max(0, Math.floor(Number(v))))
  const drop = (to: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (dragged) e.preventDefault() },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (dragged) moveStatus(dragged, to); setDragged(null) },
  })
  const chip = (sid: string, at: string | null) => {
    const st = byId.get(sid)
    return (
      <li key={sid} className="map-status" draggable={can} onDragStart={() => setDragged(sid)} onDragEnd={() => setDragged(null)}>
        <span className={`lozenge lozenge-${st?.category ?? 'todo'}`}>{st?.name ?? 'Unknown status'}</span>
        {can && (
          <Menu title={`Move ${st?.name ?? 'status'} to…`} className="icon-btn sm" trigger={<MoveHorizontal size={13} />}
            items={[...cols.filter(c => c.id !== at).map(c => ({ label: c.name || 'Untitled column', onClick: () => moveStatus(sid, c.id) })),
              ...(at ? [{ label: 'Not on the board', onClick: () => moveStatus(sid, null), divider: true }] : [])]} />
        )}
      </li>
    )
  }
  return (
    <section className="panel" id="columns">
      <h2 className="panel-title">Columns</h2>
      <p className="muted">Map statuses to columns{can ? ' (drag them, or choose a column for each)' : ''}. A column can hold several statuses; a status in no column isn’t shown on the board. The board warns when a column holds fewer than its minimum or more than its maximum.</p>
      {can && <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => setCols([...cols, { id: newId(), name: 'New column', statusIds: [] }])}><Plus size={13} />Add column</button>}
      {!statuses ? <Loading rows={2} /> : (
        <div className="map-columns">
          {cols.map((c, i) => (
            <div key={c.id} className="map-column" {...(can ? drop(c.id) : {})} aria-label={`Column ${c.name}`}>
              <div className="map-column-hdr">
                <input className="input" value={c.name} maxLength={60} disabled={!can} aria-label="Column name" onChange={e => patch(c.id, { name: e.target.value })} />
                {can && <>
                  <button className="icon-btn sm" disabled={i === 0} aria-label={`Move ${c.name} left`} title="Move left" onClick={() => shift(i, -1)}><ArrowLeft size={13} /></button>
                  <button className="icon-btn sm" disabled={i === cols.length - 1} aria-label={`Move ${c.name} right`} title="Move right" onClick={() => shift(i, 1)}><ArrowRight size={13} /></button>
                  <button className="icon-btn sm" disabled={cols.length === 1} aria-label={`Remove ${c.name}`} title="Remove column (its statuses leave the board)" onClick={() => setCols(cols.filter(x => x.id !== c.id))}><X size={13} /></button>
                </>}
              </div>
              <div className="map-limits">
                <label>Min <input className="input" type="number" min={0} value={c.min ?? ''} disabled={!can} aria-label={`Minimum for ${c.name}`} onChange={e => patch(c.id, { min: num(e.target.value) })} /></label>
                <label>Max <input className="input" type="number" min={1} value={c.max ?? ''} disabled={!can} aria-label={`Maximum for ${c.name}`} onChange={e => patch(c.id, { max: num(e.target.value) || undefined })} /></label>
              </div>
              <ul className="map-statuses">
                {c.statusIds.map(sid => chip(sid, c.id))}
                {!c.statusIds.length && <li className="muted sm">No statuses: drop one here</li>}
              </ul>
            </div>
          ))}
          <div className="map-column map-unmapped" {...(can ? drop(null) : {})} aria-label="Statuses not on the board">
            <div className="map-column-hdr"><b>Not on the board</b></div>
            <ul className="map-statuses">
              {unmapped.map(x => chip(x.id, null))}
              {!unmapped.length && <li className="muted sm">Every status has a column</li>}
            </ul>
          </div>
        </div>
      )}
      {can && <SaveRow dirty={dirty} busy={s.busy} message={s.message} onReset={() => setCols(board.columns)}
        onSave={() => s.run({ columns: cols.map(c => ({ ...c, name: c.name.trim() || 'Untitled column' })) })} />}
    </section>
  )
}

// ── Named queries: swimlanes and quick filters ─────────────

/** An ordered list of named JQL queries; `field` is where the server reports a query's mistake (`quickFilters`, `swimlanes`). */
function QueryList({ items, onChange, can, error, field, noun }: {
  items: Named[]; onChange: (q: Named[]) => void; can: boolean; error: unknown; field: string; noun: string
}) {
  const set = (id: string, p: Partial<Named>) => onChange(items.map(q => (q.id === id ? { ...q, ...p } : q)))
  const shift = (i: number, by: number) => { const next = [...items]; const [q] = next.splice(i, 1); next.splice(i + by, 0, q!); onChange(next) }
  return (
    <div className="query-list">
      {items.map((q, i) => {
        const mistake = fieldError(error, `${field}.${q.id}`)
        return (
          <div key={q.id} className="query-row">
            <input className="input" value={q.name} maxLength={60} placeholder="Name" disabled={!can} aria-label={`${noun} name`} onChange={e => set(q.id, { name: e.target.value })} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <input className="input mono" value={q.jql} placeholder="JQL, e.g. priority = urgent" disabled={!can} aria-label={`${q.name || noun} JQL`} aria-invalid={!!mistake}
                onChange={e => set(q.id, { jql: e.target.value })} />
              {mistake && <p className="hint error" role="alert">{mistake.replace(/^JQL: /, '')}</p>}
            </div>
            {can && <>
              <button className="icon-btn sm" disabled={i === 0} aria-label={`Move ${q.name} up`} onClick={() => shift(i, -1)}><ArrowUp size={13} /></button>
              <button className="icon-btn sm" disabled={i === items.length - 1} aria-label={`Move ${q.name} down`} onClick={() => shift(i, 1)}><ArrowDown size={13} /></button>
              <button className="icon-btn sm" aria-label={`Remove ${q.name}`} onClick={() => onChange(items.filter(x => x.id !== q.id))}><X size={13} /></button>
            </>}
          </div>
        )
      })}
      {!items.length && <p className="muted">None yet.</p>}
      {can && <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, { id: newId(), name: '', jql: '' }])}><Plus size={13} />Add {noun.toLowerCase()}</button>}
    </div>
  )
}

const complete = (qs: Named[]) => qs.every(q => q.name.trim() && q.jql.trim())
/** The message under a list of queries: a missing name or query first, then a mistake the server found in one. */
const listMessage = (qs: Named[], field: string, s: { error: unknown; message: string }, noun: string) =>
  !complete(qs) ? `Every ${noun} needs a name and a query` : qs.some(q => fieldError(s.error, `${field}.${q.id}`)) ? 'Not saved: fix the query marked above' : s.message

function Swimlanes({ board, can, save }: { board: Board; can: boolean; save: Save }) {
  const [by, setBy] = useState(board.swimlanes.by)
  const [queries, setQueries] = useState<Named[]>(board.swimlanes.queries ?? [])
  useEffect(() => { setBy(board.swimlanes.by); setQueries(board.swimlanes.queries ?? []) }, [board])
  const s = useSaving(save)
  const dirty = by !== board.swimlanes.by || JSON.stringify(queries) !== JSON.stringify(board.swimlanes.queries ?? [])
  return (
    <section className="panel" id="swimlanes">
      <h2 className="panel-title">Swimlanes</h2>
      <p className="muted">How the board is divided into rows.</p>
      <div role="radiogroup" aria-label="Swimlanes by" className="lane-options">
        {LANES.map(([id, label, hint]) => (
          <label key={id} className="radio-row">
            <input type="radio" name="bc-lanes" checked={by === id} disabled={!can} onChange={() => setBy(id)} />
            <span><b>{label}</b> <span className="muted">{hint}</span></span>
          </label>
        ))}
      </div>
      {by === 'queries' && (
        <>
          <p className="hint">Items that match none go in “Everything else”, at the bottom.</p>
          <QueryList items={queries} onChange={setQueries} can={can} error={s.error} field="swimlanes" noun="Swimlane" />
        </>
      )}
      {can && <SaveRow dirty={dirty} busy={s.busy} message={by === 'queries' ? listMessage(queries, 'swimlanes', s, 'swimlane') : s.message}
        onReset={() => { setBy(board.swimlanes.by); setQueries(board.swimlanes.queries ?? []) }}
        onSave={() => complete(queries) && s.run({ swimlanes: { by, queries: queries.map(q => ({ ...q, name: q.name.trim(), jql: q.jql.trim() })) } })} />}
    </section>
  )
}

function QuickFilters({ board, can, save }: { board: Board; can: boolean; save: Save }) {
  const [items, setItems] = useState<Named[]>(board.quickFilters)
  useEffect(() => setItems(board.quickFilters), [board])
  const s = useSaving(save)
  const dirty = JSON.stringify(items) !== JSON.stringify(board.quickFilters)
  return (
    <section className="panel" id="quick-filters">
      <h2 className="panel-title">Quick filters</h2>
      <p className="muted">Buttons above the board that narrow it with a query. Several on at once all apply.</p>
      <QueryList items={items} onChange={setItems} can={can} error={s.error} field="quickFilters" noun="Quick filter" />
      {can && <SaveRow dirty={dirty} busy={s.busy} message={listMessage(items, 'quickFilters', s, 'quick filter')} onReset={() => setItems(board.quickFilters)}
        onSave={() => complete(items) && s.run({ quickFilters: items.map(q => ({ ...q, name: q.name.trim(), jql: q.jql.trim() })) })} />}
    </section>
  )
}

function CardLayout({ board, can, save }: { board: Board; can: boolean; save: Save }) {
  const fields = { ...DEFAULT_FIELDS, ...board.cardFields }
  const s = useSaving(save)
  return (
    <section className="panel" id="card-layout">
      <h2 className="panel-title">Card layout</h2>
      <p className="muted">What each card shows besides its summary. Changes are saved at once.</p>
      <div className="card-fields">
        {FIELD_LABELS.map(([f, label]) => (
          <label key={f} className="toggle-row">
            <span>{label}</span>
            {can ? <Toggle on={fields[f]} label={label} onChange={on => s.run({ cardFields: { ...board.cardFields, [f]: on } })} />
              : <span className="muted">{fields[f] ? 'Shown' : 'Hidden'}</span>}
          </label>
        ))}
      </div>
      {s.message && <p role="alert" className="text-danger">{s.message}</p>}
    </section>
  )
}

// ── Card colours ───────────────────────────────────────────

const COLOR_BY: [CardColors['by'], string][] = [['none', 'None'], ['types', 'Work types'], ['priorities', 'Priorities'], ['assignees', 'Assignees'], ['queries', 'Queries']]

/** Jira's card colours (spec 0409): a stripe on each card's left edge, by work type, priority, assignee or the first JQL
 *  query a card matches. Each method keeps its own colours when another is chosen. */
function CardColorsSection({ board, project, can, save }: { board: Board; project: Project; can: boolean; save: Save }) {
  const { state } = useStore()
  const initial = (): CardColors => board.cardColors ?? { by: 'none' }
  const [f, setF] = useState<CardColors>(initial)
  useEffect(() => setF(initial()), [board])   // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSaving(save)
  const dirty = JSON.stringify(f) !== JSON.stringify(initial())
  const setIn = (k: 'types' | 'priorities' | 'assignees', key: string, color: string) => setF({ ...f, [k]: { ...f[k], [key]: color } })
  const swatch = (k: 'types' | 'priorities' | 'assignees', key: string, label: string, fallback: string) => (
    <label key={key} className="settings-row">
      <input type="color" aria-label={`${label} colour`} disabled={!can} value={f[k]?.[key] ?? fallback} onChange={e => setIn(k, key, e.target.value)} />
      <span>{label}</span>
    </label>
  )
  const queries = f.queries ?? []
  return (
    <section className="panel" id="card-colors">
      <h2 className="panel-title">Card colours</h2>
      <p className="muted">A stripe on the left edge of each card, on the board and in the backlog.</p>
      <label className="label" htmlFor="bc-color-by">Colours based on</label>
      <select id="bc-color-by" className="input" style={{ width: 'auto' }} disabled={!can} value={f.by} onChange={e => setF({ ...f, by: e.target.value as CardColors['by'] })}>
        {COLOR_BY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <div style={{ marginTop: 12 }}>
        {f.by === 'types' && typeList(project).map(t => swatch('types', t.key, t.name, t.color))}
        {f.by === 'priorities' && priorityList().map(p => swatch('priorities', p.key, p.name, p.color))}
        {f.by === 'assignees' && <>
          {Object.keys(f.assignees ?? {}).map(id => swatch('assignees', id, userOf(state, id)?.name ?? 'Someone', '#2563EB'))}
          {can && <UserPicker value={undefined} title="Add a person" allowUnassigned={false} placeholder="Add a person" className="btn btn-secondary btn-sm"
            trigger={<><Plus size={13} />Add a person</>} onChange={id => id && setIn('assignees', id, '#2563EB')} />}
        </>}
        {f.by === 'queries' && <>
          {queries.map((q, n) => (
            <div key={q.id || n} className="btn-row" style={{ alignItems: 'center', marginBottom: 6 }}>
              <input type="color" aria-label={`Query ${n + 1} colour`} disabled={!can} value={q.color} onChange={e => setF({ ...f, queries: queries.map((x, k) => k === n ? { ...x, color: e.target.value } : x) })} />
              <input className="input mono" style={{ flex: 1 }} aria-label={`Query ${n + 1}`} disabled={!can} value={q.jql} placeholder="priority = High"
                onChange={e => setF({ ...f, queries: queries.map((x, k) => k === n ? { ...x, jql: e.target.value } : x) })} />
              {can && <button type="button" className="icon-btn sm" aria-label={`Move query ${n + 1} up`} disabled={n === 0}
                onClick={() => setF({ ...f, queries: queries.map((x, k) => k === n - 1 ? queries[n]! : k === n ? queries[n - 1]! : x) })}><ArrowUp size={13} /></button>}
              {can && <button type="button" className="icon-btn sm" aria-label={`Remove query ${n + 1}`} onClick={() => setF({ ...f, queries: queries.filter((_, k) => k !== n) })}><X size={13} /></button>}
            </div>
          ))}
          {can && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setF({ ...f, queries: [...queries, { id: '', jql: '', color: '#2563EB' }] })}><Plus size={13} />Add query</button>}
          <p className="hint">A card takes the colour of the first query it matches; others are grey.</p>
        </>}
      </div>
      {can && <SaveRow dirty={dirty} busy={s.busy} message={s.message} onReset={() => setF(initial())}
        onSave={() => s.run({ cardColors: { ...f, ...(f.queries ? { queries: f.queries.filter(q => q.jql.trim()).map(q => ({ ...q, jql: q.jql.trim() })) } : {}) } })} />}
    </section>
  )
}

// ── The project's boards (Project settings, and /project/KEY/boards) ──

export function BoardsPanel({ project }: { project: Project }) {
  const { dispatch } = useStore()
  const [version, setVersion] = useState(0)
  const [creating, setCreating] = useState(false)
  const boards = useBoards(project, version)
  return (
    <section className="panel" id="boards">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Boards</h2>
          <p className="muted">{plural(boards.length, 'board')}. Each shows the work items its filter finds, from this project or several, with its own columns, swimlanes and quick filters.</p>
        </div>
        {canAdmin(project) && <button className="btn btn-secondary" onClick={() => setCreating(true)}><Plus size={14} />Create board</button>}
      </div>
      <table className="table">
        <thead><tr><th>Board</th><th>Type</th><th>Filter</th><th /></tr></thead>
        <tbody>
          {boards.map(b => (
            <tr key={b.id}>
              <td><a href={href({ name: 'project', key: project.key, tab: 'board', sub: b.id })} onClick={e => { e.preventDefault(); navigate(href({ name: 'project', key: project.key, tab: 'board', sub: b.id })) }}>{b.name}</a></td>
              <td className="muted">{b.type === 'scrum' ? 'Scrum' : 'Kanban'}</td>
              <td className="mono muted sm">{b.jql}</td>
              <td style={{ textAlign: 'right' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate(href({ name: 'project', key: project.key, tab: 'boards', sub: b.id }))}>{b.canManage ? 'Configure' : 'View settings'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && <CreateBoard project={project} onClose={() => setCreating(false)}
        onCreated={b => { setCreating(false); setVersion(v => v + 1); void reloadBoards(project.key, dispatch); navigate(href({ name: 'project', key: project.key, tab: 'board', sub: b.id })) }} />}
    </section>
  )
}

// ── Working days ───────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Jira's working days (spec 0405): the team's working weekdays and days off; the burndown's guideline falls only on working days. */
function WorkingDays({ board, can, save }: { board: Board; can: boolean; save: Save }) {
  const initial = () => board.workingDays ?? { weekdays: [1, 2, 3, 4, 5], nonWorking: [] }
  const [f, setF] = useState(initial)
  const [date, setDate] = useState('')
  useEffect(() => setF(initial()), [board])   // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSaving(save)
  const dirty = JSON.stringify(f) !== JSON.stringify(initial())
  const toggle = (d: number) => setF({ ...f, weekdays: f.weekdays.includes(d) ? f.weekdays.filter(x => x !== d) : [...f.weekdays, d].sort() })
  return (
    <section className="panel" id="working-days">
      <h2 className="panel-title">Working days</h2>
      <p className="muted">The days the team works. The burndown’s guideline only falls on working days.</p>
      <span className="label">Standard working days</span>
      <div className="btn-row" style={{ flexWrap: 'wrap' }}>
        {[1, 2, 3, 4, 5, 6, 0].map(d => (
          <label key={d} className="cell-flex"><input type="checkbox" disabled={!can} checked={f.weekdays.includes(d)} onChange={() => toggle(d)} />{WEEKDAYS[d]}</label>
        ))}
      </div>
      <span className="label" style={{ marginTop: 14 }}>Non-working days</span>
      <div className="chip-list">
        {f.nonWorking.length === 0 && <span className="muted">None</span>}
        {f.nonWorking.map(d => (
          <span key={d} className="chip-static">{d}
            {can && <button type="button" className="chip-x" aria-label={`Remove ${d}`} onClick={() => setF({ ...f, nonWorking: f.nonWorking.filter(x => x !== d) })}>×</button>}
          </span>
        ))}
      </div>
      {can && <div className="btn-row" style={{ marginTop: 8 }}>
        <input type="date" className="input" aria-label="Non-working day" value={date} onChange={e => setDate(e.target.value)} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!date || f.nonWorking.includes(date)}
          onClick={() => { setF({ ...f, nonWorking: [...f.nonWorking, date].sort() }); setDate('') }}><Plus size={13} />Add date</button>
      </div>}
      {can && <SaveRow dirty={dirty} busy={s.busy} message={f.weekdays.length ? s.message : 'Choose at least one working day'} onReset={() => setF(initial())}
        onSave={() => { if (f.weekdays.length) void s.run({ workingDays: f }) }} />}
    </section>
  )
}
