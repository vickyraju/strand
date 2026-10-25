import { useEffect, useState } from 'react'
import { Link2 } from 'lucide-react'
import { api } from '../../api/client'
import { useStore, type Issue, type Project } from '../../data/store'
import { useApp } from '../../appContext'
import { href } from '../../router'
import { Modal } from '../ui'
import { enc, message, ResultLozenge, useTestStatuses } from './shared'

// A requirement's test coverage (Xray's): how its tests (and its sub-requirements' tests) are doing, in a scope: the
// latest results, a fix version, or a Test Plan, optionally in one environment. The server applies Xray's rules.

type Coverage = 'OK' | 'NOK' | 'NOTRUN' | 'UNKNOWN' | 'UNCOVERED'
interface Result { status: Coverage; own: Coverage; tests: { id: string; key: string; title: string; status: string | null }[]; subRequirements: { id: string; key: string; title: string; status: Coverage }[] }
export const COVERAGE: Record<Coverage, { label: string; color: string; hint: string }> = {
  OK: { label: 'OK', color: '#16A34A', hint: 'Every test passed' },
  NOK: { label: 'NOK', color: '#DC2626', hint: 'A test failed' },
  NOTRUN: { label: 'Not run', color: '#78716C', hint: 'Some tests haven’t been run (none failed)' },
  UNKNOWN: { label: 'Unknown', color: '#9333EA', hint: 'A result means “unknown” (none failed)' },
  UNCOVERED: { label: 'Uncovered', color: '#A8A29E', hint: 'No tests cover it' },
}
export const CoverageLozenge = ({ status }: { status: Coverage }) =>
  <span className="test-lozenge" style={{ background: COVERAGE[status].color }} title={COVERAGE[status].hint}>{COVERAGE[status].label}</span>

/** Does this work type count as a requirement in this project (Xray's coverage)? */
export const isRequirement = (project: Project, type: string) =>
  !!project.testing && (project.requirementTypes ? project.requirementTypes.includes(type) : !['bug', 'test', 'precondition', 'test_set', 'test_plan', 'test_execution'].includes(type))

export default function CoveragePanel({ issue, project, readOnly }: { issue: Issue; project: Project; readOnly: boolean }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const statuses = useTestStatuses()
  const [scope, setScope] = useState('')                 // '' latest | v:<release id> | p:<plan key>
  const [env, setEnv] = useState('')
  const [res, setRes] = useState<Result | null>(null)
  const [linking, setLinking] = useState(false)
  const plans = state.issues.filter(i => i.projectId === project.id && i.type === 'test_plan')
  const envs = [...new Set(state.issues.filter(i => i.projectId === project.id && i.type === 'test_execution').flatMap(i => i.testEnvironments ?? []))]
  const q = new URLSearchParams({ ...(scope.startsWith('v:') ? { version: scope.slice(2) } : {}), ...(scope.startsWith('p:') ? { plan: scope.slice(2) } : {}), ...(env ? { environment: env } : {}) }).toString()
  const load = () => api<Result>('GET', `/api/issues/${enc(issue.key)}/coverage${q ? `?${q}` : ''}`).then(setRes, e => toast(message(e), { tone: 'warn' }))
  useEffect(() => { void load() }, [issue.key, q, issue.links.length])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="detail-section" aria-label="Test coverage">
      <div className="section-title-row">
        <h2 className="section-title">Test coverage {res && <CoverageLozenge status={res.status} />}</h2>
        {!readOnly && <button className="btn btn-ghost btn-sm" onClick={() => setLinking(true)}><Link2 size={14} />Add a test</button>}
      </div>
      <div className="exec-meta">
        <select className="input input-sm" aria-label="Coverage scope" value={scope} onChange={e => setScope(e.target.value)}>
          <option value="">Latest results</option>
          {project.releases.map(r => <option key={r.id} value={`v:${r.id}`}>Version {r.name}</option>)}
          {plans.map(p => <option key={p.id} value={`p:${p.key}`}>Plan {p.key} {p.title}</option>)}
        </select>
        <select className="input input-sm" aria-label="Environment" value={env} onChange={e => setEnv(e.target.value)}>
          <option value="">All environments</option>
          {envs.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      {res && res.tests.length === 0 && res.subRequirements.every(s => s.status === 'UNCOVERED') && <p className="muted sm">No tests cover this yet.</p>}
      {res && res.tests.length > 0 && (
        <ul className="test-members">
          {res.tests.map(t => (
            <li key={t.id} className="test-member">
              <ResultLozenge statuses={statuses} status={t.status} />
              <a href={href({ name: 'issue', key: t.key })} className="mono">{t.key}</a>
              <span className="test-member-title">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
      {res && res.subRequirements.some(s => s.status !== 'UNCOVERED') && <>
        <p className="test-folder-label">Sub-requirements</p>
        <ul className="test-members">
          {res.subRequirements.map(s => (
            <li key={s.id} className="test-member"><CoverageLozenge status={s.status} /><a href={href({ name: 'issue', key: s.key })} className="mono">{s.key}</a><span className="test-member-title">{s.title}</span></li>
          ))}
        </ul>
      </>}
      {linking && <LinkTest issue={issue} project={project} onClose={() => setLinking(false)}
        onLink={test => api('POST', `/api/issues/${enc(test.key)}/links`, { type: 'tests', targetKey: issue.key }).then(() => {
          dispatch({ type: 'addLink', issueId: test.id, link: { type: 'tests', issueId: issue.id } })   // the server has it already: saving it again changes nothing
          setLinking(false); toast(`${test.key} now tests ${issue.key}`); void load()
        }, e => toast(message(e), { tone: 'warn' }))} />}
    </section>
  )
}

function LinkTest({ issue, project, onClose, onLink }: { issue: Issue; project: Project; onClose: () => void; onLink: (t: Issue) => void }) {
  const { state } = useStore()
  const [q, setQ] = useState('')
  const covering = new Set(state.issues.filter(i => i.links.some(l => l.type === 'tests' && l.issueId === issue.id)).map(i => i.id))
  const tests = state.issues.filter(i => i.projectId === project.id && i.type === 'test' && !covering.has(i.id)
    && (!q.trim() || `${i.key} ${i.title}`.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 100)
  return (
    <Modal title={`A test for ${issue.key}`} onClose={onClose}>
      <input className="input" autoFocus placeholder="Find a test by key or title" aria-label="Find a test" value={q} onChange={e => setQ(e.target.value)} />
      <ul className="pick-list">
        {tests.length === 0 && <li className="muted sm">No tests to add.</li>}
        {tests.map(t => <li key={t.id}><button className="link-btn" onClick={() => onLink(t)}><span className="mono">{t.key}</span> {t.title}</button></li>)}
      </ul>
    </Modal>
  )
}
