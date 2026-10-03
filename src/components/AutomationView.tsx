import { useState } from 'react'
import { ArrowLeft, Plus, Zap, Pencil, Trash2, X } from 'lucide-react'
import { useStore, uid, userOf, type Project, type Rule, type RuleAction, type RuleTrigger, type Priority } from '../data/store'
import { useApp } from '../appContext'
import { Empty, Modal, Toggle, PRIORITY_META, PRIORITIES, plural } from './ui'

const ACTION_LABEL: Record<RuleAction['kind'], string> = {
  assign: 'Assign to', priority: 'Set priority', label: 'Add label', status: 'Move to status', comment: 'Add a comment',
}

export function describeTrigger(p: Project, t: RuleTrigger) {
  if (t.kind === 'created') return 'a work item is created'
  if (t.kind === 'assigned') return 'a work item is assigned'
  return `a work item moves to ${p.statuses.find(s => s.id === t.to)?.name ?? 'a deleted status'}`
}

function describeAction(p: Project, a: RuleAction, users: { id: string; name: string }[]) {
  switch (a.kind) {
    case 'assign':   return a.to === 'reporter' ? 'assign the reporter' : a.to === 'lead' ? 'assign the project lead' : a.to === 'unassign' ? 'remove the assignee' : `assign ${users.find(u => u.id === a.to)?.name ?? 'someone'}`
    case 'priority': return `set priority to ${PRIORITY_META[a.value].label}`
    case 'label':    return `add label “${a.value}”`
    case 'status':   return `move to ${p.statuses.find(s => s.id === a.value)?.name ?? 'a deleted status'}`
    case 'comment':  return 'add a comment'
  }
}

export default function AutomationView({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openProject, toast } = useApp()
  const [editing, setEditing] = useState<Rule | null>(null)
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const rules = project.rules
  const setRules = (next: Rule[]) => dispatch({ type: 'updateProject', id: project.id, patch: { rules: next } })

  return (
    <div className="page">
      <div className="wf-bar">
        <button className="btn btn-ghost" onClick={() => openProject(project.id, 'settings')}><ArrowLeft size={15} />Settings</button>
        <h2 className="wf-title">Automation</h2>
        <div style={{ flex: 1 }} />
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
                  When {describeTrigger(project, r.trigger)}, then {r.actions.map(a => describeAction(project, a, state.users)).join(', ')}.
                </div>
                <div className="muted sm">{r.runs ? `Ran ${plural(r.runs, 'time')}` : 'Hasn’t run yet'}</div>
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

      {editing && (
        <RuleModal project={project} rule={editing} onClose={() => setEditing(null)}
          onSave={r => {
            setRules(rules.some(x => x.id === r.id) ? rules.map(x => x.id === r.id ? r : x) : [...rules, r])
            toast(`Saved ${r.name}`); setEditing(null)
          }} />
      )}
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

function RuleModal({ project, rule, onClose, onSave }: { project: Project; rule: Rule; onClose: () => void; onSave: (r: Rule) => void }) {
  const { state } = useStore()
  const [r, setR] = useState<Rule>(rule)
  const setAction = (i: number, a: RuleAction) => setR({ ...r, actions: r.actions.map((x, k) => k === i ? a : x) })
  const blank = (kind: RuleAction['kind']): RuleAction =>
    kind === 'assign' ? { kind, to: 'lead' } : kind === 'priority' ? { kind, value: 'high' }
    : kind === 'status' ? { kind, value: project.statuses[0].id } : kind === 'comment' ? { kind, body: '' } : { kind: 'label', value: '' }
  const valid = r.name.trim() && r.actions.length > 0 && r.actions.every(a =>
    a.kind === 'label' ? a.value.trim() : a.kind === 'comment' ? a.body.trim() : true)

  return (
    <Modal title={rule.name ? 'Edit rule' : 'Create rule'} onClose={onClose} width={620}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...r, name: r.name.trim() })}>Save rule</button>
      </>}>
      <label className="label" htmlFor="rule-name">Rule name</label>
      <input id="rule-name" className="input" value={r.name} onChange={e => setR({ ...r, name: e.target.value })} placeholder="e.g. Label shipped work" autoFocus />

      <div className="rule-step">
        <span className="rule-step-tag when">When</span>
        <select className="input" aria-label="Trigger" value={r.trigger.kind === 'status' ? `status:${r.trigger.to}` : r.trigger.kind}
          onChange={e => {
            const v = e.target.value
            setR({ ...r, trigger: v.startsWith('status:') ? { kind: 'status', to: v.slice(7) } : { kind: v as 'created' | 'assigned' } })
          }}>
          <option value="created">A work item is created</option>
          <option value="assigned">A work item is assigned</option>
          {project.statuses.map(s => <option key={s.id} value={`status:${s.id}`}>A work item moves to {s.name}</option>)}
        </select>
      </div>

      {r.actions.map((a, i) => (
        <div key={i} className="rule-step">
          <span className="rule-step-tag then">{i === 0 ? 'Then' : 'And'}</span>
          <select className="input rule-kind" aria-label="Action" value={a.kind} onChange={e => setAction(i, blank(e.target.value as RuleAction['kind']))}>
            {(Object.keys(ACTION_LABEL) as RuleAction['kind'][]).map(k => <option key={k} value={k}>{ACTION_LABEL[k]}</option>)}
          </select>
          {a.kind === 'assign' && (
            <select className="input" aria-label="Assign to" value={a.to} onChange={e => setAction(i, { kind: 'assign', to: e.target.value })}>
              <option value="lead">Project lead ({userOf(state, project.leadId)?.name})</option>
              <option value="reporter">The reporter</option>
              <option value="unassign">Nobody (unassign)</option>
              {state.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {a.kind === 'priority' && (
            <select className="input" aria-label="Priority" value={a.value} onChange={e => setAction(i, { kind: 'priority', value: e.target.value as Priority })}>
              {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
            </select>
          )}
          {a.kind === 'label' && <input className="input" aria-label="Label" value={a.value} placeholder="e.g. shipped" onChange={e => setAction(i, { kind: 'label', value: e.target.value })} />}
          {a.kind === 'status' && (
            <select className="input" aria-label="Status" value={a.value} onChange={e => setAction(i, { kind: 'status', value: e.target.value })}>
              {project.statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {a.kind === 'comment' && <input className="input" aria-label="Comment" value={a.body} placeholder="e.g. Thanks! We’ll look at this today." onChange={e => setAction(i, { kind: 'comment', body: e.target.value })} />}
          {r.actions.length > 1 && <button className="icon-btn" onClick={() => setR({ ...r, actions: r.actions.filter((_, k) => k !== i) })} aria-label="Remove action"><X size={15} /></button>}
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setR({ ...r, actions: [...r.actions, blank('priority')] })}><Plus size={14} />Add another action</button>
    </Modal>
  )
}
