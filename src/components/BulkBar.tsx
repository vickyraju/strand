import { useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import { useStore, type IssuePatch, type Priority } from '../data/store'
import { planMove } from './TransitionDialog'
import { useApp } from '../appContext'
import { Picker, statusOptions, priorityOptions, plural } from './ui'
import { UserPicker } from './UserPicker'
import { can } from '../data/access'
import DeleteItemsDialog from './DeleteItemsDialog'

/** Floating "N selected" action bar (Linear style) for any list of work items. */
export default function BulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const [confirm, setConfirm] = useState(false)
  if (ids.length === 0) return null

  const items = state.issues.filter(i => ids.includes(i.id))
  const projectIds = [...new Set(items.map(i => i.projectId))]
  const project = projectIds.length === 1 ? state.projects.find(p => p.id === projectIds[0]) : undefined
  // Delete issues (spec 0202): only when I may delete in every project the selection is in
  const mayDelete = projectIds.every(id => can(state.projects.find(p => p.id === id), 'deleteIssues'))
  const sprints = project?.template === 'scrum' ? state.sprints.filter(s => s.projectId === project.id && s.state !== 'closed') : []

  const apply = (patch: IssuePatch, what: string) => {
    let target = ids
    if (patch.status && project) {
      // only items this move can go through for, as they are: a move that asks for input is made one item at a time
      target = items.filter(i => i.status === patch.status || planMove(state, i, patch.status!).kind === 'direct').map(i => i.id)
      const skipped = ids.length - target.length
      if (skipped) toast(`${plural(skipped, 'item')} couldn’t move: the workflow doesn’t allow it, or the move needs details. Move ${skipped === 1 ? 'it' : 'them'} one at a time.`, { tone: 'warn' })
    }
    if (target.length) {
      dispatch({ type: 'updateIssues', ids: target, patch })
      toast(`Updated ${what} on ${plural(target.length, 'item')}`, { undo: 'updateIssues' })
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
        <UserPicker value={undefined} onChange={a => apply({ assigneeId: a }, 'assignee')} className="btn btn-ghost btn-sm" title="Change assignee"
          trigger="Assignee" allowUnassigned projectId={project?.id} />
        <Picker value={'' as Priority | ''} options={priorityOptions} onChange={p => apply({ priority: p as Priority }, 'priority')} className="btn btn-ghost btn-sm" title="Change priority" trigger="Priority" />
        {sprints.length > 0 && (
          <Picker value={null as string | undefined | null}
            options={[{ value: undefined, label: 'Backlog' }, ...sprints.map(s => ({ value: s.id as string | undefined, label: s.name }))]}
            onChange={s => apply({ sprintId: s ?? undefined }, 'sprint')} className="btn btn-ghost btn-sm" title="Move to sprint" trigger="Sprint" />
        )}
        {mayDelete && <>
          <span className="bulk-sep" />
          <button className="btn btn-ghost btn-sm text-danger" onClick={() => setConfirm(true)}><Trash2 size={14} />Delete</button>
        </>}
      </div>

      {confirm && <DeleteItemsDialog ids={ids} onClose={() => setConfirm(false)} onDeleted={onClear} />}
    </>
  )
}
