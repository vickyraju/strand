import { useEffect, useState } from 'react'
import { Inbox, AtSign, UserPlus, MessageSquare, ArrowRightLeft, CalendarClock, MoreHorizontal, CheckCheck, Archive, Eye } from 'lucide-react'
import { useStore, userOf, timeAgo, type Notification, type NotificationKind } from '../data/store'
import { useApp, useNavList } from '../appContext'
import { useLocation, navigate, href } from '../router'
import WorkItemDetail from './WorkItemDetail'
import { Avatar, Menu, Empty, TypeIcon } from './ui'
import { apiEnabled, api } from '../api/client'
import { mapNotification, notificationReason } from '../api/map'
import { loadProjectIssues } from '../api/load'
import { issueSync } from '../api/sync'

/** Notifications from the server. Rows already carry issue key, title and project key, so the inbox
 *  renders even when the project's issues are not in the local store. */
async function fetchNotifications(archived = false, kind?: NotificationKind): Promise<Notification[]> {
  const q = new URLSearchParams({ archived: archived ? '1' : '0' })
  if (kind) q.set('kind', kind)
  return (await api<any[]>('GET', `/api/notifications?${q}`)).map(mapNotification)
}

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

/** One row per work item: its newest notification, plus how many there are. The server joins the
 *  issue key, title and project key, so the inbox renders even for unloaded projects. */
type Row = { issueKey: string; issueTitle: string; projectKey: string; latest: Notification; all: Notification[]; unread: boolean }

/** Filters one user's notifications down to visible rows, grouped per work item. */
function groupRows(mine: Notification[], filter: Filter, unread: Set<string>): Row[] {
  const byIssue = new Map<string, Notification[]>()
  for (const n of [...mine].sort((a, b) => b.createdAt - a.createdAt))
    byIssue.set(n.issueKey ?? n.issueId, [...(byIssue.get(n.issueKey ?? n.issueId) ?? []), n])
  return [...byIssue.entries()].map(([issueKey, ns]) => ({
    issueKey, issueTitle: ns[0].issueTitle ?? '', projectKey: ns[0].projectKey ?? '',
    latest: ns[0], all: ns, unread: ns.some(n => unread.has(n.id)),
  })).filter(r => filter === 'all' || (filter === 'unread' ? r.unread : r.all.some(n => n.kind === filter)))
}

