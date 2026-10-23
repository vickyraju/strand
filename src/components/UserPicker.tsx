// The people picker. In local mode it lists the workspace's people (`state.users`) exactly as
// `userOptions` did; with an API it searches the server (`/users/search`) as you type, so a
// workspace can hold more people than the first page of `/users`. The selected person always
// renders (from the search cache or the store) even when they are not in the current result page.
import { useEffect, useState } from 'react'
import { useStore } from '../data/store'
import { apiEnabled } from '../api/client'
import { useUserSearch } from '../api/users'
import { Avatar, Picker, userOptions, type PickerOption } from './ui'

// A native <select> that picks one user (for compact surfaces, e.g. automation "assign to" steps).
// Local mode: the workspace's people. API mode: the first search page, replaced as you type.
export function UserSelect({ value, onChange, className, excludeId, extraOptions, placeholder = 'Select…', label, projectId }: {
  /** Offer only people who can work in this project (key or id) */
  projectId?: string
  /** Selected user id; `''`/`undefined` = nothing selected. */
  value:    string | undefined
  /** Called with the chosen user id, or `undefined` when the placeholder is picked. */
  onChange: (id: string | undefined) => void
  className?: string
  /** Hide one user from the list (e.g. the workspace owner). */
  excludeId?: string
  /** Static options shown before/alongside the user list (e.g. "Project lead", "The reporter"). */
  extraOptions?: { value: string; label: string }[]
  placeholder?: string
  label: string
}) {
  const { state } = useStore()
  const remote = useUserSearch(projectId)
  const [q, setQ] = useState('')
  useEffect(() => { remote.search('') }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const users = apiEnabled ? remote.users : state.users
  const options = (apiEnabled ? [] : state.users.map(u => ({ value: u.id, label: u.name })))
    .concat(users.filter(u => u.id !== excludeId).map(u => ({ value: u.id, label: u.name })))
  // Avoid duplicates when both sources are in play (the local list already covered it)
  const seen = new Set<string>()
  const list = [...(extraOptions ?? []), ...options].filter(o => (seen.has(o.value) ? false : (seen.add(o.value), true)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <select className={className ?? 'input'} aria-label={label} value={value ?? ''}
        onChange={e => onChange(e.target.value || undefined)}>
        <option value="">{placeholder}</option>
        {list.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {apiEnabled && (
        <input className="input" style={{ height: 30 }} value={q} placeholder="Search people…"
          aria-label={`Search ${label.toLowerCase()}`} onChange={e => { setQ(e.target.value); remote.search(e.target.value) }} />
      )}
    </div>
  )
}

export function UserPicker({ value, onChange, trigger, title = 'Assignee', className, align, allowUnassigned = true, excludeId, placeholder = 'Unassigned', projectId }: {
  /** Offer only people who can work in this project (key or id) */
  projectId?: string
  /** Selected user id; `undefined`/`''` = nobody. */
  value:    string | undefined
  /** Called with the chosen user id, or `undefined` when the option is cleared / "Unassigned" is picked. */
  onChange: (id: string | undefined) => void
  /** The trigger label (avatar + name) shown on the closed button. */
  trigger:  React.ReactNode
  title?:   string
  className?: string
  align?:   'left' | 'right'
  /** Offer the "Unassigned" option. */
  allowUnassigned?: boolean
  /** Exclude one user from the results (e.g. the workspace owner from the project-lead picker). */
  excludeId?: string
  placeholder?: string
}) {
  const { state } = useStore()
  const remote = useUserSearch(projectId)
  const selected = remote.userById(value) ?? state.users.find(u => u.id === value)

  // Local mode: the plain list, exactly as before.
  if (!apiEnabled) {
    const options = userOptions(excludeId ? state.users.filter(u => u.id !== excludeId) : state.users)
    return (
      <Picker value={value} options={options} onChange={onChange} trigger={trigger} title={title}
        className={className} align={align} search />
    )
  }

  // API mode: the first search page as options; typing re-queries the server. The "Unassigned"
  // sentinel and the selected person are kept visible no matter which page is shown.
  const options: PickerOption<string | undefined>[] = []
  if (allowUnassigned) options.push({ value: undefined, label: placeholder, icon: <Avatar size={20} /> })
  if (selected && !remote.users.some(u => u.id === selected!.id) && selected!.id !== excludeId)
    options.push({ value: selected!.id, label: selected!.name, icon: <Avatar user={selected} size={20} /> })
  for (const u of remote.users) if (u.id !== excludeId)
    options.push({ value: u.id, label: u.name, icon: <Avatar user={u} size={20} /> })

  return (
    <Picker value={value} options={options} onChange={id => onChange(id || undefined)} trigger={trigger} title={title}
      className={className} align={align} search
      remote={{ onSearch: remote.search, searching: remote.busy }} />
  )
}