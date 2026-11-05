import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Users, ScrollText, Archive, SlidersHorizontal, Link2, Bookmark, UsersRound, UserMinus, GitBranch, FlaskConical, ArchiveRestore } from 'lucide-react'
import { href, navigate, type AdminSection } from '../../router'

// Administration's frame, as Jira lays it out: a grouped menu on the left, and each page with its title, what it is
// for, and its main action in the same place. Every menu entry is a link (open in a new tab, copy the address).

export interface MenuItem { id: AdminSection; label: string; Icon: typeof Users; intro: string }
export const MENU: { title: string; items: MenuItem[] }[] = [
  { title: 'People & access', items: [
    { id: 'people', label: 'People', Icon: Users, intro: 'Everyone who has signed in. Accounts come from your organisation’s sign-in (Microsoft Entra): see who is active, filter, and change many people at once. Admin rights come from the system-administrators group.' },
    { id: 'groups', label: 'Groups', Icon: UsersRound, intro: 'A group gives a whole team a role in a project at once. Its owners decide who is in it; project admins decide what it may do in their project.' },
    { id: 'license', label: 'License cleanup', Icon: UserMinus, intro: 'Seats in use, and a daily rule that frees the seats of people who stopped using Strand.' },
  ] },
  { title: 'Work items', items: [
    { id: 'workflows', label: 'Workflows', Icon: GitBranch, intro: 'Workflows are shared: a workflow scheme says which workflow each work type uses, and each project uses one scheme. Changing a workflow or a scheme changes every project using it.' },
    { id: 'link-types', label: 'Link types', Icon: Link2, intro: 'The kinds of link people can make between work items, and how each reads from both ends.' },
    { id: 'test-statuses', label: 'Test statuses', Icon: FlaskConical, intro: 'What a test run or one of its steps can end up as. Built-in statuses keep their meaning; add your own for cases like “Blocked” or “Flaky”.' },
  ] },
  { title: 'System', items: [
    { id: 'settings', label: 'System settings', Icon: SlidersHorizontal, intro: 'Policies for the whole workspace. Changes apply within seconds on every server, without a restart, and are recorded in the Audit log.' },
    { id: 'audit', label: 'Audit log', Icon: ScrollText, intro: 'Who changed people, project settings, workflows, automation and deletions, and when. Entries can’t be edited or removed.' },
    { id: 'archived', label: 'Archived projects', Icon: ArchiveRestore, intro: 'Archived projects are read-only and hidden from lists, search and boards; their work items still open from links. Restore one to bring it back as it was.' },
    { id: 'backups', label: 'Project backups', Icon: Archive, intro: 'A copy of each project taken when it is deleted, so a system administrator can bring it back.' },
    { id: 'views', label: 'Shared views', Icon: Bookmark, intro: 'Saved views shared beyond their owner, and views whose owner has left. Give one a new owner to keep it looked after.' },
  ] },
]
export const ITEMS = MENU.flatMap(g => g.items)

/** Where a page's main action goes: the page header (see `PageAction`). */
const ActionSlot = createContext<HTMLElement | null>(null)

/** The page's main action, shown in the header whichever page it is (one per page). */
export function PageAction({ children }: { children: ReactNode }) {
  const slot = useContext(ActionSlot)
  return slot ? createPortal(children, slot) : null
}

/** A plain link that changes page without reloading (a click with a modifier key opens a new tab as usual). */
export function AdminLink({ to, className, current, children }: { to: string; className?: string; current?: boolean; children: ReactNode }) {
  return (
    <a href={to} className={className} aria-current={current ? 'page' : undefined}
      onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(to) }}>{children}</a>
  )
}

export default function AdminShell({ title, items, section, sub, children }: {
  title: string; items: MenuItem[]; section: AdminSection
  /** Entries under the open page (System settings' own pages) */
  sub?: { id: string; label: string; current: boolean }[]
  children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const page = ITEMS.find(i => i.id === section)!
  const groups = MENU.map(g => ({ ...g, items: g.items.filter(i => items.includes(i)) })).filter(g => g.items.length)
  const menu = items.length > 1
  return (
    <div className={`page-col admin${menu ? '' : ' admin-single'}`}>
      {menu && (
        <nav className="admin-nav" aria-label={title}>
          <div className="admin-nav-title">{title}</div>
          {groups.map(g => (
            <div key={g.title} className="admin-nav-group">
              <div className="nav-section">{g.title}</div>
              {g.items.map(i => (
                <div key={i.id}>
                  <AdminLink to={href({ name: 'admin', section: i.id })} current={i.id === section && !sub?.some(s => s.current)} className={`nav-item${i.id === section ? ' active' : ''}`}>
                    <i.Icon size={16} strokeWidth={1.75} className="nav-icon" /><span className="nav-label">{i.label}</span>
                  </AdminLink>
                  {i.id === section && sub && (
                    <div className="admin-nav-sub">
                      {sub.map(s => (
                        <AdminLink key={s.id} to={href({ name: 'admin', section, item: s.id })} current={s.current} className={`nav-item admin-nav-subitem${s.current ? ' active' : ''}`}>
                          <span className="nav-label">{s.label}</span>
                        </AdminLink>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </nav>
      )}
      <main className="admin-main" aria-labelledby="admin-page-title">
        <header className="admin-hdr">
          <div className="admin-hdr-text">
            {!menu && <div className="muted sm">{title}</div>}
            <h1 id="admin-page-title" className="page-title">{page.label}</h1>
            <p className="muted">{page.intro}</p>
          </div>
          <div className="admin-hdr-action" ref={setSlot} />
        </header>
        <ActionSlot.Provider value={slot}>
          <div className="admin-body">{children}</div>
        </ActionSlot.Provider>
      </main>
    </div>
  )
}
