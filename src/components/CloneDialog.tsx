import { useState } from 'react'
import { useStore, uid, type Issue } from '../data/store'
import { api, apiEnabled, ApiError } from '../api/client'
import { issueSync } from '../api/sync'
import { sprintDeps } from '../api/sprints'
import { useApp } from '../appContext'
import { UserSelect } from './UserPicker'
import { Checkbox, Modal } from './ui'

/** Jira's Clone: a copy of the work item in the same project, starting at the start status and linked "clones" to the
 *  original. Choose its title and assignee, and whether its child items, links and sprint come along. */
export default function CloneDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { openIssue, toast } = useApp()
  const project = state.projects.find(p => p.id === issue.projectId)
  const [title, setTitle] = useState(`CLONE - ${issue.title}`)
  const [assigneeId, setAssigneeId] = useState(issue.assigneeId)
  const [include, setInclude] = useState({ children: false, links: false, sprint: false })
  const [busy, setBusy] = useState(false)
  const hasChildren = state.issues.some(i => i.parentId === issue.id)
  const hasLinks = issue.links.length > 0 || state.issues.some(o => o.links.some(l => l.issueId === issue.id))

  const submit = async () => {
    if (!title.trim()) return
    if (!apiEnabled) {
      const id = uid()
      dispatch({ type: 'cloneIssue', id, sourceId: issue.id, title: title.trim(), assigneeId, include })
      toast(`Cloned ${issue.key}`, { issueId: id }); onClose(); return
    }
    setBusy(true)
    try {
      await issueSync.idle()   // the clone copies what the server has: send pending edits first
      const made = await api<{ id: string }>('POST', `/api/issues/${encodeURIComponent(issueSync.serverKey(issue))}/clone`, { title: title.trim(), assigneeId: assigneeId ?? null, include })
      await sprintDeps.reloadProject(issue.projectId)
      onClose()
      openIssue(made.id)
      toast(`Cloned ${issue.key}`)
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not reach the server', { tone: 'warn' }) }
    setBusy(false)
  }

  const opt = (k: keyof typeof include, label: string, show: boolean) => show && (
    <label className="check-row"><Checkbox checked={include[k]} label={label} onChange={on => setInclude({ ...include, [k]: on })} />{label}</label>
  )
  return (
    <Modal title={`Clone ${issue.key}`} onClose={onClose} width={480} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={submit}>{busy ? 'Cloning…' : 'Clone'}</button>
    </>}>
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        <label className="label" htmlFor="cl-title">Summary</label>
        <input id="cl-title" className="input" value={title} autoFocus onChange={e => setTitle(e.target.value)} />
        <div style={{ marginTop: 12 }}>
          <UserSelect label="Assignee" projectId={project?.key} value={assigneeId} placeholder="Unassigned" onChange={setAssigneeId} />
        </div>
        <fieldset className="wf-fieldset" style={{ marginTop: 12 }}>
          <legend className="label">Include</legend>
          {opt('children', 'Child items', hasChildren)}
          {opt('links', 'Links', hasLinks)}
          {opt('sprint', 'Sprint', !!issue.sprintId)}
          {!hasChildren && !hasLinks && !issue.sprintId && <p className="muted sm">Nothing else to bring along.</p>}
        </fieldset>
        <p className="hint">The copy starts in the first status and is linked to {issue.key} (“clones”).</p>
      </form>
    </Modal>
  )
}
