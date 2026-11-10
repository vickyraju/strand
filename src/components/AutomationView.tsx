import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, Zap, Pencil, Trash2, X, ScrollText, Globe } from 'lucide-react'
import { api, apiEnabled } from '../api/client'
import { AuditLogDialog, DryRun } from './AutomationLog'
import { useStore, uid, userOf, type Project, type Rule, type RuleAction, type RuleTrigger, type Priority } from '../data/store'
import { useApp } from '../appContext'
import { Empty, Modal, Toggle, priorityLabel, priorityKeys, plural } from './ui'
import { defaultPriority } from '../data/lists'
import { UserSelect } from './UserPicker'
import JqlBox from './JqlBox'

const ACTION_LABEL: Record<RuleAction['kind'], string> = {
  assign: 'Assign to', priority: 'Set priority', label: 'Add label', status: 'Move to status', comment: 'Add a comment',
}

export function describeTrigger(p: Project | null, t: RuleTrigger) {
  if (t.kind === 'created') return 'a work item is created'
  if (t.kind === 'assigned') return 'a work item is assigned'
  if (t.kind === 'scheduled') return `every ${every(t.everyMinutes)}, for work items matching ${t.jql}${t.changedSinceLastRun ? ' changed since the last run' : ''}`
  return `a work item moves to ${t.toName ?? p?.statuses.find(s => s.id === t.to)?.name ?? 'a deleted status'}`
}
/** 90 → "90 minutes", 120 → "2 hours", 1440 → "day". */
export const every = (m: number) => m % 1440 === 0 ? (m === 1440 ? 'day' : `${m / 1440} days`) : m % 60 === 0 ? (m === 60 ? 'hour' : `${m / 60} hours`) : `${m} minutes`

export function describeAction(p: Project | null, a: RuleAction, users: { id: string; name: string }[]) {
  switch (a.kind) {
    case 'assign':   return a.to === 'reporter' ? 'assign the reporter' : a.to === 'lead' ? 'assign the project lead' : a.to === 'unassign' ? 'remove the assignee' : `assign ${users.find(u => u.id === a.to)?.name ?? 'someone'}`
    case 'priority': return `set priority to ${priorityKeys().includes(a.value) ? priorityLabel(a.value) : `“${a.value}” (not a priority)`}`
    case 'label':    return `add label “${a.value}”`
    case 'status':   return `move to ${a.name ?? p?.statuses.find(s => s.id === a.value)?.name ?? 'a deleted status'}`
    case 'comment':  return 'add a comment'
    default:         return 'do something this version of Strand doesn’t know'
  }
}

