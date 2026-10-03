import { useState } from 'react'
import { TrendingDown, BarChart3, Layers, ArrowLeftRight, Timer, Users } from 'lucide-react'
import { useStore, userOf, isDone, CATEGORY_COLOR, type Project } from '../data/store'
import { burndown, velocity, cumulativeFlow, createdVsResolved, cycleTimes, dayLabel } from '../data/analytics'
import { useApp } from '../appContext'
import { LineChart, ColumnChart, Legend, Scatter, HBars } from './charts'
import { Avatar, Empty, Picker, TYPE_META, plural } from './ui'

type ReportId = 'burndown' | 'velocity' | 'cfd' | 'created' | 'cycle' | 'workload'

const REPORTS: { id: ReportId; name: string; desc: string; Icon: typeof Layers; scrum?: boolean }[] = [
  { id: 'burndown', name: 'Sprint burndown', desc: 'Work remaining in a sprint against the ideal pace.', Icon: TrendingDown, scrum: true },
  { id: 'velocity', name: 'Velocity',        desc: 'Points committed vs completed per sprint.',         Icon: BarChart3, scrum: true },
  { id: 'cfd',      name: 'Cumulative flow', desc: 'Work in each stage over time. Widening bands mean bottlenecks.', Icon: Layers },
  { id: 'created',  name: 'Created vs resolved', desc: 'Is the backlog growing or shrinking?',          Icon: ArrowLeftRight },
  { id: 'cycle',    name: 'Cycle time',      desc: 'How long items take from start to done.',           Icon: Timer },
  { id: 'workload', name: 'Workload',        desc: 'Open items and points per person.',                 Icon: Users },
]

export default function ReportsView({ project, report }: { project: Project; report?: string }) {
  const { openProject } = useApp()
  const available = REPORTS.filter(r => !r.scrum || project.template === 'scrum')
  const current = available.find(r => r.id === report) ?? available[0]

  return (
    <div className="reports">
      <nav className="reports-nav" aria-label="Reports">
        {available.map(r => (
          <button key={r.id} className={`reports-nav-item${current.id === r.id ? ' active' : ''}`} aria-current={current.id === r.id ? 'page' : undefined}
            onClick={() => openProject(project.id, 'reports', r.id)}>
            <r.Icon size={16} strokeWidth={1.75} />
            <span>
              <span className="reports-nav-name">{r.name}</span>
              <span className="reports-nav-desc">{r.desc}</span>
            </span>
          </button>
        ))}
      </nav>
      <section className="report">
        <h2 className="report-title">{current.name}</h2>
        <p className="muted">{current.desc}</p>
        {current.id === 'burndown' && <Burndown project={project} />}
        {current.id === 'velocity' && <Velocity project={project} />}
        {current.id === 'cfd'      && <Flow project={project} />}
        {current.id === 'created'  && <CreatedResolved project={project} />}
        {current.id === 'cycle'    && <Cycle project={project} />}
        {current.id === 'workload' && <Workload project={project} />}
      </section>
    </div>
  )
}

