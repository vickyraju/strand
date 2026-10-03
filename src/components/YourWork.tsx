import { useState } from 'react'
import { FolderPlus, Plus, Clock, Eye, UserCheck, Star, Columns2, CalendarClock, Ban, Inbox } from 'lucide-react'
import { useStore, projectOf, isDone, blockersOf, type Issue } from '../data/store'
import { useApp, useNavList } from '../appContext'
import IssueRow from './IssueRow'
import { ProjectIcon, StarButton, LoadSampleButton } from './ProjectView'
import { Empty } from './ui'

type Tab = 'assigned' | 'worked' | 'viewed' | 'starred'

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

  const projectFor = (i: Issue) => projectOf(state, i.projectId)!
  const assigned = state.issues.filter(i => i.assigneeId === me.id && i.type !== 'epic' && !isDone(projectFor(i), i))
  const dueSoon  = assigned.filter(i => i.dueDate && new Date(i.dueDate + 'T23:59').getTime() - Date.now() < 3 * 86_400_000)
  const blocked  = assigned.filter(i => blockersOf(state, i).length > 0)
  const unread   = state.notifications.filter(n => n.userId === me.id && !n.read && !n.archived).length

  const myLast = new Map<string, number>()
  for (const a of state.activity) if (a.actorId === me.id) myLast.set(a.issueId, Math.max(myLast.get(a.issueId) ?? 0, a.createdAt))
  for (const c of state.comments) if (c.authorId === me.id) myLast.set(c.issueId, Math.max(myLast.get(c.issueId) ?? 0, c.createdAt))
  const worked = [...myLast.entries()].sort((a, b) => b[1] - a[1])
    .map(([id, ts]) => ({ issue: state.issues.find(i => i.id === id), ts })).filter((x): x is { issue: Issue; ts: number } => !!x.issue).slice(0, 40)
  const viewed = state.viewed.map(id => state.issues.find(i => i.id === id)).filter((i): i is Issue => !!i)
  const starred = state.projects.filter(p => state.starred.includes(p.id))

  const listIds = tab === 'assigned' ? assigned.map(i => i.id) : tab === 'worked' ? worked.map(w => w.issue.id) : tab === 'viewed' ? viewed.map(i => i.id) : []
  useNavList(listIds)

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const header = (
    <div className="home-hdr">
      <div>
        <h1 className="home-greeting">{greeting()}, {me.name.split(' ')[0]}</h1>
        <div className="muted">{today}</div>
      </div>
    </div>
  )

  if (state.projects.length === 0) {
    return (
      <div className="page">
        {header}
        <Empty
          icon={<FolderPlus size={22} strokeWidth={1.5} />}
          title="Let’s set up your first project"
          body="Projects hold your team’s work items, board, backlog and reports. Create one now, or load a sample workspace to explore everything Forge can do."
          action={<><button className="btn btn-primary" onClick={onCreateProject}><Plus size={15} />Create project</button><LoadSampleButton /></>}
        />
      </div>
    )
  }

  const lastTouch = (projectId: string) => Math.max(projectOf(state, projectId)!.createdAt, ...state.issues.filter(i => i.projectId === projectId).map(i => i.updatedAt))
  const recentProjects = [...state.projects].sort((a, b) => lastTouch(b.id) - lastTouch(a.id)).slice(0, 4)

  const row = (i: Issue) => <IssueRow key={i.id} issue={i} project={projectFor(i)} showProject />
  const groups = (pairs: [string, Issue[]][]) => pairs.map(([label, list]) => (
    <section key={label} className="home-group">
      <h3 className="section-label">{label} <span className="muted">{list.length}</span></h3>
      <div className="rows-box">{list.map(row)}</div>
    </section>
  ))
  const groupBy = <T,>(items: T[], key: (t: T) => string, val: (t: T) => Issue) => {
    const m = new Map<string, Issue[]>()
    for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), val(it)])
    return [...m.entries()]
  }

  const body = () => {
    if (tab === 'assigned') {
      if (!assigned.length) return <p className="tab-empty">Nothing assigned to you right now. Work assigned to you shows up here, grouped by status.</p>
      const order = (i: Issue) => -projectFor(i).statuses.findIndex(s => s.id === i.status)
      const sorted = [...assigned].sort((a, b) => order(a) - order(b) || b.updatedAt - a.updatedAt)
      return groups(groupBy(sorted, i => projectFor(i).statuses.find(s => s.id === i.status)?.name ?? '', i => i))
    }
    if (tab === 'worked') {
      if (!worked.length) return <p className="tab-empty">Items you create, update or comment on appear here.</p>
      return groups(groupBy(worked, x => dayBucket(x.ts), x => x.issue))
    }
    if (tab === 'viewed') {
      if (!viewed.length) return <p className="tab-empty">Items you open appear here so you can get back to them quickly.</p>
      return <div className="rows-box">{viewed.map(row)}</div>
    }
    if (!starred.length) return <p className="tab-empty">Star a project to pin it here and at the top of the sidebar.</p>
    return (
      <div className="rows-box">
        {starred.map(p => (
          <div key={p.id} className="row" role="button" tabIndex={0} onClick={() => openProject(p.id)} onKeyDown={e => e.key === 'Enter' && openProject(p.id)}>
            <StarButton projectId={p.id} /><ProjectIcon project={p} size={20} />
            <span className="row-title strong">{p.name}</span><span className="mono muted">{p.key}</span>
          </div>
        ))}
      </div>
    )
  }

  const TABS: { id: Tab; label: string; count?: number; Icon: typeof Clock }[] = [
    { id: 'assigned', label: 'Assigned to me', count: assigned.length, Icon: UserCheck },
    { id: 'worked',   label: 'Worked on', Icon: Clock },
    { id: 'viewed',   label: 'Viewed', Icon: Eye },
    { id: 'starred',  label: 'Starred', count: starred.length, Icon: Star },
  ]

  return (
    <div className="page">
      {header}

      <div className="focus-grid">
        <button className="focus-card" onClick={() => setTab('assigned')}>
          <UserCheck size={18} className="tone-blue" /><b>{assigned.length}</b><span>open items assigned to you</span>
        </button>
        <button className="focus-card" onClick={() => setTab('assigned')}>
          <CalendarClock size={18} className="tone-amber" /><b>{dueSoon.length}</b><span>due in the next 3 days</span>
        </button>
        <button className="focus-card" onClick={() => setTab('assigned')}>
          <Ban size={18} className="tone-red" /><b>{blocked.length}</b><span>blocked by other work</span>
        </button>
        <button className="focus-card" onClick={() => goTo('inbox')}>
          <Inbox size={18} className="tone-green" /><b>{unread}</b><span>unread in your inbox</span>
        </button>
      </div>

      <div className="section-hdr">
        <h2 className="section-heading">Recent projects</h2>
        <button className="link" onClick={() => goTo('projects')}>View all projects</button>
      </div>
      <div className="project-cards">
        {recentProjects.map(p => {
          const items = state.issues.filter(i => i.projectId === p.id && i.type !== 'epic')
          const mineOpen = items.filter(i => i.assigneeId === me.id && !isDone(p, i)).length
          const done = items.filter(i => isDone(p, i)).length
          return (
            <div key={p.id} className="project-card" style={{ ['--accent' as string]: p.color }}>
              <button className="project-card-head" onClick={() => openProject(p.id)}>
                <ProjectIcon project={p} size={32} />
                <span className="project-card-name">
                  <span className="strong">{p.name}</span>
                  <span className="muted sm">{p.template === 'scrum' ? 'Scrum' : 'Kanban'} project</span>
                </span>
              </button>
              <div className="project-card-stats">
                <button className="link-row-btn" onClick={() => openProject(p.id, 'list')}>My open work items <b>{mineOpen}</b></button>
                <button className="link-row-btn" onClick={() => openProject(p.id, 'list')}>Done work items <b>{done}</b></button>
              </div>
              <span className="progress wide"><span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} /></span>
              <div className="project-card-actions">
                <button className="link sm" onClick={() => openProject(p.id, 'board')}><Columns2 size={13} />Board</button>
                <button className="link sm" onClick={() => createIssue({ projectId: p.id })}><Plus size={13} />Work item</button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="tabs home-tabs" role="tablist">
        {TABS.map(({ id, label, count, Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
            <Icon size={15} strokeWidth={1.75} />{label}{count ? <span className="count-pill">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="home-body">{body()}</div>
    </div>
  )
}
