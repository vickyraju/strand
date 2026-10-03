// A realistic sample workspace: a team, three projects, sprint history and backdated activity so every
// screen (board, backlog, inbox, reports) has believable data. Loaded only on request, removable from Settings.
import {
  uid, makeUser, anyToAny, DEFAULT_BOARD_PREFS,
  type State, type User, type Project, type Issue, type Sprint, type Comment, type Activity, type Notification,
  type Status, type Transition, type IssueType, type Priority,
} from './reducer.ts'

const DAY = 86_400_000
const HOUR = 3_600_000

/** Small seeded PRNG so the sample looks the same every time. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

const TEAM: [string, string][] = [
  ['Maya Chen',     'Engineering Manager'],
  ['Daniel Okafor', 'Senior Backend Engineer'],
  ['Sofia Marek',   'Frontend Engineer'],
  ['Luca Ferreira', 'Mobile Engineer'],
  ['Aisha Rahman',  'Product Designer'],
  ['Tom Becker',    'Support Lead'],
]

interface Spec {
  t: IssueType; title: string; p: Priority; a?: number; est?: number; labels?: string[]
  epic?: number; status: string; sprint?: number; carried?: boolean; due?: number; desc?: string
}

interface ProjectSpec {
  key: string; name: string; description: string; color: string; template: 'scrum' | 'kanban'; lead: number
  statuses: Status[]; transitions?: (s: Status[]) => Transition[]
  epics: { title: string; status: string; a: number; desc: string }[]
  items: Spec[]
}

const PAY_STATUSES: Status[] = [
  { id: 'todo',        name: 'To do',       color: '#A8A29E', category: 'todo' },
  { id: 'in-progress', name: 'In progress', color: '#3B82F6', category: 'in-progress', wipLimit: 5 },
  { id: 'in-review',   name: 'In review',   color: '#D97706', category: 'in-progress', wipLimit: 3 },
  { id: 'done',        name: 'Done',        color: '#16A34A', category: 'done' },
]

const PROJECTS: ProjectSpec[] = [
  {
    key: 'PAY', name: 'Payments Platform', color: '#368727', template: 'scrum', lead: 1,
    description: 'Card, bank and instant payouts for merchants. Owns the ledger, payout scheduling and webhooks.',
    statuses: PAY_STATUSES,
    transitions: s => [
      { id: uid(), name: 'Start work',      from: ['todo'],                      to: 'in-progress' },
      { id: uid(), name: 'Send to review',  from: ['in-progress'],               to: 'in-review' },
      { id: uid(), name: 'Approve',         from: ['in-review'],                 to: 'done' },
      { id: uid(), name: 'Request changes', from: ['in-review'],                 to: 'in-progress' },
      { id: uid(), name: 'Stop work',       from: ['in-progress'],               to: 'todo' },
      { id: uid(), name: 'Reopen',          from: ['done'],                      to: s[1].id },
    ],
    epics: [
      { title: 'Instant payouts to debit cards',  status: 'in-progress', a: 1, desc: 'Let merchants withdraw their balance to a debit card in under 30 minutes, 24/7.' },
      { title: 'PCI DSS 4.0 audit readiness',     status: 'in-progress', a: 0, desc: 'Close the gaps found in the Q3 pre-assessment before the external audit in December.' },
      { title: 'Webhooks v2',                     status: 'todo',        a: 2, desc: 'Signed, versioned webhooks with retries, replay and a delivery log merchants can see.' },
    ],
    items: [
      // Sprint 1 (closed)
      { t: 'story', title: 'Payout scheduler supports same-day cut-off times',          p: 'high',   a: 1, est: 5, epic: 0, status: 'done', sprint: 0, labels: ['backend'] },
      { t: 'task',  title: 'Add idempotency keys to the payouts API',                    p: 'high',   a: 1, est: 3, epic: 0, status: 'done', sprint: 0, labels: ['api'] },
      { t: 'bug',   title: 'Ledger balance off by one cent on partial refunds',          p: 'urgent', a: 0, est: 3, status: 'done', sprint: 0, labels: ['ledger'] },
      { t: 'task',  title: 'Rotate TLS certificates on the card vault',                  p: 'medium', a: 0, est: 2, epic: 1, status: 'done', sprint: 0, labels: ['security'] },
      { t: 'story', title: 'Merchant dashboard: show estimated arrival for payouts',     p: 'medium', a: 2, est: 5, epic: 0, status: 'done', sprint: 1, carried: true, labels: ['frontend'] },
      // Sprint 2 (closed)
      { t: 'story', title: 'Debit card eligibility check via card network lookup',       p: 'high',   a: 1, est: 8, epic: 0, status: 'done', sprint: 1, labels: ['backend'] },
      { t: 'task',  title: 'Encrypt PAN at rest with per-tenant keys',                   p: 'urgent', a: 1, est: 5, epic: 1, status: 'done', sprint: 1, labels: ['security'] },
      { t: 'bug',   title: 'Webhook retries fire twice after a 502 from merchant',       p: 'high',   a: 2, est: 2, status: 'done', sprint: 1, labels: ['webhooks'] },
      { t: 'task',  title: 'Document the data flow diagram for card data',               p: 'medium', a: 0, est: 3, epic: 1, status: 'done', sprint: 1, labels: ['compliance'] },
      { t: 'story', title: 'Fee preview before confirming an instant payout',            p: 'medium', a: 4, est: 3, epic: 0, status: 'in-review', sprint: 2, carried: true, labels: ['design', 'frontend'] },
      // Sprint 3 (active)
      { t: 'story', title: 'Instant payout limits per merchant risk tier',               p: 'high',   a: 1, est: 5, epic: 0, status: 'in-progress', sprint: 2, labels: ['backend', 'risk'], due: 2 },
      { t: 'task',  title: 'Quarterly access review for production databases',           p: 'high',   a: 0, est: 2, epic: 1, status: 'in-progress', sprint: 2, labels: ['compliance'], due: 1 },
      { t: 'bug',   title: 'Payout CSV export times out for merchants with 50k+ rows',   p: 'urgent', a: 2, est: 3, status: 'in-review', sprint: 2, labels: ['frontend', 'performance'] },
      { t: 'task',  title: 'Alert when payout failure rate exceeds 2% over 15 minutes',  p: 'medium', a: 1, est: 2, epic: 0, status: 'done', sprint: 2, labels: ['observability'] },
      { t: 'story', title: 'Signed webhook payloads with HMAC-SHA256',                   p: 'high',   a: 2, est: 5, epic: 2, status: 'todo', sprint: 2, labels: ['webhooks', 'security'] },
      { t: 'task',  title: 'Penetration test remediation: rate-limit login endpoint',    p: 'high',   a: 0, est: 2, epic: 1, status: 'todo', sprint: 2, labels: ['security'], due: -1 },
      { t: 'story', title: 'Payout status page for merchants',                           p: 'low',    a: 4, est: 3, epic: 0, status: 'done', sprint: 2, labels: ['design'] },
      // Backlog
      { t: 'story', title: 'Webhook delivery log with replay button',                    p: 'medium', a: 2, est: 8, epic: 2, status: 'todo', labels: ['webhooks', 'frontend'] },
      { t: 'story', title: 'Versioned webhook event schemas',                            p: 'medium', est: 5, epic: 2, status: 'todo', labels: ['webhooks', 'api'] },
      { t: 'task',  title: 'Migrate payout jobs from cron to the queue worker',          p: 'low',    a: 1, est: 5, status: 'todo', labels: ['backend', 'tech-debt'] },
      { t: 'bug',   title: 'Currency formatting wrong for JPY (no decimals)',            p: 'medium', est: 1, status: 'todo', labels: ['frontend'] },
      { t: 'task',  title: 'Tokenize stored bank account numbers',                       p: 'high',   est: 5, epic: 1, status: 'todo', labels: ['security'] },
      { t: 'story', title: 'Merchants can pause automatic payouts',                      p: 'low',    est: 3, status: 'todo', labels: ['backend'] },
    ],
  },
  {
    key: 'MOB', name: 'Mobile App', color: '#4F46E5', template: 'kanban', lead: 3,
    description: 'The iOS and Android merchant app: sales on the go, payouts and notifications.',
    statuses: [
      { id: 'backlog',     name: 'Backlog',     color: '#A8A29E', category: 'todo' },
      { id: 'ready',       name: 'Ready',       color: '#78716C', category: 'todo' },
      { id: 'in-progress', name: 'In progress', color: '#3B82F6', category: 'in-progress', wipLimit: 4 },
      { id: 'qa',          name: 'QA',          color: '#7C3AED', category: 'in-progress', wipLimit: 3 },
      { id: 'released',    name: 'Released',    color: '#16A34A', category: 'done' },
    ],
    epics: [
      { title: 'Offline mode for in-person sales', status: 'in-progress', a: 3, desc: 'Take card-present payments with no signal and sync when the connection comes back.' },
      { title: 'Onboarding redesign',              status: 'in-progress', a: 4, desc: 'Cut time-to-first-sale from 14 minutes to under 5.' },
    ],
    items: [
      { t: 'story', title: 'Queue offline transactions in encrypted local storage',      p: 'high',   a: 3, est: 8, epic: 0, status: 'in-progress', labels: ['ios', 'android'], due: 3 },
      { t: 'story', title: 'Sync conflict screen when an offline sale fails',            p: 'medium', a: 4, est: 3, epic: 0, status: 'qa', labels: ['design'] },
      { t: 'task',  title: 'Background sync with exponential backoff',                   p: 'high',   a: 3, est: 5, epic: 0, status: 'ready', labels: ['android'] },
      { t: 'story', title: 'New welcome flow with business type selection',              p: 'high',   a: 4, est: 5, epic: 1, status: 'released', labels: ['design'] },
      { t: 'story', title: 'Connect bank account during onboarding with instant verification', p: 'high', a: 3, est: 8, epic: 1, status: 'qa', labels: ['ios'] },
      { t: 'task',  title: 'Onboarding analytics events for each step',                  p: 'medium', a: 2, est: 2, epic: 1, status: 'released', labels: ['analytics'] },
      { t: 'bug',   title: 'App crashes when rotating on the receipt screen (Android 14)', p: 'urgent', a: 3, est: 2, status: 'in-progress', labels: ['android', 'crash'] },
      { t: 'bug',   title: 'Push notifications not delivered after reinstall on iOS',     p: 'high',   a: 0, est: 3, status: 'ready', labels: ['ios'] },
      { t: 'story', title: 'Dark mode',                                                   p: 'low',    est: 5, status: 'backlog', labels: ['design'] },
      { t: 'task',  title: 'Upgrade React Native to 0.76',                                p: 'medium', a: 3, est: 5, status: 'backlog', labels: ['tech-debt'] },
      { t: 'story', title: 'Tap to Pay on iPhone',                                        p: 'medium', est: 13, status: 'backlog', labels: ['ios', 'payments'] },
      { t: 'bug',   title: 'Payout amount truncated on small screens',                   p: 'medium', a: 2, est: 1, status: 'released', labels: ['ui'] },
      { t: 'task',  title: 'App Store screenshots for the onboarding redesign',          p: 'low',    a: 4, est: 2, epic: 1, status: 'ready', labels: ['design'], due: 5 },
      { t: 'story', title: 'Daily sales summary widget',                                 p: 'low',    est: 3, status: 'backlog', labels: ['ios'] },
    ],
  },
  {
    key: 'SUP', name: 'Customer Support', color: '#D97706', template: 'kanban', lead: 6,
    description: 'Escalations from the support team that need engineering or product follow-up.',
    statuses: [
      { id: 'new',           name: 'New',                  color: '#A8A29E', category: 'todo' },
      { id: 'investigating', name: 'Investigating',        color: '#3B82F6', category: 'in-progress' },
      { id: 'waiting',       name: 'Waiting on customer',  color: '#D97706', category: 'in-progress' },
      { id: 'resolved',      name: 'Resolved',             color: '#16A34A', category: 'done' },
    ],
    epics: [],
    items: [
      { t: 'bug',  title: 'Merchant reports payout missing since Monday (Acme Coffee)',  p: 'urgent', a: 6, status: 'investigating', labels: ['payouts'], due: 0 },
      { t: 'bug',  title: 'Refund shows as pending for 9 days',                          p: 'high',   a: 1, status: 'investigating', labels: ['refunds'] },
      { t: 'task', title: 'Customer asks for 2023 tax invoices in bulk',                 p: 'medium', a: 6, status: 'waiting', labels: ['billing'] },
      { t: 'bug',  title: 'Two-factor codes arriving late for UK numbers',               p: 'high',   a: 0, status: 'new', labels: ['auth'] },
      { t: 'task', title: 'Explain new instant payout fees to enterprise accounts',      p: 'medium', a: 6, status: 'resolved', labels: ['payouts'] },
      { t: 'bug',  title: 'Dispute evidence upload fails for PDFs over 5 MB',            p: 'medium', a: 2, status: 'resolved', labels: ['disputes'] },
      { t: 'task', title: 'Merchant wants to change settlement currency',                p: 'low',    a: 6, status: 'waiting', labels: ['settlement'] },
      { t: 'bug',  title: 'Receipt emails going to spam for Outlook users',              p: 'medium', status: 'new', labels: ['email'] },
      { t: 'bug',  title: 'Wrong VAT rate on invoices for Irish merchants',              p: 'high',   a: 1, status: 'resolved', labels: ['billing'] },
      { t: 'task', title: 'Close account and export data (GDPR request)',                p: 'high',   a: 6, status: 'investigating', labels: ['gdpr'], due: 4 },
    ],
  },
]

const COMMENTS: [string, number, number, string][] = [
  // [item key suffix, author index, hours ago, body]
  ['PAY-14', 2, 30, 'Risk tiers come from the underwriting service. I have a draft of the mapping, @{owner} can you sanity-check the tier 3 limits?'],
  ['PAY-14', 1, 26, 'Tier 3 looks right. Let us keep the daily cap at 10k until we see a month of data.'],
  ['PAY-16', 2, 20, 'Repro: export from a merchant with 60k payouts, it hits the 30s gateway timeout. Moving it to a background job with a download link.'],
  ['PAY-16', 4, 6, '@{owner} the "your export is ready" email copy is in the design file, page 4.'],
  ['PAY-19', 1, 50, 'Auditors flagged this one specifically. Needs to land before the December fieldwork.'],
  ['MOB-3', 3, 18, 'Using SQLCipher for the local queue. Keys live in the Keychain / Android Keystore.'],
  ['MOB-9', 3, 4, 'Only on Android 14 with gesture navigation. Fix is in review, @{owner} could you test on your Pixel?'],
  ['SUP-1', 6, 3, 'Acme Coffee has called twice today. Payout 4821 shows "sent" on our side but their bank has nothing.'],
  ['SUP-1', 1, 2, 'The bank returned it with code R03 (no account). Looks like they changed bank details last week.'],
]

/** Build the sample workspace for the given owner. All ids are new so it can be merged into existing data. */
export function sampleWorkspace(owner: User, now = Date.now()): Partial<State> {
  const rand = rng(42)
  const between = (a: number, b: number) => a + (b - a) * rand()
  const team = [owner, ...TEAM.map(([name, title], i) => makeUser(name, i + 1, title))]
  const users = team.slice(1)
  const iso = (days: number) => {
    const d = new Date(now + days * DAY)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const projects: Project[] = []
  const issues: Issue[] = []
  const sprints: Sprint[] = []
  const activity: Activity[] = []
  const comments: Comment[] = []
  const notifications: Notification[] = []

  const ev = (issue: Issue, actor: string, at: number, text: string, field?: string, from?: string, to?: string) =>
    activity.push({ id: uid(), issueId: issue.id, actorId: actor, field, from, to, text, createdAt: Math.round(at) })

  for (const spec of PROJECTS) {
    const lead = team[spec.lead]
    const project: Project = {
      id: uid(), key: spec.key, name: spec.name, description: spec.description, color: spec.color,
      template: spec.template, leadId: lead.id, statuses: spec.statuses,
      transitions: spec.transitions ? spec.transitions(spec.statuses) : anyToAny(spec.statuses),
      layout: {}, boardPrefs: DEFAULT_BOARD_PREFS, nextNumber: 1, createdAt: now - 60 * DAY, rules: [],
    }
    projects.push(project)

    // Scrum: two closed two-week sprints, one active, one planned
    const sprintIds: string[] = []
    const windows: [number, number][] = [[-42, -28], [-28, -14], [-6, 8]]
    if (spec.template === 'scrum') {
      windows.forEach(([s, e], i) => {
        const id = uid()
        sprintIds.push(id)
        sprints.push({
          id, projectId: project.id, name: `${spec.key} Sprint ${i + 1}`,
          goal: ['Same-day payouts behind a feature flag', 'Card eligibility and PAN encryption', 'Instant payouts beta for tier 1 merchants'][i],
          state: i < 2 ? 'closed' : 'active', startedAt: now + s * DAY, endsAt: now + e * DAY,
          completedAt: i < 2 ? now + e * DAY : undefined,
        })
      })
      sprints.push({ id: uid(), projectId: project.id, name: `${spec.key} Sprint 4`, goal: 'Webhooks v2 signing and delivery log', state: 'planned' })
    }

    const order = spec.statuses.map(s => s.id)
    const make = (s: Spec, isEpic: boolean): Issue => {
      const n = project.nextNumber++
      const assignee = s.a !== undefined ? team[s.a] : undefined
      const reporter = team[spec.lead]
      const issue: Issue = {
        id: uid(), key: `${spec.key}-${n}`, projectId: project.id, type: s.t, title: s.title,
        description: s.desc ?? '', status: s.status, priority: s.p, assigneeId: assignee?.id, reporterId: reporter.id,
        labels: s.labels ?? [], estimate: s.est, dueDate: s.due !== undefined ? iso(s.due) : undefined,
        sprintId: s.sprint !== undefined ? sprintIds[s.sprint] : undefined,
        watcherIds: [...new Set([reporter.id, assignee?.id].filter((x): x is string => !!x))],
        links: [], attachments: [], rank: issues.length + 1, createdAt: 0, updatedAt: 0,
      }

      // Timeline: when it was created and when it moved through the workflow
      const sprintWin = s.sprint !== undefined ? windows[s.sprint] : undefined
      const prevWin = s.carried && s.sprint ? windows[s.sprint - 1] : undefined
      const created = now + (prevWin ?? sprintWin ?? [-35, -2])[0] * DAY - between(1, 4) * DAY
      const actor = assignee?.id ?? reporter.id
      issue.createdAt = Math.round(created)
      ev(issue, reporter.id, created, isEpic ? 'created the epic' : 'created the work item', 'status', undefined, order[0])
      if (issue.sprintId) {
        const first = prevWin ? sprintIds[s.sprint! - 1] : issue.sprintId
        ev(issue, reporter.id, created + HOUR, `moved to ${spec.key} Sprint ${(prevWin ? s.sprint! : s.sprint! + 1)}`, 'sprintId', undefined, first)
      }
      if (assignee) ev(issue, reporter.id, created + 2 * HOUR, `assigned to ${assignee.name}`, 'assigneeId', undefined, assignee.id)

      const target = order.indexOf(s.status)
      // Steps happen inside the sprint (or before now for Kanban/backlog)
      const [from, to] = sprintWin
        ? [now + sprintWin[0] * DAY + 0.3 * DAY, Math.min(now - HOUR, now + sprintWin[1] * DAY - 0.5 * DAY)]
        : (() => {
            // Kanban work: picked up a few days after creation and worked for 1–10 days
            const start = Math.min(now - 2 * DAY, created + between(0.5, 6) * DAY)
            return [start, Math.min(now - HOUR, start + between(1, 10) * DAY)]
          })()
      let t = created + 3 * HOUR
      if (prevWin) {
        // Started in the previous sprint, carried over unfinished
        t = now + prevWin[0] * DAY + between(3, 8) * DAY
        if (target >= 1) ev(issue, actor, t, `changed status to ${spec.statuses[1].name}`, 'status', order[0], order[1])
        ev(issue, reporter.id, now + prevWin[1] * DAY, `moved to ${spec.key} Sprint ${s.sprint! + 1}`, 'sprintId', sprintIds[s.sprint! - 1], issue.sprintId)
      }
      const startStep = prevWin && target >= 1 ? 2 : 1
      const steps = Math.max(0, target - startStep + 1)
      let last = Math.max(t, created)
      for (let k = 0; k < steps; k++) {
        const idx = startStep + k
        const lo = Math.max(from, last + HOUR)
        last = lo + (to - lo) * ((k + 1) / (steps + 0.5)) * between(0.6, 1)
        ev(issue, idx === order.length - 1 ? reporter.id : actor, last,
          `changed status to ${spec.statuses[idx].name}`, 'status', order[idx - 1], order[idx])
      }
      issue.updatedAt = Math.round(Math.max(last, created + 2 * HOUR))
      issues.push(issue)
      return issue
    }

    const epicIssues = spec.epics.map(e => make({ t: 'epic', title: e.title, p: 'high', a: e.a, status: e.status, desc: e.desc }, true))
    const made = spec.items.map(s => {
      const issue = make(s, false)
      if (s.epic !== undefined) issue.parentId = epicIssues[s.epic].id
      return { s, issue }
    })

    // Sprint snapshots for velocity and burndown. Items carried into sprint i+1 were members of sprint i.
    for (const [i, id] of sprintIds.entries()) {
      const sp = sprints.find(x => x.id === id)!
      const members = made.filter(({ s }) => s.sprint === i || (s.carried && s.sprint === i + 1))
      sp.committed = members.reduce((n, { s }) => n + (s.est ?? 0), 0)
      if (sp.state === 'closed') {
        sp.issueIds = members.map(({ issue }) => issue.id)
        sp.completed = members.filter(({ s }) => s.sprint === i).reduce((n, { s }) => n + (s.est ?? 0), 0)
      }
    }
  }

  // Blocking links that make the "Blocked" flag meaningful
  const byKey = (k: string) => issues.find(i => i.key === k)!
  byKey('PAY-18').links.push({ type: 'blocks', issueId: byKey('PAY-21').id })
  byKey('PAY-14').links.push({ type: 'relates', issueId: byKey('PAY-13').id })
  byKey('MOB-3').links.push({ type: 'blocks', issueId: byKey('MOB-5').id })
  byKey('SUP-1').links.push({ type: 'relates', issueId: byKey('PAY-14').id })

  // Comments, with @mentions of the workspace owner
  for (const [key, author, hoursAgo, body] of COMMENTS) {
    const issue = byKey(key)
    const who = team[author]
    const text = body.replace('{owner}', owner.name)
    const at = now - hoursAgo * HOUR
    comments.push({ id: uid(), issueId: issue.id, authorId: who.id, body: text, createdAt: at })
    issue.updatedAt = Math.max(issue.updatedAt, at)
    if (!issue.watcherIds.includes(who.id)) issue.watcherIds.push(who.id)
    if (who.id !== owner.id) {
      const mentioned = text.includes(`@${owner.name}`)
      if (mentioned || issue.watcherIds.includes(owner.id)) {
        notifications.push({
          id: uid(), userId: owner.id, actorId: who.id, issueId: issue.id,
          kind: mentioned ? 'mentioned' : 'commented',
          text: `${who.name} ${mentioned ? 'mentioned you on' : 'commented on'} ${issue.key}`,
          read: hoursAgo > 24, archived: false, createdAt: at,
        })
      }
    }
  }

  // A couple of recent assignments to the owner
  for (const [key, by, hoursAgo] of [['SUP-4', 6, 5], ['MOB-10', 3, 28]] as [string, number, number][]) {
    const issue = byKey(key)
    notifications.push({
      id: uid(), userId: owner.id, actorId: team[by].id, issueId: issue.id, kind: 'assigned',
      text: `${team[by].name} assigned ${issue.key} to you`, read: hoursAgo > 24, archived: false, createdAt: now - hoursAgo * HOUR,
    })
  }

  return { users, projects, issues, sprints, comments, activity, notifications, starred: [projects[0].id] }
}
