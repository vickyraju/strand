import { useState } from 'react'
import { useStore, moveContext, transitionFor, RESOLUTIONS, type Issue, type IssuePatch, type Project, type State, type Transition } from '../data/store'
import { problems, RULE_FIELDS, type Item } from '../data/transitionRules'
import { api, apiEnabled, ApiError } from '../api/client'
import { issueSync } from '../api/sync'
import { commentDeps } from '../api/comments'
import { UserSelect } from './UserPicker'
import { Modal } from './ui'

// Moving a work item the way the workflow says. A move with nothing to ask goes straight through; one whose transition
// has a screen, or whose checks aren't met yet, opens this dialog (Jira's transition screen): the fields to fill in,
// a comment, and what still stops the move. Loops (actions that keep the status) come here too.

export type Pending = { issueId: string; transitionId: string }

/** What a move needs from the person, or why they can't make it. */
export function planMove(state: State, issue: Issue, to: string):
  { kind: 'direct' } | { kind: 'ask'; transition: Transition } | { kind: 'refused'; reason: string } {
  const project = state.projects.find(p => p.id === issue.projectId)
  if (!project || to === issue.status || !project.transitions.length) return { kind: 'direct' }
  const ctx = moveContext(state, issue)
  const t = transitionFor(project, issue.status, to, ctx)
  if (!t) return { kind: 'refused', reason: transitionFor(project, issue.status, to) ? 'The workflow doesn’t let you make this move' : 'The workflow has no such move' }
  const after = { ...issue, status: to } as unknown as Item
  return t.rules?.screen?.length || Object.keys(problems(t.rules, ctx, issue as unknown as Item, after)).length ? { kind: 'ask', transition: t } : { kind: 'direct' }
}

/** Make a transition with what its screen collected. With a server: one request, all or nothing, then its copy is adopted. */
export async function makeTransition(dispatch: (a: any) => void, issue: Issue, t: Transition, fields: IssuePatch, comment: string): Promise<Record<string, string> | null> {
  if (!apiEnabled) {
    dispatch({ type: 'runTransition', issueId: issue.id, transitionId: t.id, patch: fields, comment: comment.trim() || undefined })
    return null
  }
  await issueSync.idle()   // earlier edits first, so the version matches
  const v = issueSync.versionOf(issue.id)
  const wire = Object.fromEntries(Object.entries(fields).map(([k, x]) => [k === 'status' ? 'statusId' : k, x ?? null]))
  try {
    const row = await api('POST', `/api/issues/${encodeURIComponent(issueSync.serverKey(issue))}/transitions`,
      { transitionId: t.id, fields: wire, ...(comment.trim() ? { comment } : {}) }, v != null ? { 'if-match': String(v) } : undefined)
    issueSync.adopt(row)
    void commentDeps.reloadDetail(issue.id)   // comments and history the move added
    return null
  } catch (e) {
    if (e instanceof ApiError) return e.errors ?? { '': e.message }
    return { '': 'Could not reach the server' }
  }
}

