// Deleting work items (spec 0202, as in Jira): sub-items go with their parent at every depth; an epic's items stay,
// without the epic. The dialog says both before anything goes, and Undo brings it all back.
import { useStore, type Issue } from '../data/store'
import { useApp } from '../appContext'
import { Modal, plural } from './ui'

/** What deleting these items does: the sub-items that go with them, and the items that lose their epic. */
export function deleteImpact(issues: Issue[], ids: string[]) {
  const chosen = new Set(ids)
  const epics = new Set(issues.filter(i => i.type === 'epic').map(i => i.id))
  const gone = new Set(ids)
  for (let grew = true; grew;) {
    grew = false
    for (const i of issues) if (i.parentId && gone.has(i.parentId) && !epics.has(i.parentId) && !gone.has(i.id)) { gone.add(i.id); grew = true }
  }
  const subItems = gone.size - chosen.size
  const epicItems = issues.filter(i => i.parentId && chosen.has(i.parentId) && epics.has(i.parentId) && !gone.has(i.id)).length
  return { subItems, epicItems }
}

export default function DeleteItemsDialog({ ids, onClose, onDeleted }: { ids: string[]; onClose: () => void; onDeleted?: () => void }) {
  const { state, dispatch } = useStore()
  const { toast } = useApp()
  const items = state.issues.filter(i => ids.includes(i.id))
  const { subItems, epicItems } = deleteImpact(state.issues, ids)
  const what = items.length === 1 ? items[0]!.key : plural(items.length, 'work item')
  return (
    <Modal title={`Delete ${what}?`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" autoFocus onClick={() => {
          dispatch({ type: 'deleteIssues', ids })
          toast(`Deleted ${what}`, { undo: 'deleteIssues' })
          onClose(); onDeleted?.()
        }}>Delete</button>
      </>}>
      <p>
        {items.length === 1 ? `“${items[0]!.title}”` : `${items.slice(0, 3).map(i => i.key).join(', ')}${items.length > 3 ? ` and ${items.length - 3} more` : ''}`}
        {subItems ? ` and ${plural(subItems, 'sub-item')}` : ''} will be deleted, with comments and history.
        {epicItems ? ` ${plural(epicItems, 'work item')} in ${items.length === 1 ? 'this epic' : 'these epics'} stay${epicItems === 1 ? 's' : ''}, without an epic.` : ''}
      </p>
      <p className="hint">You can undo this straight away. A project admin can also restore it from Project settings › Deleted work items for a while.</p>
    </Modal>
  )
}
