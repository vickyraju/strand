// Writes parsed GitHub deliveries to the database: repositories, dev_entities, and the links to issues.
import type { Db } from '../db.ts'
import { extractLinks } from './links.ts'
import { parseEvent, type Norm, type Repo } from './github.ts'
import { publish } from '../events.ts'

interface Integration { id: string; workspaceId: string; status: string }

export async function integrationFor(d: Db, installationId: number | null): Promise<Integration | null> {
  if (installationId == null) return null
  const [i] = await d.query<Integration>(`select id, workspace_id, status from integrations where provider = 'github' and installation_id = $1`, [installationId])
  return i ?? null
}

async function ensureRepo(d: Db, integrationId: string, repo: Repo) {
  const [r] = await d.query<{ id: string; projectIds: string[] }>(
    `insert into repositories (integration_id, external_id, full_name, default_branch) values ($1, $2, $3, $4)
     on conflict (integration_id, external_id) do update set full_name = excluded.full_name, default_branch = excluded.default_branch
     returning id, project_ids`, [integrationId, repo.externalId, repo.fullName, repo.defaultBranch])
  return r!
}

/** Apply one record: upsert it (only if not older than what we hold) and replace its issue links. Returns affected project ids. */
async function apply(d: Db, workspaceId: string, repo: { id: string; projectIds: string[] }, n: Norm): Promise<string[]> {
  const [row] = await d.query<{ id: string }>(
    `insert into dev_entities (workspace_id, repo_id, kind, external_id, url, title, state, author, branch_from, branch_to, review_state, payload, source_updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (repo_id, kind, external_id) do update set
       url = excluded.url, title = excluded.title, state = excluded.state,
       author = coalesce(excluded.author, dev_entities.author),
       branch_from = coalesce(excluded.branch_from, dev_entities.branch_from), branch_to = coalesce(excluded.branch_to, dev_entities.branch_to),
       review_state = case when $14::boolean then excluded.review_state else dev_entities.review_state end,
       payload = excluded.payload, source_updated_at = excluded.source_updated_at, updated_at = now()
     where excluded.source_updated_at >= dev_entities.source_updated_at
     returning id`,
    [workspaceId, repo.id, n.kind, n.externalId, n.url, n.title, n.state, n.author ? JSON.stringify(n.author) : null, n.branchFrom, n.branchTo,
     n.reviewState ?? null, JSON.stringify(n.payload), n.sourceUpdatedAt, n.reviewState !== undefined])
  if (!row) return []                                       // an older delivery arrived after a newer one: ignore it

  // Which issues does the text mention? Only real project keys, limited to the projects this repo is mapped to (if any).
  const projects = await d.query<{ id: string; key: string }>(
    `select id, key from projects where workspace_id = $1 and (cardinality($2::uuid[]) = 0 or id = any($2::uuid[]))`, [workspaceId, repo.projectIds])
  const found = extractLinks(n.texts, projects.map(p => p.key))
  const wanted = found.length
    ? await d.query<{ id: string; projectId: string; key: string; number: number }>(
        `select i.id, i.project_id, p.key, i.number from issues i join projects p on p.id = i.project_id
          join unnest($2::text[], $3::int[]) as k(key, num) on k.key = p.key and k.num = i.number
         where i.workspace_id = $1 and i.deleted_at is null`,
        [workspaceId, found.map(f => f.key.slice(0, f.key.lastIndexOf('-'))), found.map(f => Number(f.key.slice(f.key.lastIndexOf('-') + 1)))])
    : []
  const byKey = new Map(wanted.map(w => [`${w.key}-${w.number}`, w]))
  const affected = new Set<string>()
  const keepIssueIds: string[] = []
  for (const f of found) {
    const issue = byKey.get(f.key)
    if (!issue) continue
    keepIssueIds.push(issue.id); affected.add(issue.projectId)
    await d.query(
      `insert into dev_links (issue_id, entity_id, via, closing) values ($1, $2, $3, $4)
       on conflict (issue_id, entity_id) do update set via = excluded.via, closing = excluded.closing`, [issue.id, row.id, f.via, f.closing])
  }
  if (n.replaceLinks) {
    // links this record had before that its text no longer mentions (an edited PR title, a renamed reference)
    const gone = await d.query<{ projectId: string }>(
      `delete from dev_links l using issues i where l.entity_id = $1 and i.id = l.issue_id and l.issue_id <> all($2::uuid[]) returning i.project_id`, [row.id, keepIssueIds])
    for (const g of gone) affected.add(g.projectId)
  }
  return [...affected]
}

export type Outcome = { ok: true; ignored?: string; records?: number } | { ok: false; error: string }

/** Process one verified delivery. Runs in a transaction; the caller records the delivery status. */
export async function processDelivery(d: Db, event: string, payload: any): Promise<Outcome & { projects?: string[] }> {
  const parsed = parseEvent(event, payload)
  const integration = await integrationFor(d, parsed.installationId)

  // Installation lifecycle
  if (event === 'installation' && integration) {
    if (payload.action === 'deleted') { await d.query('delete from integrations where id = $1', [integration.id]); return { ok: true, ignored: 'installation removed' } }
    if (payload.action === 'suspend' || payload.action === 'unsuspend') {
      await d.query('update integrations set status = $2 where id = $1', [integration.id, payload.action === 'suspend' ? 'suspended' : 'active'])
      return { ok: true, ignored: payload.action }
    }
  }
  if (event === 'installation_repositories' && integration) {
    for (const r of payload.repositories_added ?? []) if (r?.id != null && r.full_name)
      await ensureRepo(d, integration.id, { externalId: String(r.id), fullName: String(r.full_name), defaultBranch: 'main', url: `https://github.com/${r.full_name}` })
    for (const r of payload.repositories_removed ?? []) if (r?.id != null)
      await d.query('delete from repositories where integration_id = $1 and external_id = $2', [integration.id, String(r.id)])   // cascades to its records
    return { ok: true, ignored: 'repositories updated' }
  }

  if (!parsed.entities.length || !parsed.repo) return { ok: true, ignored: `nothing to record for ${event}` }
  if (!integration) return { ok: true, ignored: 'unknown installation' }
  if (integration.status !== 'active') return { ok: true, ignored: 'installation suspended' }

  const repo = await ensureRepo(d, integration.id, parsed.repo)
  const projects = new Set<string>()
  for (const n of parsed.entities) for (const p of await apply(d, integration.workspaceId, repo, n)) projects.add(p)
  for (const p of projects) await publish(d, p, { type: 'dev.updated' })
  return { ok: true, records: parsed.entities.length, projects: [...projects] }
}
