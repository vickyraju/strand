import { createContext, useContext, useEffect, useState } from 'react'
import { useBoard } from '../api/boards'
import { useDurations } from '../api/settings-public'
import { TrendingDown, ClipboardCheck, BarChart3, Layers, ArrowLeftRight, Users, ShieldCheck, GitMerge, ListChecks, Activity, TrendingUp, Zap, Rocket } from 'lucide-react'
import { Burnup, EpicReport, ScopeBurndown, VersionReport } from './AgileReports'
import ControlChart from './ControlChart'
import { useStore, userOf, isDone, statOf, CATEGORY_COLOR, type Project } from '../data/store'
import { burndown, velocity, cumulativeFlow, createdVsResolved, dayLabel } from '../data/analytics'
import { useApp } from '../appContext'
import { useReportState } from '../api/reports'
import { api, apiEnabled, errorMessage } from '../api/client'
import { CoverageReport, TraceabilityReport, TestRunsReport } from './testing/TestReports'
import type { State } from '../data/reducer'
import { LineChart, ColumnChart, Legend, HBars } from './charts'
import { Avatar, ConfirmDialog, Empty, Picker, typeMeta, plural, priorityLabel } from './ui'
import { can } from '../data/access'

type ReportId = 'sprint' | 'burndown' | 'burnup' | 'velocity' | 'epic' | 'version' | 'epic-burndown' | 'release-burndown' | 'cfd' | 'created' | 'control' | 'workload' | 'test-coverage' | 'traceability' | 'test-runs'

const REPORTS: { id: ReportId; name: string; desc: string; Icon: typeof Layers; scrum?: boolean; testing?: boolean; server?: boolean }[] = [
  { id: 'sprint',   name: 'Sprint report',   desc: 'What a sprint completed, what it didn’t, and what changed while it ran.', Icon: ClipboardCheck, scrum: true },
  { id: 'burndown', name: 'Sprint burndown', desc: 'Work remaining in a sprint against the ideal pace.', Icon: TrendingDown, scrum: true },
  { id: 'burnup',   name: 'Burnup',          desc: 'A sprint’s scope and the work completed, against the guideline.', Icon: TrendingUp, scrum: true },
  { id: 'epic-burndown', name: 'Epic burndown', desc: 'An epic’s work per sprint: completed, remaining and added, and how many sprints are left.', Icon: TrendingDown, scrum: true },
  { id: 'release-burndown', name: 'Release burndown', desc: 'A version’s work per sprint: completed, remaining and added, and how many sprints are left.', Icon: TrendingDown, scrum: true },
  { id: 'velocity', name: 'Velocity',        desc: 'Points committed vs completed per sprint.',         Icon: BarChart3, scrum: true },
  { id: 'epic',     name: 'Epic report',     desc: 'An epic’s total and completed work over time, and its items.', Icon: Zap },
  { id: 'version',  name: 'Version report',  desc: 'A version’s progress and its predicted release date.', Icon: Rocket },
  { id: 'cfd',      name: 'Cumulative flow', desc: 'Work in each stage over time. Widening bands mean bottlenecks.', Icon: Layers },
  { id: 'created',  name: 'Created vs resolved', desc: 'Is the backlog growing or shrinking?',          Icon: ArrowLeftRight },
  { id: 'control',  name: 'Control chart',   desc: 'How long each item spent in the columns you choose, with the average and the rolling average.', Icon: Activity, server: true },
  { id: 'workload', name: 'Workload',        desc: 'Open items and points per person.',                 Icon: Users },
  { id: 'test-coverage', name: 'Requirement coverage', desc: 'Which requirements are tested, and how they are doing.', Icon: ShieldCheck, testing: true },
  { id: 'traceability', name: 'Traceability', desc: 'Each requirement, its tests, their results and the defects found.', Icon: GitMerge, testing: true },
  { id: 'test-runs', name: 'Test runs', desc: 'Every run in a scope, newest first.', Icon: ListChecks, testing: true },
]

/** The state the reports read: complete items and history for the project (see useReportState). */
const ReportState = createContext<State | null>(null)
const useReport = () => ({ state: useContext(ReportState)! })

