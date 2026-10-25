import { useEffect, useState } from 'react'
import { Play, Plus, X } from 'lucide-react'
import { api } from '../../api/client'
import { sprintDeps } from '../../api/sprints'
import { useStore, userOf, timeAgo, type Issue, type Project } from '../../data/store'
import { useApp } from '../../appContext'
import { href, navigate } from '../../router'
import { Modal, plural } from '../ui'
import RunDialog from './RunDialog'
import { enc, message, ProgressBar, StatusLozenge, useProgress, useTestStatuses, type TestRun } from './shared'

// A Test Execution's runs (Xray's execution page), a Test Plan's executions, and a Test's runs in every execution.

export function ExecutionPanel({ issue, project, readOnly }: { issue: Issue; project: Project; readOnly: boolean }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const statuses = useTestStatuses()
  const [runs, setRuns] = useState<TestRun[] | null>(null)
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const progress = useProgress(issue.key, [tick])
  const base = `/api/issues/${enc(issue.key)}/runs`
  const reload = () => { api<TestRun[]>('GET', base).then(setRuns, e => toast(message(e), { tone: 'warn' })); setTick(t => t + 1) }
  useEffect(reload, [base])   // eslint-disable-line react-hooks/exhaustive-deps
  const remove = (r: TestRun) => api('DELETE', `${base}/${enc(r.testKey)}`).then(reload, e => toast(message(e), { tone: 'warn' }))
  const set = (patch: Partial<Issue>) => dispatch({ type: 'updateIssues', ids: [issue.id], patch })

  return (
    <section className="detail-section" aria-label="Test runs">
      <div className="section-title-row">
        <h2 className="section-title">Tests to run{runs ? <span className="muted"> · {runs.length}</span> : null}</h2>
        {!readOnly && <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Plus size={14} />Add tests</button>}
      </div>
      <div className="exec-meta">
        <label><span className="muted sm">Environments</span>
          <input className="input input-sm" readOnly={readOnly} aria-label="Test environments" placeholder="e.g. chrome, staging" defaultValue={(issue.testEnvironments ?? []).join(', ')}
            onBlur={e => { const v = [...new Set(e.target.value.split(',').map(x => x.trim()).filter(Boolean))]; if (v.join() !== (issue.testEnvironments ?? []).join()) set({ testEnvironments: v }) }} />
        </label>
        <label><span className="muted sm">Revision</span>
          <input className="input input-sm" readOnly={readOnly} aria-label="Revision" placeholder="Build or commit" defaultValue={issue.revision ?? ''}
            onBlur={e => e.target.value.trim() !== (issue.revision ?? '') && set({ revision: e.target.value.trim() })} />
        </label>
      </div>
      {progress && <ProgressBar statuses={statuses} {...progress} />}
      {runs?.length === 0 && <p className="muted sm">No tests yet.</p>}
      {!!runs?.length && (
        <table className="table run-table">
          <thead><tr><th>Test</th><th>Status</th><th>Run by</th><th>Finished</th><th /></tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id} onClick={() => setOpen(r.id)} style={{ cursor: 'pointer' }}>
                <td><span className="mono">{r.testKey}</span> {r.testTitle}</td>
                <td><StatusLozenge statuses={statuses} status={r.status} /></td>
                <td className="muted">{userOf(state, r.executedBy ?? undefined)?.name ?? ''}</td>
                <td className="muted">{r.finishedAt ? timeAgo(Date.parse(r.finishedAt)) : ''}</td>
                <td onClick={e => e.stopPropagation()}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setOpen(r.id)} aria-label={`Run ${r.testKey}`}><Play size={13} />Run</button>
                  {!readOnly && <button className="icon-btn sm" onClick={() => remove(r)} aria-label={`Remove ${r.testKey}`} title="Remove"><X size={13} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <RunDialog runId={open} readOnly={readOnly} onClose={() => setOpen(null)} onChanged={reload} />}
      {adding && <AddRunsDialog issue={issue} project={project} onClose={() => setAdding(false)}
        onAdded={n => { setAdding(false); reload(); toast(`Added ${plural(n, 'test')}`) }} />}
    </section>
  )
}

