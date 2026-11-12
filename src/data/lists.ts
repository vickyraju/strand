// Priorities and resolutions: the workspace's lists (Administration › Priorities and Resolutions, spec 0305). The app
// loads them with the public settings; until then, and without a server, the ones every workspace starts with.

export interface PriorityDef { key: string; name: string; description: string; color: string; icon: string; position: number; isDefault: boolean }
export interface ResolutionDef { id: string; name: string; description: string; position: number; isDefault: boolean }

export const DEFAULT_PRIORITIES: PriorityDef[] = [
  { key: 'urgent', name: 'Urgent', description: '', color: '#DC2626', icon: 'chevrons-up', position: 0, isDefault: false },
  { key: 'high', name: 'High', description: '', color: '#EA580C', icon: 'chevron-up', position: 1, isDefault: false },
  { key: 'medium', name: 'Medium', description: '', color: '#D97706', icon: 'equal', position: 2, isDefault: true },
  { key: 'low', name: 'Low', description: '', color: '#2563EB', icon: 'chevron-down', position: 3, isDefault: false },
  { key: 'none', name: 'No priority', description: '', color: '#A8A29E', icon: 'minus', position: 4, isDefault: false },
]
export const DEFAULT_RESOLUTIONS: ResolutionDef[] = ['Done', "Won't do", 'Duplicate', 'Cannot reproduce']
  .map((name, position) => ({ id: name, name, description: '', position, isDefault: position === 0 }))

let priorities = DEFAULT_PRIORITIES
let resolutions = DEFAULT_RESOLUTIONS

/** Take the server's lists (in their order). */
export function setLists(p?: PriorityDef[], r?: ResolutionDef[]) {
  if (p?.length) priorities = p
  if (r?.length) resolutions = r
}

/** Priorities, highest first. */
export const priorityList = () => priorities
/** A priority by key; one no longer in the list shows as its key, in grey. */
export const priorityOf = (key: string): PriorityDef =>
  priorities.find(p => p.key === key) ?? { key, name: key, description: '', color: '#A8A29E', icon: 'minus', position: priorities.length, isDefault: false }
/** What new work gets when no priority is chosen (Medium out of the box, as in Jira). */
export const defaultPriority = () => (priorities.find(p => p.isDefault) ?? priorities[0])?.key ?? 'medium'
/** Place in the list: 0 is the highest. */
export const priorityRank = (key: string) => priorityOf(key).position

/** Resolution names, in order. */
export const resolutionNames = () => resolutions.map(r => r.name)
/** The resolution a workflow that resolves on its own sets on reaching Done. */
export const defaultResolution = () => (resolutions.find(r => r.isDefault) ?? resolutions[0])?.name ?? 'Done'
