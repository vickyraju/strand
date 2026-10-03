import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Bookmark, Bug, SquareCheck, Zap, ChevronsUp, ChevronUp, Equal, ChevronDown, Minus, Check, UserRound, X,
} from 'lucide-react'
import { transitionsFrom, type IssueType, type Priority, type Project, type Status, type User } from '../data/store'

// ── Type ───────────────────────────────────────────────────

export const TYPE_META: Record<IssueType, { label: string; Icon: typeof Bug; color: string }> = {
  epic:  { label: 'Epic',  Icon: Zap,         color: '#7C3AED' },
  story: { label: 'Story', Icon: Bookmark,    color: '#16A34A' },
  task:  { label: 'Task',  Icon: SquareCheck, color: '#2563EB' },
  bug:   { label: 'Bug',   Icon: Bug,         color: '#DC2626' },
}

export function TypeIcon({ type, size = 14 }: { type: IssueType; size?: number }) {
  const { Icon, color, label } = TYPE_META[type]
  return (
    <span className="type-icon" style={{ background: color, width: size + 2, height: size + 2 }} title={label} aria-label={label}>
      <Icon size={size - 4} strokeWidth={2.5} color="#FFFFFF" />
    </span>
  )
}

// ── Priority ───────────────────────────────────────────────

export const PRIORITY_META: Record<Priority, { label: string; Icon: typeof Bug; color: string }> = {
  urgent: { label: 'Urgent',      Icon: ChevronsUp,  color: '#DC2626' },
  high:   { label: 'High',        Icon: ChevronUp,   color: '#EA580C' },
  medium: { label: 'Medium',      Icon: Equal,       color: '#D97706' },
  low:    { label: 'Low',         Icon: ChevronDown, color: '#2563EB' },
  none:   { label: 'No priority', Icon: Minus,       color: '#A8A29E' },
}
export const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const { Icon, color, label } = PRIORITY_META[priority]
  return <Icon size={size} strokeWidth={2.25} color={color} style={{ flexShrink: 0 }} aria-label={label} />
}

// ── People ─────────────────────────────────────────────────

export function Avatar({ user, size = 22 }: { user?: User | null; size?: number }) {
  if (!user) {
    return (
      <span className="avatar avatar-empty" style={{ width: size, height: size }} title="Unassigned">
        <UserRound size={size * 0.6} strokeWidth={1.5} />
      </span>
    )
  }
  return (
    <span className="avatar" style={{ width: size, height: size, background: user.color, fontSize: Math.max(8, size * 0.4) }} title={user.name}>
      {user.initials}
    </span>
  )
}

// ── Status ─────────────────────────────────────────────────

/** Jira-style lozenge: grey for to do, blue for in progress, green for done. */
export function StatusLozenge({ status }: { status?: Status }) {
  if (!status) return null
  return <span className={`lozenge lozenge-${status.category}`}>{status.name}</span>
}

// ── Picker: choose one value from a list ───────────────────

export interface PickerOption<T> {
  value: T
  label: string
  icon?: ReactNode
  hint?:  string
}

