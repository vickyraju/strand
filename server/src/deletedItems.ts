// Deleted work items are kept for the period in System settings (spec 0202), then removed for good: comments, work
// logs, links, history and attachments go with them (their files are queued for removal by the attachments trigger).
// Daily, per workspace, a batch at a time so a large backlog never holds one long transaction.
import { db, tx, type Db } from './db.ts'
import { enqueue, registerJob } from './jobs.ts'
import { getSetting } from './settings.ts'
import { audit } from './audit.ts'

const BATCH = 1000

/** The next daily run (03:00 UTC), queued once per day per workspace. */
export async function schedulePurge(d: Db, ws: string) {
  const next = new Date(); next.setUTCHours(3, 0, 0, 0)
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1)
  await enqueue(d, 'deleted-items.purge', { workspaceId: ws }, { workspaceId: ws, runAt: next, dedupeKey: `deleted-items.purge:${ws}:${next.toISOString().slice(0, 10)}` })
}

/** Remove, oldest first, the items of this workspace deleted longer ago than the retention period. Returns how many. */
export async function purgeDeleted(ws: string) {
  const { retentionDays } = await getSetting(ws, 'deletedItems')
  let total = 0
  for (;;) {
    const n = await tx(async d => {
      const gone = await d.query<{ id: string }>(
        `delete from issues where id in (select id from issues where workspace_id = $1 and deleted_at < now() - make_interval(days => $2)
                                          order by deleted_at, id limit $3 for update skip locked) returning id`, [ws, retentionDays, BATCH])
      return gone.length
    })
    total += n
    if (n < BATCH) break
  }
  if (total) await audit(db, { system: 'Deleted work items' }, { workspaceId: ws, action: 'issue.purged', type: 'issue', name: `${total} work items`, after: { count: total, retentionDays } })
  return total
}

registerJob('deleted-items.purge', async (p: { workspaceId: string }) => {
  const removed = await purgeDeleted(p.workspaceId)
  await schedulePurge(db, p.workspaceId)
  return { removed }
})
