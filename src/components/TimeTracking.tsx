import { useState } from 'react'
import { Clock, Trash2 } from 'lucide-react'
import { useStore, userOf, type Issue } from '../data/store'
import { useApp } from '../appContext'
import { Avatar, Modal, formatDate } from './ui'
import { parseDuration, formatDuration, loggedMinutes } from '../data/time'

/** Bar + numbers in the details panel, with "Log time" and the estimate. */
export function TimeField({ issue }: { issue: Issue }) {
  const { dispatch } = useStore()
  const [open, setOpen] = useState(false)
  const [estimate, setEstimate] = useState(issue.timeEstimate ? formatDuration(issue.timeEstimate) : '')
  const logged = loggedMinutes(issue)
  const est = issue.timeEstimate ?? 0
  const remaining = Math.max(0, est - logged)
  const over = est > 0 && logged > est
  const scale = Math.max(est, logged, 1)

  return (
    <div className="time-field">
      <button className="time-bar-btn" onClick={() => setOpen(true)} title="Log time" aria-label={`Log time. ${logged ? formatDuration(logged) : "Nothing"} logged${est ? ` of ${formatDuration(est)}` : ""}`}>
        <span className="time-bar">
          <span className={`time-logged${over ? ' over' : ''}`} style={{ width: `${(logged / scale) * 100}%` }} />
        </span>
        <span className="time-nums">
          <span>{logged ? `${formatDuration(logged)} logged` : 'No time logged'}</span>
          {est > 0 && <span className={over ? 'text-danger' : 'muted'}>{over ? `${formatDuration(logged - est)} over` : `${formatDuration(remaining)} left`}</span>}
        </span>
      </button>
      <label className="time-est">
        <span className="muted sm">Estimate</span>
        <input className="field-input" value={estimate} placeholder="e.g. 2d 4h" aria-label="Time estimate"
          onChange={e => setEstimate(e.target.value)}
          onBlur={() => {
            const v = estimate.trim() ? parseDuration(estimate) : undefined
            if (v === null) { setEstimate(issue.timeEstimate ? formatDuration(issue.timeEstimate) : ''); return }
            dispatch({ type: 'updateIssues', ids: [issue.id], patch: { timeEstimate: v } })
            setEstimate(v ? formatDuration(v) : '')
          }}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
      </label>
      {open && <LogTimeDialog issue={issue} onClose={() => setOpen(false)} />}
    </div>
  )
}

function LogTimeDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [spent, setSpent] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const minutes = parseDuration(spent)
  const logs = [...issue.worklogs].sort((a, b) => b.date.localeCompare(a.date) || b.at - a.at)

  return (
    <Modal title={`Time tracking · ${issue.key}`} onClose={onClose} width={520}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
        <button className="btn btn-primary" form="log-time" type="submit" disabled={!minutes}><Clock size={15} />Log time</button>
      </>}>
      <form id="log-time" onSubmit={e => {
        e.preventDefault()
        if (!minutes) return
        dispatch({ type: 'logWork', issueId: issue.id, minutes, date, note })
        toast(`Logged ${formatDuration(minutes)} on ${issue.key}`)
        setSpent(''); setNote('')
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
        <label className="label" htmlFor="lt-note" style={{ marginTop: 10 }}>What did you work on? <span className="muted">(optional)</span></label>
        <input id="lt-note" className="input" value={note} onChange={e => setNote(e.target.value)} />
      </form>

      {logs.length > 0 && (
        <>
          <h3 className="section-label" style={{ marginTop: 20 }}>Work log · {formatDuration(loggedMinutes(issue))}</h3>
          <div className="worklog">
            {logs.map(w => {
              const who = userOf(state, w.userId)
              return (
                <div key={w.id} className="worklog-row">
                  <Avatar user={who} size={22} />
                  <span className="worklog-text"><b>{who?.name}</b> logged <b>{formatDuration(w.minutes)}</b>{w.note ? ` · ${w.note}` : ''}</span>
                  <span className="muted sm nowrap">{formatDate(w.date)}</span>
                  {w.userId === state.me?.id && (
                    <button className="icon-btn sm" onClick={() => dispatch({ type: 'deleteWorklog', issueId: issue.id, worklogId: w.id })} aria-label="Delete work log" title="Delete"><Trash2 size={13} /></button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </Modal>
  )
}
