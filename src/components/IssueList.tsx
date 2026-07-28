import { useState, useMemo } from 'react'
import { Filter, SlidersHorizontal, Plus, ChevronDown, Sparkles } from 'lucide-react'
import { ISSUES, PROJECTS, type Status } from '../data/issues'
import IssueRow from './IssueRow'

interface IssueListProps {
  project: string
  onCmdK: () => void
}

const STATUS_ORDER: Status[] = ['blocked', 'in-progress', 'todo', 'done']
const STATUS_LABELS: Record<Status, string> = {
  blocked:     'Blocked',
  'in-progress': 'In progress',
  todo:        'To do',
  done:        'Done',
}
const STATUS_COLORS: Record<Status, string> = {
  blocked:       '#DC2626',
  'in-progress': '#D97706',
  todo:          '#A8A29E',
  done:          '#16A34A',
}

export default function IssueList({ project }: IssueListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(['done']))
  const [activeFilter, setActiveFilter] = useState<Status | null>(null)

  const projectInfo = PROJECTS[project]
  const issues = useMemo(() =>
    ISSUES.filter(i => i.project === project && (!activeFilter || i.status === activeFilter)),
    [project, activeFilter]
  )

  const grouped = useMemo(() => {
    const g: Record<string, typeof issues> = {}
    STATUS_ORDER.forEach(s => {
      const items = issues.filter(i => i.status === s)
      if (items.length > 0) g[s] = items
    })
    return g
  }, [issues])

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const totalCount   = ISSUES.filter(i => i.project === project).length
  const blockedCount = ISSUES.filter(i => i.project === project && i.status === 'blocked').length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#FAFAF9' }}>

      {/* Header */}
      <div style={{ padding: '0 24px', borderBottom: '1px solid #E7E5E4', background: '#FFFFFF', flexShrink: 0 }}>

        {/* Project title row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 16, paddingBottom: 12 }}>
          <div style={{ width: 18, height: 18, borderRadius: 4, background: projectInfo.color, flexShrink: 0 }} />
          <h1 style={{ fontSize: 15, fontWeight: 600, color: '#1C1917', margin: 0, letterSpacing: '-0.01em' }}>
            {projectInfo.name}
          </h1>
          <span style={{
            fontSize: 11, color: '#78716C', background: '#F5F5F4',
            padding: '2px 6px', borderRadius: 10, fontWeight: 500,
          }}>{totalCount}</span>
          {blockedCount > 0 && (
            <span style={{
              fontSize: 11, color: '#DC2626', background: '#FEF2F2',
              padding: '2px 6px', borderRadius: 10, fontWeight: 500,
              display: 'flex', alignItems: 'center', gap: 3,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#DC2626', display: 'inline-block' }} />
              {blockedCount} blocked
            </span>
          )}
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 10 }}>

          <button className="btn-assist">
            <Sparkles size={11} />
            Assist
          </button>

          <div style={{ width: 1, height: 16, background: '#E7E5E4', margin: '0 2px' }} />

          {(STATUS_ORDER as Status[]).map(s => (
            <button
              key={s}
              className="btn-ghost"
              aria-pressed={activeFilter === s}
              onClick={() => setActiveFilter(activeFilter === s ? null : s)}
              style={{
                color: activeFilter === s ? STATUS_COLORS[s] : '#78716C',
                borderColor: activeFilter === s ? `${STATUS_COLORS[s]}30` : 'transparent',
                background:  activeFilter === s ? `${STATUS_COLORS[s]}0F` : 'transparent',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLORS[s] }} />
              {STATUS_LABELS[s]}
            </button>
          ))}

          <div style={{ flex: 1 }} />

          <button className="btn-secondary">
            <Filter size={12} strokeWidth={1.5} />
            Filter
          </button>
          <button className="btn-secondary">
            <SlidersHorizontal size={12} strokeWidth={1.5} />
            Group by
          </button>

          <button className="btn-primary">
            <Plus size={13} strokeWidth={2} />
            Create issue
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '28px 1fr 90px 80px 70px 80px',
        padding: '0 24px',
        borderBottom: '1px solid #E7E5E4',
        background: '#FAFAF9',
        flexShrink: 0,
      }}>
        {['', 'Title', 'Assignee', 'Priority', 'Due', 'Est'].map((h, i) => (
          <div key={i} style={{
            padding: '7px 6px',
            fontSize: 11, color: '#A8A29E', fontWeight: 500,
            textAlign: i >= 3 ? 'center' : 'left',
            letterSpacing: '0.02em',
          }}>{h}</div>
        ))}
      </div>

      {/* Issue rows */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {Object.entries(grouped).map(([groupKey, groupIssues]) => (
          <div key={groupKey}>
            <div className="group-header" onClick={() => toggleGroup(groupKey)}>
              <ChevronDown
                size={12}
                strokeWidth={2}
                color="#A8A29E"
                className={`group-chevron${collapsedGroups.has(groupKey) ? ' collapsed' : ''}`}
              />
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLORS[groupKey as Status] }} />
              <span className="group-label" style={{ fontSize: 12, fontWeight: 500, color: '#78716C', transition: 'color var(--dur-micro) var(--ease)' }}>
                {STATUS_LABELS[groupKey as Status]}
              </span>
              <span style={{ fontSize: 11, color: '#A8A29E', marginLeft: 2 }}>{groupIssues.length}</span>
            </div>
            {!collapsedGroups.has(groupKey) && groupIssues.map(issue => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
