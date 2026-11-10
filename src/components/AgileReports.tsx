// Jira's reports for sprints, epics and versions (spec 0411): Burnup, Epic report, Version report, Epic burndown and
// Release burndown. The maths is in data/agile.ts; these draw it, in the board's estimation statistic.
import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { apiEnabled } from '../api/client'
import { useBoard, useBoards } from '../api/boards'
import { useDurations } from '../api/settings-public'
import { useApp } from '../appContext'
import { burnup, predictRelease, progressReport, scopeBurndown } from '../data/agile'
import { categoryOf, type Estimation, type Issue, type Project, type State } from '../data/reducer'
import { ColumnChart, Legend, LineChart } from './charts'
import { Empty, Picker, plural } from './ui'

const NoData = ({ text }: { text: string }) => <Empty icon={<BarChart3 size={22} strokeWidth={1.5} />} title="Not enough data yet" body={text} />

/** The statistic the project's first Scrum board counts in (spec 0404), and its working days. */
function useStatistic(project: Project) {
  const boards = useBoards(project)
  const { board } = useBoard(apiEnabled ? (boards.find(b => b.type === 'scrum') ?? boards[0])?.id : undefined)
  return { estimation: (board?.estimation ?? 'points') as Estimation, working: board?.workingDays }
}

export function Burnup({ project, state }: { project: Project; state: State }) {
  const { stat } = useDurations()
  const sprints = state.sprints.filter(s => s.projectId === project.id && s.startedAt).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const [id, setId] = useState(sprints[0]?.id)
  const sprint = sprints.find(s => s.id === id) ?? sprints[0]
  const { board } = useBoard(apiEnabled ? sprint?.boardId : undefined)
  if (!sprint) return <NoData text="Start a sprint from the backlog to see its burnup." />
  const d = burnup(state, project, sprint, undefined, board?.workingDays)!
  const done = [...d.completed].reverse().find(v => !Number.isNaN(v)) ?? 0
  return <>
    <div className="report-tools">
      <Picker value={sprint.id} options={sprints.map(s => ({ value: s.id, label: s.name, hint: s.state === 'active' ? 'Active' : 'Closed' }))} onChange={setId} className="btn btn-secondary" title="Sprint" trigger={sprint.name} />
    </div>
    <div className="kpis">
      <div><b>{stat(d.scope[0] ?? 0, sprint.estimation)}</b><span>work scope</span></div>
      <div><b>{stat(done, sprint.estimation)}</b><span>completed</span></div>
    </div>
    <LineChart ariaLabel={`Burnup for ${sprint.name}`} labels={d.labels} height={300} series={[
      { label: 'Work scope', color: '#DC2626', values: d.scope }, { label: 'Completed', color: '#16A34A', values: d.completed },
      { label: 'Guideline', color: '#A8A29E', values: d.ideal, dashed: true }]} />
    <Legend items={[{ label: 'Work scope', color: '#DC2626' }, { label: 'Completed', color: '#16A34A' }, { label: 'Guideline', color: '#A8A29E', dashed: true }]} />
  </>
}

/** R2: one epic's total and completed work over time, and its three lists. */
export function EpicReport({ project, state }: { project: Project; state: State }) {
  const { estimation } = useStatistic(project)
  const epics = state.issues.filter(i => i.projectId === project.id && i.type === 'epic').sort((a, b) => a.rank - b.rank)
  const [id, setId] = useState(epics.find(e => categoryOf(project, e.status) !== 'done')?.id ?? epics[0]?.id)
  const epic = epics.find(e => e.id === id)
  if (!epic) return <NoData text="Create an epic and add work items to it to see its report." />
  const r = progressReport(state, project, { epic: epic.id }, { estimation, from: epic.createdAt })
  return <>
    <div className="report-tools">
      <Picker value={epic.id} options={epics.map(e => ({ value: e.id, label: `${e.key} ${e.title}` }))} onChange={setId} className="btn btn-secondary" title="Epic" trigger={epic.title} />
    </div>
    <Progress r={r} estimation={estimation} name={epic.title} />
  </>
}

/** R3: one version's progress, with its predicted release date. */
export function VersionReport({ project, state }: { project: Project; state: State }) {
  const { estimation } = useStatistic(project)
  const { stat } = useDurations()
  const versions = project.releases.filter(r => !r.archived)
  const [id, setId] = useState(versions.find(v => !v.released)?.id ?? versions[0]?.id)
  const v = versions.find(x => x.id === id)
  if (!v) return <NoData text="Create a version on the Releases page and give work items that fix version to see its report." />
  const from = v.startDate ? new Date(`${v.startDate}T00:00`).getTime() : undefined
  const to = v.released && v.releasedAt ? v.releasedAt : undefined
  const r = progressReport(state, project, { version: v.id }, { estimation, from, to })
  const total = r.total.at(-1) ?? 0, done = r.completed.at(-1) ?? 0
  const forecast = v.released ? null : predictRelease({ start: r.timeline[0] ?? Date.now(), now: Date.now(), total, completed: done })
  const date = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return <>
    <div className="report-tools">
      <Picker value={v.id} options={versions.map(x => ({ value: x.id, label: x.name, hint: x.released ? 'Released' : undefined }))} onChange={setId} className="btn btn-secondary" title="Version" trigger={v.name} />
      {v.releaseDate && <span className="muted">Release date {v.releaseDate}</span>}
    </div>
    {!v.released && <div className="kpis">
      <div><b>{forecast ? date(forecast.predicted) : '—'}</b><span>predicted release date</span></div>
      <div><b>{forecast ? date(forecast.optimistic) : '—'}</b><span>optimistic</span></div>
      <div><b>{forecast ? date(forecast.pessimistic) : '—'}</b><span>pessimistic</span></div>
      <div><b>{stat(total - done, estimation)}</b><span>remaining</span></div>
    </div>}
    {!forecast && !v.released && done === 0 && total > 0 && <p className="hint">A release date is predicted once some of this version’s work is done.</p>}
    <Progress r={r} estimation={estimation} name={v.name} />
  </>
}

