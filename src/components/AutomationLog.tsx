import { useEffect, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { Project, RuleAction } from '../data/store'
import { timeAgo } from '../data/store'
import { Modal } from './ui'

// Automation's audit log (Jira's): each run of a rule, what started it, the item, what every action did. And a dry
// run: what a rule's actions would do to a work item, with nothing changed.

interface Step { action: string; outcome: 'done' | 'skipped' | 'unchanged' | 'failed'; note?: string }
interface Run { id: string; ruleId: string; rule: string; issueKey: string | null; result: 'success' | 'some_skipped' | 'no_change' | 'failed'; steps: Step[]; error: string | null; at: string }

const RESULT: Record<Run['result'], { label: string; tone: string }> = {
  success: { label: 'Success', tone: 'lozenge-done' }, some_skipped: { label: 'Some actions skipped', tone: 'lozenge-in-progress' },
  no_change: { label: 'No changes needed', tone: 'lozenge-todo' }, failed: { label: 'Failed', tone: 'lozenge-danger' },
}
const OUTCOME: Record<Step['outcome'], string> = { done: 'done', skipped: 'skipped', unchanged: 'already so', failed: 'failed' }
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach the server.')

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="change-list">
      {steps.map((s, i) => <li key={i}><b>{s.action}</b>: {OUTCOME[s.outcome]}{s.note ? `, ${s.note}` : ''}</li>)}
    </ul>
  )
}

export function AuditLogDialog({ project, ruleId, onClose }: { project: Project; ruleId?: string; onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)
  useEffect(() => {
    const q = new URLSearchParams({ limit: '100', ...(ruleId ? { rule: ruleId } : {}), ...(failedOnly ? { result: 'failed' } : {}) })
    setRuns(null)
    api<Run[]>('GET', `/api/projects/${encodeURIComponent(project.key)}/automation/runs?${q}`).then(setRuns, e => setError(message(e)))
  }, [project.key, ruleId, failedOnly])
  return (
    <Modal title={ruleId ? `Audit log · ${project.rules.find(r => r.id === ruleId)?.name ?? 'rule'}` : 'Automation audit log'} onClose={onClose} width={680}>
      <label className="check-row" style={{ marginBottom: 8 }}><input type="checkbox" checked={failedOnly} onChange={e => setFailedOnly(e.target.checked)} />Only failures</label>
      {error && <p className="hint error" role="alert">{error}</p>}
      {!runs && !error && <p className="muted" role="status">Loading…</p>}
      {runs && !runs.length && <p className="muted">No runs in the last 90 days.</p>}
      {runs && runs.length > 0 && (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>When</th>{!ruleId && <th>Rule</th>}<th>Work item</th><th>Result</th><th>What happened</th></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id} style={{ cursor: 'default', verticalAlign: 'top' }}>
                  <td className="muted sm" title={new Date(r.at).toLocaleString()}>{timeAgo(Date.parse(r.at))}</td>
                  {!ruleId && <td>{r.rule}</td>}
                  <td className="mono">{r.issueKey ?? <span className="muted">deleted</span>}</td>
                  <td><span className={`lozenge ${RESULT[r.result].tone}`}>{RESULT[r.result].label}</span></td>
                  <td className="sm">{r.error ? <span className="text-danger">{r.error}</span> : <StepList steps={r.steps} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}

/** In the rule editor: try the actions on a work item, see what they would do. */
export function DryRun({ project, actions }: { project: Project; actions: RuleAction[] }) {
  const [key, setKey] = useState('')
  const [out, setOut] = useState<{ steps: Step[]; error: string | null } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = () => {
    setBusy(true); setError(''); setOut(null)
    api<{ steps: Step[]; error: string | null }>('POST', `/api/projects/${encodeURIComponent(project.key)}/automation/dry-run`, { issue: key.trim(), actions })
      .then(setOut, e => setError(message(e))).finally(() => setBusy(false))
  }
  return (
    <div className="dry-run">
      <div className="form-row" style={{ alignItems: 'center' }}>
        <span className="muted sm">Try it on</span>
        <input className="input input-sm" style={{ width: 120 }} aria-label="Work item to try the rule on" placeholder={`${project.key}-1`} value={key} onChange={e => setKey(e.target.value)} />
        <button className="btn btn-secondary btn-sm" disabled={!key.trim() || busy} onClick={run}>{busy ? 'Trying…' : 'Dry run'}</button>
        <span className="muted sm">Nothing is changed.</span>
      </div>
      {error && <p className="hint error" role="alert">{error}</p>}
      {out && (out.error ? <p className="hint error" role="alert">It would fail: {out.error}</p> : <StepList steps={out.steps} />)}
    </div>
  )
}
