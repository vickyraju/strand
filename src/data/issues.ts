export type Status = 'todo' | 'in-progress' | 'done' | 'blocked'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

export interface Issue {
  id: string
  key: string
  title: string
  status: Status
  priority: Priority
  assignee: string
  initials: string
  avatarColor: string
  project: string
  label?: string
  dueDate?: string
  estimate?: number
}

export const PROJECTS: Record<string, { name: string; color: string }> = {
  PLAT: { name: 'Platform', color: '#4F46E5' },
  PAY: { name: 'Payments', color: '#D97706' },
  RISK: { name: 'Risk & Compliance', color: '#DC2626' },
  DATA: { name: 'Data Infra', color: '#16A34A' },
}

export const ISSUES: Issue[] = [
  { id: '1', key: 'PLAT-4821', title: 'Reconciliation job exceeds 4h window on month-end', status: 'blocked', priority: 'urgent', assignee: 'Priya Raman', initials: 'PR', avatarColor: '#7C3AED', project: 'PLAT', label: 'Performance', dueDate: 'Jul 15', estimate: 8 },
  { id: '2', key: 'PLAT-4819', title: 'Migrate auth middleware to FAPI 2.0 compliant flow', status: 'in-progress', priority: 'high', assignee: 'Daniel Okafor', initials: 'DO', avatarColor: '#0891B2', project: 'PLAT', label: 'Security', dueDate: 'Jul 18', estimate: 5 },
  { id: '3', key: 'PLAT-4817', title: 'Add circuit breaker to downstream payment gateway calls', status: 'in-progress', priority: 'high', assignee: 'Sofia Marek', initials: 'SM', avatarColor: '#16A34A', project: 'PLAT', label: 'Reliability', dueDate: 'Jul 20', estimate: 3 },
  { id: '4', key: 'PLAT-4815', title: 'Remove deprecated /v1/ledger endpoints from API surface', status: 'todo', priority: 'medium', assignee: 'Marcus Chen', initials: 'MC', avatarColor: '#EA580C', project: 'PLAT', label: 'Cleanup', estimate: 2 },
  { id: '5', key: 'PLAT-4813', title: 'Keyboard navigation audit: command palette missing focus traps', status: 'todo', priority: 'medium', assignee: 'Priya Raman', initials: 'PR', avatarColor: '#7C3AED', project: 'PLAT', label: 'Accessibility' },
  { id: '6', key: 'PLAT-4810', title: 'Upgrade Postgres driver to 15.x for prepared statement caching', status: 'todo', priority: 'low', assignee: 'Nadia Osei', initials: 'NO', avatarColor: '#DB2777', project: 'PLAT', label: 'Dependencies', estimate: 1 },
  { id: '7', key: 'PLAT-4807', title: 'Event sourcing: replay pipeline drops ~3% of events under load', status: 'done', priority: 'high', assignee: 'Daniel Okafor', initials: 'DO', avatarColor: '#0891B2', project: 'PLAT', label: 'Bug', dueDate: 'Jul 10', estimate: 5 },
  { id: '8', key: 'PLAT-4805', title: 'Session affinity config for gRPC connections to clearing house', status: 'done', priority: 'medium', assignee: 'Sofia Marek', initials: 'SM', avatarColor: '#16A34A', project: 'PLAT', label: 'Infrastructure', estimate: 3 },
  { id: '9', key: 'PAY-393', title: 'SEPA instant credit transfer: handle rejection reason codes R09/R12', status: 'in-progress', priority: 'urgent', assignee: 'Luca Ferreira', initials: 'LF', avatarColor: '#0891B2', project: 'PAY', label: 'Compliance', dueDate: 'Jul 16', estimate: 5 },
  { id: '10', key: 'PAY-391', title: 'Idempotency key collision under high-frequency batch submission', status: 'blocked', priority: 'high', assignee: 'Nadia Osei', initials: 'NO', avatarColor: '#DB2777', project: 'PAY', label: 'Bug', dueDate: 'Jul 14', estimate: 8 },
  { id: '11', key: 'PAY-389', title: 'FX rate staleness: cache TTL too long for volatile pairs', status: 'in-progress', priority: 'high', assignee: 'Marcus Chen', initials: 'MC', avatarColor: '#EA580C', project: 'PAY', label: 'Performance', estimate: 3 },
  { id: '12', key: 'PAY-387', title: 'Retry storm: exponential backoff not applied to webhook delivery', status: 'todo', priority: 'medium', assignee: 'Luca Ferreira', initials: 'LF', avatarColor: '#0891B2', project: 'PAY', estimate: 2 },
  { id: '13', key: 'RISK-1204', title: 'KYC document expiry alerts: 90-day window not triggering', status: 'blocked', priority: 'urgent', assignee: 'Priya Raman', initials: 'PR', avatarColor: '#7C3AED', project: 'RISK', label: 'Compliance', dueDate: 'Jul 15', estimate: 5 },
  { id: '14', key: 'RISK-1202', title: 'AML screening: false positive rate at 12% on corporate names with articles', status: 'in-progress', priority: 'high', assignee: 'Sofia Marek', initials: 'SM', avatarColor: '#16A34A', project: 'RISK', label: 'ML', dueDate: 'Jul 22', estimate: 13 },
  { id: '15', key: 'DATA-891', title: 'Spark job SLAs: 3 pipelines missed cut-off in June', status: 'todo', priority: 'high', assignee: 'Daniel Okafor', initials: 'DO', avatarColor: '#0891B2', project: 'DATA', estimate: 8 },
  { id: '16', key: 'DATA-889', title: 'Implement incremental loads for regulatory reporting warehouse', status: 'in-progress', priority: 'medium', assignee: 'Nadia Osei', initials: 'NO', avatarColor: '#DB2777', project: 'DATA', label: 'Architecture', estimate: 13 },
]
