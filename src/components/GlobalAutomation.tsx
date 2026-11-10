import { useEffect, useState } from 'react'
import { Globe, Pencil, Plus, ScrollText, Trash2 } from 'lucide-react'
import { api, ApiError, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { useStore, uid, timeAgo, type Rule } from '../data/store'
import { ConfirmDialog, LoadError, Loading, Modal, Toggle, plural } from './ui'
import { PageAction } from './admin/AdminShell'
import { RuleModal, describeAction, describeScope, describeTrigger } from './AutomationView'
import { StepList, type Run } from './AutomationLog'

// Administration › Automation (spec 0709): global rules over every project, a project category (projects added to it
// later included) or chosen projects. Statuses are named, since each project has its own.

type Scope = { kind: 'all' } | { kind: 'category'; categoryId: string; categoryName?: string } | { kind: 'projects'; projectKeys: string[] }
interface GlobalRule extends Rule { scope: Scope & { categoryName?: string; projectKeys?: string[] }; lastRunAt: string | null }
interface Category { id: string; name: string }

export default function GlobalAutomation() {
  const { toast } = useApp()
  const { state } = useStore()
  const [rules, setRules] = useState<GlobalRule[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<GlobalRule | null>(null)
  const [deleting, setDeleting] = useState<GlobalRule | null>(null)
  const [log, setLog] = useState(false)
  const load = () => api<GlobalRule[]>('GET', '/api/admin/automation/rules').then(setRules, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!rules) return <Loading />
  const blank = (): GlobalRule => ({ id: '', name: '', enabled: true, runs: 0, trigger: { kind: 'created' }, actions: [{ kind: 'label', value: '' }], scope: { kind: 'all' }, lastRunAt: null })
  const save = (r: GlobalRule) => {
    const body = { name: r.name, enabled: r.enabled, scope: r.scope.kind === 'category' ? { kind: 'category', categoryId: r.scope.categoryId } : r.scope.kind === 'projects' ? { kind: 'projects', projectKeys: r.scope.projectKeys } : { kind: 'all' },
      trigger: r.trigger, actions: r.actions, condition: r.condition ?? null }
    return api('PUT', `/api/admin/automation/rules/${r.id}`, body)
  }
  return (
    <section>
      <PageAction><button className="btn btn-primary" onClick={() => setEditing(blank())}><Plus size={14} />Create rule</button></PageAction>
      {rules.length > 0 && <div className="cell-flex" style={{ marginBottom: 12 }}><span style={{ flex: 1 }} /><button className="btn btn-ghost" onClick={() => setLog(true)}><ScrollText size={15} />Audit log</button></div>}
      {!rules.length ? <p className="muted">No global rules yet. A global rule acts in every project, the projects of a category (new ones too), or the projects you choose. Project admins see the ones for their project, read-only.</p>
        : rules.map(r => (
          <div key={r.id} className={`panel rule-card${r.enabled ? '' : ' off'}`}>
            <span className="rule-icon"><Globe size={16} /></span>
            <div className="rule-text">
              <div className="strong">{r.name}</div>
              <div className="muted sm">For {describeScope(r.scope)}: when {describeTrigger(null, r.trigger)}{r.condition ? <>, if <span className="mono">{r.condition}</span></> : null}, then {r.actions.map(a => describeAction(null, a, state.users)).join(', ')}.</div>
              <div className="muted sm">{r.runs ? `Ran ${plural(r.runs, 'time')}` : 'Hasn’t run yet'}{r.failures ? <span className="text-danger"> · {plural(r.failures, 'failure')}</span> : null}</div>
            </div>
            <Toggle on={r.enabled} label={r.enabled ? `Turn off ${r.name}` : `Turn on ${r.name}`}
              onChange={on => save({ ...r, enabled: on }).then(() => { toast(`${r.name} ${on ? 'on' : 'off'}`); void load() }, e => toast(errorMessage(e), { tone: 'warn' }))} />
            <button className="icon-btn" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`} title="Edit"><Pencil size={15} /></button>
            <button className="icon-btn" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`} title="Delete"><Trash2 size={15} /></button>
          </div>
        ))}
      {editing && <Editor rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load() }} />}
      {deleting && <ConfirmDialog title={`Delete “${deleting.name}”?`} action="Delete rule" onClose={() => setDeleting(null)}
        onConfirm={() => api('DELETE', `/api/admin/automation/rules/${deleting.id}`).then(() => { toast(`${deleting.name} deleted`); setDeleting(null); void load() })}>
        It stops running in every project. Changes it already made stay.
      </ConfirmDialog>}
      {log && <RunsDialog onClose={() => setLog(false)} />}
    </section>
  )
}