export default function ReportsView({ project, report }: { project: Project; report?: string }) {
  const { openProject } = useApp()
  const data = useReportState(project)
  const available = REPORTS.filter(r => (!r.scrum || project.template === 'scrum') && (!r.testing || (project.testing && apiEnabled)) && (!r.server || apiEnabled))
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
        {current.id === 'test-coverage' ? <CoverageReport project={project} />
          : current.id === 'traceability' ? <TraceabilityReport project={project} />
          : current.id === 'test-runs' ? <TestRunsReport project={project} />
          : current.id === 'control' ? <ControlChart project={project} />
          : data.error ? <p className="hint error" role="alert">{data.error}</p>
          : !data.state ? <p className="muted" role="status">Loading the project's history…</p>
          : <ReportState.Provider value={data.state}>
        {current.id === 'sprint'   && <SprintReport project={project} />}
        {current.id === 'burndown' && <Burndown project={project} />}
        {current.id === 'velocity' && <Velocity project={project} />}
        {current.id === 'burnup'   && <Burnup project={project} state={data.state} />}
        {current.id === 'epic'     && <EpicReport project={project} state={data.state} />}
        {current.id === 'version'  && <VersionReport project={project} state={data.state} />}
        {current.id === 'epic-burndown' && <ScopeBurndown key="epic" project={project} state={data.state} kind="epic" />}
        {current.id === 'release-burndown' && <ScopeBurndown key="version" project={project} state={data.state} kind="version" />}
        {current.id === 'cfd'      && <Flow project={project} />}
        {current.id === 'created'  && <CreatedResolved project={project} />}
        {current.id === 'workload' && <Workload project={project} />}
          </ReportState.Provider>}
      </section>
    </div>
  )
}