/** Keeps a popover inside the viewport: flips up when there is no room below. */
function usePopoverPlacement(open: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [up, setUp] = useState(false)
  useEffect(() => {
    if (!open || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setUp(r.bottom > window.innerHeight - 8 && r.top - r.height > 8)
  }, [open])
  return { ref, up }
}

export function Picker<T>({ value, options, onChange, trigger, title, className = 'chip', align = 'left', search, disabled }: {
  value:      T
  options:    PickerOption<T>[]
  onChange:   (v: T) => void
  trigger:    ReactNode
  title?:     string
  className?: string
  align?:     'left' | 'right'
  search?:    boolean
  disabled?:  boolean
}) {
  const [open, setOpen]   = useState(false)
  const [query, setQuery] = useState('')
  const { ref, up } = usePopoverPlacement(open)
  const shown = query ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase())) : options

  useEffect(() => {
    if (!open) { setQuery(''); return }
    if (!search) ref.current?.querySelector<HTMLButtonElement>('[aria-selected=true], button')?.focus()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('.picker-item') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
    if (e.key === 'Enter' && search && document.activeElement?.tagName === 'INPUT' && shown[0]) {
      e.preventDefault(); onChange(shown[0].value); setOpen(false)
    }
  }

  return (
    <span className="picker" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <button type="button" className={className} onClick={() => setOpen(v => !v)} title={title} aria-label={title}
        aria-haspopup="listbox" aria-expanded={open} disabled={disabled}>
        {trigger}
      </button>
      {open && (
        <>
          <div className="popover-scrim" onClick={() => setOpen(false)} />
          <div ref={ref} className={`picker-menu picker-${align}${up ? ' up' : ''}`} role="listbox" onKeyDown={onKeyDown}>
            {search && (
              <input className="picker-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…" autoFocus aria-label="Search options" />
            )}
            {shown.length === 0 && <div className="picker-empty">No matches</div>}
            {shown.map(o => {
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
                  <span className="picker-label">{o.label}</span>
                  {o.hint && <span className="picker-hint">{o.hint}</span>}
                  {selected && <Check size={14} strokeWidth={2} className="picker-check" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </span>
  )
}

// ── Menu: a list of actions ────────────────────────────────

export interface MenuItem {
  label:   string
  icon?:   ReactNode
  onClick: () => void
  danger?: boolean
  hint?:   string
  divider?: boolean
}

export function Menu({ items, trigger, title, className = 'icon-btn', align = 'right' }: {
  items: MenuItem[]; trigger: ReactNode; title: string; className?: string; align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const { ref, up } = usePopoverPlacement(open)
  useEffect(() => { if (open) ref.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className="picker" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <button type="button" className={className} onClick={() => setOpen(v => !v)} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open}>
        {trigger}
      </button>
      {open && (
        <>
          <div className="popover-scrim" onClick={() => setOpen(false)} />
          <div ref={ref} className={`picker-menu picker-${align}${up ? ' up' : ''}`} role="menu"
            onKeyDown={e => {
              if (e.key === 'Escape') setOpen(false)
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const xs = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
                const i = xs.indexOf(document.activeElement as HTMLButtonElement)
                xs[(i + (e.key === 'ArrowDown' ? 1 : -1) + xs.length) % xs.length]?.focus()
              }
            }}>
            {items.map((it, i) => (
              <span key={i} style={{ display: 'contents' }}>
                {it.divider && <div className="menu-divider" />}
                <button type="button" role="menuitem" className={`picker-item${it.danger ? ' danger' : ''}`}
                  onClick={() => { setOpen(false); it.onClick() }}>
                  {it.icon}
                  <span className="picker-label">{it.label}</span>
                  {it.hint && <kbd className="kbd">{it.hint}</kbd>}
                </button>
              </span>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

// ── Modal ──────────────────────────────────────────────────

export function Modal({ title, onClose, children, footer, width = 480 }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
        <div className="modal-hdr">
          <h2 className="modal-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-ftr">{footer}</div>}
      </div>
    </div>
  )
}

// ── Small controls ─────────────────────────────────────────

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle-thumb" />
    </button>
  )
}

export function Checkbox({ checked, indeterminate, onChange, label }: {
  checked: boolean; indeterminate?: boolean; onChange: (v: boolean, e: React.MouseEvent) => void; label: string
}) {
  return (
    <button type="button" role="checkbox" aria-checked={indeterminate ? 'mixed' : checked} aria-label={label}
      className={`checkbox${checked || indeterminate ? ' on' : ''}`}
      onClick={e => { e.stopPropagation(); onChange(!checked, e) }}>
      {indeterminate ? <Minus size={11} strokeWidth={3} /> : checked ? <Check size={11} strokeWidth={3} /> : null}
    </button>
  )
}

// ── Option builders ────────────────────────────────────────

/** Status options. With `from`, only statuses the workflow allows moving to (plus the current one). */
export function statusOptions(project: Project, from?: string): PickerOption<string>[] {
  const allowed = from === undefined ? null : new Map(transitionsFrom(project, from).map(t => [t.to, t.name]))
  return project.statuses
    .filter(s => !allowed || s.id === from || allowed.has(s.id))
    .map(s => ({
      value: s.id, label: s.name,
      hint: allowed && s.id !== from && allowed.get(s.id) !== s.name ? allowed.get(s.id) : undefined,
      icon: <span className="status-dot" style={{ background: s.color }} />,
    }))
}

export const priorityOptions: PickerOption<Priority>[] =
  PRIORITIES.map(p => ({ value: p, label: PRIORITY_META[p].label, icon: <PriorityIcon priority={p} /> }))

export const typeOptions = (allowEpic = true): PickerOption<IssueType>[] =>
  (Object.keys(TYPE_META) as IssueType[]).filter(t => allowEpic || t !== 'epic')
    .map(t => ({ value: t, label: TYPE_META[t].label, icon: <TypeIcon type={t} /> }))

export const userOptions = (users: User[]): PickerOption<string | undefined>[] => [
  { value: undefined, label: 'Unassigned', icon: <Avatar size={20} /> },
  ...users.map(u => ({ value: u.id as string | undefined, label: u.name, icon: <Avatar user={u} size={20} /> })),
]

// ── Empty state ────────────────────────────────────────────

export function Empty({ icon, title, body, action }: {
  icon: ReactNode; title: string; body: string; action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      <div className="empty-body">{body}</div>
      {action && <div className="empty-actions">{action}</div>}
    </div>
  )
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Mar 4" for a YYYY-MM-DD date. */
export const formatDate = (date: string) =>
  new Date(date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
export const isOverdue = (date?: string) => !!date && new Date(date + 'T23:59') < new Date()

// ── Popover: free-form panel under a trigger ───────────────

export function Popover({ trigger, title, className = 'btn btn-secondary', align = 'right', children, width = 280 }: {
  trigger: ReactNode; title: string; className?: string; align?: 'left' | 'right'; children: ReactNode; width?: number
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className="picker" onClick={e => e.stopPropagation()}>
      <button type="button" className={`${className}${open ? ' active' : ''}`} onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={title} title={title}>
        {trigger}
      </button>
      {open && (
        <>
          <div className="popover-scrim" onClick={() => setOpen(false)} />
          <div className={`popover picker-${align}`} style={{ width }} role="dialog" aria-label={title}
            onKeyDown={e => e.key === 'Escape' && setOpen(false)}>
            <div className="popover-hdr">
              <span>{title}</span>
              <button className="icon-btn sm" onClick={() => setOpen(false)} aria-label="Close"><X size={14} /></button>
            </div>
            {children}
          </div>
        </>
      )}
    </span>
  )
}
