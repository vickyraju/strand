import { useState } from 'react'
import { Clock, Pencil, Trash2 } from 'lucide-react'
import { useStore, userOf, type Issue, type Worklog } from '../data/store'
import { canAdmin } from '../data/access'
import type { Adjust } from '../../server/src/shared/estimates.ts'
import { useApp } from '../appContext'
import { Avatar, Modal, formatDate } from './ui'
import { parseDuration, formatDuration, loggedMinutes } from '../data/time'

/** Jira's time tracking in the details panel: logged against the original estimate, and what is left (the remaining
 *  estimate, which counts down as work is logged and can be set by hand). */
export function TimeField({ issue }: { issue: Issue }) {
  const { dispatch } = useStore()
  const [open, setOpen] = useState(false)
  const logged = loggedMinutes(issue)
  const est = issue.timeEstimate ?? 0
  const remaining = issue.timeRemaining ?? Math.max(0, est - logged)
  const over = est > 0 && logged + remaining > est
  const scale = Math.max(est, logged + remaining, 1)

  return (
    <div className="time-field">
      <button className="time-bar-btn" onClick={() => setOpen(true)} title="Log time" aria-label={`Log time. ${logged ? formatDuration(logged) : 'Nothing'} logged${remaining ? `, ${formatDuration(remaining)} remaining` : ''}`}>
        <span className="time-bar">
          <span className={`time-logged${over ? ' over' : ''}`} style={{ width: `${(logged / scale) * 100}%` }} />
        </span>
        <span className="time-nums">
          <span>{logged ? `${formatDuration(logged)} logged` : 'No time logged'}</span>
          {(est > 0 || issue.timeRemaining !== undefined) && <span className={over ? 'text-danger' : 'muted'}>{formatDuration(remaining)} remaining</span>}
        </span>
      </button>
      <DurationInput label="Original estimate" value={issue.timeEstimate} onSave={v => dispatch({ type: 'updateIssues', ids: [issue.id], patch: { timeEstimate: v } })} />
      <DurationInput label="Remaining estimate" value={issue.timeRemaining} onSave={v => dispatch({ type: 'updateIssues', ids: [issue.id], patch: { timeRemaining: v } })} />
      {open && <LogTimeDialog issue={issue} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** A duration typed as "2d 4h", saved when it loses focus (empty clears it; something unreadable goes back). */
function DurationInput({ label, value, onSave }: { label: string; value: number | undefined; onSave: (v: number | undefined) => void }) {
  const shown = value ? formatDuration(value) : value === 0 ? '0m' : ''
  const [text, setText] = useState(shown)
  const [was, setWas] = useState(value)
  if (was !== value) { setWas(value); setText(shown) }                        // changed elsewhere (logging work)
  return (
    <label className="time-est">
      <span className="muted sm">{label}</span>
      <input className="field-input" value={text} placeholder="e.g. 2d 4h" aria-label={label}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          const v = text.trim() ? parseDuration(text) : undefined
          if (v === null || v === value) { setText(shown); return }
          onSave(v)
        }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    </label>
  )
}

type Mode = Adjust['adjustEstimate']
const MODES: { id: Mode; label: string }[] = [
  { id: 'auto', label: 'Adjust automatically' }, { id: 'leave', label: 'Leave unchanged' }, { id: 'new', label: 'Set to' }, { id: 'manual', label: 'Reduce by' },
]

function LogTimeDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [spent, setSpent] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [mode, setMode] = useState<Mode>('auto')
  const [amount, setAmount] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const minutes = parseDuration(spent)
  const by = mode === 'new' || mode === 'manual' ? parseDuration(amount) : 0
  const adjust: Adjust | null = mode === 'new' ? (by === null ? null : { adjustEstimate: 'new', newEstimate: by })
    : mode === 'manual' ? (by === null ? null : { adjustEstimate: 'manual', reduceBy: by }) : { adjustEstimate: mode }
  const logs = [...issue.worklogs].sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at)
  const admin = canAdmin(state.projects.find(p => p.id === issue.projectId))

  return (
    <Modal title={`Time tracking · ${issue.key}`} onClose={onClose} width={540}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <button className="btn btn-primary" form="log-time" type="submit" disabled={!minutes || !adjust}><Clock size={15} />Log time</button>
      </>}>
      <form id="log-time" onSubmit={e => {
        e.preventDefault()
        if (!minutes || !adjust) return
        dispatch({ type: 'logWork', issueId: issue.id, minutes, date, note, adjust })
        toast(`Logged ${formatDuration(minutes)} on ${issue.key}`)
        setSpent(''); setNote(''); setAmount(''); setMode('auto')
      }}>
        <div className="form-row">
          <div style={{ flex: 1 }}>
            <label className="label" htmlFor="lt-spent">Time spent</label>
            <input id="lt-spent" className="input" value={spent} onChange={e => setSpent(e.target.value)} placeholder="e.g. 1h 30m" autoFocus aria-invalid={!!spent && !minutes} />
          </div>
          <div style={{ width: 170 }}>
            <label className="label" htmlFor="lt-date">Date</label>
            <input id="lt-date" className="input" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={e => setDate(e.target.value)} />
          </div>
        </div>
        <p className={`hint${spent && !minutes ? ' error' : ''}`}>{spent && !minutes ? 'Use a format like 45m, 2h, 1h 30m or 1d (8 hours).' : minutes ? `= ${formatDuration(minutes)}` : 'Use d (8 hours), h and m, e.g. 1h 30m.'}</p>
        <fieldset className="wf-fieldset" style={{ marginTop: 10 }}>
          <legend className="label">Remaining estimate{issue.timeRemaining !== undefined ? ` (now ${formatDuration(issue.timeRemaining) || '0m'})` : ''}</legend>
          <div className="form-row" style={{ alignItems: 'center', gap: 6 }}>
            <div className="segmented sm" role="radiogroup" aria-label="Remaining estimate">
              {MODES.map(m => <button type="button" key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>{m.label}</button>)}
            </div>
            {(mode === 'new' || mode === 'manual') && <input className="input input-sm" style={{ width: 100 }} aria-label={mode === 'new' ? 'New remaining estimate' : 'Reduce by'} placeholder="e.g. 4h" value={amount} onChange={e => setAmount(e.target.value)} />}
          </div>
        </fieldset>
        <label className="label" htmlFor="lt-note" style={{ marginTop: 10 }}>What did you work on? <span className="muted">(optional)</span></label>
        <input id="lt-note" className="input" value={note} onChange={e => setNote(e.target.value)} />
      </form>

      {logs.length > 0 && (
        <>
          <h3 className="section-label" style={{ marginTop: 20 }}>Work log · {formatDuration(loggedMinutes(issue))}</h3>
          <div className="worklog">
            {logs.map(w => {
              const who = userOf(state, w.userId)
              const mine = w.userId === state.me?.id
              if (editing === w.id) return <EditRow key={w.id} w={w} onDone={() => setEditing(null)} onSave={(m, d, n) => { dispatch({ type: 'updateWorklog', issueId: issue.id, worklogId: w.id, minutes: m, date: d, note: n }); setEditing(null) }} />
              return (
                <div key={w.id} className="worklog-row">
                  <Avatar user={who} size={22} />
                  <span className="worklog-text"><b>{who?.name}</b> logged <b>{formatDuration(w.minutes)}</b>{w.note ? ` · ${w.note}` : ''}</span>
                  <span className="muted sm nowrap">{formatDate(w.date)}</span>
                  {(mine || admin) && <>
                    <button className="icon-btn sm" onClick={() => setEditing(w.id)} aria-label="Change work log" title="Change"><Pencil size={13} /></button>
                    <button className="icon-btn sm" onClick={() => dispatch({ type: 'deleteWorklog', issueId: issue.id, worklogId: w.id })} aria-label="Delete work log" title="Delete"><Trash2 size={13} /></button>
                  </>}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}

function EditRow({ w, onSave, onDone }: { w: Worklog; onSave: (minutes: number, date: string, note: string) => void; onDone: () => void }) {
  const [spent, setSpent] = useState(formatDuration(w.minutes))
  const [date, setDate] = useState(w.date)
  const [note, setNote] = useState(w.note)
  const minutes = parseDuration(spent)
  return (
    <form className="worklog-row" onSubmit={e => { e.preventDefault(); if (minutes) onSave(minutes, date, note) }}>
      <input className="input input-sm" style={{ width: 90 }} aria-label="Time spent" value={spent} onChange={e => setSpent(e.target.value)} aria-invalid={!minutes} />
      <input className="input input-sm" type="date" aria-label="Date" value={date} onChange={e => setDate(e.target.value)} />
      <input className="input input-sm" style={{ flex: 1 }} aria-label="Note" value={note} onChange={e => setNote(e.target.value)} />
      <button className="btn btn-primary btn-sm" disabled={!minutes}>Save</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
    </form>
  )
}