const RANGE_OPTIONS = [{ value: 14, label: 'Last 14 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }]

function NoData({ text }: { text: string }) {
  return <Empty icon={<BarChart3 size={22} strokeWidth={1.5} />} title="Not enough data yet" body={text} />
}

function Burndown({ project }: { project: Project }) {
  const { stat } = useDurations()                        // totals in the sprint's estimation statistic (spec 0404)
  const { state } = useReport()
  const sprints = state.sprints.filter(s => s.projectId === project.id && s.startedAt)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const [id, setId] = useState(sprints[0]?.id)
  const sprint = sprints.find(s => s.id === id) ?? sprints[0]
  const { board } = useBoard(apiEnabled ? sprint?.boardId : undefined)        // its working days (spec 0405)
  if (!sprint) return <NoData text="Start a sprint from the backlog to see its burndown." />
  const data = burndown(state, project, sprint, undefined, board?.workingDays)!
  const remaining = [...data.remaining].reverse().find(v => !Number.isNaN(v)) ?? data.total
  const pts = data.members.reduce((n, i) => n + statOf(i, sprint.estimation), 0)

  return (
    <>
      <div className="report-tools">
        <Picker value={sprint.id} options={sprints.map(s => ({ value: s.id, label: s.name, hint: s.state === 'active' ? 'Active' : 'Closed' }))}
          onChange={setId} className="btn btn-secondary" title="Sprint" trigger={sprint.name} />
        <span className="muted">{dayLabel(sprint.startedAt!)} – {dayLabel(sprint.completedAt ?? sprint.endsAt ?? Date.now())}</span>
      </div>
      <div className="kpis">
        <div><b>{stat(data.total, sprint.estimation)}</b><span>committed</span></div>
        <div><b>{stat(remaining, sprint.estimation)}</b><span>remaining</span></div>
        <div><b>{plural(data.members.length, 'item')}</b><span>in sprint{pts !== data.total ? ` (${stat(pts, sprint.estimation)} now)` : ''}</span></div>
      </div>
      <BurndownChart data={data} name={sprint.name} />
    </>
  )
}

/** A sprint's burndown: the remaining points against the guideline (Jira's red and grey lines). */
function BurndownChart({ data, name }: { data: NonNullable<ReturnType<typeof burndown>>; name: string }) {
  if (data.total === 0) return <NoData text="Add story point estimates to the sprint’s work items to see the burndown." />
  return <>
    <LineChart ariaLabel={`Burndown for ${name}`} labels={data.labels} height={300}
      series={[
        { label: 'Remaining', color: '#DC2626', values: data.remaining },
        { label: 'Guideline', color: '#A8A29E', values: data.ideal, dashed: true },
      ]} />
    <Legend items={[{ label: 'Remaining points', color: '#DC2626' }, { label: 'Guideline', color: '#A8A29E', dashed: true }]} />
  </>
}

interface ReportRow { key: string; title: string; type: string; priority: string; status: string; points: number | null; addedAfterStart: boolean }
interface SprintReportData { completed: ReportRow[]; notCompleted: ReportRow[]; completedOutside: ReportRow[]; removed: ReportRow[]; totals: Record<string, number> }
const SECTIONS: [keyof Omit<SprintReportData, 'totals'>, string][] = [
  ['completed', 'Completed Issues'], ['notCompleted', 'Issues Not Completed'],
  ['completedOutside', 'Issues completed outside of this sprint'], ['removed', 'Issues Removed From Sprint'],
]

/** Jira's Sprint Report (spec 0402): one started sprint's burndown, then what it completed, what it didn't, what was
 *  already done when it joined, and what was taken out; points as they were at the start (* added later). */
function SprintReport({ project }: { project: Project }) {
  const { stat } = useDurations()                        // totals in the sprint's estimation statistic (spec 0404)
  const { state } = useReport()
  const live = useStore()                       // reopening and deleting change the live workspace (the report reads a copy)
  const { openIssue, toast } = useApp()
  const [deleting, setDeleting] = useState(false)
  const sprints = state.sprints.filter(s => s.projectId === project.id && s.startedAt).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const [id, setId] = useState(sprints[0]?.id)
  const sprint = sprints.find(s => s.id === id) ?? sprints[0]
  const [report, setReport] = useState<{ id: string; data?: SprintReportData; error?: string } | null>(null)
  useEffect(() => {
    if (!sprint || !apiEnabled) return
    let live = true
    api<SprintReportData>('GET', `/api/projects/${project.key}/sprints/${sprint.id}/report`)
      .then(data => live && setReport({ id: sprint.id, data }), e => live && setReport({ id: sprint.id, error: errorMessage(e) }))
    return () => { live = false }
  }, [project.key, sprint?.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const { board } = useBoard(apiEnabled ? sprint?.boardId : undefined)        // its working days (spec 0405)
  if (!sprint) return <NoData text="Start a sprint from the backlog to see its report." />
  if (!apiEnabled) return <NoData text="The sprint report needs Strand to be connected to a server." />
  const data = burndown(state, project, sprint, undefined, board?.workingDays)!
  const r = report?.id === sprint.id ? report : null
  const added = r?.data && SECTIONS.some(([k]) => r.data![k].some(x => x.addedAfterStart))
  return (
    <>
      <div className="report-tools">
        <Picker value={sprint.id} options={sprints.map(s => ({ value: s.id, label: s.name, hint: s.state === 'active' ? 'Active' : 'Closed' }))}
          onChange={setId} className="btn btn-secondary" title="Sprint" trigger={sprint.name} />
        <span className="muted">{dayLabel(sprint.startedAt!)} – {dayLabel(sprint.completedAt ?? sprint.endsAt ?? Date.now())}{sprint.state === 'active' ? ' · active' : ''}</span>
        {/* Jira's Sprint Report actions for a completed sprint (spec 0403) */}
        {sprint.state === 'closed' && can(project, 'manageSprints') && <>
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={() => { live.dispatch({ type: 'reopenSprint', id: sprint.id }); toast(`${sprint.name} reopened`) }}>Reopen sprint</button>
          <button className="btn btn-secondary text-danger" onClick={() => setDeleting(true)}>Delete sprint</button>
        </>}
      </div>
      {deleting && <ConfirmDialog title={`Delete ${sprint.name}?`} action="Delete sprint" onClose={() => setDeleting(false)}
        onConfirm={() => { live.dispatch({ type: 'deleteSprint', id: sprint.id }); setDeleting(false); toast(`${sprint.name} deleted`) }}>
        <p>It goes for good, and no longer shows in velocity. Work it didn’t complete moves to the board’s next planned sprint, or the backlog; work it completed keeps no sprint.</p>
      </ConfirmDialog>}
      {sprint.goal && <p><b>Goal:</b> {sprint.goal}</p>}
      <BurndownChart data={data} name={sprint.name} />
      {!r ? <p className="muted" role="status">Loading the sprint’s work…</p>
        : r.error ? <p className="hint error" role="alert">{r.error}</p>
        : SECTIONS.map(([k, title]) => r.data![k].length > 0 && (
          <section key={k} aria-label={title} style={{ marginTop: 20 }}>
            <h3 className="section-label">{title} <span className="muted">· {plural(r.data![k].length, 'item')} · {stat(r.data!.totals[k] ?? 0, sprint.estimation)}</span></h3>
            <table className="table">
              <thead><tr><th>Key</th><th>Summary</th><th>Type</th><th>Priority</th><th>Status</th><th className="col-num">{sprint.estimation === 'time' ? 'Estimate' : sprint.estimation === 'count' ? 'Count' : 'Points'}</th></tr></thead>
              <tbody>{r.data![k].map(x => (
                <tr key={x.key} onClick={() => openIssue(x.key)}>
                  <td className="nowrap">{x.key}{x.addedAfterStart && <span title="Added after the sprint started"> *</span>}</td>
                  <td>{x.title}</td><td>{typeMeta(x.type, project).label}</td><td>{priorityLabel(x.priority)}</td><td>{x.status}</td>
                  <td className="col-num">{x.points == null ? '—' : sprint.estimation === 'time' ? stat(x.points, 'time') : x.points}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        ))}
      {added && <p className="muted sm">* Added after the sprint started. Points are as they were at the start, or when the sprint completed for work added later.</p>}
    </>
  )
}

function Velocity({ project }: { project: Project }) {
  const { state } = useReport()
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
  const { state } = useReport()
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
  const { state } = useReport()
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

function Workload({ project }: { project: Project }) {
  const { state } = useReport()
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
