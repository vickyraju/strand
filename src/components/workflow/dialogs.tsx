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

/** `known`: the global statuses, offered as names; picking one adds that status (with its own category). */
export function AddStatusDialog({ existing, known = [], onAdd, onClose }: { existing: Status[]; known?: Status[]; onAdd: (s: NewStatusInput) => void; onClose: () => void }) {
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
        <input id="as-name" className="input" value={name} autoFocus placeholder="e.g. In review" list="as-known" aria-invalid={duplicate}
          onChange={e => { setName(e.target.value); const k = known.find(x => x.name.toLowerCase() === e.target.value.trim().toLowerCase()); if (k) setCategory(k.category) }} />
        <datalist id="as-known">{known.filter(k => !existing.some(s => s.id === k.id)).map(k => <option key={k.id} value={k.name} />)}</datalist>
        {duplicate && <p className="hint error" role="alert">A status called “{trimmed}” already exists.</p>}
        {!duplicate && known.some(k => k.name.toLowerCase() === trimmed.toLowerCase()) && <p className="hint">An existing status: projects that have it keep its items in it.</p>}
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

/** Asked for a published status: as in Jira, one with work items in any project using the workflow can't leave it
 *  (spec 0103); Update workflow says so, and where they are. */
export function DeleteStatusDialog({ status, transitions, others, onConfirm, onClose }: {
  status: Status; transitions: Transition[]; others: Status[]; onConfirm: (moveTo: string) => void; onClose: () => void
}) {
  const moveTo = others[0]!.id
  return (
    <Modal title={`Delete “${status.name}”?`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" onClick={() => onConfirm(moveTo)}>Delete status</button>
      </>}>
      <p>A status can leave the workflow only when no project using it has work items in it. If some do, Update workflow tells you where they are, and they need moving to another status first.</p>
      <p className="hint">
        {transitions.length > 0 ? `${plural(transitions.length, 'transition')} into and out of it will be removed too. ` : ''}
        Nothing changes until you choose Update workflow, and you can undo until then.
      </p>
    </Modal>
  )
}
