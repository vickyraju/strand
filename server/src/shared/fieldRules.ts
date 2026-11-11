// Field configurations (spec 0504): which fields are hidden and required for a project's work type, and the check. Pure:
// the server enforces it and the web app marks and hides fields with it, so the two agree.

/** A field's settings in a field configuration (Jira's description, hidden, required). */
export interface FieldRule { description?: string; hidden?: boolean; required?: boolean }
/** Field key → its settings; custom fields are `custom.<field id>`. */
export type FieldRules = Record<string, FieldRule>

/** The system fields a configuration can hide or require, with Jira's names (Summary and the work type are always shown and required). */
export const SYSTEM_FIELDS: Record<string, string> = {
  description: 'Description', assigneeId: 'Assignee', reporterId: 'Reporter', priority: 'Priority', labels: 'Labels', componentIds: 'Component/s',
  fixReleaseIds: 'Fix Version/s', affectsReleaseIds: 'Affects Version/s', dueDate: 'Due Date', startDate: 'Start date', estimate: 'Story Points',
  timeEstimate: 'Time Tracking', sprintId: 'Sprint', parentId: 'Parent', resolution: 'Resolution',
}

/** Empty as Jira's required check sees it: nothing, an empty text or list; a cascading field without the child its option needs. */
export function isEmpty(v: unknown, childNeeded = false): boolean {
  if (v == null || v === '') return true
  if (Array.isArray(v)) return v.length === 0 || (childNeeded && v.length < 2)
  return typeof v === 'string' && !v.trim()
}

/** The value of a field key on an item (system fields by name, custom fields from `custom`). */
export const valueOf = (item: Record<string, any>, key: string) => (key.startsWith('custom.') ? item.custom?.[key.slice(7)] : item[key])

/** Required fields an item lacks, by key. `needsChild(key, value)` says when a cascading value needs its child option. */
export function missingRequired(rules: FieldRules, item: Record<string, any>, needsChild: (key: string, v: unknown) => boolean = () => false) {
  return Object.entries(rules).filter(([k, r]) => r.required && !r.hidden && isEmpty(valueOf(item, k), needsChild(k, valueOf(item, k)))).map(([k]) => k)
}
