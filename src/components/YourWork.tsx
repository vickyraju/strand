import { useState } from 'react'
import { FolderPlus, Plus, Clock, Eye, UserCheck, Star, Columns2, CalendarClock, Ban, Inbox } from 'lucide-react'
import { useStore, projectOf, isDone, blockersOf, type Issue, type Project } from '../data/store'
import { useApp, useNavList } from '../appContext'
import IssueRow from './IssueRow'
import { ProjectIcon, StarButton } from './ProjectView'
import { Empty } from './ui'
import { apiEnabled } from '../api/client'
import { useMyWork, useMyRecent, useMyViewed, useRecentProjects, useWorkSummary } from '../api/work'
import { useEnsureProjects, projectKeyOf } from '../api/useEnsureProjects'

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
  const { openProject, openProjectByKey, createIssue, goTo } = useApp()
  const [tab, setTab] = useState<Tab>('assigned')
  const me = state.me!

  const projectFor = (i: Issue): Project => projectOf(state, i.projectId) ?? {
    id: i.projectId, key: i.key.split('-')[0], name: i.key.split('-')[0],
    description: '', color: '#8A8578', template: 'kanban', leadId: '',
    statuses: [], transitions: [], layout: {}, boardPrefs: { fields: [] as any },
    nextNumber: 0, createdAt: 0, rules: [], fields: [], releases: [], templates: [],
  } as unknown as Project

  // API mode: the assigned/worked lists come from the server, not from a scan of every work item.
  const work = useMyWork()
  const recent = useMyRecent()
  const viewedServer = useMyViewed()
  const summary = useWorkSummary()
  const serverProjects = useRecentProjects()
  const localAssigned = state.issues.filter(i => i.assigneeId === me.id && i.type !== 'epic' && !isDone(projectFor(i), i))
  const assigned: Issue[] = apiEnabled ? work.items.filter(i => i.type !== 'epic') : localAssigned
  const localDueSoon = assigned.filter(i => i.dueDate && new Date(i.dueDate + 'T23:59').getTime() - Date.now() < 3 * 86_400_000).length
  // With an API the cards show the database's counts (the list below holds at most the first 200 items)
  const counts = {
    assigned: apiEnabled ? summary?.assigned ?? assigned.length : assigned.length,
    dueSoon:  apiEnabled ? summary?.dueSoon ?? localDueSoon : localDueSoon,
    blocked:  apiEnabled ? summary?.blocked : assigned.filter(i => blockersOf(state, i).length > 0).length,   // undefined: not known yet, card hidden
  }
  const unread   = state.notifications.filter(n => n.userId === me.id && !n.read && !n.archived).length

  const localWorked = (() => {
    const myLast = new Map<string, number>()
    for (const a of state.activity) if (a.actorId === me.id) myLast.set(a.issueId, Math.max(myLast.get(a.issueId) ?? 0, a.createdAt))
    for (const c of state.comments) if (c.authorId === me.id) myLast.set(c.issueId, Math.max(myLast.get(c.issueId) ?? 0, c.createdAt))
    return [...myLast.entries()].sort((a, b) => b[1] - a[1])
      .map(([id, ts]) => ({ issue: state.issues.find(i => i.id === id), ts })).filter((x): x is { issue: Issue; ts: number } => !!x.issue).slice(0, 40)
  })()
  const worked = apiEnabled
    ? recent.items.map(i => ({ issue: i, ts: i.updatedAt }))
    : localWorked
  const viewed = apiEnabled ? viewedServer.items : state.viewed.map(id => state.issues.find(i => i.id === id)).filter((i): i is Issue => !!i)
  const starred = state.projects.filter(p => state.starred.includes(p.id))

  // Rows from the server can belong to projects that are not loaded: load their workflows so status and grouping are right
  useEnsureProjects([...assigned, ...worked.map(w => w.issue), ...viewed].map(i => projectKeyOf(i.key)).concat((serverProjects ?? []).map(p => p.key)))

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
          body={apiEnabled ? 'Projects hold your team’s work items, board, backlog and reports. Create one now.' : 'Projects hold your team’s work items, board, backlog and reports. Create one now, or load a sample workspace to explore everything Forge can do.'}
          action={<><button className="btn btn-primary" onClick={onCreateProject}><Plus size={15} />Create project</button></>}
        />
      </div>
    )
  }

  // The project cards: with an API the server says which projects were active last and counts their items;
  // without one they are worked out from the store
  interface Card { id: string; key: string; name: string; color: string; template: 'kanban' | 'scrum'; open: number | null; done: number | null; total: number }
  const lastTouch = (projectId: string) => Math.max(projectOf(state, projectId)!.createdAt, ...state.issues.filter(i => i.projectId === projectId).map(i => i.updatedAt))
  const cards: Card[] = apiEnabled
    ? (serverProjects ?? []).map(p => ({ id: p.id, key: p.key, name: p.name, color: p.color, template: p.template, open: p.myOpen, done: p.done, total: p.total }))
    : [...state.projects].sort((a, b) => lastTouch(b.id) - lastTouch(a.id)).slice(0, 4).map(p => {
        const items = state.issues.filter(i => i.projectId === p.id && i.type !== 'epic')
        return { id: p.id, key: p.key, name: p.name, color: p.color, template: p.template, open: items.filter(i => i.assigneeId === me.id && !isDone(p, i)).length, done: items.filter(i => isDone(p, i)).length, total: items.length }
      })

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
          <div key={p.id} className="row" onClick={() => openProject(p.id)}>
            <StarButton projectId={p.id} /><ProjectIcon project={p} size={20} />
            <button type="button" className="row-title strong" onClick={e => { e.stopPropagation(); openProject(p.id) }}>{p.name}</button>
            <span className="mono muted">{p.key}</span>
          </div>
        ))}
      </div>
    )
  }

  const TABS: { id: Tab; label: string; count?: number; Icon: typeof Clock }[] = [
    { id: 'assigned', label: 'Assigned to me', count: counts.assigned, Icon: UserCheck },
    { id: 'worked',   label: 'Worked on', Icon: Clock },
    { id: 'viewed',   label: 'Viewed', Icon: Eye },
    { id: 'starred',  label: 'Starred', count: starred.length, Icon: Star },
  ]

  return (
    <div className="page">
      {header}

      <div className="focus-grid">
        <button className="focus-card" onClick={() => setTab('assigned')}>
          <UserCheck size={18} className="tone-blue" /><b>{counts.assigned}</b><span>open items assigned to you</span>
        </button>
        <button className="focus-card" onClick={() => setTab('assigned')}>
          <CalendarClock size={18} className="tone-amber" /><b>{counts.dueSoon}</b><span>due in the next 3 days</span>
        </button>
        {counts.blocked !== undefined && (
          <button className="focus-card" onClick={() => setTab('assigned')}>
            <Ban size={18} className="tone-red" /><b>{counts.blocked}</b><span>blocked by other work</span>
          </button>
        )}
        <button className="focus-card" onClick={() => goTo('inbox')}>
          <Inbox size={18} className="tone-green" /><b>{unread}</b><span>unread in your inbox</span>
        </button>
      </div>

      <div className="section-hdr">
        <h2 className="section-heading">Recent projects</h2>
        <button className="link" onClick={() => goTo('projects')}>View all projects</button>
      </div>
      <div className="project-cards">
        {cards.map(p => {
          const openN = p.open, doneN = p.done
          const go = (tab?: 'board' | 'list') => (apiEnabled ? openProjectByKey(p.key, tab) : openProject(p.id, tab))
          return (
            <div key={p.id} className="project-card" style={{ ['--accent' as string]: p.color }}>
              <button className="project-card-head" onClick={() => go()}>
                <ProjectIcon project={p} size={32} />
                <span className="project-card-name">
                  <span className="strong">{p.name}</span>
                  <span className="muted sm">{p.template === 'scrum' ? 'Scrum' : 'Kanban'} project</span>
                </span>
              </button>
              <div className="project-card-stats">
                <button className="link-row-btn" onClick={() => go('list')}>My open work items <b>{openN ?? '…'}</b></button>
                <button className="link-row-btn" onClick={() => go('list')}>Done work items <b>{doneN ?? '…'}</b></button>
              </div>
              {doneN !== null && <span className="progress wide"><span style={{ width: `${p.total ? (doneN / p.total) * 100 : 0}%` }} /></span>}
              <div className="project-card-actions">
                <button className="link sm" onClick={() => go('board')}><Columns2 size={13} />Board</button>
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