function Editor({ rule, onClose, onSaved }: { rule: GlobalRule; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp()
  const [scope, setScope] = useState<Scope>(rule.scope.kind === 'projects' ? { kind: 'projects', projectKeys: rule.scope.projectKeys ?? [] } : rule.scope)
  const [keys, setKeys] = useState(rule.scope.projectKeys?.join(', ') ?? '')
  const [cats, setCats] = useState<Category[]>([])
  const [error, setError] = useState('')
  useEffect(() => { api<Category[]>('GET', '/api/project-categories').then(setCats, () => {}) }, [])
  const save = (r: Rule) => {
    const s = scope.kind === 'projects' ? { kind: 'projects', projectKeys: keys.split(/[\s,]+/).filter(Boolean) } : scope.kind === 'category' ? { kind: 'category', categoryId: scope.categoryId } : scope
    const body = { name: r.name, enabled: r.enabled, scope: s, trigger: r.trigger, actions: r.actions, condition: r.condition ?? null }
    ;(rule.id ? api('PUT', `/api/admin/automation/rules/${rule.id}`, body) : api('POST', '/api/admin/automation/rules', body))
      .then(() => { toast(`Saved ${r.name}`); onSaved() }, e => setError(e instanceof ApiError ? Object.values(e.errors ?? {})[0] ?? e.message : errorMessage(e)))
  }
  const scopeField = (
    <div className="rule-step">
      <span className="rule-step-tag when">For</span>
      <select className="input" aria-label="Scope" value={scope.kind} onChange={e => {
        const k = e.target.value
        setScope(k === 'category' ? { kind: 'category', categoryId: cats[0]?.id ?? '' } : k === 'projects' ? { kind: 'projects', projectKeys: [] } : { kind: 'all' })
      }}>
        <option value="all">Every project</option>
        <option value="category" disabled={!cats.length}>The projects in a category{cats.length ? '' : ' (none yet)'}</option>
        <option value="projects">Chosen projects</option>
      </select>
      {scope.kind === 'category' && (
        <select className="input" aria-label="Category" value={scope.categoryId} onChange={e => setScope({ kind: 'category', categoryId: e.target.value })}>
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {scope.kind === 'projects' && <input className="input" aria-label="Project keys" placeholder="Project keys, e.g. PAY, OPS" value={keys} onChange={e => setKeys(e.target.value)} />}
    </div>
  )
  return <RuleModal project={null} rule={{ ...rule, id: rule.id || uid() }} onClose={onClose} onSave={save} extra={scopeField} error={error} />
}

function RunsDialog({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { api<Run[]>('GET', '/api/admin/automation/runs?limit=100').then(setRuns, e => setError(errorMessage(e))) }, [])
  return (
    <Modal title="Global automation audit log" onClose={onClose} width={720}>
      {error && <p className="hint error" role="alert">{error}</p>}
      {!runs && !error && <p className="muted" role="status">Loading…</p>}
      {runs && !runs.length && <p className="muted">No runs in the last 90 days.</p>}
      {runs && runs.length > 0 && (
        <div className="card-table" style={{ marginInline: 0 }}>
          <table className="table">
            <thead><tr><th>When</th><th>Rule</th><th>Work item</th><th>What happened</th></tr></thead>
            <tbody>{runs.map(r => (
              <tr key={r.id} style={{ cursor: 'default', verticalAlign: 'top' }}>
                <td className="muted sm">{timeAgo(Date.parse(r.at))}</td><td>{r.rule}</td><td className="mono">{r.issueKey ?? '—'}</td>
                <td className="sm">{r.error ? <span className="text-danger">{r.error}</span> : r.result === 'condition_not_met' ? <span className="muted">Condition not met</span> : <StepList steps={r.steps} />}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
