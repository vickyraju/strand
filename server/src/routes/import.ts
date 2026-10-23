import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { tx, type Db } from '../db.ts'
import { requireAdmin } from '../auth.ts'

// One-time import of a client-side `forge:v1` state (reducer v4) into the shared workspace.
// Local users are placeholders, so everything they authored is attributed to the importing admin.
// Skipped: notifications (ephemeral), attachment bytes (live in the browser; re-upload to S3).
const ms = (v?: number) => (v ? new Date(v).toISOString() : null)

const plugin: FastifyPluginAsyncZod = async app => {
  // Body is the whole browser state (large, free-form), so it is documented as an object and checked by hand below
  app.post('/import', { schema: {
    tags: ['Admin'], summary: 'One-time import of a browser forge:v1 state (reducer v4). Admin only; existing project keys are skipped.',
    body: z.object({ version: z.literal(4) }).passthrough(),
  } }, async req => {
    requireAdmin(req)
    const s: any = req.body
    if (!s || s.version !== 4 || !Array.isArray(s.projects)) return { error: 'Expected a reducer v4 state (version: 4)' }
    const me = req.me
    const report = { projects: 0, issues: 0, skippedProjects: [] as string[], skippedAttachments: 0 }

    await tx(async d => {
      const id = new Map<string, string>()                     // old id → new uuid
      const nid = (old: string) => id.get(old) ?? (id.set(old, randomUUID()), id.get(old)!)
      const maybe = (old?: string | null) => (old && id.has(old) ? id.get(old)! : null)
      const ins = (table: string, row: Record<string, unknown>) => {
        const k = Object.keys(row)
        return d.query(`insert into ${table} (${k.join(', ')}) values (${k.map((_, i) => `$${i + 1}`).join(', ')})`, k.map(c => row[c]))
      }
      const issues: any[] = s.issues ?? []
      const done = new Set<string>()

      for (const p of s.projects) {
        const exists = await d.query('select 1 from projects where workspace_id = $1 and key = $2', [me.workspaceId, p.key])
        if (exists.length) { report.skippedProjects.push(p.key); continue }
        done.add(p.id)
        const pid = nid(p.id)
        await ins('projects', {
          id: pid, workspace_id: me.workspaceId, key: p.key, name: p.name, description: p.description ?? '', color: p.color,
          template: p.template, lead_id: me.id, next_number: p.nextNumber ?? 1, board_prefs: JSON.stringify(p.boardPrefs ?? {}),
          layout: JSON.stringify(p.layout ?? {}), sample: !!p.sample, created_at: ms(p.createdAt) ?? new Date().toISOString(),
        })
        await ins('project_members', { project_id: pid, user_id: me.id, role: 'admin', added_by: me.id })   // the importer administers what they imported
        for (const [i, st] of (p.statuses ?? []).entries())
          await ins('statuses', { id: nid(st.id), project_id: pid, name: st.name, color: st.color, category: st.category, wip_limit: st.wipLimit ?? null, position: i })
        for (const t of p.transitions ?? [])
          await ins('transitions', { id: nid(t.id), project_id: pid, name: t.name, from_ids: t.from === 'any' ? null : t.from.map(nid), to_id: nid(t.to) })
        for (const [i, f] of (p.fields ?? []).entries())
          await ins('field_defs', { id: nid(f.id), project_id: pid, name: f.name, kind: f.kind, options: f.options ?? null, position: i })
        for (const r of p.releases ?? [])
          await ins('releases', {
            id: nid(r.id), workspace_id: me.workspaceId, project_id: pid, name: r.name, description: r.description ?? '',
            start_date: r.startDate ?? null, release_date: r.releaseDate ?? null, released: !!r.released, released_at: ms(r.releasedAt),
          })
        for (const t of p.templates ?? [])
          await ins('item_templates', { id: nid(t.id), project_id: pid, name: t.name, type: t.type, title: t.title, description: t.description ?? '', priority: t.priority, labels: t.labels ?? [], estimate: t.estimate ?? null })
        for (const r of p.rules ?? []) {
          const trigger = r.trigger.kind === 'status' ? { ...r.trigger, to: nid(r.trigger.to) } : r.trigger
          const actions = (r.actions ?? []).map((a: any) =>
            a.kind === 'status' ? { ...a, value: nid(a.value) }
            : a.kind === 'assign' && !['reporter', 'lead', 'unassign'].includes(a.to) ? { ...a, to: 'lead' } : a)
          await ins('rules', { id: nid(r.id), project_id: pid, name: r.name, enabled: r.enabled, trigger: JSON.stringify(trigger), actions: JSON.stringify(actions), runs: r.runs ?? 0 })
        }
        for (const sp of (s.sprints ?? []).filter((x: any) => x.projectId === p.id))
          await ins('sprints', {
            id: nid(sp.id), workspace_id: me.workspaceId, project_id: pid, name: sp.name, goal: sp.goal ?? '', state: sp.state,
            started_at: ms(sp.startedAt), ends_at: ms(sp.endsAt), completed_at: ms(sp.completedAt), committed: sp.committed ?? null, completed: sp.completed ?? null,
          })
        report.projects++
      }

      // Issues in two passes so parents can be referenced regardless of order
      const mine = issues.filter(i => done.has(i.projectId))
      for (const i of mine) nid(i.id)
      for (const i of mine) {
        const fieldIds = new Map<string, string>()
        const pr = s.projects.find((p: any) => p.id === i.projectId)
        for (const f of pr?.fields ?? []) fieldIds.set(f.id, nid(f.id))
        const custom = Object.fromEntries(Object.entries(i.custom ?? {}).map(([k, v]) => [fieldIds.get(k) ?? k, v]))
        const number = Number(String(i.key).split('-').pop())
        await ins('issues', {
          id: nid(i.id), workspace_id: me.workspaceId, project_id: nid(i.projectId), number, type: i.type, title: i.title,
          description: i.description ?? '', status_id: nid(i.status), priority: i.priority, assignee_id: i.assigneeId ? me.id : null,
          reporter_id: me.id, labels: i.labels ?? [], estimate: i.estimate ?? null, time_estimate: i.timeEstimate ?? null,
          due_date: i.dueDate ?? null, start_date: i.startDate ?? null, sprint_id: maybe(i.sprintId), release_id: maybe(i.releaseId),
          custom: JSON.stringify(custom), rank: i.rank ?? 0, created_at: ms(i.createdAt), updated_at: ms(i.updatedAt),
        })
        report.issues++
        report.skippedAttachments += (i.attachments ?? []).length
      }
      for (const i of mine) if (i.parentId && id.has(i.parentId))
        await d.query('update issues set parent_id = $2 where id = $1', [id.get(i.id), id.get(i.parentId)])
      for (const i of mine) {
        for (const l of i.links ?? []) if (id.has(l.issueId))
          await d.query('insert into issue_links (issue_id, target_id, type) values ($1, $2, $3) on conflict do nothing', [id.get(i.id), id.get(l.issueId), l.type])
        for (const w of i.worklogs ?? [])
          await ins('worklogs', { issue_id: id.get(i.id), user_id: me.id, minutes: w.minutes, date: w.date, note: w.note ?? '', created_at: ms(w.at) })
      }
      for (const c of (s.comments ?? []).filter((c: any) => maybe(c.issueId)))
        await ins('comments', { issue_id: id.get(c.issueId), author_id: me.id, body: c.body, created_at: ms(c.createdAt), edited_at: ms(c.editedAt) })
      for (const a of (s.activity ?? []).filter((a: any) => maybe(a.issueId))) {
        // the app calls a status change 'status' and uses its own status ids; the server stores 'statusId' with the new ids
        const st = a.field === 'status'
        await ins('activity', {
          issue_id: id.get(a.issueId), actor_id: a.actorId === 'automation' ? null : me.id, field: st ? 'statusId' : a.field ?? null,
          from_value: (st ? maybe(a.from) : a.from) ?? null, to_value: (st ? maybe(a.to) : a.to) ?? null, text: a.text, created_at: ms(a.createdAt),
        })
      }

      await importViews(d, s, me, id, done)
    })
    return report
  })
}

async function importViews(d: Db, s: any, me: { id: string; workspaceId: string }, id: Map<string, string>, done: Set<string>) {
  const viewIds = new Map<string, string>()
  for (const v of s.views ?? []) {
    const newId = randomUUID()
    viewIds.set(v.id, newId)
    const f = { ...v.filters, projectId: v.filters?.projectId && done.has(v.filters.projectId) ? id.get(v.filters.projectId) : undefined, assignee: v.filters?.assignee === 'me' ? 'me' : null }
    await d.query('insert into saved_views (id, workspace_id, owner_id, name, shared, filters) values ($1, $2, $3, $4, $5, $6)',
      [newId, me.workspaceId, me.id, v.name, !!v.shared, JSON.stringify(f)])
  }
  for (const pid of s.starred ?? []) if (done.has(pid))
    await d.query('insert into stars (user_id, project_id) values ($1, $2) on conflict do nothing', [me.id, id.get(pid)])
}

export default plugin
