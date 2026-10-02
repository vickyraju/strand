import { useState } from 'react'
import { FolderPlus, Plus, Clock, Eye, UserCheck, Star, Columns2 } from 'lucide-react'
import { useStore, projectOf, isDone, type Issue } from '../data/store'
import { useApp } from '../appContext'
import IssueRow from './IssueRow'
import { ProjectIcon, StarButton } from './ProjectView'
import { Empty } from './ui'

type Tab = 'worked' | 'viewed' | 'assigned' | 'starred'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function dayBucket(ts: number) {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const day = 86_400_000
  if (ts >= start.getTime()) return 'Today'
  if (ts >= start.getTime() - day) return 'Yesterday'
  if (ts >= start.getTime() - 6 * day) return 'Earlier this week'
  return 'Older'
}

export default function YourWork({ onCreateProject }: { onCreateProject: () => void }) {
  const { state } = useStore()
  const { openProject, createIssue, goTo } = useApp()
  const [tab, setTab] = useState<Tab>('assigned')
  const me = state.me!

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const header = (
    <div className="yw-header">
      <h1 className="yw-greeting">{greeting()}, {me.name.split(' ')[0]}.</h1>
      <div className="yw-date">{today}</div>
    </div>
  )

  if (state.projects.length === 0) {
    return (
      <div className="yw-root">
        {header}
        <Empty
          icon={<FolderPlus size={20} strokeWidth={1.5} />}
          title="Create your first project"
          body="Projects hold your team's work items, board and backlog. Once you have one, your assigned and recent work shows up here."
          action={<button className="btn-primary" onClick={onCreateProject}><Plus size={14} strokeWidth={2} />Create project</button>}
        />
      </div>
    )
  }

  // Last time anything happened in each project, for "Recent projects"
  const lastTouch = (projectId: string) => Math.max(
    state.projects.find(p => p.id === projectId)!.createdAt,
    ...state.issues.filter(i => i.projectId === projectId).map(i => i.updatedAt),
  )
  const recentProjects = [...state.projects].sort((a, b) => lastTouch(b.id) - lastTouch(a.id)).slice(0, 4)

  const byId = new Map(state.issues.map(i => [i.id, i]))
  const myLastAction = new Map<string, number>()
  for (const a of state.activity) if (a.actorId === me.id) myLastAction.set(a.issueId, Math.max(myLastAction.get(a.issueId) ?? 0, a.createdAt))
  for (const c of state.comments) if (c.authorId === me.id) myLastAction.set(c.issueId, Math.max(myLastAction.get(c.issueId) ?? 0, c.createdAt))

  const worked   = [...myLastAction.entries()].sort((a, b) => b[1] - a[1]).map(([id, ts]) => ({ issue: byId.get(id), ts })).filter(x => x.issue) as { issue: Issue; ts: number }[]
  const viewed   = state.viewed.map(id => byId.get(id)).filter(Boolean) as Issue[]
  const assigned = state.issues.filter(i => i.assigneeId === me.id && !isDone(projectOf(state, i.projectId), i))
  const starred  = state.projects.filter(p => state.starred.includes(p.id))

  const TABS: { id: Tab; label: string; count?: number; Icon: typeof Clock }[] = [
    { id: 'assigned', label: 'Assigned to me', count: assigned.length, Icon: UserCheck },
    { id: 'worked',   label: 'Worked on',      Icon: Clock },
    { id: 'viewed',   label: 'Viewed',         Icon: Eye },
    { id: 'starred',  label: 'Starred',        count: starred.length, Icon: Star },
  ]

  const row = (i: Issue) => <IssueRow key={i.id} issue={i} project={projectOf(state, i.projectId)!} showProject />
  const grouped = (groups: [string, Issue[]][]) => groups.map(([label, list]) => (
    <section key={label}>
      <div className="yw-group-label">{label}</div>
      {list.map(row)}
    </section>
  ))
  const groupBy = <T,>(items: T[], key: (t: T) => string, val: (t: T) => Issue) => {
    const m = new Map<string, Issue[]>()
    for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), val(it)])
    return [...m.entries()]
  }

  const tabBody = () => {
    if (tab === 'assigned') {
      if (!assigned.length) return <div className="yw-empty-tab">Nothing assigned to you right now. Items you're assigned to will appear here.</div>
      const order = (i: Issue) => projectOf(state, i.projectId)!.statuses.findIndex(s => s.id === i.status)
      const sorted = [...assigned].sort((a, b) => order(b) - order(a) || b.updatedAt - a.updatedAt)
      return grouped(groupBy(sorted, i => projectOf(state, i.projectId)!.statuses.find(s => s.id === i.status)?.name ?? '', i => i))
    }
    if (tab === 'worked') {
      if (!worked.length) return <div className="yw-empty-tab">Items you create, update or comment on will appear here.</div>
      return grouped(groupBy(worked, x => dayBucket(x.ts), x => x.issue))
    }
    if (tab === 'viewed') {
      if (!viewed.length) return <div className="yw-empty-tab">Items you open will appear here so you can get back to them quickly.</div>
      return viewed.map(row)
    }
    if (!starred.length) return <div className="yw-empty-tab">Star a project to pin it here and in the sidebar.</div>
    return starred.map(p => (
      <button key={p.id} className="ir-row" style={{ width: '100%' }} onClick={() => openProject(p.id)}>
        <StarButton projectId={p.id} />
        <ProjectIcon project={p} size={16} />
        <span className="ir-title">{p.name}</span>
        <span className="ir-key">{p.key}</span>
      </button>
    ))
  }

  return (
    <div className="yw-root" style={{ overflowY: 'auto' }}>
      {header}

      <div className="yw-section-hdr">
        <h2>Recent projects</h2>
        <button className="wi-link" onClick={() => goTo('projects')}>View all projects</button>
      </div>
      <div className="yw-projects">
        {recentProjects.map(p => {
          const items = state.issues.filter(i => i.projectId === p.id)
          const mineOpen = items.filter(i => i.assigneeId === me.id && !isDone(p, i)).length
          const doneCount = items.filter(i => isDone(p, i)).length
          return (
            <div key={p.id} className="yw-project-card" style={{ borderLeftColor: p.color }}>
              <button className="yw-project-name" onClick={() => openProject(p.id)}>
                <ProjectIcon project={p} size={24} />
                <span>
                  <span className="yw-project-title">{p.name}</span>
                  <span className="yw-project-type">{p.template === 'scrum' ? 'Scrum' : 'Kanban'} project</span>
                </span>
              </button>
              <div className="yw-project-links">
                <span>My open items <b>{mineOpen}</b></span>
                <span>Done items <b>{doneCount}</b></span>
              </div>
              <div className="yw-project-actions">
                <button className="wi-link" onClick={() => openProject(p.id, 'board')}><Columns2 size={12} />Board</button>
                <button className="wi-link" onClick={() => createIssue({ projectId: p.id })}><Plus size={12} />Work item</button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="yw-tabs" style={{ margin: '24px 32px 0', paddingRight: 0 }} role="tablist">
        {TABS.map(({ id, label, count, Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`yw-tab${tab === id ? ' active' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setTab(id)}>
            <Icon size={13} strokeWidth={1.5} />{label}{count ? <span className="ir-group-count">{count}</span> : null}
          </button>
        ))}
      </div>
      <div style={{ padding: '4px 32px 40px' }}>{tabBody()}</div>
    </div>
  )
}
