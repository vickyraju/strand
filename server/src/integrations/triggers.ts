// Workflow triggers (spec 0718), as Jira's: a development event moves each item it links through the first transition
// from the item's status that has the trigger. Conditions, validators and permissions are skipped; post functions run.
import type { Db } from '../db.ts'
import { publish } from '../events.ts'
import { emit } from '../webhooks.ts'
import { TRIGGER_LABELS, type Trigger } from '../shared/transitionRules.ts'
import { ruleContext, type TransitionRow } from '../transitions.ts'

/** Which trigger a record's change is: a branch or commit first seen, a pull request's state changing (`before` is its
 *  previous state, undefined when it is new). Null: nothing to fire. */
export function triggerOf(kind: string, before: string | null | undefined, after: string | null): Trigger | null {
  if (kind === 'commit') return before === undefined ? 'commit_created' : null
  if (kind === 'branch') return after === 'active' && (before === undefined || before === 'deleted') ? 'branch_created' : null
  if (kind !== 'pull_request' || before === after) return null
  if (after === 'merged') return 'pr_merged'
  if (after === 'closed') return 'pr_declined'
  if (after === 'open') return before === undefined ? 'pr_created' : 'pr_reopened'
  return null
}

/** Fire a trigger on one item. Returns whether it moved. */
export async function fireTrigger(d: Db, issueId: string, trigger: Trigger): Promise<boolean> {
  const { ISSUE_ROW, runActions } = await import('../routes/issues.ts')
  const [item] = await d.query<any>(`${ISSUE_ROW} where i.id = $1 and i.deleted_at is null and i.archived_at is null for update of i`, [issueId])
  if (!item) return false
  const ts = await d.query<TransitionRow>('select id, name, from_ids, to_id, rules, type_keys from transitions where project_id = $1 order by id', [item.projectId])
  const t = ts.find(x => (x.typeKeys === null || x.typeKeys.includes(item.type)) && (x.fromIds === null || x.fromIds.includes(item.statusId))
    && x.toId !== null && x.toId !== item.statusId && (x.rules.triggers ?? []).includes(trigger))
  if (!t) return false
  const [ws] = await d.query<{ workspaceId: string }>('select workspace_id from issues where id = $1', [issueId])
  await d.query('update issues set status_id = $2, version = version + 1, updated_at = now() where id = $1', [issueId, t.toId])
  const [to] = await d.query<{ name: string }>('select name from statuses where id = $1', [t.toId])
  await d.query('insert into activity (issue_id, actor_id, field, from_value, to_value, text) values ($1, null, $2, $3, $4, $5)',
    [issueId, 'statusId', item.statusId, t.toId, `“${to?.name ?? t.name}” by GitHub: ${TRIGGER_LABELS[trigger]}`])
  await runActions(d, null, issueId, t, await ruleContext(d, item, null))          // post functions still run
  // as any status change: Issue Resolved into Done, Issue Reopened out of it, otherwise Generic Event (spec 0605 R4)
  const [cat] = await d.query<{ before: string; after: string }>('select (select category from statuses where id = $1) as before, (select category from statuses where id = $2) as after', [item.statusId, t.toId])
  const type = cat!.before !== 'done' && cat!.after === 'done' ? 'issue_resolved' as const : cat!.before === 'done' && cat!.after !== 'done' ? 'issue_reopened' as const : 'issue_generic' as const
  await emit(d, ws!.workspaceId, 'jira:issue_updated', { issueId, projectId: item.projectId, type }, null, [{ field: 'statusId', from: item.statusId, to: t.toId }])
  await publish(d, item.projectId, { type: 'issue.updated', id: issueId, key: item.key })
  return true
}