export default function InboxView() {
  const { state, dispatch } = useStore()
  const { toast, goTo } = useApp()
  const { peek } = useLocation()
  const [filter, setFilter] = useState<Filter>('all')
  const [showArchived, setShowArchived] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [loadError, setLoadError] = useState(false)
  const me = state.me!

  // No API: one row per work item from the store's notifications
  const localMine = state.notifications.filter(n => n.userId === me.id && (showArchived ? n.archived : !n.archived))
  const localRows = groupRows(localMine, filter, new Set(localMine.filter(n => !n.read).map(n => n.id)))

  // API: the server joins each row's issue key/title/project key, so the inbox renders even when
  // the project's issues are not loaded. No API: group the store's notifications instead.
  useEffect(() => {
    if (!apiEnabled) { setRows(localRows); return }
    let cancelled = false
    setLoadError(false)
    const kind = filter === 'all' || filter === 'unread' ? undefined : filter
    fetchNotifications(showArchived, kind).then(list => {
      if (cancelled) return
      const unread = new Set(list.filter(n => !n.read).map(n => n.id))
      setRows(groupRows(list, filter, unread))
    }).catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, showArchived, apiEnabled])

  // Re-group the same rows from the store when read/archive state changes locally (opening an item marks it read)
  useEffect(() => {
    setRows(prev => prev.map(r => {
      const local = r.all.map(n => state.notifications.find(x => x.id === n.id)).filter((x): x is Notification => !!x)
      return { ...r, latest: local.length ? local.sort((a, b) => b.createdAt - a.createdAt)[0]! : r.latest,
               all: local.length ? local : r.all, unread: local.some(n => !n.read) }
    }))
  }, [state.notifications])

  const selectedRow = rows.find(r => r.issueKey === peek)
  const ids = rows.map(r => r.latest.issueId)
  useNavList(ids)
  const unreadCount = state.notifications.filter(n => n.userId === me.id && !n.read && !n.archived).length

  // The detail panel needs the full issue. The server's notification rows only carry key/title, so
  // when the selected issue is not in the store yet, fetch its project's issues on demand.
  const selectedKey = selectedRow?.issueKey
  useEffect(() => {
    if (!apiEnabled || !selectedRow || !selectedKey || state.issues.some(i => i.key === selectedKey)) return
    let cancelled = false
    loadProjectIssues(selectedRow.projectKey).then(loaded => {
      if (cancelled || !loaded.length) return
      issueSync.load(loaded[0].projectId, loaded)   // tell the sync layer these exist on the server, or they would be POSTed as new
      dispatch({ type: 'loadIssues', projectId: loaded[0].projectId, issues: loaded.map(({ version, ...i }) => i) })
    }).catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const open = (issueKey: string) => navigate(href({ name: 'inbox' }, issueKey), { replace: !!peek })
  const archive = (row: Row) => {
    const i = rows.indexOf(row)
    dispatch({ type: 'archive', ids: row.all.map(n => n.id) })
    toast('Archived', { undo: 'archive' })
    const next = rows[i + 1] ?? rows[i - 1]
    if (next && next.issueKey !== row.issueKey) open(next.issueKey); else navigate(href({ name: 'inbox' }), { replace: true })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (e.metaKey || e.ctrlKey || (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return
      if (e.key === 'e' && selectedRow && !showArchived) { e.preventDefault(); archive(selectedRow) }
      if ((e.key === 'j' || e.key === 'k') && !selectedRow && rows.length) { e.preventDefault(); open(rows[0].issueKey) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const mine = state.notifications.filter(n => n.userId === me.id && !n.archived)
  const issueOf = (key: string) => state.issues.find(i => i.key === key)

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
          {loadError && <div className="inbox-empty"><b>Couldn’t load your inbox</b><p className="muted sm">The server did not respond. Retry with a new filter.</p></div>}
          {!loadError && rows.length === 0 && (
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
            const issue = issueOf(r.issueKey)   // type icon when the issue is loaded; key + title always
            const actor = userOf(state, r.latest.actorId)
            const reason = notificationReason(r.latest.text, actor?.name, r.issueKey)
            const Icon = KIND_ICON[r.latest.kind]
            const b = bucket(r.latest.createdAt)
            const header = b !== lastBucket ? (lastBucket = b) : null
            return (
              <div key={r.issueKey}>
                {header && <div className="inbox-bucket">{header}</div>}
                <div className={`inbox-row${selectedRow?.issueKey === r.issueKey ? ' active' : ''}${r.unread ? ' unread' : ''}`}>
                  <button type="button" className="inbox-open" aria-current={selectedRow?.issueKey === r.issueKey}
                    aria-label={`${r.issueKey} ${r.issueTitle}. ${reason}${r.unread ? '. Unread' : ''}`}
                    onClick={() => open(r.issueKey)} />
                  <span className="inbox-avatar">
                    <Avatar user={actor} size={30} />
                    <span className={`kind-badge kind-${r.latest.kind}`}><Icon size={10} strokeWidth={2.5} /></span>
                  </span>
                  <span className="inbox-text">
                    <span className="inbox-issue">{issue && <TypeIcon type={issue.type} size={12} />}<span className="mono muted">{r.issueKey}</span><span className="cell-ellipsis">{r.issueTitle}</span></span>
                    <span className="inbox-reason">{reason}{r.all.length > 1 ? ` · +${r.all.length - 1} more` : ''}</span>
                  </span>
                  <span className="inbox-meta">
                    <span className="muted sm">{timeAgo(r.latest.createdAt)}</span>
                    {r.unread && <span className="unread-dot" role="img" aria-label="Unread" />}
                  </span>
                  {!showArchived && (
                    <button className="icon-btn sm inbox-archive" title="Archive (E)" aria-label={`Archive ${r.issueKey}`}
                      onClick={e => { e.stopPropagation(); archive(r) }}><Archive size={13} /></button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="inbox-detail" aria-label="Selected work item">
        {selectedRow && issueOf(selectedRow.issueKey)
          ? <WorkItemDetail issueId={issueOf(selectedRow.issueKey)!.id} mode="peek" navList={ids} />
          : <Empty icon={<Inbox size={22} strokeWidth={1.5} />} title={rows.length ? 'Select a notification' : 'No notification selected'}
              body="Open a notification to see the work item here. Use J and K to move through the list, E to archive." />}
      </section>
    </div>
  )
}
