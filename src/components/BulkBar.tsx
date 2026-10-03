import { useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import { useStore, canTransition, type IssuePatch, type Priority } from '../data/store'
import { useApp } from '../appContext'
import { Picker, Modal, statusOptions, priorityOptions, userOptions, plural } from './ui'

/** Floating "N selected" action bar (Linear style) for any list of work items. */
export default function BulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [confirm, setConfirm] = useState(false)
  if (ids.length === 0) return null

  const items = state.issues.filter(i => ids.includes(i.id))
  const projectIds = [...new Set(items.map(i => i.projectId))]
  const project = projectIds.length === 1 ? state.projects.find(p => p.id === projectIds[0]) : undefined
  const sprints = project?.template === 'scrum' ? state.sprints.filter(s => s.projectId === project.id && s.state !== 'closed') : []

  const apply = (patch: IssuePatch, what: string) => {
    let target = ids
    if (patch.status && project) {
      target = items.filter(i => canTransition(project, i.status, patch.status!)).map(i => i.id)
      const skipped = ids.length - target.length
      if (skipped) toast(`${plural(skipped, 'item')} couldn’t move because the workflow doesn’t allow it`, { tone: 'warn' })
    }
    if (target.length) {
      dispatch({ type: 'updateIssues', ids: target, patch })
      toast(`Updated ${what} on ${plural(target.length, 'item')}`)
    }
  }

  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label={`${ids.length} selected`}>
        <span className="bulk-count">{ids.length} selected</span>
        <button className="icon-btn sm" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)"><X size={14} /></button>
        <span className="bulk-sep" />
        {project && (
          <Picker value="" options={statusOptions(project)} onChange={s => apply({ status: s }, 'status')} className="btn btn-ghost btn-sm" title="Change status" trigger="Status" />
        )}
        <Picker value={null as string | undefined | null} search options={userOptions(state.users)} onChange={a => apply({ assigneeId: a ?? undefined }, 'assignee')} className="btn btn-ghost btn-sm" title="Change assignee" trigger="Assignee" />
        <Picker value={'' as Priority | ''} options={priorityOptions} onChange={p => apply({ priority: p as Priority }, 'priority')} className="btn btn-ghost btn-sm" title="Change priority" trigger="Priority" />
        {sprints.length > 0 && (
          <Picker value={null as string | undefined | null}
            options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name }))]}
            onChange={s => apply({ sprintId: s ?? undefined }, 'sprint')} className="btn btn-ghost btn-sm" title="Move to sprint" trigger="Sprint" />
        )}
        <span className="bulk-sep" />
        <button className="btn btn-ghost btn-sm text-danger" onClick={() => setConfirm(true)}><Trash2 size={14} />Delete</button>
      </div>

      {confirm && (
        <Modal title={`Delete ${plural(ids.length, 'work item')}?`} onClose={() => setConfirm(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn btn-danger" autoFocus onClick={() => {
              dispatch({ type: 'deleteIssues', ids })
              toast(`Deleted ${plural(ids.length, 'work item')}`)
              setConfirm(false); onClear()
            }}>Delete</button>
          </>}>
          <p>This permanently deletes {items.slice(0, 3).map(i => i.key).join(', ')}{items.length > 3 ? ` and ${items.length - 3} more` : ''}, including their sub-items and comments.</p>
        </Modal>
      )}
    </>
  )
}
