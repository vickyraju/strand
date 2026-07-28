import { AlertCircle, AlertTriangle, ArrowUp, Minus, Calendar, Clock } from 'lucide-react'
import type { Issue, Status, Priority } from '../data/issues'

const STATUS_COLORS: Record<Status, string> = {
  blocked:       '#DC2626',
  'in-progress': '#D97706',
  todo:          '#A8A29E',
  done:          '#16A34A',
}

const PRIORITY_ICON: Record<Priority, React.ReactNode> = {
  urgent: <AlertCircle  size={13} color="#DC2626" strokeWidth={1.5} />,
  high:   <AlertTriangle size={13} color="#D97706" strokeWidth={1.5} />,
  medium: <ArrowUp      size={13} color="#78716C" strokeWidth={1.5} />,
  low:    <Minus        size={13} color="#A8A29E" strokeWidth={1.5} />,
}

const LABEL_COLORS: Record<string, string> = {
  Performance: '#EEF2FF', Security: '#FEF3C7', Reliability: '#F0FDF4',
  Cleanup: '#F5F5F4', Accessibility: '#FDF4FF', Dependencies: '#F0F9FF',
  Bug: '#FEF2F2', Infrastructure: '#F0FDF4', Compliance: '#FEF3C7',
  ML: '#FDF4FF', Architecture: '#EEF2FF',
}
const LABEL_TEXT: Record<string, string> = {
  Performance: '#4338CA', Security: '#B45309', Reliability: '#15803D',
  Cleanup: '#78716C', Accessibility: '#7C3AED', Dependencies: '#0369A1',
  Bug: '#DC2626', Infrastructure: '#15803D', Compliance: '#B45309',
  ML: '#7C3AED', Architecture: '#004833',
}

interface IssueRowProps { issue: Issue }

export default function IssueRow({ issue }: IssueRowProps) {
  const isOverdue = issue.dueDate && issue.status === 'blocked'

  return (
    <div className="issue-row">
      {/* Status dot */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: STATUS_COLORS[issue.status], flexShrink: 0,
        }} />
      </div>

      {/* Title + metadata */}
      <div className="issue-title-cell" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: '6px 0' }}>
        <span style={{ fontSize: 11, color: '#A8A29E', fontFamily: 'monospace', flexShrink: 0, letterSpacing: '0.01em' }}>
          {issue.key}
        </span>
        <span style={{
          fontSize: 13, color: '#1C1917', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
          fontWeight: issue.status === 'blocked' ? 500 : 400,
        }}>{issue.title}</span>
        {issue.label && (
          <span style={{
            fontSize: 11, padding: '1px 6px', borderRadius: 4, flexShrink: 0, fontWeight: 500,
            background: LABEL_COLORS[issue.label] || '#F5F5F4',
            color: LABEL_TEXT[issue.label] || '#78716C',
          }}>{issue.label}</span>
        )}

        {/* Quick actions — visible on .issue-row:hover via opacity */}
        <div className="quick-actions" style={{ display: 'flex', gap: 4, flexShrink: 0, opacity: 0, transition: 'opacity var(--dur-micro) var(--ease)' }}>
          {[
            { label: 'A', title: 'Assign — A' },
            { label: 'S', title: 'Set status — S' },
            { label: 'M', title: 'Move to sprint — M' },
          ].map(({ label, title }) => (
            <button key={label} className="quick-action-btn" title={title}>{label}</button>
          ))}
        </div>
      </div>

      {/* Assignee */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{
          width: 20, height: 20, borderRadius: '50%', background: issue.avatarColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 600, color: 'white', flexShrink: 0,
        }}>{issue.initials}</div>
        <span style={{ fontSize: 12, color: '#78716C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {issue.assignee.split(' ')[0]}
        </span>
      </div>

      {/* Priority */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        {PRIORITY_ICON[issue.priority]}
        <span style={{ fontSize: 11, color: '#78716C', textTransform: 'capitalize' }}>{issue.priority}</span>
      </div>

      {/* Due */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
        {issue.dueDate ? (
          <>
            <Calendar size={11} color={isOverdue ? '#DC2626' : '#A8A29E'} strokeWidth={1.5} />
            <span style={{ fontSize: 11, color: isOverdue ? '#DC2626' : '#78716C', fontWeight: isOverdue ? 500 : 400 }}>
              {issue.dueDate}
            </span>
          </>
        ) : <span style={{ fontSize: 11, color: '#E7E5E4' }}>—</span>}
      </div>

      {/* Estimate */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
        {issue.estimate ? (
          <>
            <Clock size={11} color="#A8A29E" strokeWidth={1.5} />
            <span style={{ fontSize: 11, color: '#78716C' }}>{issue.estimate}p</span>
          </>
        ) : <span style={{ fontSize: 11, color: '#E7E5E4' }}>—</span>}
      </div>
    </div>
  )
}
