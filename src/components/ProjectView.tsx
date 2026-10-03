import { lazy, Suspense, useState } from 'react'
import { Plus, Star, FolderPlus, Columns2, List, ListChecks, Settings, Gauge, BarChart3, GanttChart, CalendarDays, Rocket, Check, GitBranch, Info, Sparkles, Zap } from 'lucide-react'
import { useStore, userOf, isDone, timeAgo, PROJECT_COLORS, type Project, type ProjectPatch } from '../data/store'
import { useApp } from '../appContext'
import type { ProjectTab } from '../router'
import { sampleWorkspace } from '../data/sample'
import BoardView from './BoardView'
import BacklogView from './BacklogView'
import IssueTable, { type TableGroup } from './IssueTable'
import SummaryView from './SummaryView'
import { FieldsPanel } from './CustomFields'
import { TemplatesPanel, ImportPanel } from './TemplatesImport'
import { useFilters } from './filters'
import { Avatar, Empty, Picker, Modal, userOptions, plural } from './ui'

// Screens most people don't open first load on demand to keep the first page fast
const ReportsView     = lazy(() => import('./ReportsView'))
const TimelineView    = lazy(() => import('./TimelineView'))
const CalendarView    = lazy(() => import('./CalendarView'))
const ReleasesView    = lazy(() => import('./ReleasesView'))
const WorkflowBuilder = lazy(() => import('./WorkflowBuilder'))
const AutomationView  = lazy(() => import('./AutomationView'))

export const TAB_LABEL: Record<ProjectTab, string> = {
  summary: 'Summary', backlog: 'Backlog', board: 'Board', list: 'List', timeline: 'Timeline', calendar: 'Calendar', releases: 'Releases', reports: 'Reports', settings: 'Settings',
}

// ── Shared bits ────────────────────────────────────────────

