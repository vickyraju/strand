import { lazy, Suspense, useEffect, useState } from 'react'
import WorkTypesPanel from './WorkTypesPanel'
import ComponentsPanel from './ComponentsPanel'
import SecurityLevelsPanel from './SecurityLevelsPanel'
import TestingPanel from './testing/TestingPanel'
import { WorkflowPanel } from './ProjectWorkflow'
const TestRepository = lazy(() => import('./testing/TestRepository'))
import { Plus, Star, FolderPlus, Columns2, List, ListChecks, Settings, Gauge, BarChart3, GanttChart, CalendarDays, Rocket, Check, Info, Zap, Users, FlaskConical, Archive } from 'lucide-react'
import { useStore, userOf, isDone, timeAgo, PROJECT_COLORS, type Project, type ProjectPatch } from '../data/store'
import { plansInBacklog } from '../data/reducer'
import { useApp } from '../appContext'
import { can, canAdmin, isGlobalAdmin } from '../data/access'
import { navigate, href, type ProjectTab } from '../router'
import { api, apiEnabled, errorMessage } from '../api/client'
import { useProjectEvents } from '../api/presence'
import BoardView from './BoardView'
import DeletedItems from './DeletedItems'
import ConfigureBoard, { BoardsPanel } from './boards/ConfigureBoard'
import BacklogView from './BacklogView'
import IssueTable, { type TableGroup } from './IssueTable'
import SummaryView from './SummaryView'
import { FieldsPanel } from './CustomFields'
import { TemplatesPanel, ImportPanel } from './TemplatesImport'
import { useFilters } from './filters'
import { Avatar, ConfirmDialog, Empty, Modal, plural } from './ui'
import { loadProjectByKey } from '../api/load'
import { imageUrl } from '../api/look'
import { UserPicker } from './UserPicker'

// Screens most people don't open first load on demand to keep the first page fast
const ReportsView     = lazy(() => import('./ReportsView'))
const TimelineView    = lazy(() => import('./TimelineView'))
const CalendarView    = lazy(() => import('./CalendarView'))
const ReleasesView    = lazy(() => import('./ReleasesView'))
const ProjectWorkflow = lazy(() => import('./ProjectWorkflow'))
const AutomationView  = lazy(() => import('./AutomationView'))
const ProjectPeople   = lazy(() => import('./ProjectPeople'))

export const TAB_LABEL: Record<ProjectTab, string> = {
  summary: 'Summary', backlog: 'Backlog', board: 'Board', boards: 'Boards', list: 'List', timeline: 'Timeline', calendar: 'Calendar', releases: 'Releases', reports: 'Reports', tests: 'Tests', settings: 'Settings',
}

// ── Shared bits ────────────────────────────────────────────

export function ProjectIcon({ project, size = 16 }: { project: Pick<Project, 'name' | 'color'> & { avatar?: string | null }; size?: number }) {
  const src = imageUrl(project.avatar ?? null)                                          // its avatar (spec 0703)
  if (src) return <img className="proj-icon proj-avatar" src={src} alt="" width={size} height={size} style={{ borderRadius: Math.max(3, size / 5) }} />
  return (
    <span className="proj-icon" style={{ background: project.color, width: size, height: size, fontSize: size * 0.5, borderRadius: Math.max(3, size / 5) }} aria-hidden>
      {project.name[0]?.toUpperCase()}
    </span>
  )
}

export function StarButton({ projectId }: { projectId: string }) {
  const { state, dispatch } = useStore()
  const on = state.starred.includes(projectId)
  return (
    <button className={`icon-btn star${on ? ' on' : ''}`} onClick={e => { e.stopPropagation(); dispatch({ type: 'toggleStar', projectId }) }}
      aria-pressed={on} title={on ? 'Remove from starred' : 'Add to starred'} aria-label={on ? 'Remove from starred' : 'Add to starred'}>
      <Star size={15} strokeWidth={1.75} fill={on ? 'currentColor' : 'none'} />
    </button>
  )
}