export default function TransitionDialog({ pending, onClose, onDone }: { pending: Pending; onClose: () => void; onDone: (text: string) => void }) {
  const { state, dispatch } = useStore()
  const issue = state.issues.find(i => i.id === pending.issueId)
  const project = state.projects.find(p => p.id === issue?.projectId)
  const t = project?.transitions.find(x => x.id === pending.transitionId)
  const [fields, setFields] = useState<IssuePatch>({})
  const [comment, setComment] = useState('')
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  if (!issue || !project || !t) return null

  const ctx = moveContext(state, issue)
  const after = { ...issue, ...fields, ...(t.to ? { status: t.to } : {}) } as unknown as Item
  const errors = { ...problems(t.rules, ctx, issue as unknown as Item, after, comment), ...serverErrors }
  const screen = t.rules?.screen ?? []
  const elsewhere = Object.entries(errors).filter(([k]) => !screen.includes(k))   // problems this dialog can't fix
  const to = t.to ? project.statuses.find(s => s.id === t.to)?.name : null
  const set = (k: string, v: unknown) => {
    setServerErrors({})
    if (k.startsWith('custom.')) {
      const custom = { ...issue.custom, ...(fields.custom ?? {}) }
      if (v === '' || v == null) delete custom[k.slice(7)]; else custom[k.slice(7)] = v as string | number
      setFields({ ...fields, custom })
    } else setFields({ ...fields, [k]: v === '' ? undefined : v })
  }
  const submit = async () => {
    setBusy(true)
    const result = await makeTransition(dispatch, issue, t, fields, comment)
    setBusy(false)
    if (result) { setServerErrors(result); return }
    onDone(to ? `${issue.key} moved to ${to}` : `${t.name}: done`)
  }

  return (
    <Modal title={`${t.name}: ${issue.key}`} onClose={onClose} width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || Object.keys(errors).length > 0} onClick={submit}>{busy ? 'Saving…' : t.name}</button>
      </>}>
      <form onSubmit={e => { e.preventDefault(); if (!Object.keys(errors).length) void submit() }}>
        <p className="muted" style={{ marginBottom: 12 }}>{to ? <>Moves “{issue.title}” to <b>{to}</b>.</> : <>“{issue.title}” stays in its status.</>}</p>
        {elsewhere.length > 0 && (
          <div className="callout callout-warn" role="alert" style={{ marginBottom: 12 }}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{elsewhere.map(([k, m]) => <li key={k}>{m}</li>)}</ul>
          </div>
        )}
        {screen.map(k => (
          <div key={k} style={{ marginBottom: 12 }}>
            <label className="label" htmlFor={`tr-${k}`}>{k === 'comment' ? 'Comment' : label(project, k)}</label>
            {k === 'comment'
              ? <textarea id="tr-comment" className="input" rows={3} value={comment} onChange={e => { setComment(e.target.value); setServerErrors({}) }} />
              : <FieldInput id={`tr-${k}`} field={k} project={project} value={valueIn(issue, fields, k)} onChange={v => set(k, v)} />}
            {errors[k] && <p className="hint error" role="alert">{errors[k]}</p>}
          </div>
        ))}
      </form>
    </Modal>
  )
}

const label = (p: Project, k: string) => (k.startsWith('custom.') ? p.fields.find(f => f.id === k.slice(7))?.name ?? 'Field' : RULE_FIELDS[k] ?? k)
const valueIn = (issue: Issue, fields: IssuePatch, k: string): unknown =>
  k.startsWith('custom.') ? (fields.custom ?? issue.custom)[k.slice(7)] : k in fields ? (fields as any)[k] : (issue as any)[k]

/** One field on the transition screen, with the input that suits it. */
function FieldInput({ id, field, project, value, onChange }: { id: string; field: string; project: Project; value: unknown; onChange: (v: unknown) => void }) {
  const { state } = useStore()
  const str = value == null ? '' : String(value)
  const select = (options: { value: string; label: string }[], none = 'None') => (
    <select id={id} className="input" value={str} onChange={e => onChange(e.target.value)}>
      <option value="">{none}</option>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
  if (field.startsWith('custom.')) {
    const f = project.fields.find(x => x.id === field.slice(7))
    if (f?.kind === 'select') return select((f.options ?? []).map(o => ({ value: o, label: o })))
    return <input id={id} className="input" type={f?.kind === 'number' ? 'number' : f?.kind === 'date' ? 'date' : 'text'} value={str}
      onChange={e => onChange(f?.kind === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />
  }
  switch (field) {
    case 'assigneeId': return <UserSelect label="Assignee" projectId={project.key} value={str || undefined} placeholder="Unassigned" onChange={v => onChange(v ?? '')} />
    case 'priority': return select(['urgent', 'high', 'medium', 'low', 'none'].map(p => ({ value: p, label: p[0]!.toUpperCase() + p.slice(1) })))
    case 'resolution': return select(RESOLUTIONS.map(r => ({ value: r, label: r })), 'Done (default)')
    case 'releaseId': return select(project.releases.filter(r => !r.released).map(r => ({ value: r.id, label: r.name })))
    case 'sprintId': return select(state.sprints.filter(s => s.projectId === project.id && s.state !== 'closed').map(s => ({ value: s.id, label: s.name })), 'Backlog')
    case 'type': return select(['epic', 'story', 'task', 'bug'].map(t => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) })))
    case 'dueDate': case 'startDate': return <input id={id} className="input" type="date" value={str} onChange={e => onChange(e.target.value)} />
    case 'estimate': case 'timeEstimate': return <input id={id} className="input" type="number" min={0} value={str} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    case 'labels': return <input id={id} className="input" placeholder="Comma-separated" value={Array.isArray(value) ? value.join(', ') : ''}
      onChange={e => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))} />
    case 'description': return <textarea id={id} className="input" rows={4} value={str} onChange={e => onChange(e.target.value)} />
    default: return <input id={id} className="input" value={str} onChange={e => onChange(e.target.value)} />
  }
}

