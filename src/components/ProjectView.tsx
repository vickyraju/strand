import { useState } from 'react'
import {
  Plus, Star, FolderPlus, Columns2, List, ListChecks, Settings, ChevronDown, ChevronRight,
  ArrowUp, ArrowDown, Trash2, Check,
} from 'lucide-react'
import { useStore, userOf, uid, PROJECT_COLORS, type Project, type ProjectPatch, type Status } from '../data/store'
import { useApp, type ProjectTab } from '../appContext'
import BoardView, { useIssueFilter } from './BoardView'
import BacklogView from './BacklogView'
import IssueRow from './IssueRow'
import { Avatar, Empty, Picker, userOptions } from './ui'

// ── Shared bits ────────────────────────────────────────────

export function ProjectIcon({ project, size = 16 }: { project: Project; size?: number }) {
  return (
    <span className="proj-icon" style={{ background: project.color, width: size, height: size, fontSize: size * 0.55 }}>
      {project.name[0]?.toUpperCase()}
    </span>
  )
}

export function StarButton({ projectId }: { projectId: string }) {
  const { state, dispatch } = useStore()
  const on = state.starred.includes(projectId)
  return (
    <button
      className={`proj-star${on ? ' on' : ''}`}
      onClick={e => { e.stopPropagation(); dispatch({ type: 'toggleStar', projectId }) }}
      aria-pressed={on}
      title={on ? 'Remove from starred' : 'Add to starred'}
    >
      <Star size={14} strokeWidth={1.5} fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}

// ── All projects ───────────────────────────────────────────

export function ProjectsView({ onCreate }: { onCreate: () => void }) {
  const { state } = useStore()
  const { openProject } = useApp()

  return (
    <div className="pv-root">
      <div className="pv-header">
        <h1 className="pv-title">Projects</h1>
        <div style={{ flex: 1 }} />
        {state.projects.length > 0 && (
          <button className="btn-primary" onClick={onCreate}><Plus size={14} strokeWidth={2} />Create project</button>
        )}
      </div>

      {state.projects.length === 0 ? (
        <Empty
          icon={<FolderPlus size={20} strokeWidth={1.5} />}
          title="Create your first project"
          body="Projects hold your team's work items, board and backlog. Start with one and invite your team later."
          action={<button className="btn-primary" onClick={onCreate}><Plus size={14} strokeWidth={2} />Create project</button>}
        />
      ) : (
        <table className="pv-table">
          <thead>
            <tr>
              <th style={{ width: 36 }} aria-label="Starred" />
              <th>Name</th>
              <th style={{ width: 100 }}>Key</th>
              <th style={{ width: 100 }}>Type</th>
              <th style={{ width: 110 }}>Open items</th>
              <th style={{ width: 180 }}>Lead</th>
            </tr>
          </thead>
          <tbody>
            {state.projects.map(p => {
              const lead = userOf(state, p.leadId)
              const open = state.issues.filter(i => i.projectId === p.id && !p.statuses.find(s => s.id === i.status)?.done).length
              return (
                <tr key={p.id} onClick={() => openProject(p.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && openProject(p.id)}>
                  <td><StarButton projectId={p.id} /></td>
                  <td><span className="pv-name"><ProjectIcon project={p} size={20} />{p.name}</span></td>
                  <td className="pv-key">{p.key}</td>
                  <td>{p.template === 'scrum' ? 'Scrum' : 'Kanban'}</td>
                  <td>{open}</td>
                  <td>{lead && <span className="pv-lead"><Avatar user={lead} />{lead.name}</span>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Single project ─────────────────────────────────────────

export function ProjectView({ project, tab }: { project: Project; tab: ProjectTab }) {
  const { openProject, createIssue } = useApp()
  const tabs: { id: ProjectTab; label: string; Icon: typeof List }[] = [
    ...(project.template === 'scrum' ? [{ id: 'backlog' as const, label: 'Backlog', Icon: ListChecks }] : []),
    { id: 'board',    label: 'Board',    Icon: Columns2 },
    { id: 'list',     label: 'List',     Icon: List     },
    { id: 'settings', label: 'Settings', Icon: Settings },
  ]

  return (
    <div className="pv-root" style={{ overflow: 'hidden' }}>
      <div className="pv-header" style={{ paddingBottom: 0 }}>
        <ProjectIcon project={project} size={24} />
        <h1 className="pv-title">{project.name}</h1>
        <StarButton projectId={project.id} />
        <div style={{ flex: 1 }} />
        <button className="btn-secondary" onClick={() => createIssue({ projectId: project.id })}>
          <Plus size={14} strokeWidth={2} />Work item
        </button>
      </div>

      <div className="yw-tabs pv-tabs" role="tablist">
        {tabs.map(({ id, label, Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`yw-tab${tab === id ? ' active' : ''}`} onClick={() => openProject(project.id, id)}>
            <Icon size={13} strokeWidth={1.5} />{label}
          </button>
        ))}
      </div>

      {tab === 'board'    && <BoardView project={project} />}
      {tab === 'list'     && <ListTab project={project} />}
      {tab === 'backlog'  && <BacklogView project={project} />}
      {tab === 'settings' && <ProjectSettings project={project} />}
    </div>
  )
}

// ── List tab: every item, grouped by status ────────────────

function ListTab({ project }: { project: Project }) {
  const { state } = useStore()
  const { createIssue } = useApp()
  const { apply, toolbar } = useIssueFilter()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const all = state.issues.filter(i => i.projectId === project.id)
  if (all.length === 0) {
    return (
      <Empty
        icon={<List size={20} strokeWidth={1.5} />}
        title="No work items yet"
        body={`Work items you create in ${project.name} are listed here as ${project.key}-1, ${project.key}-2 and so on.`}
        action={<button className="btn-primary" onClick={() => createIssue({ projectId: project.id })}><Plus size={14} strokeWidth={2} />Create work item</button>}
      />
    )
  }
  const issues = apply(all)

  const toggle = (id: string) => setCollapsed(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="bv-toolbar">{toolbar}</div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {project.statuses.map(s => {
          const rows = issues.filter(i => i.status === s.id).sort((a, b) => b.updatedAt - a.updatedAt)
          const isCollapsed = collapsed.has(s.id)
          return (
            <section key={s.id}>
              <div className="ir-group">
                <button className="ir-group-toggle" onClick={() => toggle(s.id)} aria-expanded={!isCollapsed}>
                  {isCollapsed ? <ChevronRight size={13} strokeWidth={1.75} /> : <ChevronDown size={13} strokeWidth={1.75} />}
                  <span className="status-dot" style={{ background: s.color }} />
                  {s.name}
                  <span className="ir-group-count">{rows.length}</span>
                </button>
                <div style={{ flex: 1 }} />
                <button className="col-hdr-btn" title={`Create in ${s.name}`} onClick={() => createIssue({ projectId: project.id, status: s.id })}>
                  <Plus size={13} strokeWidth={2} />
                </button>
              </div>
              {!isCollapsed && rows.map(i => <IssueRow key={i.id} issue={i} project={project} />)}
            </section>
          )
        })}
      </div>
    </div>
  )
}

// ── Settings tab ───────────────────────────────────────────

function ProjectSettings({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [confirmDelete, setConfirmDelete] = useState('')
  const [newStatus, setNewStatus] = useState('')

  const update = (patch: ProjectPatch) =>
    dispatch({ type: 'updateProject', id: project.id, patch })
  const setStatuses = (statuses: Status[]) => update({ statuses })
  const used = (id: string) => state.issues.some(i => i.projectId === project.id && i.status === id)
  const lead = userOf(state, project.leadId)

  const move = (index: number, dir: -1 | 1) => {
    const next = [...project.statuses]
    ;[next[index], next[index + dir]] = [next[index + dir], next[index]]
    setStatuses(next)
  }

  return (
    <div className="ps-root">
      <section className="ps-section">
        <h2 className="ps-h">Details</h2>
        <label className="form-lbl" htmlFor="ps-name">Name</label>
        <input id="ps-name" className="form-input" value={name} onChange={e => setName(e.target.value)}
          onBlur={() => name.trim() ? update({ name: name.trim() }) : setName(project.name)} />
        <label className="form-lbl" htmlFor="ps-desc" style={{ marginTop: 14 }}>Description</label>
        <textarea id="ps-desc" className="form-input" rows={3} value={description} onChange={e => setDescription(e.target.value)}
          onBlur={() => update({ description: description.trim() })} placeholder="What is this project for?" />
        <div style={{ display: 'flex', gap: 32, marginTop: 14 }}>
          <div>
            <span className="form-lbl">Key</span>
            <span className="pv-key">{project.key}</span>
          </div>
          <div>
            <span className="form-lbl">Lead</span>
            <Picker value={project.leadId as string | undefined} options={userOptions(state.users).slice(1)}
              onChange={id => id && update({ leadId: id })} title="Project lead"
              trigger={<><Avatar user={lead} size={16} />{lead?.name}</>} />
          </div>
          <div>
            <span className="form-lbl">Color</span>
            <div className="cp-colors">
              {PROJECT_COLORS.map(c => (
                <button key={c} type="button" aria-label={c} aria-pressed={project.color === c} className="cp-swatch" style={{ background: c, width: 20, height: 20 }}
                  onClick={() => update({ color: c })}>
                  {project.color === c && <Check size={11} strokeWidth={2.5} color="#FFFFFF" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="ps-section">
        <h2 className="ps-h">Workflow</h2>
        <p className="ps-sub">Statuses are the columns on your board, in order. Items in a “done” status count as finished.</p>
        <div className="ps-statuses">
          {project.statuses.map((s, i) => (
            <div key={s.id} className="ps-status">
              <input type="color" className="ps-color" value={s.color} aria-label={`${s.name} color`}
                onChange={e => setStatuses(project.statuses.map(x => x.id === s.id ? { ...x, color: e.target.value } : x))} />
              <input className="form-input ps-status-name" defaultValue={s.name} aria-label="Status name"
                onBlur={e => e.target.value.trim() && setStatuses(project.statuses.map(x => x.id === s.id ? { ...x, name: e.target.value.trim() } : x))} />
              <label className="ps-done">
                <input type="checkbox" checked={!!s.done}
                  onChange={e => setStatuses(project.statuses.map(x => x.id === s.id ? { ...x, done: e.target.checked } : x))} />
                Done
              </label>
              <button className="col-hdr-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={13} /></button>
              <button className="col-hdr-btn" disabled={i === project.statuses.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={13} /></button>
              <button className="col-hdr-btn" disabled={project.statuses.length <= 1 || used(s.id)}
                title={used(s.id) ? 'Move its work items to another status first' : 'Delete status'}
                onClick={() => setStatuses(project.statuses.filter(x => x.id !== s.id))} aria-label="Delete status">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <form className="ps-add" onSubmit={e => {
          e.preventDefault()
          if (!newStatus.trim()) return
          setStatuses([...project.statuses, { id: uid(), name: newStatus.trim(), color: '#78716C' }])
          setNewStatus('')
        }}>
          <input className="form-input" value={newStatus} onChange={e => setNewStatus(e.target.value)} placeholder="New status, e.g. Blocked" />
          <button className="btn-secondary" type="submit" disabled={!newStatus.trim()}><Plus size={13} />Add status</button>
        </form>
      </section>

      <section className="ps-section ps-danger">
        <h2 className="ps-h">Delete project</h2>
        <p className="ps-sub">This permanently deletes {project.name} and all its work items, sprints and comments. Type <b>{project.key}</b> to confirm.</p>
        <div className="ps-add">
          <input className="form-input" value={confirmDelete} onChange={e => setConfirmDelete(e.target.value.toUpperCase())} aria-label="Type the project key to confirm" />
          <button className="btn-danger" disabled={confirmDelete !== project.key} onClick={() => dispatch({ type: 'deleteProject', id: project.id })}>
            Delete project
          </button>
        </div>
      </section>
    </div>
  )
}