// ── All projects ───────────────────────────────────────────

/** Search every project in the workspace on the server (the screen below lists only the ones loaded: starred and recent). */
function RemoteProjectSearch() {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')                                    // a category id, 'none', or '' for any (spec 0703)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { api<{ id: string; name: string }[]>('GET', '/api/project-categories').then(setCategories, () => {}) }, [])
  const [rows, setRows] = useState<{ id: string; key: string; name: string; template: string; openCount: number; color: string; avatar?: string | null; category?: { id: string; name: string } | null }[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const term = q.trim()

  const url = (cursor?: string) =>
    `/api/projects/search?query=${encodeURIComponent(term)}&limit=20${category ? `&category=${category}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`

  useEffect(() => {
    if (!term && !category) { setRows([]); setNext(null); setStatus('idle'); return }
    let cancelled = false
    setStatus('loading')
    const t = window.setTimeout(() => {   // wait for a pause in typing
      api<{ items: typeof rows; next: string | null }>('GET', url()).then(
        r => { if (!cancelled) { setRows(r.items); setNext(r.next); setStatus('idle') } },
        () => { if (!cancelled) setStatus('error') },
      )
    }, 300)
    return () => { cancelled = true; window.clearTimeout(t) }
  }, [term, category]) // eslint-disable-line react-hooks/exhaustive-deps

  const more = () => {
    if (!next) return
    setStatus('loading')
    api<{ items: typeof rows; next: string | null }>('GET', url(next)).then(
      r => { setRows(prev => [...prev, ...r.items]); setNext(r.next); setStatus('idle') }, () => setStatus('error'))
  }

  return (
    <div style={{ margin: '0 28px 20px' }}>   {/* same side margin as the tables below it */}
      <div className="form-row" style={{ alignItems: 'center' }}>
        <input className="input" style={{ flex: 1, maxWidth: 420 }} type="search" aria-label="Search all projects" placeholder="Search all projects by name or key…"
          value={q} onChange={e => setQ(e.target.value)} />
        {categories.length > 0 && <select className="input" style={{ width: 'auto' }} aria-label="Category" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">Any category</option><option value="none">No category</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>}
      </div>
      {(term || category) && (
        <div className="card-table" style={{ marginTop: 10, marginInline: 0 }} role="region" aria-label="Project search results" aria-live="polite">
          {status === 'error' ? <p className="muted" style={{ padding: 14 }}>Could not search. Try again.</p>
            : rows.length === 0 && status === 'loading' ? <p className="muted" style={{ padding: 14 }}>Searching…</p>
            : rows.length === 0 ? <p className="muted" style={{ padding: 14 }}>No projects match.</p>
            : (
              <table className="table">
                <thead><tr><th>Name</th><th style={{ width: 90 }}>Key</th><th style={{ width: 160 }}>Category</th><th style={{ width: 100 }}>Type</th><th style={{ width: 120 }}>Open items</th></tr></thead>
                <tbody>
                  {rows.map(p => (
                    <tr key={p.id} tabIndex={0} onClick={() => navigate(href({ name: 'project', key: p.key }))} onKeyDown={e => e.key === 'Enter' && navigate(href({ name: 'project', key: p.key }))}>
                      <td><span className="cell-flex strong"><ProjectIcon project={p} size={20} />{p.name}</span></td>
                      <td className="mono">{p.key}</td>
                      <td className="muted">{p.category?.name ?? ''}</td>
                      <td>{p.template === 'scrum' ? 'Scrum' : 'Kanban'}</td>
                      <td className="muted">{p.openCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {next && <div style={{ padding: 10 }}><button className="btn btn-secondary btn-sm" onClick={more} disabled={status === 'loading'}>Load more</button></div>}
        </div>
      )}
    </div>
  )
}

export function ProjectsView({ onCreate }: { onCreate: () => void }) {
  const { state } = useStore()
  const { openProject } = useApp()

  return (
    <div className="page">
      <div className="page-hdr">
        <h1 className="page-title">Projects</h1>
        <div style={{ flex: 1 }} />
        {(state.projects.length > 0 || apiEnabled) && <button className="btn btn-primary" onClick={onCreate}><Plus size={15} />Create project</button>}
      </div>

      {apiEnabled && <RemoteProjectSearch />}
      {apiEnabled && <p className="muted sm" style={{ margin: '0 28px 8px' }}>Showing your starred and recently opened projects. Search above to find any other project.</p>}

      {state.projects.length === 0 && apiEnabled ? (
        <p className="muted">No starred or recent projects yet. Search for one above, or create a new project.</p>
      ) : state.projects.length === 0 ? (
        <Empty
          icon={<FolderPlus size={22} strokeWidth={1.5} />}
          title="Create your first project"
          body={apiEnabled ? 'Projects hold your team’s work items, board, backlog and reports. Start with one.' : 'Projects hold your team’s work items, board, backlog and reports. Start with one, or explore a sample workspace first.'}
          action={<><button className="btn btn-primary" onClick={onCreate}><Plus size={15} />Create project</button></>}
        />
      ) : (
        <div className="card-table">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 44 }}><span className="sr-only">Starred</span></th>
                <th>Name</th>
                <th style={{ width: 90 }}>Key</th>
                <th style={{ width: 140 }}>Category</th>
                <th style={{ width: 100 }}>Type</th>
                <th style={{ width: 200 }}>Progress</th>
                <th style={{ width: 190 }}>Lead</th>
                <th style={{ width: 110 }}>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {state.projects.map(p => {
                const lead = userOf(state, p.leadId)
                const items = state.issues.filter(i => i.projectId === p.id && i.type !== 'epic')
                const done = items.filter(i => isDone(p, i)).length
                const last = Math.max(p.createdAt, ...items.map(i => i.updatedAt))
                return (
                  <tr key={p.id} tabIndex={0} onClick={() => openProject(p.id)} onKeyDown={e => e.key === 'Enter' && openProject(p.id)}>
                    <td><StarButton projectId={p.id} /></td>
                    <td><span className="cell-flex strong"><ProjectIcon project={p} size={24} />{p.name}</span></td>
                    <td className="mono">{p.key}</td>
                    <td className="muted">{p.category?.name ?? ''}</td>
                    <td>{p.template === 'scrum' ? 'Scrum' : 'Kanban'}</td>
                    <td>
                      <span className="cell-flex">
                        <span className="progress"><span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} /></span>
                        <span className="muted sm">{done}/{items.length}</span>
                      </span>
                    </td>
                    <td>{lead && <span className="cell-flex"><Avatar user={lead} size={22} />{lead.name}</span>}</td>
                    <td className="muted">{timeAgo(last)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Single project ─────────────────────────────────────────

/** An archived project (spec 0102): nothing of it shows, as in Jira; a system administrator can restore it here. */
function ArchivedProject({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [restoring, setRestoring] = useState(false)
  return (
    <>
      <Empty icon={<Archive size={22} strokeWidth={1.5} />} title={`${project.key} is archived`}
        body={`${project.name} is read-only and hidden from lists, search and boards. Its work items still open from links.`}
        action={isGlobalAdmin(state) ? <button className="btn btn-primary" onClick={() => setRestoring(true)}>Restore project</button> : undefined} />
      {restoring && (
        <ConfirmDialog title={`Restore ${project.name}?`} action="Restore project" danger={false} onClose={() => setRestoring(false)}
          onConfirm={async () => {
            await api('POST', `/api/projects/${encodeURIComponent(project.key)}/restore`)
            const { project: p, sprints } = await loadProjectByKey(project.key)
            dispatch({ type: 'loadProject', project: p, sprints })
            toast(`${project.name} restored`)
          }}>
          <p>It comes back as it was: in project lists, search and boards, and its members can change its work again.</p>
        </ConfirmDialog>
      )}
    </>
  )
}

export function ProjectView({ project, tab, sub, quick }: { project: Project; tab: ProjectTab; sub?: string; quick?: string }) {
  useProjectEvents(project.id, project.key, apiEnabled, true)   // other people's changes appear here as they happen
  const { state } = useStore()
  const { openProject } = useApp()
  // a Scrum project, or one with a Scrum board, has a backlog
  const scrum = project.template === 'scrum' || !!project.boards?.some(plansInBacklog)   // a Backlog tab: Scrum boards, Kanban boards with a backlog
  const tabs: { id: ProjectTab; Icon: typeof List }[] = [
    { id: 'summary', Icon: Gauge },
    ...(scrum ? [{ id: 'backlog' as const, Icon: ListChecks }] : []),
    { id: 'board',    Icon: Columns2 },
    { id: 'list',     Icon: List },
    { id: 'timeline', Icon: GanttChart },
    { id: 'calendar', Icon: CalendarDays },
    { id: 'releases', Icon: Rocket },
    { id: 'reports',  Icon: BarChart3 },
    ...(project.testing ? [{ id: 'tests' as const, Icon: FlaskConical }] : []),
    { id: 'settings', Icon: Settings },
  ]
  const members = [...new Set([project.leadId, ...state.issues.filter(i => i.projectId === project.id).map(i => i.assigneeId)])]
    .map(id => userOf(state, id)).filter(u => !!u)

  return (
    <div className="page-col">
      <div className="project-hdr">
        <ProjectIcon project={project} size={32} />
        <div className="project-hdr-text">
          <div className="project-hdr-row">
            <h1 className="page-title">{project.name}</h1>
            <StarButton projectId={project.id} />
          </div>
          {project.description && <p className="project-desc" title={project.description}>{project.description}</p>}
        </div>
        <div style={{ flex: 1 }} />
        <div className="avatar-group" aria-label={`${members.length} members`}>
          {members.slice(0, 5).map(u => <Avatar key={u.id} user={u} size={28} />)}
          {members.length > 5 && <span className="avatar avatar-more" style={{ width: 28, height: 28 }}>+{members.length - 5}</span>}
        </div>
      </div>

      {project.archivedAt ? <ArchivedProject project={project} /> : <>
      <div className="tabs" role="tablist" aria-label={`${project.name} views`}>
        {tabs.map(({ id, Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id || (tab === 'boards' && id === 'board')} className={`tab${tab === id || (tab === 'boards' && id === 'board') ? ' active' : ''}`} onClick={() => openProject(project.id, id)}>
            <Icon size={15} strokeWidth={1.75} />{TAB_LABEL[id]}
          </button>
        ))}
      </div>

      <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
      {tab === 'summary'  && <SummaryView project={project} />}
      {tab === 'board'    && <BoardView project={project} sub={sub} quick={quick} />}
      {tab === 'boards'   && (sub ? <ConfigureBoard key={sub} project={project} boardId={sub} /> : <div className="settings"><BoardsPanel project={project} /></div>)}
      {tab === 'backlog'  && (scrum ? <BacklogView project={project} sub={sub} /> : <Empty icon={<ListChecks size={22} />} title="No backlog" body="Scrum boards have a backlog. A Kanban board gets one when a board admin puts statuses in its Kanban backlog column (Configure board › Columns)." />)}
      {tab === 'list'     && <ListTab project={project} />}
      {tab === 'timeline' && <TimelineView project={project} />}
      {tab === 'calendar' && <CalendarView project={project} />}
      {tab === 'releases' && <ReleasesView project={project} releaseId={sub} />}
      {tab === 'reports'  && <ReportsView project={project} report={sub} />}
      {tab === 'tests'    && (project.testing ? <TestRepository project={project} /> : <Empty icon={<FlaskConical size={22} />} title="Testing is off" body="A project admin can turn it on in Project settings › Testing." />)}
      {tab === 'settings' && (sub === 'workflow' ? <ProjectWorkflow project={project} /> : !canAdmin(project) ? <ProjectPeople project={project} /> : sub === 'automation' ? <AutomationView project={project} /> : sub === 'people' ? <ProjectPeople project={project} /> : <ProjectSettings project={project} />)}
      </Suspense>
      </>}
    </div>
  )
}

// ── List tab ───────────────────────────────────────────────

function ListTab({ project }: { project: Project }) {
  const { state } = useStore()
  const { createIssue } = useApp()
  const [groupBy, setGroupBy] = useState<TableGroup>(() => (localStorage.getItem(`forge:list-group:${project.id}`) as TableGroup) ?? 'status')
  const all = state.issues.filter(i => i.projectId === project.id)
  const people = [...new Set(all.map(i => i.assigneeId).filter((x): x is string => !!x))].map(id => userOf(state, id)!).filter(Boolean)
  const filters = useFilters(people, project)

  if (all.length === 0) {
    return (
      <Empty
        icon={<List size={22} strokeWidth={1.5} />}
        title="No work items yet"
        body={`Work items you create in ${project.name} are listed here as ${project.key}-1, ${project.key}-2 and so on.`}
        action={<button className="btn btn-primary" onClick={() => createIssue({ projectId: project.id })}><Plus size={15} />Create work item</button>}
      />
    )
  }

  return (
    <div className="page-col">
      <div className="toolbar">{filters.toolbar}</div>
      <IssueTable
        id={`list:${project.id}`}
        issues={filters.apply(all)}
        project={project}
        groupBy={groupBy}
        onGroupBy={g => { setGroupBy(g); localStorage.setItem(`forge:list-group:${project.id}`, g) }}
        emptyText="No work items match the filters."
      />
    </div>
  )
}

// ── Settings tab ───────────────────────────────────────────

function ProjectSettings({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openProject, goTo, toast } = useApp()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const update = (patch: ProjectPatch) => dispatch({ type: 'updateProject', id: project.id, patch })
  const lead = userOf(state, project.leadId)
  const count = state.issues.filter(i => i.projectId === project.id).length

  return (
    <div className="settings">
      <section className="panel">
        <h2 className="panel-title">Details</h2>
        <div className="form-row">
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="ps-name">Name</label>
            <input id="ps-name" className="input" value={name} onChange={e => setName(e.target.value)}
              onBlur={() => name.trim() ? (name.trim() !== project.name && (update({ name: name.trim() }), toast('Project renamed'))) : setName(project.name)} />
          </div>
          <div style={{ width: 160 }}>
            <span className="label">Key</span>
            {apiEnabled && isGlobalAdmin(state)
              ? <button className="static-field mono link-btn" title="Change the key" onClick={() => setNewKey(project.key)}>{project.key}</button>
              : <div className="static-field mono">{project.key}</div>}
            {!!project.oldKeys?.length && <span className="muted sm">Earlier: {project.oldKeys.join(', ')}</span>}
          </div>
        </div>
        {apiEnabled && <ProjectExtras project={project} admin={isGlobalAdmin(state)} />}
        <label className="label" htmlFor="ps-desc" style={{ marginTop: 14 }}>Description</label>
        <textarea id="ps-desc" className="input" rows={3} value={description} onChange={e => setDescription(e.target.value)}
          onBlur={() => description !== project.description && update({ description: description.trim() })} placeholder="What is this project for? Shown under the project name." />
        <div className="form-row" style={{ marginTop: 14 }}>
          <div>
            <span className="label">Project lead</span>
            <UserPicker value={project.leadId} onChange={id => id && update({ leadId: id })} projectId={project.id} title="Project lead"
              excludeId={state.ownerId ?? undefined} trigger={<><Avatar user={lead} size={18} />{lead?.name}</>} />
          </div>
          <div>
            <span className="label">Color</span>
            <div className="swatches">
              {PROJECT_COLORS.map(c => (
                <button key={c} type="button" aria-label={c} aria-pressed={project.color === c} className="swatch sm" style={{ background: c }} onClick={() => update({ color: c })}>
                  {project.color === c && <Check size={11} strokeWidth={3} color="#FFFFFF" />}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Template</span>
            <div className="static-field">{project.template === 'scrum' ? 'Scrum' : 'Kanban'}</div>
          </div>
        </div>
      </section>

      {newKey !== null && <ConfirmDialog title={`Change ${project.key}’s key`} action="Change key" danger={false}
        onClose={() => setNewKey(null)}
        onConfirm={async () => {
          const r = await api<{ key: string }>('PATCH', `/api/projects/${encodeURIComponent(project.key)}`, { key: newKey.trim().toUpperCase() })
          location.assign(`/project/${r.key}/settings`)                              // every item's key changes: start fresh
        }}>
        <p>Every work item takes the new key ({newKey.trim().toUpperCase() || '…'}-1, -2…). The old key keeps finding them: links, searches, filters and boards still work. No other project can take {project.key} afterwards.</p>
        <label className="label" htmlFor="ps-key" style={{ marginTop: 12 }}>New key</label>
        <input id="ps-key" className="input mono" value={newKey} onChange={e => setNewKey(e.target.value.toUpperCase())} autoFocus />
      </ConfirmDialog>}
      <WorkflowPanel project={project} />
      {apiEnabled && <BoardsPanel project={project} />}
      {apiEnabled && can(project, 'deleteIssues') && <DeletedItems project={project} />}

      {apiEnabled && <TestingPanel project={project} admin={canAdmin(project)} />}
      <WorkTypesPanel project={project} />
      <ComponentsPanel project={project} />
      {apiEnabled && <SecurityLevelsPanel project={project} />}
      <FieldsPanel project={project} />
      <TemplatesPanel project={project} />
      <ImportPanel project={project} />

      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2 className="panel-title">Automation</h2>
            <p className="muted">{project.rules.length ? `${plural(project.rules.filter(r => r.enabled).length, 'active rule')} of ${project.rules.length}.` : 'No rules yet.'} Rules update work items for you when they’re created, assigned or moved.</p>
          </div>
          <button className="btn btn-secondary" onClick={() => openProject(project.id, 'settings', 'automation')}><Zap size={14} />Manage rules</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2 className="panel-title">People and access</h2>
            <p className="muted">Who can see this project, and what each person can do.</p>
          </div>
          <button className="btn btn-secondary" onClick={() => openProject(project.id, 'settings', 'people')}><Users size={14} />Manage people</button>
        </div>
      </section>

      {isGlobalAdmin(state) && apiEnabled && <section className="panel">
        <h2 className="panel-title">Archive project</h2>
        <p className="muted">Archiving makes {project.name} read-only for everyone and hides it from project lists, search and boards. Its work items still open from links. A system administrator can restore it from Administration › Archived projects.</p>
        <button className="btn btn-secondary" style={{ marginTop: 10 }} onClick={() => setArchiving(true)}><Archive size={14} />Archive project</button>
      </section>}

      {isGlobalAdmin(state) && <section className="panel panel-danger">
        <h2 className="panel-title">Delete project</h2>
        <p className="muted">{apiEnabled
          ? <>Deletes {project.name} with its {plural(count, 'work item')}, sprints, comments and files. If backups are on (Administration), a full copy is saved first and an admin can restore it.</>
          : <>Permanently deletes {project.name} with its {plural(count, 'work item')}, sprints and comments. This can’t be undone.</>}</p>
        <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={() => setDeleting(true)}>Delete project</button>
      </section>}

      {archiving && (
        <ConfirmDialog title={`Archive ${project.name}?`} action="Archive project" danger={false} onClose={() => setArchiving(false)}
          onConfirm={async () => {
            await api('POST', `/api/projects/${encodeURIComponent(project.key)}/archive`)
            const { project: p, sprints } = await loadProjectByKey(project.key)
            dispatch({ type: 'loadProject', project: p, sprints })
            toast(`${project.name} archived`)
            goTo('projects')
          }}>
          <p>Nobody, admins included, can change its {plural(count, 'work item')}, sprints, boards or settings while it is archived, and it leaves project lists, search and every board. Its work items still open from links, read-only.</p>
        </ConfirmDialog>
      )}

      {deleting && (
        <Modal title={`Delete ${project.name}?`} onClose={() => setDeleting(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleting(false)}>Cancel</button>
            <button className="btn btn-danger" disabled={confirm !== project.key} onClick={() => {
              dispatch({ type: 'deleteProject', id: project.id }); toast(`Deleted ${project.name}`, { undo: 'deleteProject' }); goTo('projects')
            }}>Delete project</button>
          </>}>
          <p className="callout callout-danger"><Info size={15} />{apiEnabled
            ? <>This deletes {plural(count, 'work item')} for everyone. A backup is taken first when backups are on.</>
            : <>This deletes {plural(count, 'work item')} and can’t be undone.</>}</p>
          <label className="label" htmlFor="del-key" style={{ marginTop: 12 }}>Type <b className="mono">{project.key}</b> to confirm</label>
          <input id="del-key" className="input" value={confirm} onChange={e => setConfirm(e.target.value.toUpperCase())} autoFocus />
        </Modal>
      )}
    </div>
  )
}

/** A project's category (system administrators) and avatar (its admins), spec 0703. */
function ProjectExtras({ project, admin }: { project: Project; admin: boolean }) {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [categories, setCategories] = useState<{ id: string; name: string }[] | null>(null)
  useEffect(() => { api<{ id: string; name: string }[]>('GET', '/api/project-categories').then(setCategories, () => setCategories([])) }, [])
  const reload = () => loadProjectByKey(project.key).then(({ project: p, sprints }) => dispatch({ type: 'loadProject', project: p, sprints }))
  const fail = (e: unknown) => toast(errorMessage(e), { tone: 'warn' })
  const upload = (file: File) => {
    const r = new FileReader()
    r.onload = () => api('PUT', `/api/projects/${encodeURIComponent(project.key)}/avatar`, { image: String(r.result) }).then(() => { void reload(); toast('Avatar saved') }, fail)
    r.readAsDataURL(file)
  }
  return (
    <div className="form-row" style={{ marginTop: 14 }}>
      <div>
        <span className="label">Category</span>
        {admin
          ? <select className="input" style={{ width: 'auto' }} aria-label="Project category" value={project.category?.id ?? ''}
              onChange={e => api('PATCH', `/api/projects/${encodeURIComponent(project.key)}`, { categoryId: e.target.value || null }).then(() => { void reload(); toast('Category saved') }, fail)}>
              <option value="">None</option>
              {(categories ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          : <div className="static-field">{project.category?.name ?? 'None'}</div>}
      </div>
      <div>
        <span className="label">Avatar</span>
        <div className="cell-flex">
          <ProjectIcon project={project} size={28} />
          {canAdmin(project) && <>
            <label className="btn btn-secondary btn-sm">Upload…<input type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Upload avatar"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} /></label>
            {project.avatar && <button className="btn btn-ghost btn-sm" onClick={() => api('DELETE', `/api/projects/${encodeURIComponent(project.key)}/avatar`).then(() => { void reload(); toast('Avatar removed') }, fail)}>Remove</button>}
          </>}
        </div>
      </div>
    </div>
  )
}

