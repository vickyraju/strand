// Jira automation's smart values (spec 0709 R6): {{issue.key}}, {{issue.assignee.displayName}}, {{now}}… filled in from
// what the rule ran on. Pure: the server gives it the values. Unknown or empty values become nothing, as in Jira.

export interface SmartPerson { displayName: string }
export interface SmartIssue {
  key: string; summary: string; description: string; url: string
  status: { name: string }; priority: { name: string }; issueType: { name: string }
  assignee: SmartPerson | null; reporter: SmartPerson | null
  project: { key: string; name: string }
  labels: string[]; fixVersions: { name: string }[]
  parent: { key: string } | null; duedate: string | null; created: string
}
export interface SmartContext { issue: SmartIssue; triggerIssue: SmartIssue; initiator: SmartPerson | null; now: Date }

/** A value at a path, as text: lists joined with ", " (a list of objects by the rest of the path), a person by their name. */
function lookup(root: unknown, path: string[]): string {
  let v: unknown = root
  for (let i = 0; i < path.length; i++) {
    if (Array.isArray(v)) return v.map(x => lookup(x, path.slice(i))).filter(Boolean).join(', ')
    if (v == null || typeof v !== 'object') return ''
    v = (v as Record<string, unknown>)[path[i]!]
  }
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x ? lookup(x, ['name']) : String(x))).filter(Boolean).join(', ')
  if (v && typeof v === 'object') return 'displayName' in v ? String((v as SmartPerson).displayName) : 'name' in v ? String((v as { name: string }).name) : 'key' in v ? String((v as { key: string }).key) : ''
  return v == null ? '' : String(v)
}

export function fillSmartValues(text: string, c: SmartContext): string {
  return text.replace(/\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g, (_, expr: string) => {
    const [head, ...rest] = expr.split('.')
    if (head === 'now') return rest.length ? '' : c.now.toISOString()
    const root = head === 'issue' ? c.issue : head === 'triggerIssue' ? c.triggerIssue : head === 'initiator' ? c.initiator : undefined
    return root === undefined ? '' : lookup(root, rest)
  })
}
