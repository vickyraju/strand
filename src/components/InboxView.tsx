import { useEffect } from 'react'
import { useState } from 'react'
import { Inbox, AtSign, UserPlus, MessageSquare, ArrowRightLeft, CalendarClock, MoreHorizontal, CheckCheck, Archive, Eye } from 'lucide-react'
import { useStore, userOf, timeAgo, type Notification, type NotificationKind } from '../data/store'
import { useApp, useNavList } from '../appContext'
import { useLocation, navigate, href } from '../router'
import WorkItemDetail from './WorkItemDetail'
import { Avatar, Menu, Empty, TypeIcon } from './ui'

type Filter = 'all' | 'unread' | 'mentioned' | 'assigned'

const KIND_ICON: Record<NotificationKind, typeof AtSign> = {
  mentioned: AtSign, assigned: UserPlus, commented: MessageSquare, status: ArrowRightLeft, due: CalendarClock,
}

function bucket(ts: number) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (ts >= today.getTime()) return 'Today'
  if (ts >= today.getTime() - 86_400_000) return 'Yesterday'
  if (ts >= today.getTime() - 6 * 86_400_000) return 'This week'
  return 'Older'
}

export default function InboxView() {
  const { state, dispatch } = useStore()
  const { toast, goTo } = useApp()
  const { peek } = useLocation()
  const [filter, setFilter] = useState<Filter>('all')
  const [showArchived, setShowArchived] = useState(false)
  const me = state.me!

  // One row per work item: its newest notification, plus how many there are
  const mine = state.notifications.filter(n => n.userId === me.id && (showArchived ? n.archived : !n.archived))
  const byIssue = new Map<string, Notification[]>()
  for (const n of [...mine].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!state.issues.some(i => i.id === n.issueId)) continue
    byIssue.set(n.issueId, [...(byIssue.get(n.issueId) ?? []), n])
  }
  const rows = [...byIssue.entries()].map(([issueId, ns]) => ({ issueId, latest: ns[0], all: ns, unread: ns.some(n => !n.read) }))
    .filter(r => filter === 'all' || (filter === 'unread' ? r.unread : r.all.some(n => n.kind === filter)))
  const selectedIssue = peek ? state.issues.find(i => i.key === peek) : undefined
  const ids = rows.map(r => r.issueId)
  useNavList(ids)
  const unreadCount = mine.filter(n => !n.read).length

  const open = (issueId: string) => {
    const key = state.issues.find(i => i.id === issueId)?.key
    if (key) navigate(href({ name: 'inbox' }, key), { replace: !!peek })
  }
  const archive = (issueId: string) => {
    const i = ids.indexOf(issueId)
    dispatch({ type: 'archive', ids: byIssue.get(issueId)!.map(n => n.id) })
    toast('Archived', { undo: 'archive' })
    const next = ids[i + 1] ?? ids[i - 1]
    if (next && next !== issueId) open(next); else navigate(href({ name: 'inbox' }), { replace: true })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (e.metaKey || e.ctrlKey || (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
      if (e.key === 'e' && selectedIssue && byIssue.has(selectedIssue.id) && !showArchived) { e.preventDefault(); archive(selectedIssue.id) }
      if ((e.key === 'j' || e.key === 'k') && !selectedIssue && ids.length) { e.preventDefault(); open(ids[0]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  let lastBucket = ''
  return (
    <div className="inbox">
      <section className="inbox-list" aria-label="Notifications">
        <div className="inbox-hdr">
          <h1 className="inbox-title">{showArchived ? 'Archive' : 'Inbox'}</h1>
          {unreadCount > 0 && !showArchived && <span className="count-pill">{unreadCount}</span>}
          <div style={{ flex: 1 }} />
          <Menu title="Inbox options" trigger={<MoreHorizontal size={16} />} items={[
            { label: 'Mark all as read', icon: <CheckCheck size={14} />, onClick: () => { dispatch({ type: 'markRead', ids: mine.filter(n => !n.read).map(n => n.id) }); toast('All caught up') } },
            { label: 'Archive all read', icon: <Archive size={14} />, onClick: () => { dispatch({ type: 'archive', ids: mine.filter(n => n.read).map(n => n.id) }); toast('Archived all read', { undo: 'archive' }) } },
            { label: showArchived ? 'Show inbox' : 'Show archived', icon: <Eye size={14} />, divider: true, onClick: () => setShowArchived(v => !v) },
          ]} />
        </div>
        <div className="segmented full inbox-filters" role="tablist" aria-label="Filter notifications">
          {([['all', 'All'], ['unread', 'Unread'], ['mentioned', 'Mentions'], ['assigned', 'Assigned']] as const).map(([f, l]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{l}</button>
          ))}
        </div>

        <div className="inbox-items">
          {rows.length === 0 && (
            <div className="inbox-empty">
              <Inbox size={28} strokeWidth={1.25} />
              <b>{showArchived ? 'Nothing archived' : filter === 'all' ? 'You’re all caught up' : 'Nothing here'}</b>
              <p className="muted sm">
                {state.users.length > 1
                  ? 'You’ll be notified when someone assigns you, mentions you, or updates work you watch.'
                  : 'Notifications come from teammates. Add people in Settings, then use “Act as” in your avatar menu to work as them.'}
              </p>
              {state.users.length <= 1 && <button className="btn btn-secondary btn-sm" onClick={() => goTo('settings')}>Add people</button>}
            </div>
          )}
          {rows.map(r => {
            const issue = state.issues.find(i => i.id === r.issueId)!
            const actor = userOf(state, r.latest.actorId)
            const Icon = KIND_ICON[r.latest.kind]
            const b = bucket(r.latest.createdAt)
            const header = b !== lastBucket ? (lastBucket = b) : null
            return (
              <div key={r.issueId}>
                {header && <div className="inbox-bucket">{header}</div>}
                <div role="button" tabIndex={0} aria-current={selectedIssue?.id === r.issueId}
                  className={`inbox-row${selectedIssue?.id === r.issueId ? ' active' : ''}${r.unread ? ' unread' : ''}`}
                  onClick={() => open(r.issueId)} onKeyDown={e => e.key === 'Enter' && open(r.issueId)}>
                  <span className="inbox-avatar">
                    <Avatar user={actor} size={30} />
                    <span className={`kind-badge kind-${r.latest.kind}`}><Icon size={10} strokeWidth={2.5} /></span>
                  </span>
                  <span className="inbox-text">
                    <span className="inbox-issue"><TypeIcon type={issue.type} size={12} /><span className="mono muted">{issue.key}</span><span className="cell-ellipsis">{issue.title}</span></span>
                    <span className="inbox-reason">{r.latest.text}{r.all.length > 1 ? ` · +${r.all.length - 1} more` : ''}</span>
                  </span>
                  <span className="inbox-meta">
                    <span className="muted sm">{timeAgo(r.latest.createdAt)}</span>
                    {r.unread && <span className="unread-dot" aria-label="Unread" />}
                  </span>
                  {!showArchived && (
                    <button className="icon-btn sm inbox-archive" title="Archive (E)" aria-label={`Archive ${issue.key}`}
                      onClick={e => { e.stopPropagation(); archive(r.issueId) }}><Archive size={13} /></button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="inbox-detail" aria-label="Selected work item">
        {selectedIssue
          ? <WorkItemDetail issueId={selectedIssue.id} mode="peek" navList={ids} />
          : <Empty icon={<Inbox size={22} strokeWidth={1.5} />} title={rows.length ? 'Select a notification' : 'No notification selected'}
              body="Open a notification to see the work item here. Use J and K to move through the list, E to archive." />}
      </section>
    </div>
  )
}
