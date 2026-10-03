import { isDone, type Issue, type State, type ViewFilters } from './reducer.ts'

export const EMPTY_FILTERS: ViewFilters = { q: '', assignee: null, resolution: 'open' }

/** Work items matching a saved view's filters, as seen by `viewerId`. */
export function applyFilters(state: State, f: ViewFilters, viewerId: string | undefined): Issue[] {
  const q = f.q.trim().toLowerCase()
  const assignee = f.assignee === 'me' ? viewerId : f.assignee
  return state.issues.filter(i => {
    const p = state.projects.find(x => x.id === i.projectId)
    return (!f.projectId || i.projectId === f.projectId)
      && (assignee === null || (assignee === '' ? !i.assigneeId : i.assigneeId === assignee))
      && (!f.type || i.type === f.type)
      && (!f.priority || i.priority === f.priority)
      && (!f.label || i.labels.includes(f.label))
      && (f.resolution === 'all' || (f.resolution === 'done') === isDone(p, i))
      && (!q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
          || i.description.toLowerCase().includes(q) || i.labels.some(l => l.toLowerCase().includes(q)))
  })
}

export const filtersActive = (f: ViewFilters) =>
  !!(f.q.trim() || f.projectId || f.assignee !== null || f.type || f.priority || f.label || f.resolution !== 'open')
