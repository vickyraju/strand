export type CardStatus   = 'backlog' | 'in-progress' | 'in-review' | 'blocked' | 'done'
export type CardType     = 'story' | 'bug' | 'task'
export type Priority     = 'urgent' | 'high' | 'medium' | 'low'
export type LabelVariant = 'gray' | 'amber' | 'indigo' | 'red'

/** One accent color per board status — drives the column top border/dot and the status dropdown dot. */
export const STATUS_COLOR: Record<CardStatus, string> = {
  backlog:       '#A8A29E',
  'in-progress': '#6366F1',
  'in-review':   '#D97706',
  blocked:       '#DC2626',
  done:          '#16A34A',
}

export const STATUS_LABEL: Record<CardStatus, string> = {
  backlog:       'To do',
  'in-progress': 'In progress',
  'in-review':   'In review',
  blocked:       'Blocked',
  done:          'Done',
}

export interface BoardMember {
  initials: string
  color:    string
  name:     string
}

export interface BoardCard {
  id:           string
  key:          string
  type:         CardType
  priority:     Priority
  title:        string
  labels:       { text: string; variant: LabelVariant }[]
  assignee:     BoardMember
  status:       CardStatus
  epicKey?:     string
  epicColor?:   string
  epicName?:    string
  piiFlag?:     boolean
  commentCount?: number
  attachCount?:  number
  points?:       number
  subtasksDone?: number
  subtasksTotal?: number
}

export const SPRINT_MEMBERS: BoardMember[] = [
  { initials: 'PR', color: '#4F46E5', name: 'Priya Raman'    },
  { initials: 'DO', color: '#0891B2', name: 'Daniel Okafor'  },
  { initials: 'SM', color: '#16A34A', name: 'Sofia Marek'    },
  { initials: 'LF', color: '#0369A1', name: 'Luca Ferreira'  },
  { initials: 'MC', color: '#EA580C', name: 'Marcus Chen'    },
  { initials: 'NO', color: '#DB2777', name: 'Nadia Osei'     },
]

export const EPICS: Record<string, { key: string; name: string; color: string }> = {
  'PAY-201':  { key: 'PAY-201',  name: 'Month-end resilience', color: '#D97706' },
  'PAY-108':  { key: 'PAY-108',  name: 'Auth hardening',       color: '#7C3AED' },
  'PLAT-101': { key: 'PLAT-101', name: 'Infrastructure',       color: '#16A34A' },
}

const [pr, dok, sm, lf, mc, no] = SPRINT_MEMBERS