export default function AutomationView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openProject, toast } = useApp()
  const [editing, setEditing] = useState<Rule | null>(null)
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const rules = project.rules
  const setRules = (next: Rule[]) => dispatch({ type: 'updateProject', id: project.id, patch: { rules: next } })

  return (
    <div className="page">
      <div className="wf-bar">
        <button className="btn btn-ghost" onClick={() => openProject(project.id, 'settings')}><ArrowLeft size={15} />Settings</button>
        <h2 className="wf-title">Automation</h2>
        <div style={{ flex: 1 }} />
        {apiEnabled && rules.length > 0 && <button className="btn btn-ghost" onClick={() => setLog('all')}><ScrollText size={15} />Audit log</button>}
        {rules.length > 0 && <button className="btn btn-primary" onClick={() => setEditing(blankRule(project))}><Plus size={15} />Create rule</button>}
      </div>

      {rules.length === 0 ? (
        <Empty icon={<Zap size={22} strokeWidth={1.5} />} title="Automate the busywork"
          body="Rules run when something happens to a work item: assign the lead when a bug is created, label work that ships, or comment when an item moves to review."
          action={<button className="btn btn-primary" onClick={() => setEditing(blankRule(project))}><Plus size={15} />Create rule</button>} />
      ) : (
        <div className="settings" style={{ padding: '20px 24px' }}>
          {rules.map(r => (
            <div key={r.id} className={`panel rule-card${r.enabled ? '' : ' off'}`}>
              <span className="rule-icon"><Zap size={16} /></span>
              <div className="rule-text">
                <div className="strong">{r.name}</div>
                <div className="muted sm">
                  When {describeTrigger(project, r.trigger)}{r.condition ? <>, if <span className="mono">{r.condition}</span></> : null}, then {r.actions.map(a => describeAction(project, a, state.users)).join(', ')}.
                </div>
                <div className="muted sm">
                  {r.runs ? `Ran ${plural(r.runs, 'time')}` : 'Hasn’t run yet'}
                  {r.failures ? <span className="text-danger"> · {plural(r.failures, 'failure')}</span> : null}
                  {r.ownerId && ` · owner ${userOf(state, r.ownerId)?.name ?? 'someone who left'}`}
                  {apiEnabled && r.runs > 0 && <> · <button className="link" onClick={() => setLog(r.id)}>Audit log</button></>}
                </div>
              </div>
              <Toggle on={r.enabled} label={r.enabled ? `Turn off ${r.name}` : `Turn on ${r.name}`}
                onChange={on => { setRules(rules.map(x => x.id === r.id ? { ...x, enabled: on } : x)); toast(`${r.name} ${on ? 'on' : 'off'}`) }} />
              <button className="icon-btn" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`} title="Edit"><Pencil size={15} /></button>
              <button className="icon-btn" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`} title="Delete"><Trash2 size={15} /></button>
            </div>
          ))}
          <p className="muted sm">Rules run once per change and never trigger each other, so they can’t loop. Their changes show as “Automation” in history.</p>
        </div>
      )}
      {apiEnabled && <GlobalRules project={project} />}

      {editing && (
        <RuleModal project={project} rule={editing} onClose={() => setEditing(null)}
          onSave={r => {
            setRules(rules.some(x => x.id === r.id) ? rules.map(x => x.id === r.id ? r : x) : [...rules, r])
            toast(`Saved ${r.name}`); setEditing(null)
          }} />
      )}
      {log && <AuditLogDialog project={project} ruleId={log === 'all' ? undefined : log} onClose={() => setLog(null)} />}
      {deleting && (
        <Modal title={`Delete “${deleting.name}”?`} onClose={() => setDeleting(null)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { setRules(rules.filter(x => x.id !== deleting.id)); setDeleting(null) }}>Delete rule</button>
          </>}>
          <p>The rule stops running. Changes it already made stay.</p>
        </Modal>
      )}
    </div>
  )
}

const blankRule = (p: Project): Rule => ({
  id: uid(), name: '', enabled: true, runs: 0,
  trigger: { kind: 'status', to: p.statuses.find(s => s.category === 'done')?.id ?? p.statuses[0].id },
  actions: [{ kind: 'label', value: '' }],
})

/** The rule editor, for a project's rules, or (project null) a global rule, which names statuses (spec 0709). `extra` goes
 *  above the steps (a global rule's scope). */