function AddRunsDialog({ issue, project, onClose, onAdded }: { issue: Issue; project: Project; onClose: () => void; onAdded: (n: number) => void }) {
  const { state } = useStore()
  const [mode, setMode] = useState<'pick' | 'from' | 'jql'>('pick')
  const [picked, setPicked] = useState<string[]>([])
  const [from, setFrom] = useState('')
  const [jql, setJql] = useState(`project = ${project.key} AND type = test`)
  const [error, setError] = useState('')
  const items = state.issues.filter(i => i.projectId === project.id)
  const tests = items.filter(i => i.type === 'test'), containers = items.filter(i => i.type === 'test_set' || i.type === 'test_plan')
  const ok = mode === 'pick' ? picked.length > 0 : mode === 'from' ? !!from : !!jql.trim()
  const add = () => api<{ added: number }>('POST', `/api/issues/${enc(issue.key)}/runs`, mode === 'pick' ? { keys: picked } : mode === 'from' ? { from } : { jql })
    .then(r => onAdded(r.added), e => setError(message(e)))
  return (
    <Modal title={`Add tests to ${issue.key}`} onClose={onClose} width={600} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!ok} onClick={add}>Add</button>
    </>}>
      <div className="segmented sm" role="radiogroup" aria-label="How to add">
        {([['pick', 'Choose'], ['from', 'From a set or plan'], ['jql', 'By JQL']] as const).map(([m, l]) => (
          <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{l}</button>
        ))}
      </div>
      {mode === 'pick' && (
        <ul className="pick-list">
          {tests.length === 0 && <li className="muted sm">No tests in this project.</li>}
          {tests.map(t => <li key={t.id}><label><input type="checkbox" checked={picked.includes(t.key)} onChange={e => setPicked(e.target.checked ? [...picked, t.key] : picked.filter(k => k !== t.key))} /><span className="mono">{t.key}</span> {t.title}</label></li>)}
        </ul>
      )}
      {mode === 'from' && (
        <select className="input" style={{ marginTop: 10 }} aria-label="Test Set or Test Plan" value={from} onChange={e => setFrom(e.target.value)}>
          <option value="">Choose a Test Set or Test Plan…</option>
          {containers.map(c => <option key={c.id} value={c.key}>{c.key} {c.title}</option>)}
        </select>
      )}
      {mode === 'jql' && <textarea className="input mono" rows={3} style={{ marginTop: 10 }} aria-label="JQL" value={jql} onChange={e => setJql(e.target.value)} />}
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

/** A Test Plan's executions, each with its progress, and the plan's own progress (each test's latest result). */
export function PlanExecutions({ issue, project, readOnly }: { issue: Issue; project: Project; readOnly: boolean }) {
  const { toast } = useApp()
  const statuses = useTestStatuses()
  const [execs, setExecs] = useState<Issue[] | null>(null)
  const [making, setMaking] = useState(false)
  const [tick, setTick] = useState(0)
  const progress = useProgress(issue.key, [tick])
  const load = () => { api<any[]>('GET', `/api/issues/${enc(issue.key)}/executions`).then(setExecs, e => toast(message(e), { tone: 'warn' })); setTick(t => t + 1) }
  useEffect(load, [issue.key])   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="detail-section" aria-label="Test executions">
      <div className="section-title-row">
        <h2 className="section-title">Test executions{execs ? <span className="muted"> · {execs.length}</span> : null}</h2>
        {!readOnly && <button className="btn btn-ghost btn-sm" onClick={() => setMaking(true)}><Play size={14} />Create execution</button>}
      </div>
      {progress && <><p className="muted sm">Plan progress (each test’s latest result)</p><ProgressBar statuses={statuses} {...progress} /></>}
      {execs?.length === 0 && <p className="muted sm">No executions yet.</p>}
      <ul className="test-members">
        {(execs ?? []).map(e => <ExecRow key={e.id} exec={e as any} statuses={statuses} />)}
      </ul>
      {making && <MakeExecution container={issue} project={project} onClose={() => setMaking(false)} onMade={async key => { setMaking(false); load(); toast(`Created ${key}`); await sprintDeps.reloadProject(project.id); navigate(href({ name: 'issue', key })) }} />}
    </section>
  )
}
function ExecRow({ exec, statuses }: { exec: { key: string; title: string; testEnvironments?: string[] }; statuses: any[] }) {
  const p = useProgress(exec.key)
  return (
    <li className="test-member exec-row">
      <a href={href({ name: 'issue', key: exec.key })} className="mono">{exec.key}</a>
      <span className="test-member-title">{exec.title}{exec.testEnvironments?.length ? <span className="muted sm"> · {exec.testEnvironments.join(', ')}</span> : null}</span>
      {p && <ProgressBar statuses={statuses} {...p} />}
    </li>
  )
}