export const BOARD_CARDS: BoardCard[] = [
  // ── In progress (6, WIP at limit) ────────────────────────
  { id: 'ip1', key: 'PAY-393',    type: 'story', priority: 'urgent', title: 'Settlement webhook retries exhausted after 5 attempts',          labels: [{ text: 'month-end', variant: 'gray' }, { text: 'regulatory', variant: 'amber' }], assignee: pr,  status: 'in-progress', epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', commentCount: 7, attachCount: 2, points: 5, subtasksDone: 1, subtasksTotal: 2 },
  { id: 'ip2', key: 'PAY-397',    type: 'bug',   priority: 'high',   title: 'Backpressure not applied to FX rate streaming endpoint',           labels: [{ text: 'performance', variant: 'gray' }],                                       assignee: lf, status: 'in-progress', epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', commentCount: 3, points: 3 },
  { id: 'ip3', key: 'PAY-401',    type: 'task',  priority: 'high',   title: 'Retry budget configuration for partial settlement failures',        labels: [{ text: 'month-end', variant: 'gray' }],                                        assignee: sm, status: 'in-progress', epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', points: 2 },
  { id: 'ip4', key: 'PLAT-4821',  type: 'bug',   priority: 'urgent', title: 'Reconciliation job exceeds 4h window on month-end cutoff',         labels: [{ text: 'month-end', variant: 'gray' }],                                        assignee: dok, status: 'in-progress', epicKey: 'PLAT-101', epicColor: '#16A34A', epicName: 'Infrastructure',       commentCount: 12, points: 8 },
  { id: 'ip5', key: 'PAY-388',    type: 'bug',   priority: 'high',   title: 'SEPA callback signature validation fails on event replay',          labels: [{ text: 'regulatory', variant: 'amber' }],                                      assignee: mc, status: 'in-progress', epicKey: 'PAY-108',  epicColor: '#7C3AED', epicName: 'Auth hardening',       commentCount: 4, points: 5 },
  { id: 'ip6', key: 'PAY-412',    type: 'task',  priority: 'medium', title: 'Add idempotency headers to all outbound webhook calls',            labels: [],                                                                               assignee: no, status: 'in-progress', points: 1 },

  // ── In review (3) ────────────────────────────────────────
  { id: 'ir1', key: 'PAY-381',    type: 'story', priority: 'medium', title: 'Normalize webhook error codes to RFC 7807 problem format',         labels: [{ text: 'api', variant: 'indigo' }],                                             assignee: lf, status: 'in-review',   epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', commentCount: 2, points: 3 },
  { id: 'ir2', key: 'PAY-395',    type: 'task',  priority: 'medium', title: 'Circuit breaker configuration for payment gateway calls',           labels: [],                                                                               assignee: sm, status: 'in-review', points: 2 },
  { id: 'ir3', key: 'PLAT-4819',  type: 'story', priority: 'high',   title: 'Migrate auth middleware to FAPI 2.0 compliant token flow',         labels: [{ text: 'security', variant: 'amber' }],                                        assignee: pr, status: 'in-review',   epicKey: 'PAY-108',  epicColor: '#7C3AED', epicName: 'Auth hardening',       commentCount: 8, points: 8 },

  // ── Blocked (2) ──────────────────────────────────────────
  { id: 'bl1', key: 'PAY-391',    type: 'bug',   priority: 'urgent', title: 'Idempotency key collision under high-frequency batch submission',   labels: [{ text: 'regulatory', variant: 'amber' }],                                      assignee: no, status: 'blocked',     epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', commentCount: 5, points: 3 },
  { id: 'bl2', key: 'RISK-1204',  type: 'task',  priority: 'urgent', title: 'KYC document expiry alerts: 90-day window not triggering in prod', labels: [{ text: 'compliance', variant: 'amber' }],                                      assignee: dok, status: 'blocked',    piiFlag: true, points: 2 },

  // ── Backlog (showing 6 of 14) ─────────────────────────────
  { id: 'bk1', key: 'PAY-415',    type: 'task',  priority: 'medium', title: 'Add OpenTelemetry spans to the settlement pipeline',               labels: [],                                                                               assignee: lf, status: 'backlog', points: 2 },
  { id: 'bk2', key: 'PAY-416',    type: 'task',  priority: 'low',    title: 'Webhook delivery log retention: enforce 90-day default policy',    labels: [],                                                                               assignee: mc, status: 'backlog', points: 1 },
  { id: 'bk3', key: 'PAY-417',    type: 'story', priority: 'medium', title: 'FX rate fallback strategy when primary provider is unreachable',   labels: [{ text: 'month-end', variant: 'gray' }],                                        assignee: sm, status: 'backlog',     epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', points: 5 },
  { id: 'bk4', key: 'PAY-418',    type: 'task',  priority: 'medium', title: 'Retry webhook delivery on 503 and 429 response codes',            labels: [],                                                                               assignee: no, status: 'backlog',     epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', points: 3 },
  { id: 'bk5', key: 'PAY-419',    type: 'story', priority: 'high',   title: 'Dead letter queue for failed settlement events past retry budget',  labels: [{ text: 'month-end', variant: 'gray' }],                                        assignee: pr, status: 'backlog',     epicKey: 'PAY-201',  epicColor: '#D97706', epicName: 'Month-end resilience', points: 5 },
  { id: 'bk6', key: 'PAY-420',    type: 'task',  priority: 'low',    title: 'Audit trail for manual settlement overrides by operations team',   labels: [],                                                                               assignee: dok, status: 'backlog', points: 1 },

  // ── Done (23 total — showing 8, "+15 more") ───────────────
  { id: 'd1',  key: 'PAY-370',    type: 'bug',   priority: 'high',   title: 'Webhook endpoint timeouts on 30s+ settlement confirmation',        labels: [], assignee: lf,  status: 'done', points: 3 },
  { id: 'd2',  key: 'PAY-371',    type: 'task',  priority: 'medium', title: 'Settlement state machine: add PENDING_RETRY intermediate state',   labels: [], assignee: sm,  status: 'done', points: 2 },
  { id: 'd3',  key: 'PAY-372',    type: 'story', priority: 'medium', title: 'Expose retry count in settlement status API response',             labels: [], assignee: pr,  status: 'done', points: 1 },
  { id: 'd4',  key: 'PAY-373',    type: 'bug',   priority: 'high',   title: 'Race condition in concurrent settlement finalization',             labels: [], assignee: mc,  status: 'done', points: 5 },
  { id: 'd5',  key: 'PAY-374',    type: 'task',  priority: 'low',    title: 'Update settlement retry semantics in developer documentation',     labels: [], assignee: no,  status: 'done', points: 1 },
  { id: 'd6',  key: 'PAY-375',    type: 'story', priority: 'medium', title: 'Settlement batch size limits: configurable per client tier',       labels: [], assignee: dok, status: 'done', points: 3 },
  { id: 'd7',  key: 'PAY-376',    type: 'bug',   priority: 'medium', title: 'Missing correlation ID in async settlement callbacks',             labels: [], assignee: lf,  status: 'done', points: 2 },
  { id: 'd8',  key: 'PAY-377',    type: 'task',  priority: 'low',    title: 'Refactor settlement event schema to snake_case throughout',        labels: [], assignee: sm,  status: 'done', points: 1 },
]

export const STATUS_TOTALS: Record<CardStatus, number> = {
  backlog:       14,
  'in-progress': 6,
  'in-review':   3,
  blocked:       2,
  done:          23,
}