export function RuleModal({ project, rule, onClose, onSave, extra, error }: {
  project: Project | null; rule: Rule; onClose: () => void; onSave: (r: Rule) => void; extra?: React.ReactNode; error?: string
}) {
  const { state } = useStore()
  const [r, setR] = useState<Rule>(rule)
  const setAction = (i: number, a: RuleAction) => setR({ ...r, actions: r.actions.map((x, k) => k === i ? a : x) })
  const blank = (kind: RuleAction['kind']): RuleAction =>
    kind === 'assign' ? { kind, to: project ? 'lead' : 'reporter' } : kind === 'priority' ? { kind, value: 'high' }
    : kind === 'status' ? (project ? { kind, value: project.statuses[0].id } : { kind, value: '', name: '' }) : kind === 'comment' ? { kind, body: '' } : { kind: 'label', value: '' }
  const t = r.trigger
  const valid = r.name.trim() && r.actions.length > 0 && r.actions.every(a =>
    a.kind === 'label' ? a.value.trim() : a.kind === 'comment' ? a.body.trim() : a.kind === 'status' && !project ? a.name?.trim() : true)
    && (t.kind !== 'scheduled' || (t.jql.trim() && t.everyMinutes > 0)) && (t.kind !== 'status' || project || t.toName?.trim())
  const unit = t.kind === 'scheduled' ? [1440, 60, 1].find(u => t.everyMinutes % u === 0)! : 60

  return (
    <Modal title={rule.name ? 'Edit rule' : 'Create rule'} onClose={onClose} width={620}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...r, name: r.name.trim(), condition: r.condition?.trim() || null })}>Save rule</button>
      </>}>
      {error && <p className="hint error" role="alert" style={{ marginBottom: 8 }}>{error}</p>}
      <label className="label" htmlFor="rule-name">Rule name</label>
      <input id="rule-name" className="input" value={r.name} onChange={e => setR({ ...r, name: e.target.value })} placeholder="e.g. Label shipped work" autoFocus />
      {extra}

      <div className="rule-step">
        <span className="rule-step-tag when">When</span>
        <select className="input" aria-label="Trigger" value={t.kind === 'status' && project ? `status:${t.to}` : t.kind}
          onChange={e => {
            const v = e.target.value
            setR({ ...r, trigger: v.startsWith('status:') ? { kind: 'status', to: v.slice(7) } : v === 'status' ? { kind: 'status', to: '', toName: '' }
              : v === 'scheduled' ? { kind: 'scheduled', everyMinutes: 60, jql: '' } : { kind: v as 'created' | 'assigned' } })
          }}>
          <option value="created">A work item is created</option>
          <option value="assigned">A work item is assigned</option>
          {project ? project.statuses.map(s => <option key={s.id} value={`status:${s.id}`}>A work item moves to {s.name}</option>)
            : <option value="status">A work item moves to a status…</option>}
          {apiEnabled && <option value="scheduled">Scheduled</option>}
        </select>
        {t.kind === 'status' && !project && <input className="input" aria-label="Status name" placeholder="Status name, e.g. Done" value={t.toName ?? ''} onChange={e => setR({ ...r, trigger: { ...t, toName: e.target.value } })} />}
      </div>
      {t.kind === 'scheduled' && (
        <div className="rule-sched">
          <div className="form-row" style={{ alignItems: 'center' }}>
            <span className="muted sm">Every</span>
            <input className="input input-sm" type="number" min={1} style={{ width: 80 }} aria-label="Every" value={t.everyMinutes / unit}
              onChange={e => setR({ ...r, trigger: { ...t, everyMinutes: Math.max(1, Math.round(Number(e.target.value) || 1)) * unit } })} />
            <select className="input input-sm" aria-label="Unit" value={unit} onChange={e => setR({ ...r, trigger: { ...t, everyMinutes: (t.everyMinutes / unit) * Number(e.target.value) } })}>
              <option value={1}>minutes</option><option value={60}>hours</option><option value={1440}>days</option>
            </select>
          </div>
          <JqlBox value={t.jql} action="Check" onRun={jql => setR({ ...r, trigger: { ...t, jql } })} onChange={jql => setR({ ...r, trigger: { ...t, jql } })} />
          <label className="check-row"><input type="checkbox" checked={!!t.changedSinceLastRun} onChange={e => setR({ ...r, trigger: { ...t, changedSinceLastRun: e.target.checked } })} />
            Only work items people changed since the last run</label>
        </div>
      )}
      {apiEnabled && (
        <div className="rule-step rule-if">
          <span className="rule-step-tag if">If</span>
          {r.condition !== undefined && r.condition !== null
            ? <div style={{ flex: 1 }}>
                <JqlBox value={r.condition} action="Check" onRun={condition => setR({ ...r, condition })} onChange={condition => setR({ ...r, condition })} />
                <button className="link sm" onClick={() => setR({ ...r, condition: null })}>Remove the condition</button>
              </div>
            : <button className="btn btn-ghost btn-sm" onClick={() => setR({ ...r, condition: '' })}><Plus size={14} />Add a JQL condition</button>}
        </div>
      )}

      {r.actions.map((a, i) => (
        <div key={i} className="rule-step">
          <span className="rule-step-tag then">{i === 0 ? 'Then' : 'And'}</span>
          <select className="input rule-kind" aria-label="Action" value={a.kind} onChange={e => setAction(i, blank(e.target.value as RuleAction['kind']))}>
            {(Object.keys(ACTION_LABEL) as RuleAction['kind'][]).map(k => <option key={k} value={k}>{ACTION_LABEL[k]}</option>)}
          </select>
          {a.kind === 'assign' && !project && (
            <select className="input" aria-label="Assign to" value={a.to} onChange={e => setAction(i, { kind: 'assign', to: e.target.value })}>
              <option value="reporter">The reporter</option>
              <option value="lead">The project’s lead</option>
              <option value="unassign">Nobody (unassign)</option>
            </select>
          )}
          {a.kind === 'assign' && project && (
            <div className="rule-user-pick">
              <select className="input" aria-label="Assign to" value={a.to} onChange={e => setAction(i, { kind: 'assign', to: e.target.value })}>
                <option value="lead">Project lead ({userOf(state, project.leadId)?.name})</option>
                <option value="reporter">The reporter</option>
                <option value="unassign">Nobody (unassign)</option>
              </select>
              {a.to && a.to !== 'lead' && a.to !== 'reporter' && a.to !== 'unassign' && (
                <UserSelect value={a.to} projectId={project.id} label="Assign to user"
                  onChange={id => setAction(i, { kind: 'assign', to: id ?? 'unassign' })}
                  extraOptions={[
                    { value: 'lead', label: `Project lead (${userOf(state, project.leadId)?.name ?? ''})` },
                    { value: 'reporter', label: 'The reporter' },
                    { value: 'unassign', label: 'Nobody (unassign)' },
                  ]} />
              )}
            </div>
          )}
          {a.kind === 'priority' && (
            <select className="input" aria-label="Priority" value={priorityKeys().includes(a.value) ? a.value : defaultPriority()} onChange={e => setAction(i, { kind: 'priority', value: e.target.value as Priority })}>
              {priorityKeys().map(p => <option key={p} value={p}>{priorityLabel(p)}</option>)}
            </select>
          )}
          {a.kind === 'label' && <input className="input" aria-label="Label" value={a.value} placeholder="e.g. shipped" onChange={e => setAction(i, { kind: 'label', value: e.target.value })} />}
          {a.kind === 'status' && !project && <input className="input" aria-label="Status name" placeholder="Status name, e.g. In review" value={a.name ?? ''} onChange={e => setAction(i, { kind: 'status', value: '', name: e.target.value })} />}
          {a.kind === 'status' && project && (
            <select className="input" aria-label="Status" value={a.value} onChange={e => setAction(i, { kind: 'status', value: e.target.value })}>
              {project.statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {a.kind === 'comment' && <input className="input" aria-label="Comment" value={a.body} placeholder="e.g. Thanks! We’ll look at this today." onChange={e => setAction(i, { kind: 'comment', body: e.target.value })} />}
          {r.actions.length > 1 && <button className="icon-btn" onClick={() => setR({ ...r, actions: r.actions.filter((_, k) => k !== i) })} aria-label="Remove action"><X size={15} /></button>}
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setR({ ...r, actions: [...r.actions, blank('priority')] })}><Plus size={14} />Add another action</button>
      {apiEnabled && valid && project && <DryRun project={project} actions={r.actions} condition={r.condition} />}
    </Modal>
  )
}

interface GlobalRule extends Rule { scope: { kind: 'all' | 'category' | 'projects'; categoryName?: string; projectKeys?: string[] } }
export const describeScope = (s: GlobalRule['scope']) => s.kind === 'all' ? 'every project' : s.kind === 'category' ? `projects in ${s.categoryName ?? 'a category'}` : s.projectKeys!.join(', ')

/** The global rules that apply to this project: made in Administration › Automation, read-only here (spec 0709 R3). */
function GlobalRules({ project }: { project: Project }) {
  const { state } = useStore()
  const [rules, setRules] = useState<GlobalRule[]>([])
  useEffect(() => { api<GlobalRule[]>('GET', `/api/projects/${encodeURIComponent(project.key)}/automation/global`).then(setRules, () => {}) }, [project.key])
  if (!rules.length) return null
  return (
    <div className="settings" style={{ padding: '0 24px 20px' }} aria-label="Global rules">
      <h3 className="dir-section">Global rules for this project</h3>
      {rules.map(r => (
        <div key={r.id} className={`panel rule-card${r.enabled ? '' : ' off'}`}>
          <span className="rule-icon"><Globe size={16} /></span>
          <div className="rule-text">
            <div className="strong">{r.name}</div>
            <div className="muted sm">When {describeTrigger(null, r.trigger)}{r.condition ? <>, if <span className="mono">{r.condition}</span></> : null}, then {r.actions.map(a => describeAction(null, a, state.users)).join(', ')}.</div>
            <div className="muted sm">For {describeScope(r.scope)} · {r.enabled ? 'on' : 'off'} · a system administrator changes it in Administration › Automation</div>
          </div>
        </div>
      ))}
    </div>
  )
}