export function ProjectIcon({ project, size = 16 }: { project: Project; size?: number }) {
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

export function LoadSampleButton({ className = 'btn btn-secondary' }: { className?: string }) {
  const { state, dispatch } = useStore()
  if (state.sampleIds.length > 0 || !state.owner) return null
  return (
    <button className={className} onClick={() => dispatch({ type: 'merge', data: sampleWorkspace(state.owner!) })}>
      <Sparkles size={14} />Load a sample workspace
    </button>
  )
}

// ── All projects ───────────────────────────────────────────

export function ProjectsView({ onCreate }: { onCreate: () => void }) {
  const { state } = useStore()
  const { openProject } = useApp()

  return (
    <div className="page">
      <div className="page-hdr">
        <h1 className="page-title">Projects</h1>
        <div style={{ flex: 1 }} />
        {state.projects.length > 0 && <button className="btn btn-primary" onClick={onCreate}><Plus size={15} />Create project</button>}
      </div>

      {state.projects.length === 0 ? (
        <Empty
          icon={<FolderPlus size={22} strokeWidth={1.5} />}
          title="Create your first project"
          body="Projects hold your team’s work items, board, backlog and reports. Start with one, or explore a sample workspace first."
          action={<><button className="btn btn-primary" onClick={onCreate}><Plus size={15} />Create project</button><LoadSampleButton /></>}
        />
      ) : (
        <div className="card-table">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 44 }}><span className="sr-only">Starred</span></th>
                <th>Name</th>
                <th style={{ width: 90 }}>Key</th>
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

export function ProjectView({ project, tab, sub }: { project: Project; tab: ProjectTab; sub?: string }) {
  const { state } = useStore()
  const { openProject } = useApp()
  const tabs: { id: ProjectTab; Icon: typeof List }[] = [
    { id: 'summary', Icon: Gauge },
    ...(project.template === 'scrum' ? [{ id: 'backlog' as const, Icon: ListChecks }] : []),
    { id: 'board',    Icon: Columns2 },
    { id: 'list',     Icon: List },
    { id: 'timeline', Icon: GanttChart },
    { id: 'calendar', Icon: CalendarDays },
    { id: 'releases', Icon: Rocket },
    { id: 'reports',  Icon: BarChart3 },
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

      <div className="tabs" role="tablist" aria-label={`${project.name} views`}>
        {tabs.map(({ id, Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => openProject(project.id, id)}>
            <Icon size={15} strokeWidth={1.75} />{TAB_LABEL[id]}
          </button>
        ))}
      </div>

      <Suspense fallback={<div className="loading" role="status">Loading…</div>}>
      {tab === 'summary'  && <SummaryView project={project} />}
      {tab === 'board'    && <BoardView project={project} />}
      {tab === 'backlog'  && (project.template === 'scrum' ? <BacklogView project={project} /> : <Empty icon={<ListChecks size={22} />} title="Backlog is for Scrum projects" body="Kanban projects plan work directly on the board." />)}
      {tab === 'list'     && <ListTab project={project} />}
      {tab === 'timeline' && <TimelineView project={project} />}
      {tab === 'calendar' && <CalendarView project={project} />}
      {tab === 'releases' && <ReleasesView project={project} releaseId={sub} />}
      {tab === 'reports'  && <ReportsView project={project} report={sub} />}
      {tab === 'settings' && (sub === 'workflow' ? <WorkflowBuilder project={project} /> : sub === 'automation' ? <AutomationView project={project} /> : <ProjectSettings project={project} />)}
      </Suspense>
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
  const filters = useFilters(people)

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
  const [confirm, setConfirm] = useState('')
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
          <div style={{ width: 120 }}>
            <span className="label">Key</span>
            <div className="static-field mono" title="Keys can’t change once work items exist">{project.key}</div>
          </div>
        </div>
        <label className="label" htmlFor="ps-desc" style={{ marginTop: 14 }}>Description</label>
        <textarea id="ps-desc" className="input" rows={3} value={description} onChange={e => setDescription(e.target.value)}
          onBlur={() => description !== project.description && update({ description: description.trim() })} placeholder="What is this project for? Shown under the project name." />
        <div className="form-row" style={{ marginTop: 14 }}>
          <div>
            <span className="label">Project lead</span>
            <Picker value={project.leadId as string | undefined} search options={userOptions(state.users).slice(1)}
              onChange={id => id && update({ leadId: id })} title="Project lead"
              trigger={<><Avatar user={lead} size={18} />{lead?.name}</>} />
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

      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2 className="panel-title">Workflow</h2>
            <p className="muted">{plural(project.statuses.length, 'status', )} · {plural(project.transitions.length, 'transition')}. The workflow decides the board columns and which moves are allowed.</p>
          </div>
          <button className="btn btn-secondary" onClick={() => openProject(project.id, 'settings', 'workflow')}><GitBranch size={14} />Edit workflow</button>
        </div>
        <div className="workflow-strip">
          {project.statuses.map(s => <span key={s.id} className={`lozenge lozenge-${s.category}`}>{s.name}</span>)}
        </div>
      </section>

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

      <section className="panel panel-danger">
        <h2 className="panel-title">Delete project</h2>
        <p className="muted">Permanently deletes {project.name} with its {plural(count, 'work item')}, sprints and comments. This can’t be undone.</p>
        <button className="btn btn-danger" style={{ marginTop: 10 }} onClick={() => setDeleting(true)}>Delete project</button>
      </section>

      {deleting && (
        <Modal title={`Delete ${project.name}?`} onClose={() => setDeleting(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleting(false)}>Cancel</button>
            <button className="btn btn-danger" disabled={confirm !== project.key} onClick={() => {
              dispatch({ type: 'deleteProject', id: project.id }); toast(`Deleted ${project.name}`); goTo('projects')
            }}>Delete project</button>
          </>}>
          <p className="callout callout-danger"><Info size={15} />This deletes {plural(count, 'work item')} and can’t be undone.</p>
          <label className="label" htmlFor="del-key" style={{ marginTop: 12 }}>Type <b className="mono">{project.key}</b> to confirm</label>
          <input id="del-key" className="input" value={confirm} onChange={e => setConfirm(e.target.value.toUpperCase())} autoFocus />
        </Modal>
      )}
    </div>
  )
}
