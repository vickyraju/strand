import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, X, Link2, Trash2, Plus } from 'lucide-react'
import { useStore, userOf, projectOf, timeAgo, type Issue, type IssuePatch } from '../data/store'
import { useApp } from '../appContext'
import {
  Picker, TypeIcon, PriorityIcon, Avatar, TYPE_META, PRIORITY_META,
  statusOptions, priorityOptions, typeOptions, userOptions,
} from './ui'
import IssueRow from './IssueRow'

/** Textarea that grows with its content. */
function AutoText(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} />
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="wi-prop"><span className="wi-prop-label">{label}</span><div className="wi-prop-val">{children}</div></div>
}

export default function WorkItemDetail({ issueId, mode, onExpand, onClose }: {
  issueId:  string
  mode:     'peek' | 'full'
  onExpand: () => void
  onClose:  () => void
}) {
  const { state, dispatch } = useStore()
  const { createIssue, openIssue, openProject, toast } = useApp()
  const issue = state.issues.find(i => i.id === issueId)
  const project = projectOf(state, issue?.projectId)

  const [title, setTitle]       = useState(issue?.title ?? '')
  const [desc, setDesc]         = useState(issue?.description ?? '')
  const [comment, setComment]   = useState('')
  const [labels, setLabels]     = useState(issue?.labels.join(', ') ?? '')
  const [confirmDel, setConfirmDel] = useState(false)

  // Reset local edit buffers when switching to another item
  useEffect(() => {
    setTitle(issue?.title ?? '')
    setDesc(issue?.description ?? '')
    setLabels(issue?.labels.join(', ') ?? '')
    setConfirmDel(false)
  }, [issueId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!issue || !project) return null

  const set = (patch: IssuePatch) => dispatch({ type: 'updateIssue', id: issue.id, patch })
  const status   = project.statuses.find(s => s.id === issue.status)
  const assignee = userOf(state, issue.assigneeId)
  const reporter = userOf(state, issue.reporterId)
  const parent   = state.issues.find(i => i.id === issue.parentId)
  const subItems = state.issues.filter(i => i.parentId === issue.id)
  const sprints  = state.sprints.filter(s => s.projectId === project.id && s.state !== 'closed')
  const sprint   = state.sprints.find(s => s.id === issue.sprintId)

  const timeline = [
    ...state.activity.filter(a => a.issueId === issue.id).map(a => ({ kind: 'activity' as const, ...a })),
    ...state.comments.filter(c => c.issueId === issue.id).map(c => ({ kind: 'comment' as const, ...c })),
  ].sort((a, b) => a.createdAt - b.createdAt)

  const postComment = () => {
    if (!comment.trim()) return
    dispatch({ type: 'addComment', issueId: issue.id, body: comment })
    setComment('')
  }

  const remove = () => {
    dispatch({ type: 'deleteIssue', id: issue.id })
    toast(`Deleted ${issue.key}`)
    onClose()
  }

  return (
    <div className="wi-root">
      <div className="detail-header">
        <button className="detail-header-crumb wi-crumb" onClick={() => openProject(project.id)}>{project.name}</button>
        {parent && (
          <>
            <span className="detail-header-sep">/</span>
            <button className="issue-key-chip" onClick={() => openIssue(parent.id)}>{parent.key}</button>
          </>
        )}
        <span className="detail-header-sep">/</span>
        <span className="issue-key-chip"><TypeIcon type={issue.type} size={12} />{issue.key}</span>
        <div style={{ flex: 1 }} />
        <div className="detail-header-actions">
          <button className="dhdr-btn" title="Copy key" onClick={() => { navigator.clipboard?.writeText(issue.key); toast(`Copied ${issue.key}`) }}>
            <Link2 size={15} strokeWidth={1.5} />
          </button>
          {confirmDel ? (
            <button className="btn-danger" style={{ height: 28 }} onClick={remove}>Delete {issue.key}?</button>
          ) : (
            <button className="dhdr-btn" title="Delete" onClick={() => setConfirmDel(true)}><Trash2 size={15} strokeWidth={1.5} /></button>
          )}
          <button className="dhdr-btn" title={mode === 'peek' ? 'Open full page' : 'Back to peek'} onClick={onExpand}>
            {mode === 'peek' ? <Maximize2 size={15} strokeWidth={1.5} /> : <Minimize2 size={15} strokeWidth={1.5} />}
          </button>
          <button className="dhdr-btn" title="Close (Esc)" onClick={onClose}><X size={16} strokeWidth={1.5} /></button>
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-left">
          <div className="detail-title-wrap">
            <AutoText
              className="detail-title"
              value={title}
              aria-label="Title"
              onChange={e => setTitle(e.target.value.replace(/\n/g, ''))}
              onBlur={() => title.trim() ? set({ title: title.trim() }) : setTitle(issue.title)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
            />
          </div>

          <h3 className="wi-h">Description</h3>
          <AutoText
            className="wi-desc"
            value={desc}
            placeholder="Add a description…"
            aria-label="Description"
            onChange={e => setDesc(e.target.value)}
            onBlur={() => set({ description: desc })}
          />

          {!issue.parentId && (
            <>
              <div className="wi-h-row">
                <h3 className="wi-h">Sub-items {subItems.length > 0 && <span className="ir-group-count">
                  {subItems.filter(i => project.statuses.find(s => s.id === i.status)?.done).length}/{subItems.length}
                </span>}</h3>
                <button className="col-hdr-btn" title="Add sub-item"
                  onClick={() => createIssue({ projectId: project.id, parentId: issue.id, sprintId: issue.sprintId })}>
                  <Plus size={13} strokeWidth={2} />
                </button>
              </div>
              <div className="wi-subs">
                {subItems.length === 0
                  ? <div className="wi-muted">Break this work into smaller pieces.</div>
                  : subItems.map(s => <IssueRow key={s.id} issue={s} project={project} />)}
              </div>
            </>
          )}

          <h3 className="wi-h">Activity</h3>
          <div className="wi-timeline">
            {timeline.map(t => {
              const who = userOf(state, t.kind === 'comment' ? t.authorId : t.actorId)
              return t.kind === 'comment' ? (
                <div key={t.id} className="wi-comment">
                  <Avatar user={who} size={24} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="wi-meta"><b>{who?.name ?? 'Someone'}</b> · {timeAgo(t.createdAt)}</div>
                    <div className="wi-comment-body">{t.body}</div>
                  </div>
                </div>
              ) : (
                <div key={t.id} className="wi-event">
                  <Avatar user={who} size={16} />
                  <span><b>{who?.name ?? 'Someone'}</b> {t.text} · {timeAgo(t.createdAt)}</span>
                </div>
              )
            })}
          </div>
          <div className="wi-compose">
            <Avatar user={state.me ?? undefined} size={24} />
            <div style={{ flex: 1 }}>
              <AutoText
                className="form-input"
                value={comment}
                placeholder="Leave a comment…"
                aria-label="Comment"
                onChange={e => setComment(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), postComment())}
              />
              {comment.trim() && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                  <button className="btn-primary" onClick={postComment} title="⌘↵">Comment</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="detail-sidebar">
          <Row label="Status">
            <Picker value={issue.status} options={statusOptions(project.statuses)} onChange={s => set({ status: s })}
              trigger={<><span className="status-dot" style={{ background: status?.color }} />{status?.name}</>} />
          </Row>
          <Row label="Priority">
            <Picker value={issue.priority} options={priorityOptions} onChange={priority => set({ priority })}
              trigger={<><PriorityIcon priority={issue.priority} />{PRIORITY_META[issue.priority].label}</>} />
          </Row>
          <Row label="Assignee">
            <Picker value={issue.assigneeId} options={userOptions(state.users)} onChange={assigneeId => set({ assigneeId })}
              trigger={<><Avatar user={assignee} size={16} />{assignee?.name ?? 'Unassigned'}</>} />
            {issue.assigneeId !== state.me?.id && (
              <button className="wi-link" onClick={() => set({ assigneeId: state.me?.id })}>Assign to me</button>
            )}
          </Row>
          <Row label="Type">
            <Picker value={issue.type} options={typeOptions} onChange={type => set({ type })}
              trigger={<><TypeIcon type={issue.type} size={13} />{TYPE_META[issue.type].label}</>} />
          </Row>
          {project.template === 'scrum' && (
            <Row label="Sprint">
              <Picker
                value={issue.sprintId}
                options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name }))]}
                onChange={sprintId => set({ sprintId })}
                trigger={<>{sprint?.name ?? 'Backlog'}</>}
              />
            </Row>
          )}
          <Row label="Labels">
            <input className="chip-input wi-input" value={labels} placeholder="Add labels, comma separated" aria-label="Labels"
              onChange={e => setLabels(e.target.value)}
              onBlur={() => set({ labels: labels.split(',').map(l => l.trim()).filter(Boolean) })} />
          </Row>
          <Row label="Estimate">
            <input className="chip-input wi-input" type="number" min={0} value={issue.estimate ?? ''} placeholder="Points" aria-label="Estimate"
              onChange={e => set({ estimate: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} />
          </Row>
          <Row label="Due date">
            <input className="chip-date wi-input" type="date" value={issue.dueDate ?? ''} aria-label="Due date"
              onChange={e => set({ dueDate: e.target.value || undefined })} />
          </Row>
          {!subItems.length && (
            <Row label="Parent">
              <Picker
                value={issue.parentId}
                options={[
                  { value: undefined, label: 'None' },
                  ...state.issues
                    .filter((i: Issue) => i.projectId === project.id && i.id !== issue.id && !i.parentId)
                    .map(i => ({ value: i.id as string | undefined, label: `${i.key} ${i.title}` })),
                ]}
                onChange={parentId => set({ parentId })}
                trigger={<>{parent ? parent.key : 'None'}</>}
              />
            </Row>
          )}
          <Row label="Reporter"><span className="wi-static"><Avatar user={reporter} size={16} />{reporter?.name}</span></Row>
          <div className="wi-dates">
            Created {new Date(issue.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}<br />
            Updated {timeAgo(issue.updatedAt)}
          </div>
        </aside>
      </div>
    </div>
  )
}
