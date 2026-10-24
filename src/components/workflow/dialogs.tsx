import { useState } from 'react'
import type { Category, Status, Transition } from '../../data/store'
import { Checkbox, Modal, plural } from '../ui'
import { LOOP } from './Panels'

const CATS: { id: Category; label: string }[] = [{ id: 'todo', label: 'To do' }, { id: 'in-progress', label: 'In progress' }, { id: 'done', label: 'Done' }]

// ── Create transition ────────────────────────────────────

export interface NewTransition { name: string; from: string[] | 'any'; to: string | null }

/** Jira's "Create transition": where the move starts (one or several statuses, or any), where it ends, and what it is called. */
export function CreateTransitionDialog({ statuses, initial, onCreate, onClose }: {
  statuses: Status[]; initial: NewTransition; onCreate: (t: NewTransition) => void; onClose: () => void
}) {
  const [from, setFrom] = useState<string[] | 'any'>(initial.from)
  const [to, setTo] = useState<string | null>(initial.to)
  const [name, setName] = useState(initial.name)
  const [named, setNamed] = useState(false)   // once the person types a name, stop following the target's name
  const starts = from === 'any' ? 'any' : from.filter(f => f !== to)
  const valid = name.trim() !== '' && (starts === 'any' || starts.length > 0)
  const nameOf = (id: string | null) => (id === null ? '' : statuses.find(s => s.id === id)?.name ?? '')
  const submit = () => { if (valid) onCreate({ name: name.trim(), from: starts, to }) }

  return (
    <Modal title="Create transition" onClose={onClose} width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit}>Create transition</button>
      </>}>
      <form onSubmit={e => { e.preventDefault(); submit() }}>
        <p className="muted" style={{ marginBottom: 14 }}>
          Transitions connect statuses. They are the moves people can make, and they appear as drop zones when people drag work items across the board.
        </p>
        <fieldset className="wf-fieldset">
          <legend className="label">From statuses</legend>
          <label className="check-row">
            <Checkbox checked={from === 'any'} label="Any status" onChange={on => setFrom(on ? 'any' : [])} />Any status
          </label>
          {from !== 'any' && statuses.filter(s => s.id !== to).map(s => (
            <label key={s.id} className="check-row">
              <Checkbox checked={from.includes(s.id)} label={s.name} onChange={on => setFrom(on ? [...from, s.id] : from.filter(f => f !== s.id))} />
              <span className="status-dot" style={{ background: s.color }} />{s.name}
            </label>
          ))}
        </fieldset>
        <label className="label" htmlFor="ct-to" style={{ marginTop: 12 }}>To status</label>
        <select id="ct-to" className="input" value={to ?? LOOP} onChange={e => { const v = e.target.value === LOOP ? null : e.target.value; setTo(v); if (!named) setName(nameOf(v)) }}>
          {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value={LOOP}>Stays in its status (an action)</option>
        </select>
        <label className="label" htmlFor="ct-name" style={{ marginTop: 12 }}>Name</label>
        <input id="ct-name" className="input" value={name} autoFocus onChange={e => { setName(e.target.value); setNamed(true) }} />
        <p className="hint">Tip: name it as the action people take, like “start work” or “send to review”.</p>
      </form>
    </Modal>
  )
}

// ── Add status ───────────────────────────────────────────

export interface NewStatusInput { name: string; category: Category; global: boolean }

export function AddStatusDialog({ existing, onAdd, onClose }: { existing: Status[]; onAdd: (s: NewStatusInput) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState<Category>('in-progress')
  const [global, setGlobal] = useState(true)
  const trimmed = name.trim()
  const duplicate = existing.some(s => s.name.trim().toLowerCase() === trimmed.toLowerCase())
  const valid = trimmed !== '' && !duplicate
  const submit = () => { if (valid) onAdd({ name: trimmed, category, global }) }

  return (
    <Modal title="Add status" onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit}>Add status</button>
      </>}>
      <form onSubmit={e => { e.preventDefault(); submit() }}>
        <label className="label" htmlFor="as-name">Name</label>
        <input id="as-name" className="input" value={name} autoFocus placeholder="e.g. In review" onChange={e => setName(e.target.value)} aria-invalid={duplicate} />
        {duplicate && <p className="hint error" role="alert">A status called “{trimmed}” already exists.</p>}
        <label className="label" style={{ marginTop: 12 }}>Category</label>
        <div className="segmented full" role="radiogroup" aria-label="Category">
          {CATS.map(c => <button type="button" key={c.id} role="radio" aria-checked={category === c.id} className={category === c.id ? 'on' : ''} onClick={() => setCategory(c.id)}>{c.label}</button>)}
        </div>
        <p className="hint">Categories drive reports and decide when work counts as finished.</p>
        <label className="check-row" style={{ marginTop: 10 }}>
          <Checkbox checked={global} label="Add global transition to status" onChange={setGlobal} />Add global transition to status
        </label>
        <p className="hint">Lets any status move work here, so the new status is usable at once. Without it you add a transition into it yourself.</p>
      </form>
    </Modal>
  )
}

// ── Delete status ────────────────────────────────────────

/** Asked only when work items are in the status: where should they go? */
export function DeleteStatusDialog({ status, count, transitions, others, onConfirm, onClose }: {
  status: Status; count: number; transitions: Transition[]; others: Status[]; onConfirm: (moveTo: string) => void; onClose: () => void
}) {
  const [moveTo, setMoveTo] = useState(others[0]!.id)
  return (
    <Modal title={`Delete “${status.name}”?`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" onClick={() => onConfirm(moveTo)}>Delete status</button>
      </>}>
      <p>{plural(count, 'work item')} {count === 1 ? 'is' : 'are'} in this status. Choose where {count === 1 ? 'it' : 'they'} should go:</p>
      <label className="label" htmlFor="ds-to" style={{ marginTop: 12 }}>Move work items to</label>
      <select id="ds-to" className="input" value={moveTo} autoFocus onChange={e => setMoveTo(e.target.value)}>
        {others.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <p className="hint">
        {transitions.length > 0 ? `${plural(transitions.length, 'transition')} into and out of it will be removed too. ` : ''}
        Nothing changes until you choose Update workflow, and you can undo until then.
      </p>
    </Modal>
  )
}
