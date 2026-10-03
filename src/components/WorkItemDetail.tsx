import { useEffect, useRef, useState } from 'react'
import {
  Maximize2, Minimize2, X, Link2, Trash2, Plus, Eye, EyeOff, ChevronUp, ChevronDown, MoreHorizontal,
  Ban, Unlink, Pencil, UserCheck, Copy,
} from 'lucide-react'
import {
  useStore, userOf, projectOf, timeAgo, transitionsFrom,
  type Issue, type IssuePatch, type IssueLink,
} from '../data/store'
import { useApp } from '../appContext'
import { href, navigate } from '../router'
import {
  Picker, Menu, TypeIcon, PriorityIcon, Avatar, Modal, TYPE_META, PRIORITY_META, StatusLozenge,
  priorityOptions, typeOptions, userOptions, plural,
} from './ui'
import { Markdown, MentionTextarea } from './markdown'
import { transitionLabel } from './BoardCard'
import IssueRow from './IssueRow'

function AutoText(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} />
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><span className="field-label">{label}</span><div className="field-val">{children}</div></div>
}

export default function WorkItemDetail({ issueId, mode, navList }: { issueId: string; mode: 'peek' | 'full'; navList: string[] }) {
  const { state, dispatch } = useStore()
  const { createIssue, openIssue, closeIssue, openProject, toast } = useApp()
  const issue = state.issues.find(i => i.id === issueId)
  const project = projectOf(state, issue?.projectId)

  const [title, setTitle]         = useState(issue?.title ?? '')
  const [desc, setDesc]           = useState(issue?.description ?? '')
  const [editingDesc, setEditing] = useState(false)
  const [comment, setComment]     = useState('')
  const [labels, setLabels]       = useState(issue?.labels.join(', ') ?? '')
  const [tab, setTab]             = useState<'comments' | 'history' | 'all'>('comments')
  const [editComment, setEditComment] = useState<{ id: string; body: string } | null>(null)
  const [linking, setLinking]     = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  useEffect(() => {
    setTitle(issue?.title ?? ''); setDesc(issue?.description ?? ''); setLabels(issue?.labels.join(', ') ?? '')
    setEditing(false); setConfirmDel(false); setLinking(false)
    if (issue) dispatch({ type: 'markViewed', issueId: issue.id })
    // Opening an item marks its notifications for the viewer as read
    const unread = state.notifications.filter(n => n.issueId === issueId && n.userId === state.me?.id && !n.read).map(n => n.id)
    if (unread.length) dispatch({ type: 'markRead', ids: unread })
  }, [issueId]) // eslint-disable-line react-hooks/exhaustive-deps

  // j / k step through the list the item was opened from
  const idx = navList.indexOf(issueId)
  const prev = idx > 0 ? navList[idx - 1] : undefined
  const next = idx >= 0 && idx < navList.length - 1 ? navList[idx + 1] : undefined
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (e.metaKey || e.ctrlKey || (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
      if (e.key === 'j' && next) { e.preventDefault(); openIssue(next) }
      if (e.key === 'k' && prev) { e.preventDefault(); openIssue(prev) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prev, next, openIssue])

  if (!issue || !project) return null

  const set = (patch: IssuePatch) => dispatch({ type: 'updateIssues', ids: [issue.id], patch })
  const status   = project.statuses.find(s => s.id === issue.status)
  const assignee = userOf(state, issue.assigneeId)
  const reporter = userOf(state, issue.reporterId)
  const parent   = state.issues.find(i => i.id === issue.parentId)
  const epic     = parent?.type === 'epic' ? parent : parent ? state.issues.find(i => i.id === parent.parentId && i.type === 'epic') : undefined
  const children = state.issues.filter(i => i.parentId === issue.id)
  const childDone = children.filter(i => project.statuses.find(s => s.id === i.status)?.category === 'done').length
  const sprints  = state.sprints.filter(s => s.projectId === project.id && s.state !== 'closed')
  const sprint   = state.sprints.find(s => s.id === issue.sprintId)
  const watching = !!state.me && issue.watcherIds.includes(state.me.id)
  const watchers = issue.watcherIds.map(id => userOf(state, id)).filter(u => !!u)
  const moves    = transitionsFrom(project, issue.status)

  // Links in both directions, described from this item's point of view
  const links: { other: Issue; label: string; owner: string }[] = [
    ...issue.links.map(l => ({ l, other: state.issues.find(i => i.id === l.issueId) }))
      .filter(x => x.other).map(({ l, other }) => ({ other: other!, label: l.type === 'blocks' ? 'blocks' : 'relates to', owner: issue.id })),
    ...state.issues.flatMap(o => o.links.filter(l => l.issueId === issue.id).map(l => ({ other: o, label: l.type === 'blocks' ? 'is blocked by' : 'relates to', owner: o.id }))),
  ]

  const events = state.activity.filter(a => a.issueId === issue.id)
  const comments = state.comments.filter(c => c.issueId === issue.id)
  const timeline = [
    ...(tab !== 'comments' ? events.map(a => ({ kind: 'event' as const, id: a.id, at: a.createdAt, who: a.actorId, text: a.text })) : []),
    ...(tab !== 'history' ? comments.map(c => ({ kind: 'comment' as const, id: c.id, at: c.createdAt, who: c.authorId, text: c.body, edited: c.editedAt })) : []),
  ].sort((a, b) => a.at - b.at)

  const postComment = () => {
    if (!comment.trim()) return
    dispatch({ type: 'addComment', issueId: issue.id, body: comment })
    setComment('')
    setTab(t => t === 'history' ? 'comments' : t)
  }

  const copyLink = () => { navigator.clipboard?.writeText(location.origin + href({ name: 'issue', key: issue.key })); toast(`Copied link to ${issue.key}`) }

  return (
    <div className="detail">
      <div className="detail-hdr">
        <nav className="detail-crumbs" aria-label="Location">
          <button className="crumb-link" onClick={() => openProject(project.id)}>{project.name}</button>
          {epic && epic.id !== parent?.id && <><span className="crumb-sep">/</span><button className="crumb-link" onClick={() => openIssue(epic.id)}><TypeIcon type="epic" size={12} />{epic.key}</button></>}
          {parent && <><span className="crumb-sep">/</span><button className="crumb-link" onClick={() => openIssue(parent.id)}><TypeIcon type={parent.type} size={12} />{parent.key}</button></>}
          <span className="crumb-sep">/</span>
          <button className="key-chip" onClick={copyLink} title="Copy link"><TypeIcon type={issue.type} size={12} />{issue.key}</button>
        </nav>
        <div style={{ flex: 1 }} />
        {navList.length > 1 && idx >= 0 && (
          <span className="pager">
            <span className="muted sm">{idx + 1} / {navList.length}</span>
            <button className="icon-btn" disabled={!prev} onClick={() => prev && openIssue(prev)} title="Previous (K)" aria-label="Previous work item"><ChevronUp size={16} /></button>
            <button className="icon-btn" disabled={!next} onClick={() => next && openIssue(next)} title="Next (J)" aria-label="Next work item"><ChevronDown size={16} /></button>
          </span>
        )}
        <button className={`icon-btn${watching ? ' active' : ''}`} onClick={() => dispatch({ type: 'toggleWatch', issueId: issue.id })}
          title={watching ? 'Stop watching' : 'Watch for updates'} aria-pressed={watching} aria-label={watching ? 'Stop watching' : 'Watch'}>
          {watching ? <Eye size={16} /> : <EyeOff size={16} />}<span className="sm">{watchers.length}</span>
        </button>
        <button className="icon-btn" onClick={copyLink} title="Copy link" aria-label="Copy link"><Link2 size={16} /></button>
        <Menu title="More actions" trigger={<MoreHorizontal size={16} />} items={[
          { label: 'Copy key', icon: <Copy size={14} />, onClick: () => { navigator.clipboard?.writeText(issue.key); toast(`Copied ${issue.key}`) } },
          { label: 'Link work item', icon: <Link2 size={14} />, onClick: () => setLinking(true) },
          ...(issue.type !== 'epic' && !issue.parentId ? [{ label: 'Add sub-item', icon: <Plus size={14} />, onClick: () => createIssue({ projectId: project.id, parentId: issue.id, sprintId: issue.sprintId }) }] : []),
          { label: 'Delete', icon: <Trash2 size={14} />, danger: true, divider: true, onClick: () => setConfirmDel(true) },
        ]} />
        <button className="icon-btn" onClick={() => mode === 'peek' ? openIssue(issue.id, { full: true }) : navigate(href({ name: 'project', key: project.key }, issue.key))}
          title={mode === 'peek' ? 'Open full page' : 'Open in side panel'} aria-label={mode === 'peek' ? 'Open full page' : 'Open in side panel'}>
          {mode === 'peek' ? <Maximize2 size={15} /> : <Minimize2 size={15} />}
        </button>
        <button className="icon-btn" onClick={closeIssue} title="Close (Esc)" aria-label="Close"><X size={17} /></button>
      </div>

      <div className="detail-body">
        <div className="detail-main">
          <AutoText className="detail-title" value={title} aria-label="Title"
            onChange={e => setTitle(e.target.value.replace(/\n/g, ''))}
            onBlur={() => title.trim() ? set({ title: title.trim() }) : setTitle(issue.title)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }} />

          <div className="quick-actions">
            {issue.type !== 'epic' && !issue.parentId && (
              <button className="btn btn-secondary btn-sm" onClick={() => createIssue({ projectId: project.id, parentId: issue.id, sprintId: issue.sprintId })}><Plus size={14} />Sub-item</button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => setLinking(true)}><Link2 size={14} />Link</button>
          </div>

          <section className="detail-section">
            <h3 className="section-title">Description</h3>
            {editingDesc ? (
              <>
                <MentionTextarea className="input desc-input" value={desc} onChange={setDesc} users={state.users} autoFocus
                  placeholder="Describe the work. Markdown: **bold**, *italic*, `code`, - lists, [links](https://…), @mentions"
                  onSubmit={() => { set({ description: desc }); setEditing(false) }} aria-label="Description" />
                <div className="row-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => { set({ description: desc }); setEditing(false) }}>Save</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setDesc(issue.description); setEditing(false) }}>Cancel</button>
                  <span className="muted sm">Markdown supported · ⌘↵ to save</span>
                </div>
              </>
            ) : (
              <div className={`desc-view${issue.description ? '' : ' is-empty'}`} role="button" tabIndex={0}
                onClick={e => { if (!(e.target as HTMLElement).closest('a')) setEditing(true) }}
                onKeyDown={e => e.key === 'Enter' && setEditing(true)} aria-label="Edit description">
                {issue.description ? <Markdown text={issue.description} users={state.users} /> : 'Add a description…'}
              </div>
            )}
          </section>

          {(issue.type === 'epic' || !issue.parentId) && (
            <section className="detail-section">
              <div className="section-title-row">
                <h3 className="section-title">{issue.type === 'epic' ? 'Work in this epic' : 'Sub-items'}</h3>
                {children.length > 0 && (
                  <span className="cell-flex muted sm">
                    <span className="progress"><span style={{ width: `${(childDone / children.length) * 100}%` }} /></span>{childDone} of {children.length} done
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <button className="icon-btn sm" title="Add" aria-label="Add child work item"
                  onClick={() => createIssue({ projectId: project.id, parentId: issue.id, sprintId: issue.type === 'epic' ? undefined : issue.sprintId, type: issue.type === 'epic' ? 'story' : 'task' })}>
                  <Plus size={15} />
                </button>
              </div>
              {children.length === 0
                ? <p className="muted sm">{issue.type === 'epic' ? 'Add stories, tasks and bugs to this epic to track its progress.' : 'Break this work into smaller pieces.'}</p>
                : <div className="rows-box">{children.map(c => <IssueRow key={c.id} issue={c} project={project} showUpdated={false} />)}</div>}
            </section>
          )}

          {links.length > 0 && (
            <section className="detail-section">
              <div className="section-title-row">
                <h3 className="section-title">Linked work items</h3>
                <div style={{ flex: 1 }} />
                <button className="icon-btn sm" onClick={() => setLinking(true)} aria-label="Link work item" title="Link work item"><Plus size={15} /></button>
              </div>
              <div className="rows-box">
                {links.map(({ other, label, owner }) => {
                  const op = projectOf(state, other.projectId)!
                  return (
                    <div key={`${owner}-${other.id}`} className="link-row">
                      <span className={`link-type${label === 'is blocked by' ? ' danger' : ''}`}>{label === 'is blocked by' && <Ban size={12} />}{label}</span>
                      <button className="link-target" onClick={() => openIssue(other.id)}>
                        <TypeIcon type={other.type} size={13} /><span className="mono muted">{other.key}</span><span className="cell-ellipsis">{other.title}</span>
                      </button>
                      <StatusLozenge status={op.statuses.find(s => s.id === other.status)} />
                      <button className="icon-btn sm" title="Remove link" aria-label={`Remove link to ${other.key}`}
                        onClick={() => dispatch({ type: 'removeLink', issueId: issue.id, otherId: other.id })}><Unlink size={13} /></button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section className="detail-section">
            <div className="section-title-row">
              <h3 className="section-title">Activity</h3>
              <div style={{ flex: 1 }} />
              <div className="segmented sm" role="tablist" aria-label="Activity filter">
                {(['comments', 'history', 'all'] as const).map(t => (
                  <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                    {t === 'comments' ? `Comments${comments.length ? ` ${comments.length}` : ''}` : t === 'history' ? 'History' : 'All'}
                  </button>
                ))}
              </div>
            </div>

            <div className="compose-comment">
              <Avatar user={state.me} size={30} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <MentionTextarea className="input comment-input" value={comment} onChange={setComment} users={state.users}
                  placeholder="Add a comment… Type @ to mention someone" aria-label="Add a comment" onSubmit={postComment} />
                {comment.trim() && (
                  <div className="row-actions">
                    <button className="btn btn-primary btn-sm" onClick={postComment}>Comment</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setComment('')}>Cancel</button>
                    <span className="muted sm">⌘↵ to post</span>
                  </div>
                )}
              </div>
            </div>

            <ol className="timeline">
              {timeline.length === 0 && <li className="muted sm">{tab === 'comments' ? 'No comments yet.' : 'No history yet.'}</li>}
              {[...timeline].reverse().map(t => {
                const who = userOf(state, t.who)
                if (t.kind === 'event') {
                  return (
                    <li key={t.id} className="event">
                      <Avatar user={who} size={20} />
                      <span><b>{who?.name ?? 'Someone'}</b> {t.text}</span>
                      <span className="muted sm nowrap" title={new Date(t.at).toLocaleString()}>{timeAgo(t.at)}</span>
                    </li>
                  )
                }
                const mine = t.who === state.me?.id
                const editing = editComment?.id === t.id
                return (
                  <li key={t.id} className="comment">
                    <Avatar user={who} size={30} />
                    <div className="comment-main">
                      <div className="comment-meta">
                        <b>{who?.name ?? 'Someone'}</b>
                        <span className="muted sm" title={new Date(t.at).toLocaleString()}>{timeAgo(t.at)}{t.edited ? ' · edited' : ''}</span>
                      </div>
                      {editing ? (
                        <>
                          <MentionTextarea className="input comment-input" value={editComment.body} users={state.users} autoFocus aria-label="Edit comment"
                            onChange={body => setEditComment({ id: t.id, body })}
                            onSubmit={() => { dispatch({ type: 'editComment', id: t.id, body: editComment.body }); setEditComment(null) }} />
                          <div className="row-actions">
                            <button className="btn btn-primary btn-sm" onClick={() => { dispatch({ type: 'editComment', id: t.id, body: editComment.body }); setEditComment(null) }}>Save</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditComment(null)}>Cancel</button>
                          </div>
                        </>
                      ) : <Markdown text={t.text} users={state.users} />}
                      {mine && !editing && (
                        <div className="comment-actions">
                          <button className="link sm" onClick={() => setEditComment({ id: t.id, body: t.text })}><Pencil size={11} />Edit</button>
                          <button className="link sm text-danger" onClick={() => dispatch({ type: 'deleteComment', id: t.id })}><Trash2 size={11} />Delete</button>
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        </div>

        <aside className="detail-side" aria-label="Details">
          <div className="status-action">
            <Picker
              value={issue.status}
              title="Change status"
              className={`status-btn cat-${status?.category}`}
              options={[
                { value: issue.status, label: status?.name ?? '', icon: <span className="status-dot" style={{ background: status?.color }} /> },
                ...moves.map(t => ({ value: t.to, label: transitionLabel(project, t), icon: <span className="status-dot" style={{ background: project.statuses.find(s => s.id === t.to)?.color }} /> })),
              ]}
              onChange={s => set({ status: s })}
              trigger={<>{status?.name}<ChevronDown size={14} /></>}
            />
            {moves.length === 0 && <span className="muted sm">No moves allowed from this status</span>}
          </div>

          <div className="side-card">
            <h3 className="side-title">Details</h3>
            <Field label="Assignee">
              <Picker value={issue.assigneeId} search options={userOptions(state.users)} onChange={assigneeId => set({ assigneeId })} className="field-btn" title="Assignee"
                trigger={<><Avatar user={assignee} size={22} />{assignee?.name ?? 'Unassigned'}</>} />
              {issue.assigneeId !== state.me?.id && <button className="link sm" onClick={() => set({ assigneeId: state.me?.id })}><UserCheck size={12} />Assign to me</button>}
            </Field>
            <Field label="Reporter"><span className="field-static"><Avatar user={reporter} size={22} />{reporter?.name ?? '—'}</span></Field>
            <Field label="Priority">
              <Picker value={issue.priority} options={priorityOptions} onChange={priority => set({ priority })} className="field-btn" title="Priority"
                trigger={<><PriorityIcon priority={issue.priority} />{PRIORITY_META[issue.priority].label}</>} />
            </Field>
            <Field label="Type">
              <Picker value={issue.type} options={typeOptions(!issue.parentId && children.every(c => c.type !== 'epic'))} onChange={type => set({ type })} className="field-btn" title="Type"
                trigger={<><TypeIcon type={issue.type} size={14} />{TYPE_META[issue.type].label}</>} />
            </Field>
            {issue.type !== 'epic' && (
              <Field label="Parent">
                <Picker value={issue.parentId} search className="field-btn" title="Parent"
                  options={[
                    { value: undefined, label: 'None' },
                    ...state.issues.filter(i => i.projectId === project.id && i.id !== issue.id && (i.type === 'epic' || (!i.parentId && children.length === 0)))
                      .map(i => ({ value: i.id as string | undefined, label: `${i.key} ${i.title}`, icon: <TypeIcon type={i.type} size={12} /> })),
                  ]}
                  onChange={parentId => set({ parentId })}
                  trigger={parent ? <><TypeIcon type={parent.type} size={13} /><span className="cell-ellipsis">{parent.title}</span></> : <span className="muted">None</span>} />
              </Field>
            )}
            {project.template === 'scrum' && issue.type !== 'epic' && (
              <Field label="Sprint">
                <Picker value={issue.sprintId} className="field-btn" title="Sprint"
                  options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name, hint: s.state === 'active' ? 'Active' : undefined }))]}
                  onChange={sprintId => set({ sprintId })}
                  trigger={<>{sprint?.name ?? <span className="muted">Backlog</span>}</>} />
              </Field>
            )}
            <Field label="Labels">
              <input className="field-input" value={labels} placeholder="None" aria-label="Labels (comma separated)"
                onChange={e => setLabels(e.target.value)}
                onBlur={() => set({ labels: [...new Set(labels.split(',').map(l => l.trim()).filter(Boolean))] })} />
            </Field>
            <Field label="Story points">
              <input className="field-input" type="number" min={0} value={issue.estimate ?? ''} placeholder="None" aria-label="Story points"
                onChange={e => set({ estimate: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Start date">
              <input className="field-input" type="date" value={issue.startDate ?? ''} max={issue.dueDate} aria-label="Start date" onChange={e => set({ startDate: e.target.value || undefined })} />
            </Field>
            <Field label="Due date">
              <input className="field-input" type="date" value={issue.dueDate ?? ''} min={issue.startDate} aria-label="Due date" onChange={e => set({ dueDate: e.target.value || undefined })} />
            </Field>
            <Field label="Watchers">
              <span className="avatar-group sm">{watchers.map(u => <Avatar key={u.id} user={u} size={22} />)}</span>
            </Field>
          </div>
          <div className="side-dates">
            <div>Created {new Date(issue.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
            <div>Updated {timeAgo(issue.updatedAt)}</div>
          </div>
        </aside>
      </div>

      {linking && <LinkDialog issue={issue} onClose={() => setLinking(false)} />}
      {confirmDel && (
        <Modal title={`Delete ${issue.key}?`} onClose={() => setConfirmDel(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setConfirmDel(false)}>Cancel</button>
            <button className="btn btn-danger" autoFocus onClick={() => { dispatch({ type: 'deleteIssues', ids: [issue.id] }); toast(`Deleted ${issue.key}`); closeIssue() }}>Delete</button>
          </>}>
          <p>“{issue.title}” will be permanently deleted{children.length ? `, along with ${plural(children.length, 'sub-item')}` : ''}. Comments and history go with it.</p>
        </Modal>
      )}
    </div>
  )
}

function LinkDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const [type, setType] = useState<'blocks' | 'blocked' | 'relates'>('blocks')
  const [query, setQuery] = useState('')
  const linked = new Set([...issue.links.map(l => l.issueId), ...state.issues.filter(o => o.links.some(l => l.issueId === issue.id)).map(o => o.id)])
  const q = query.trim().toLowerCase()
  const options = state.issues
    .filter(i => i.id !== issue.id && !linked.has(i.id) && (!q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)))
    .slice(0, 8)

  const link = (other: Issue) => {
    const l: IssueLink = { type: type === 'relates' ? 'relates' : 'blocks', issueId: type === 'blocked' ? issue.id : other.id }
    dispatch({ type: 'addLink', issueId: type === 'blocked' ? other.id : issue.id, link: l })
    onClose()
  }

  return (
    <Modal title={`Link ${issue.key} to another work item`} onClose={onClose} width={520}>
      <div className="segmented full" role="radiogroup" aria-label="Link type">
        {([['blocks', 'Blocks'], ['blocked', 'Is blocked by'], ['relates', 'Relates to']] as const).map(([v, l]) => (
          <button key={v} role="radio" aria-checked={type === v} className={type === v ? 'on' : ''} onClick={() => setType(v)}>{l}</button>
        ))}
      </div>
      <input className="input" style={{ marginTop: 12 }} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by key or title" autoFocus aria-label="Search work items" />
      <div className="link-results" role="listbox">
        {options.length === 0 && <p className="muted sm" style={{ padding: 8 }}>No matching work items.</p>}
        {options.map(o => (
          <button key={o.id} role="option" aria-selected={false} className="picker-item" onClick={() => link(o)}>
            <TypeIcon type={o.type} size={13} /><span className="mono muted">{o.key}</span><span className="picker-label">{o.title}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
