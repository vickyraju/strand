import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Users, ScrollText, Archive, SlidersHorizontal, Link2, Bookmark, UsersRound, GitBranch, FlaskConical, ArchiveRestore, Signal, CircleCheck, KeyRound, Network, FolderTree, Webhook, GitPullRequest, Zap, TextCursorInput, ListChecks, LayoutPanelTop } from 'lucide-react'
import { href, navigate, type AdminSection } from '../../router'

// Administration's frame, as Jira lays it out: a grouped menu on the left, and each page with its title, what it is
// for, and its main action in the same place. Every menu entry is a link (open in a new tab, copy the address).

export interface MenuItem { id: AdminSection; label: string; Icon: typeof Users; intro: string }
export const MENU: { title: string; items: MenuItem[] }[] = [
  { title: 'People & access', items: [
    { id: 'people', label: 'People', Icon: Users, intro: 'Everyone who has signed in. Accounts come from your organisation’s sign-in (Microsoft Entra): see who is active, filter, and change many people at once. Admin rights come from the system-administrators group.' },
    { id: 'groups', label: 'Groups', Icon: UsersRound, intro: 'A group gives a whole team a role in a project at once. Its owners decide who is in it; project admins decide what it may do in their project.' },
    { id: 'auth-methods', label: 'Authentication methods', Icon: KeyRound, intro: 'How people sign in: Microsoft Entra single sign-on, the username and password login form, or both. At least one stays on; every change is recorded in the Audit log.' },
    { id: 'directories', label: 'User directories', Icon: Network, intro: 'Your company’s Active Directory or LDAP servers, read only: people sign in on the login form with their corp id and password, and people, groups and memberships are copied in on a schedule. Nobody is ever deleted: people missing from a directory are deactivated.' },
  ] },
  { title: 'Projects', items: [
    { id: 'project-categories', label: 'Project categories', Icon: FolderTree, intro: 'Group projects by department, client or product line. Each project has at most one category, chosen in its details; search finds their work with category = "Name".' },
  ] },
  { title: 'Work items', items: [
    { id: 'workflows', label: 'Workflows', Icon: GitBranch, intro: 'Workflows are shared: a workflow scheme says which workflow each work type uses, and each project uses one scheme. Changing a workflow or a scheme changes every project using it.' },
    { id: 'custom-fields', label: 'Custom fields', Icon: TextCursorInput, intro: 'Fields shared across projects, as Jira’s: each context says where a field applies (projects, or every project) and for which work types, with its own options and default value.' },
    { id: 'field-configurations', label: 'Field configurations', Icon: ListChecks, intro: 'Which fields are hidden or required, with their descriptions, as Jira’s field configurations. A scheme gives each work type a configuration; a project uses one scheme.' },
    { id: 'screens', label: 'Screens', Icon: LayoutPanelTop, intro: 'Which fields show, on which tabs, when people create, edit and view work, as Jira’s screens. A screen scheme gives Create, Edit and View a screen; an issue type screen scheme gives each work type a screen scheme.' },
    { id: 'link-types', label: 'Link types', Icon: Link2, intro: 'The kinds of link people can make between work items, and how each reads from both ends.' },
    { id: 'priorities', label: 'Priorities', Icon: Signal, intro: 'How urgent work is, highest first. New work gets the default when nobody chooses one. Search and sorting by priority follow this order.' },
    { id: 'resolutions', label: 'Resolutions', Icon: CircleCheck, intro: 'How finished work ended. Each workflow says whether reaching Done sets the default on its own, or only its transitions’ rules set one.' },
    { id: 'test-statuses', label: 'Test statuses', Icon: FlaskConical, intro: 'What a test run or one of its steps can end up as. Built-in statuses keep their meaning; add your own for cases like “Blocked” or “Flaky”.' },
  ] },
  { title: 'System', items: [
    { id: 'settings', label: 'System settings', Icon: SlidersHorizontal, intro: 'Policies for the whole workspace. Changes apply within seconds on every server, without a restart, and are recorded in the Audit log.' },
    { id: 'automation', label: 'Automation', Icon: Zap, intro: 'Global rules: automation that acts in every project, the projects of a category (new ones too), or the projects you choose. Project admins see the ones for their project, read-only.' },
    { id: 'webhooks', label: 'Webhooks', Icon: Webhook, intro: 'Tell other systems when work changes here, with Jira’s events and body. Each call is signed, retried when it fails, and listed with its answer.' },
    { id: 'development', label: 'Development tools', Icon: GitPullRequest, intro: 'Connect GitHub so each work item shows the branches, commits and pull requests that name its key, as Jira’s Development panel.' },
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