/** A new Test Execution for a Test Plan or Test Set, with all its tests. */
export function MakeExecution({ container, project, onClose, onMade }: { container: Issue; project: Project; onClose: () => void; onMade: (key: string) => void }) {
  const [title, setTitle] = useState(`Run of ${container.title}`)
  const [envs, setEnvs] = useState('')
  const [releaseId, setReleaseId] = useState('')
  const [error, setError] = useState('')
  const make = () => api<{ key: string }>('POST', `/api/issues/${enc(container.key)}/executions`, {
    title: title.trim(), environments: [...new Set(envs.split(',').map(x => x.trim()).filter(Boolean))], ...(releaseId ? { releaseId } : {}),
  }).then(e => onMade(e.key), e => setError(message(e)))
  return (
    <Modal title="Create test execution" onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!title.trim()} onClick={make}>Create</button>
    </>}>
      <p className="muted sm">Every test in {container.key} gets a run.</p>
      <label className="label" htmlFor="ex-title">Title</label>
      <input id="ex-title" className="input" value={title} onChange={e => setTitle(e.target.value)} />
      <label className="label" htmlFor="ex-envs" style={{ marginTop: 10 }}>Environments</label>
      <input id="ex-envs" className="input" placeholder="e.g. chrome, staging" value={envs} onChange={e => setEnvs(e.target.value)} />
      {(project.releases?.length ?? 0) > 0 && <>
        <label className="label" htmlFor="ex-rel" style={{ marginTop: 10 }}>Fix version</label>
        <select id="ex-rel" className="input" value={releaseId} onChange={e => setReleaseId(e.target.value)}>
          <option value="">None</option>{project.releases!.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </>}
      {error && <p className="hint error" role="alert">{error}</p>}
    </Modal>
  )
}

/** On a Test: its runs in every execution, newest first. */
export function TestRuns({ issue, readOnly }: { issue: Issue; readOnly: boolean }) {
  const statuses = useTestStatuses()
  const [runs, setRuns] = useState<TestRun[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = () => { api<TestRun[]>('GET', `/api/issues/${enc(issue.key)}/runs`).then(setRuns, () => setRuns([])) }
  useEffect(load, [issue.key])   // eslint-disable-line react-hooks/exhaustive-deps
  if (!runs?.length) return null
  return (
    <section className="detail-section" aria-label="Runs">
      <h2 className="section-title">Runs<span className="muted"> · {runs.length}</span></h2>
      <ul className="test-members">
        {runs.map(r => (
          <li key={r.id} className="test-member" onClick={() => setOpen(r.id)} style={{ cursor: 'pointer' }}>
            <StatusLozenge statuses={statuses} status={r.status} />
            <span className="mono">{r.executionKey}</span>
            <span className="test-member-title">{r.executionTitle}</span>
            <span className="muted sm">{r.finishedAt ? timeAgo(Date.parse(r.finishedAt)) : r.environments.join(', ')}</span>
          </li>
        ))}
      </ul>
      {open && <RunDialog runId={open} readOnly={readOnly} onClose={() => setOpen(null)} onChanged={load} />}
    </section>
  )
}
