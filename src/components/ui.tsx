import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bookmark, Bug, SquareCheck, ChevronsUp, ChevronUp, Equal, ChevronDown, Minus, Check, UserRound,
} from 'lucide-react'
import type { IssueType, Priority, Status, User } from '../data/store'

// ── Type ───────────────────────────────────────────────────

export const TYPE_META: Record<IssueType, { label: string; Icon: typeof Bug; color: string }> = {
  task:  { label: 'Task',  Icon: SquareCheck, color: '#4F46E5' },
  story: { label: 'Story', Icon: Bookmark,    color: '#059669' },
  bug:   { label: 'Bug',   Icon: Bug,         color: '#DC2626' },
}

export function TypeIcon({ type, size = 14 }: { type: IssueType; size?: number }) {
  const { Icon, color, label } = TYPE_META[type]
  return <Icon size={size} strokeWidth={2} color={color} style={{ flexShrink: 0 }} aria-label={label} />
}

// ── Priority ───────────────────────────────────────────────

export const PRIORITY_META: Record<Priority, { label: string; Icon: typeof Bug; color: string }> = {
  urgent: { label: 'Urgent',      Icon: ChevronsUp,  color: '#DC2626' },
  high:   { label: 'High',        Icon: ChevronUp,   color: '#D97706' },
  medium: { label: 'Medium',      Icon: Equal,       color: '#78716C' },
  low:    { label: 'Low',         Icon: ChevronDown, color: '#78716C' },
  none:   { label: 'No priority', Icon: Minus,       color: '#A8A29E' },
}
export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

export function PriorityIcon({ priority, size = 13 }: { priority: Priority; size?: number }) {
  const { Icon, color, label } = PRIORITY_META[priority]
  return <Icon size={size} strokeWidth={2} color={color} style={{ flexShrink: 0 }} aria-label={label} />
}

// ── People ─────────────────────────────────────────────────

export function Avatar({ user, size = 22 }: { user?: User; size?: number }) {
  if (!user) {
    return (
      <span className="avatar avatar-empty" style={{ width: size, height: size }} title="Unassigned">
        <UserRound size={size * 0.6} strokeWidth={1.5} />
      </span>
    )
  }
  return (
    <span className="avatar" style={{ width: size, height: size, background: user.color, fontSize: size * 0.4 }} title={user.name}>
      {user.initials}
    </span>
  )
}

// ── Status ─────────────────────────────────────────────────

export function StatusPill({ status }: { status?: Status }) {
  if (!status) return null
  return (
    <span className="status-pill" style={{ color: status.done ? '#15803D' : '#44403C' }}>
      <span className="status-dot" style={{ background: status.color }} />
      {status.name}
    </span>
  )
}

// ── Picker: a small accessible dropdown of options ─────────

export interface PickerOption<T> {
  value: T
  label: string
  icon?: ReactNode
}

export function Picker<T>({ value, options, onChange, trigger, title, className = 'chip', align = 'left' }: {
  value:      T
  options:    PickerOption<T>[]
  onChange:   (v: T) => void
  trigger:    ReactNode
  title?:     string
  className?: string
  align?:     'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLButtonElement>('[aria-selected=true], button')?.focus()
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onClick={e => e.stopPropagation()}>
      <button type="button" className={className} onClick={() => setOpen(v => !v)} title={title} aria-haspopup="listbox" aria-expanded={open}>
        {trigger}
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 549 }} onClick={() => setOpen(false)} />
          <div ref={listRef} className={`picker-menu picker-${align}`} role="listbox" onKeyDown={onKeyDown}>
            {options.map(o => {
              const selected = o.value === value
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="picker-item"
                  onClick={() => { onChange(o.value); setOpen(false) }}
                >
                  {o.icon}
                  <span style={{ flex: 1 }}>{o.label}</span>
                  {selected && <Check size={13} strokeWidth={2} color="#368727" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </span>
  )
}

// ── Option builders shared by the create modal and detail page ──

export const statusOptions = (statuses: Status[]): PickerOption<string>[] =>
  statuses.map(s => ({ value: s.id, label: s.name, icon: <span className="status-dot" style={{ background: s.color }} /> }))

export const priorityOptions: PickerOption<Priority>[] =
  PRIORITIES.map(p => ({ value: p, label: PRIORITY_META[p].label, icon: <PriorityIcon priority={p} /> }))

export const typeOptions: PickerOption<IssueType>[] =
  (Object.keys(TYPE_META) as IssueType[]).map(t => ({ value: t, label: TYPE_META[t].label, icon: <TypeIcon type={t} /> }))

export const userOptions = (users: User[]): PickerOption<string | undefined>[] => [
  { value: undefined, label: 'Unassigned', icon: <Avatar size={18} /> },
  ...users.map(u => ({ value: u.id as string | undefined, label: u.name, icon: <Avatar user={u} size={18} /> })),
]

// ── Empty state ────────────────────────────────────────────

export function Empty({ icon, title, body, action }: {
  icon: ReactNode; title: string; body: string; action?: ReactNode
}) {
  return (
    <div className="pv-empty">
      <div className="pv-empty-icon">{icon}</div>
      <div className="pv-empty-title">{title}</div>
      <div className="pv-empty-body">{body}</div>
      {action}
    </div>
  )
}
