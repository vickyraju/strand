import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useStore, userOf, isDone, type Project } from '../data/store'
import { useApp, useNavList } from '../appContext'
import { useFilters } from './filters'
import { TypeIcon, Avatar } from './ui'
import { toDay } from './TimelineView'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_PER_DAY = 4

export default function CalendarView({ project }: { project: Project }) {
  const { state } = useStore()
  const { openIssue, createIssue } = useApp()
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [expanded, setExpanded] = useState<string | null>(null)

  const all = state.issues.filter(i => i.projectId === project.id)
  const people = [...new Set(all.map(i => i.assigneeId).filter((x): x is string => !!x))].map(id => userOf(state, id)!).filter(Boolean)
  const filters = useFilters(people)
  const items = filters.apply(all).filter(i => i.dueDate).sort((a, b) => a.rank - b.rank)
  const undated = filters.apply(all).filter(i => !i.dueDate && i.type !== 'epic').length

  // Six-week grid starting on the Monday on or before the 1st
  const first = new Date(month)
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset)
  const cells = Array.from({ length: 42 }, (_, k) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + k))
  const todayKey = toDay(Date.now())
  const inMonth = items.filter(i => i.dueDate!.startsWith(toDay(month.getTime()).slice(0, 7)))
  useNavList(inMonth.map(i => i.id))

  const shift = (n: number) => setMonth(m => new Date(m.getFullYear(), m.getMonth() + n, 1))

  return (
    <div className="page-col">
      <div className="toolbar">
        {filters.toolbar}
        <div style={{ flex: 1 }} />
        <span className="muted sm">{inMonth.length} due this month{undated ? ` · ${undated} without a due date` : ''}</span>
        <button className="btn btn-secondary" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)) }}>Today</button>
        <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
        <h2 className="cal-month">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        <button className="icon-btn" onClick={() => shift(1)} aria-label="Next month"><ChevronRight size={16} /></button>
      </div>

      <div className="cal-scroll">
        <div className="cal" role="grid" aria-label={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}>
          {WEEKDAYS.map(d => <div key={d} className="cal-weekday" role="columnheader">{d}</div>)}
          {cells.map(d => {
            const key = toDay(d.getTime())
            const due = items.filter(i => i.dueDate === key)
            const open = expanded === key
            const shown = open ? due : due.slice(0, MAX_PER_DAY)
            return (
              <div key={key} role="gridcell" aria-label={d.toDateString()}
                className={`cal-day${d.getMonth() !== month.getMonth() ? ' other' : ''}${key === todayKey ? ' today' : ''}${d.getDay() % 6 === 0 ? ' weekend' : ''}`}>
                <div className="cal-day-head">
                  <span className="cal-date">{d.getDate()}</span>
                  <button className="icon-btn sm cal-add" onClick={() => createIssue({ projectId: project.id, dueDate: key })} aria-label={`Create work item due ${d.toDateString()}`} title="Create work item due this day">
                    <Plus size={13} />
                  </button>
                </div>
                {shown.map(i => {
                  const done = isDone(project, i)
                  const late = !done && key < todayKey
                  return (
                    <button key={i.id} className={`cal-item${done ? ' done' : ''}${late ? ' late' : ''}`} onClick={() => openIssue(i.id)} title={`${i.key} ${i.title}`}
                      style={{ ['--bar' as string]: project.statuses.find(s => s.id === i.status)?.color }}>
                      <TypeIcon type={i.type} size={12} />
                      <span className="cell-ellipsis">{i.title}</span>
                      {i.assigneeId && <Avatar user={userOf(state, i.assigneeId)} size={16} />}
                    </button>
                  )
                })}
                {due.length > MAX_PER_DAY && (
                  <button className="link sm cal-more" onClick={() => setExpanded(open ? null : key)}>{open ? 'Show less' : `+${due.length - MAX_PER_DAY} more`}</button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
