import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { api } from '../../api/client'
import { csvCell } from '../../../server/src/shared/csv.ts'
import { useStore, userOf, timeAgo, type Project } from '../../data/store'
import { href } from '../../router'
import { plural } from '../ui'
import { COVERAGE, CoverageLozenge } from './CoveragePanel'
import { enc, message, ResultLozenge, StatusLozenge, useTestStatuses, type TestRun } from './shared'

// The testing reports (Xray's): requirement coverage, traceability (requirement → tests → results → defects) and test
// runs, each in a scope (latest results, a version or a plan, optionally one environment) and each as a CSV file.

type Coverage = keyof typeof COVERAGE
interface TraceRow { id: string; key: string; title: string; type: string; status: Coverage; tests: { id: string; key: string; title: string; status: string | null; defects: { id: string; key: string; title: string; done: boolean }[] }[] }

function useScope(project: Project) {
  const { state } = useStore()
  const [scope, setScope] = useState('')
  const [env, setEnv] = useState('')
  const plans = state.issues.filter(i => i.projectId === project.id && i.type === 'test_plan')
  const envs = [...new Set(state.issues.filter(i => i.projectId === project.id && i.type === 'test_execution').flatMap(i => i.testEnvironments ?? []))]
  const query = new URLSearchParams({ ...(scope.startsWith('v:') ? { version: scope.slice(2) } : {}), ...(scope.startsWith('p:') ? { plan: scope.slice(2) } : {}), ...(env ? { environment: env } : {}) }).toString()
  const picker = (
    <div className="exec-meta report-scope">
      <select className="input input-sm" aria-label="Report scope" value={scope} onChange={e => setScope(e.target.value)}>
        <option value="">Latest results</option>
        {project.releases.map(r => <option key={r.id} value={`v:${r.id}`}>Version {r.name}</option>)}
        {plans.map(p => <option key={p.id} value={`p:${p.key}`}>Plan {p.key} {p.title}</option>)}
      </select>
      <select className="input input-sm" aria-label="Environment" value={env} onChange={e => setEnv(e.target.value)}>
        <option value="">All environments</option>{envs.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
    </div>
  )
  return { query, picker }
}
function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { setData(null); api<T>('GET', path).then(d => { setData(d); setError('') }, e => setError(message(e))) }, [path])
  return { data, error }
}
const download = (name: string, rows: (string | number | null)[][]) => {
  const url = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }))
  Object.assign(document.createElement('a'), { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function CoverageReport({ project }: { project: Project }) {
  const { query, picker } = useScope(project)
  const { data, error } = useLoad<TraceRow[]>(`/api/projects/${enc(project.key)}/reports/traceability${query ? `?${query}` : ''}`)
  const counts = (Object.keys(COVERAGE) as Coverage[]).map(k => [k, data?.filter(r => r.status === k).length ?? 0] as const)
  return <>
    {picker}
    {error && <p className="hint error" role="alert">{error}</p>}
    {data && <>
      <div className="test-progress-bar coverage-bar" role="img" aria-label={counts.filter(([, n]) => n).map(([k, n]) => `${n} ${COVERAGE[k].label}`).join(', ') || 'No requirements'}>
        {counts.map(([k, n]) => n ? <span key={k} style={{ width: `${(100 * n) / Math.max(1, data.length)}%`, background: COVERAGE[k].color }} /> : null)}
      </div>
      <div className="coverage-legend">{counts.map(([k, n]) => <span key={k}><CoverageLozenge status={k} /> {n}</span>)}</div>
      <p className="muted sm">{plural(data.length, 'requirement')} · {data.length ? Math.round((100 * data.filter(r => r.status !== 'UNCOVERED').length) / data.length) : 0}% covered by tests</p>
      <table className="table">
        <thead><tr><th>Requirement</th><th>Coverage</th><th className="col-num">Tests</th></tr></thead>
        <tbody>{data.map(r => (
          <tr key={r.id}><td><a href={href({ name: 'issue', key: r.key })} className="mono">{r.key}</a> {r.title}</td><td><CoverageLozenge status={r.status} /></td><td className="col-num">{r.tests.length}</td></tr>
        ))}</tbody>
      </table>
      <button className="btn btn-secondary btn-sm" onClick={() => download(`${project.key}-requirement-coverage.csv`, [['Requirement', 'Title', 'Coverage', 'Tests'], ...data.map(r => [r.key, r.title, COVERAGE[r.status].label, r.tests.length])])}><Download size={14} />CSV</button>
    </>}
  </>
}

export function TraceabilityReport({ project }: { project: Project }) {
  const statuses = useTestStatuses()
  const { query, picker } = useScope(project)
  const { data, error } = useLoad<TraceRow[]>(`/api/projects/${enc(project.key)}/reports/traceability${query ? `?${query}` : ''}`)
  const name = (k: string | null) => (k ? statuses.find(s => s.kind === 'run' && s.key === k)?.name ?? k : 'Not run')
  return <>
    {picker}
    {error && <p className="hint error" role="alert">{error}</p>}
    {data && <>
      <table className="table trace-table">
        <thead><tr><th>Requirement</th><th>Coverage</th><th>Test</th><th>Result</th><th>Defects</th></tr></thead>
        <tbody>{data.flatMap(r => (r.tests.length ? r.tests : [null]).map((t, n) => (
          <tr key={`${r.id}:${t?.id ?? ''}`} className={n ? 'trace-cont' : ''}>
            <td>{n === 0 && <><a href={href({ name: 'issue', key: r.key })} className="mono">{r.key}</a> {r.title}</>}</td>
            <td>{n === 0 && <CoverageLozenge status={r.status} />}</td>
            <td>{t ? <><a href={href({ name: 'issue', key: t.key })} className="mono">{t.key}</a> {t.title}</> : <span className="muted">No tests</span>}</td>
            <td>{t && <ResultLozenge statuses={statuses} status={t.status} />}</td>
            <td>{t?.defects.map(d => <a key={d.id} href={href({ name: 'issue', key: d.key })} className={`mono trace-defect${d.done ? ' is-done' : ''}`} title={d.title}>{d.key}</a>)}</td>
          </tr>
        )))}</tbody>
      </table>
      <button className="btn btn-secondary btn-sm" onClick={() => download(`${project.key}-traceability.csv`, [['Requirement', 'Title', 'Coverage', 'Test', 'Test title', 'Result', 'Defects'],
        ...data.flatMap(r => (r.tests.length ? r.tests.map(t => [r.key, r.title, COVERAGE[r.status].label, t.key, t.title, name(t.status), t.defects.map(d => d.key).join(' ')]) : [[r.key, r.title, COVERAGE[r.status].label, '', '', '', '']]))])}><Download size={14} />CSV</button>
    </>}
  </>
}

export function TestRunsReport({ project }: { project: Project }) {
  const { state } = useStore()
  const statuses = useTestStatuses()
  const { query, picker } = useScope(project)
  const [status, setStatus] = useState('')
  const q = [query, status ? `status=${enc(status)}` : ''].filter(Boolean).join('&')
  const { data, error } = useLoad<TestRun[]>(`/api/projects/${enc(project.key)}/reports/test-runs${q ? `?${q}` : ''}`)
  const name = (k: string) => statuses.find(s => s.kind === 'run' && s.key === k)?.name ?? k
  return <>
    {picker}
    <select className="input input-sm" style={{ maxWidth: 200, marginBottom: 10 }} aria-label="Run status" value={status} onChange={e => setStatus(e.target.value)}>
      <option value="">Any status</option>{statuses.filter(s => s.kind === 'run').map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
    </select>
    {error && <p className="hint error" role="alert">{error}</p>}
    {data && <>
      <table className="table">
        <thead><tr><th>Test</th><th>Execution</th><th>Status</th><th>Run by</th><th>Finished</th><th className="col-num">Defects</th></tr></thead>
        <tbody>{data.map(r => (
          <tr key={r.id}>
            <td><a href={href({ name: 'issue', key: r.testKey })} className="mono">{r.testKey}</a> {r.testTitle}</td>
            <td><a href={href({ name: 'issue', key: r.executionKey })} className="mono">{r.executionKey}</a></td>
            <td><StatusLozenge statuses={statuses} status={r.status} /></td>
            <td className="muted">{userOf(state, r.executedBy ?? undefined)?.name ?? ''}</td>
            <td className="muted">{r.finishedAt ? timeAgo(Date.parse(r.finishedAt)) : ''}</td>
            <td className="col-num">{r.defectIds.length || ''}</td>
          </tr>
        ))}</tbody>
      </table>
      <button className="btn btn-secondary btn-sm" onClick={() => download(`${project.key}-test-runs.csv`, [['Test', 'Title', 'Execution', 'Environments', 'Status', 'Run by', 'Started', 'Finished', 'Defects'],
        ...data.map(r => [r.testKey, r.testTitle, r.executionKey, r.environments.join(' '), name(r.status), userOf(state, r.executedBy ?? undefined)?.name ?? '', r.startedAt ?? '', r.finishedAt ?? '', r.defectIds.length])])}><Download size={14} />CSV</button>
    </>}
  </>
}
