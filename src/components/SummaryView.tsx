import { CheckCircle2, Pencil, PlusCircle, CalendarClock, Gauge } from 'lucide-react'
import { useStore, userOf, isDone, timeAgo, type Project, type IssueType } from '../data/store'
import { lastWeek } from '../data/analytics'
import { useApp } from '../appContext'
import { Donut, HBars } from './charts'
import { Avatar, Empty, TypeIcon, TYPE_META, PRIORITIES, PRIORITY_META, PriorityIcon, plural } from './ui'
import { LoadSampleButton } from './ProjectView'

export default function SummaryView({ project }: { project: Project }) {
  const { state } = useStore()
  const { openIssue, openProject, createIssue } = useApp()
  const items = state.issues.filter(i => i.projectId === project.id)
  const work = items.filter(i => i.type !== 'epic')

  if (items.length === 0) {
    return (
      <Empty icon={<Gauge size={22} strokeWidth={1.5} />} title="Nothing to summarize yet"
        body="Once your team creates and moves work items, this page shows progress, workload and recent activity."
        action={<><button className="btn btn-primary" onClick={() => createIssue({ projectId: project.id })}>Create work item</button><LoadSampleButton /></>} />
    )
  }

  const week = lastWeek(state, project)
  const open = work.filter(i => !isDone(project, i))
  const sprint = state.sprints.find(s => s.projectId === project.id && s.state === 'active')
  const sprintItems = sprint ? work.filter(i => i.sprintId === sprint.id) : []
  const sprintDone = sprintItems.filter(i => isDone(project, i)).length
  const daysLeft = sprint?.endsAt ? Math.ceil((sprint.endsAt - Date.now()) / 86_400_000) : undefined

  const assignees = [...new Set(open.map(i => i.assigneeId ?? ''))]
    .map(id => ({ user: userOf(state, id || undefined), count: open.filter(i => (i.assigneeId ?? '') === id).length }))
    .sort((a, b) => b.count - a.count)

  const issueIds = new Set(items.map(i => i.id))
  const feed = [
    ...state.activity.filter(a => issueIds.has(a.issueId)).map(a => ({ id: a.id, at: a.createdAt, actor: a.actorId, issueId: a.issueId, text: a.text })),
    ...state.comments.filter(c => issueIds.has(c.issueId)).map(c => ({ id: c.id, at: c.createdAt, actor: c.authorId, issueId: c.issueId, text: 'commented' })),
  ].sort((a, b) => b.at - a.at).slice(0, 14)

  const epics = items.filter(i => i.type === 'epic').map(e => {
    const children = items.filter(i => i.parentId === e.id)
    return { e, total: children.length, done: children.filter(i => isDone(project, i)).length }
  })

  return (
    <div className="summary">
      <div className="stat-grid">
        <Stat icon={<CheckCircle2 size={18} />} tone="green" value={week.completed} label="completed" sub="in the last 7 days" />
        <Stat icon={<Pencil size={18} />} tone="blue" value={week.updated} label="updated" sub="in the last 7 days" />
        <Stat icon={<PlusCircle size={18} />} tone="purple" value={week.created} label="created" sub="in the last 7 days" />
        <Stat icon={<CalendarClock size={18} />} tone="amber" value={week.dueSoon} label="due soon" sub="in the next 7 days" />
      </div>

      <div className="summary-grid">
        {sprint && (
          <section className="panel span-2">
            <div className="panel-title-row">
              <div>
                <h2 className="panel-title">{sprint.name}</h2>
                <p className="muted">{sprint.goal || 'No sprint goal'}{daysLeft !== undefined ? ` · ${daysLeft < 0 ? `${-daysLeft} days overdue` : `${plural(daysLeft, 'day')} left`}` : ''}</p>
              </div>
              <button className="btn btn-secondary" onClick={() => openProject(project.id, 'board')}>Open board</button>
            </div>
            <div className="sprint-progress">
              {project.statuses.map(s => {
                const n = sprintItems.filter(i => i.status === s.id).length
                return n ? <span key={s.id} style={{ flex: n, background: s.color }} title={`${s.name}: ${n}`} /> : null
              })}
            </div>
            <p className="muted sm">{sprintDone} of {plural(sprintItems.length, 'item')} done</p>
          </section>
        )}

        <section className="panel">
          <h2 className="panel-title">Status overview</h2>
          <p className="muted">A snapshot of where every work item is.</p>
          <Donut ariaLabel="Work items by status"
            center={{ value: String(work.length), label: 'work items' }}
            data={project.statuses.map(s => ({ label: s.name, value: work.filter(i => i.status === s.id).length, color: s.color }))} />
        </section>

        <section className="panel">
          <h2 className="panel-title">Recent activity</h2>
          <p className="muted">What changed across the project.</p>
          <ul className="feed">
            {feed.map(f => {
              const issue = items.find(i => i.id === f.issueId)
              const who = userOf(state, f.actor)
              return (
                <li key={f.id} className="feed-row">
                  <Avatar user={who} size={22} />
                  <span className="feed-text">
                    <b>{who?.name ?? 'Someone'}</b> {f.text}{' '}
                    {issue && <button className="link" onClick={() => openIssue(issue.id)}>{issue.key}: {issue.title}</button>}
                  </span>
                  <span className="muted sm nowrap">{timeAgo(f.at)}</span>
                </li>
              )
            })}
          </ul>
        </section>

        <section className="panel">
          <h2 className="panel-title">Priority breakdown</h2>
          <p className="muted">Open work by priority.</p>
          <HBars data={PRIORITIES.map(p => ({ key: p, label: <><PriorityIcon priority={p} />{PRIORITY_META[p].label}</>, value: open.filter(i => i.priority === p).length, color: PRIORITY_META[p].color }))} />
        </section>

        <section className="panel">
          <h2 className="panel-title">Team workload</h2>
          <p className="muted">Open work items per person.</p>
          {assignees.length === 0 ? <p className="muted">No open work.</p> : (
            <HBars data={assignees.map(a => ({ key: a.user?.id ?? 'none', label: <><Avatar user={a.user} size={20} />{a.user?.name ?? 'Unassigned'}</>, value: a.count, color: a.user?.color ?? '#A8A29E' }))} />
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Types of work</h2>
          <p className="muted">All work items by type.</p>
          <HBars data={(Object.keys(TYPE_META) as IssueType[]).map(t => ({ key: t, label: <><TypeIcon type={t} size={14} />{TYPE_META[t].label}</>, value: items.filter(i => i.type === t).length, color: TYPE_META[t].color }))} />
        </section>

        <section className="panel">
          <h2 className="panel-title">Epic progress</h2>
          <p className="muted">How far each epic has come.</p>
          {epics.length === 0 ? <p className="muted">No epics yet. Create a work item of type Epic to group related work.</p> : (
            <ul className="epic-list">
              {epics.map(({ e, total, done }) => (
                <li key={e.id}>
                  <button className="epic-row" onClick={() => openIssue(e.id)}>
                    <TypeIcon type="epic" size={14} />
                    <span className="epic-title">{e.title}</span>
                    <span className="muted sm">{done}/{total}</span>
                  </button>
                  <span className="progress wide"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}

function Stat({ icon, tone, value, label, sub }: { icon: React.ReactNode; tone: string; value: number; label: string; sub: string }) {
  return (
    <div className="stat">
      <span className={`stat-icon tone-${tone}`}>{icon}</span>
      <div>
        <div className="stat-value">{value} {label}</div>
        <div className="muted sm">{sub}</div>
      </div>
    </div>
  )
}