function Progress({ r, estimation, name }: { r: ReturnType<typeof progressReport>; estimation: Estimation; name: string }) {
  const { stat } = useDurations()
  const { openIssue } = useApp()
  const all = r.lists.completed.length + r.lists.incomplete.length + r.lists.unestimated.length
  if (!all) return <NoData text="Nothing is in it yet." />
  const list = (title: string, items: Issue[]) => (
    <section className="panel" style={{ marginTop: 12 }} aria-label={title}>
      <h3 className="panel-title">{title} <span className="muted">· {plural(items.length, 'item')}</span></h3>
      {items.length === 0 ? <p className="muted sm">None.</p> : <ul className="report-list">
        {items.map(i => <li key={i.id}><button className="link-btn" onClick={() => openIssue(i.id)}><span className="mono">{i.key}</span> {i.title}</button></li>)}
      </ul>}
    </section>
  )
  return <>
    <div className="kpis">
      <div><b>{stat(r.total.at(-1) ?? 0, estimation)}</b><span>total</span></div>
      <div><b>{stat(r.completed.at(-1) ?? 0, estimation)}</b><span>completed</span></div>
      <div><b>{r.lists.unestimated.length}</b><span>unestimated</span></div>
    </div>
    <LineChart ariaLabel={`Progress of ${name}`} labels={r.labels} height={280}
      series={[{ label: 'Total', color: '#2563EB', values: r.total }, { label: 'Completed', color: '#16A34A', values: r.completed }]} />
    <Legend items={[{ label: 'Total', color: '#2563EB' }, { label: 'Completed', color: '#16A34A' }]} />
    {list('Completed', r.lists.completed)}{list('Incomplete', r.lists.incomplete)}{list('Unestimated', r.lists.unestimated)}
  </>
}

/** R4: an epic's (or a version's) work across sprints, and how many more sprints it needs. */
export function ScopeBurndown({ project, state, kind }: { project: Project; state: State; kind: 'epic' | 'version' }) {
  const { estimation } = useStatistic(project)
  const { stat } = useDurations()
  const options = kind === 'epic'
    ? state.issues.filter(i => i.projectId === project.id && i.type === 'epic').sort((a, b) => a.rank - b.rank).map(e => ({ value: e.id, label: `${e.key} ${e.title}`, done: categoryOf(project, e.status) === 'done' }))
    : project.releases.filter(r => !r.archived).map(r => ({ value: r.id, label: r.name, done: r.released }))
  const [id, setId] = useState(options.find(o => !o.done)?.value ?? options[0]?.value)
  const chosen = options.find(o => o.value === id)
  if (!chosen) return <NoData text={kind === 'epic' ? 'Create an epic to see its burndown.' : 'Create a version to see its burndown.'} />
  const sprints = state.sprints.filter(s => s.projectId === project.id)
  const r = scopeBurndown(state, project, kind === 'epic' ? { epic: chosen.value } : { version: chosen.value }, sprints, estimation)
  return <>
    <div className="report-tools">
      <Picker value={chosen.value} options={options.map(o => ({ value: o.value, label: o.label }))} onChange={setId} className="btn btn-secondary" title={kind === 'epic' ? 'Epic' : 'Version'} trigger={chosen.label} />
    </div>
    <div className="kpis">
      <div><b>{stat(r.remaining, estimation)}</b><span>remaining</span></div>
      <div><b>{r.forecast === null ? '—' : r.forecast === 0 ? 'Done' : `about ${r.forecast}`}</b><span>{r.forecast === 0 ? '' : 'more sprints'}</span></div>
    </div>
    {r.forecast === null && r.remaining > 0 && <p className="hint">A forecast appears once a sprint has completed some of its work.</p>}
    {!r.rows.length ? <NoData text="Its burndown appears once a sprint has started." /> : <>
      <ColumnChart ariaLabel={`${kind === 'epic' ? 'Epic' : 'Release'} burndown`} labels={r.rows.map(x => x.name)} height={300} series={[
        { label: 'Completed', color: '#16A34A', values: r.rows.map(x => x.completed) },
        { label: 'Remaining', color: '#2563EB', values: r.rows.map(x => x.remaining) },
        { label: 'Added', color: '#DC2626', values: r.rows.map(x => x.added) }]} />
      <Legend items={[{ label: 'Completed', color: '#16A34A' }, { label: 'Remaining', color: '#2563EB' }, { label: 'Added', color: '#DC2626' }]} />
    </>}
  </>
}