const RANGE_OPTIONS = [{ value: 14, label: 'Last 14 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }]

function NoData({ text }: { text: string }) {
  return <Empty icon={<BarChart3 size={22} strokeWidth={1.5} />} title="Not enough data yet" body={text} />
}

function Burndown({ project }: { project: Project }) {
  const { state } = useStore()
  const sprints = state.sprints.filter(s => s.projectId === project.id && s.startedAt)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const [id, setId] = useState(sprints[0]?.id)
  const sprint = sprints.find(s => s.id === id) ?? sprints[0]
  if (!sprint) return <NoData text="Start a sprint from the backlog to see its burndown." />
  const data = burndown(state, project, sprint)!
  const remaining = [...data.remaining].reverse().find(v => !Number.isNaN(v)) ?? data.total
  const pts = data.members.reduce((n, i) => n + (i.estimate ?? 0), 0)

  return (
    <>
      <div className="report-tools">
        <Picker value={sprint.id} options={sprints.map(s => ({ value: s.id, label: s.name, hint: s.state === 'active' ? 'Active' : 'Closed' }))}
          onChange={setId} className="btn btn-secondary" title="Sprint" trigger={sprint.name} />
        <span className="muted">{dayLabel(sprint.startedAt!)} – {dayLabel(sprint.completedAt ?? sprint.endsAt ?? Date.now())}</span>
      </div>
      <div className="kpis">
        <div><b>{data.total}</b><span>points committed</span></div>
        <div><b>{remaining}</b><span>points remaining</span></div>
        <div><b>{plural(data.members.length, 'item')}</b><span>in sprint{pts !== data.total ? ` (${pts} pts now)` : ''}</span></div>
      </div>
      {data.total === 0
        ? <NoData text="Add story point estimates to the sprint’s work items to see the burndown." />
        : <>
          <LineChart ariaLabel={`Burndown for ${sprint.name}`} labels={data.labels} height={300}
            series={[
              { label: 'Remaining', color: '#DC2626', values: data.remaining },
              { label: 'Guideline', color: '#A8A29E', values: data.ideal, dashed: true },
            ]} />
          <Legend items={[{ label: 'Remaining points', color: '#DC2626' }, { label: 'Guideline', color: '#A8A29E', dashed: true }]} />
        </>}
    </>
  )
}

function Velocity({ project }: { project: Project }) {
  const { state } = useStore()
  const v = velocity(state, project)
  if (v.labels.length === 0) return <NoData text="Complete a sprint to see velocity. It compares what the team committed to with what it finished." />
  return (
    <>
      <div className="kpis">
        <div><b>{Math.round(v.average * 10) / 10}</b><span>average points completed</span></div>
        <div><b>{v.labels.length}</b><span>sprints</span></div>
        <div><b>{Math.round((v.completed.reduce((a, b) => a + b, 0) / Math.max(1, v.committed.reduce((a, b) => a + b, 0))) * 100)}%</b><span>say/do ratio</span></div>
      </div>
      <ColumnChart ariaLabel="Velocity per sprint" labels={v.labels} height={300}
        series={[{ label: 'Committed', color: '#A8A29E', values: v.committed }, { label: 'Completed', color: '#16A34A', values: v.completed }]} />
      <Legend items={[{ label: 'Committed', color: '#A8A29E' }, { label: 'Completed', color: '#16A34A' }]} />
    </>
  )
}

function Flow({ project }: { project: Project }) {
  const { state } = useStore()
  const [span, setSpan] = useState(30)
  const data = cumulativeFlow(state, project, span)
  const series = [
    { label: 'To do',       color: CATEGORY_COLOR.todo,          values: data.counts.todo },
    { label: 'In progress', color: CATEGORY_COLOR['in-progress'], values: data.counts['in-progress'] },
    { label: 'Done',        color: CATEGORY_COLOR.done,          values: data.counts.done },
  ]
  return (
    <>
      <div className="report-tools">
        <Picker value={span} options={RANGE_OPTIONS} onChange={setSpan} className="btn btn-secondary" title="Range" trigger={RANGE_OPTIONS.find(o => o.value === span)!.label} />
      </div>
      <LineChart ariaLabel="Cumulative flow" labels={data.labels} series={[...series].reverse()} stacked height={320} />
      <Legend items={series} />
    </>
  )
}

function CreatedResolved({ project }: { project: Project }) {
  const { state } = useStore()
  const [span, setSpan] = useState(30)
  const d = createdVsResolved(state, project, span)
  const created = d.created.reduce((a, b) => a + b, 0)
  const resolved = d.resolved.reduce((a, b) => a + b, 0)
  return (
    <>
      <div className="report-tools">
        <Picker value={span} options={RANGE_OPTIONS} onChange={setSpan} className="btn btn-secondary" title="Range" trigger={RANGE_OPTIONS.find(o => o.value === span)!.label} />
        <span className="muted">{d.bucket > 86_400_000 ? 'Per week' : 'Per day'}</span>
      </div>
      <div className="kpis">
        <div><b>{created}</b><span>created</span></div>
        <div><b>{resolved}</b><span>resolved</span></div>
        <div><b className={created > resolved ? 'text-danger' : 'text-success'}>{created - resolved > 0 ? '+' : ''}{created - resolved}</b><span>backlog change</span></div>
      </div>
      <ColumnChart ariaLabel="Created vs resolved" labels={d.labels} height={300}
        series={[{ label: 'Created', color: '#DC2626', values: d.created }, { label: 'Resolved', color: '#16A34A', values: d.resolved }]} />
      <Legend items={[{ label: 'Created', color: '#DC2626' }, { label: 'Resolved', color: '#16A34A' }]} />
    </>
  )
}

function Cycle({ project }: { project: Project }) {
  const { state } = useStore()
  const { points, median, p85 } = cycleTimes(state, project)
  if (points.length < 2) return <NoData text="Cycle time appears once items have moved from in progress to done." />
  return (
    <>
      <div className="kpis">
        <div><b>{Math.round(median * 10) / 10} d</b><span>median cycle time</span></div>
        <div><b>{Math.round(p85 * 10) / 10} d</b><span>85% of items finish within</span></div>
        <div><b>{points.length}</b><span>items measured</span></div>
      </div>
      <Scatter ariaLabel="Cycle time per item" height={300} xLabel={dayLabel}
        reference={{ v: median, label: `Median ${Math.round(median * 10) / 10}d` }}
        points={points.map(p => ({ t: p.done, v: p.days, label: `${p.issue.key} ${p.issue.title}`, color: TYPE_META[p.issue.type].color }))} />
      <Legend items={(['story', 'task', 'bug'] as const).map(t => ({ label: TYPE_META[t].label, color: TYPE_META[t].color }))} />
    </>
  )
}

function Workload({ project }: { project: Project }) {
  const { state } = useStore()
  const open = state.issues.filter(i => i.projectId === project.id && i.type !== 'epic' && !isDone(project, i))
  if (open.length === 0) return <NoData text="There is no open work in this project." />
  const rows = [...new Set(open.map(i => i.assigneeId ?? ''))].map(id => {
    const mine = open.filter(i => (i.assigneeId ?? '') === id)
    return { user: userOf(state, id || undefined), count: mine.length, points: mine.reduce((n, i) => n + (i.estimate ?? 0), 0),
      inProgress: mine.filter(i => project.statuses.find(s => s.id === i.status)?.category === 'in-progress').length }
  }).sort((a, b) => b.points - a.points || b.count - a.count)

  return (
    <>
      <HBars unit=" pts" data={rows.map(r => ({ key: r.user?.id ?? 'none', label: <><Avatar user={r.user} size={20} />{r.user?.name ?? 'Unassigned'}</>, value: r.points, color: r.user?.color ?? '#A8A29E' }))} />
      <div className="card-table" style={{ marginTop: 20 }}>
        <table className="table">
          <thead><tr><th>Person</th><th className="col-num">Open items</th><th className="col-num">In progress</th><th className="col-num">Points</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.user?.id ?? 'none'}>
                <td><span className="cell-flex"><Avatar user={r.user} size={22} />{r.user?.name ?? 'Unassigned'}</span></td>
                <td className="col-num">{r.count}</td><td className="col-num">{r.inProgress}</td><td className="col-num">{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
