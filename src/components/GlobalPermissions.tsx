import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api/client'
import { useApp } from '../appContext'
import { GroupPicker } from './admin/scale'
import { Loading, LoadError } from './ui'

// Administration › Global permissions (spec 0717), as Jira's: each permission and the groups it is granted to.

interface Perm { key: string; name: string; groups: { id: string | null; groupId: string; groupName: string; fixed: boolean }[] }
const ABOUT: Record<string, string> = {
  'system-admin': 'Everything in Administration. The system-administrators group always has it.',
  'jira-admin': 'Most of Administration: people, groups, project categories, workflows, fields, screens, notification schemes, link types, priorities, resolutions and global automation. Not system settings, sign-in, directories, global permissions, webhooks, backups or the audit log.',
  'browse-users': 'See lists of people and groups in pickers. Without it, people are found by their exact email address, and only one’s own groups are listed.',
  'shared-objects': 'Share saved views with the workspace, projects, groups or people.',
  'group-subscriptions': 'Subscribe a group to a saved view.',
  'bulk-change': 'Change many work items at once from the selection bar: edit, move, transition, watch, delete.',
}

export default function GlobalPermissions() {
  const { toast } = useApp()
  const [perms, setPerms] = useState<Perm[] | null>(null)
  const [error, setError] = useState('')
  const load = () => api<Perm[]>('GET', '/api/admin/global-permissions').then(setPerms, e => setError(errorMessage(e)))
  useEffect(() => { void load() }, [])
  const run = (p: Promise<unknown>, done: string) => p.then(() => { toast(done); return load() }, e => toast(errorMessage(e), { tone: 'warn' }))
  if (error) return <LoadError error={error} onRetry={() => { setError(''); void load() }} />
  if (!perms) return <Loading rows={5} />
  return <>{perms.map(p => (
    <section key={p.key} className="panel" aria-label={p.name}>
      <h2 className="panel-title">{p.name}</h2>
      <p className="muted">{ABOUT[p.key]}</p>
      <ul className="plain-list" style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
        {p.groups.length === 0 && <li className="muted sm">No group: only system administrators.</li>}
        {p.groups.map(g => (
          <li key={g.groupId} className="cell-flex" style={{ gap: 8, padding: '4px 0' }}>
            <span style={{ flex: 1 }}>{g.groupName}</span>
            {g.fixed ? <span className="muted sm">Always</span>
              : <button className="btn btn-ghost btn-sm" onClick={() => void run(api('DELETE', `/api/admin/global-permissions/${g.id}`), `${g.groupName} no longer has ${p.name}`)}>Remove</button>}
          </li>
        ))}
      </ul>
      <GroupPicker value={null} label={`Add a group to ${p.name}`} placeholder="Add a group…" exclude={p.groups.map(g => g.groupId)}
        onChange={g => g && void run(api('POST', '/api/admin/global-permissions', { permission: p.key, groupId: g.id }), `${g.name} has ${p.name}`)} />
    </section>
  ))}</>
}
