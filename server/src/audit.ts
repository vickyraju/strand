import type { Db } from './db.ts'
import type { Me } from './auth.ts'

/** Who is acting: a signed-in person (or their token), or a system such as SCIM provisioning. */
export interface Actor { me?: Me; ip?: string; system?: string }

export interface AuditEntry {
  action: string
  type: string
  id?: string | null
  name?: string | null
  project?: { id: string; key: string } | null
  before?: unknown
  after?: unknown
  /** Defaults to the actor's workspace */
  workspaceId?: string | null
}

/** Adds one row to the audit log. Call inside the transaction that makes the change, so both happen or neither. */
export async function audit(d: Db, who: Actor, e: AuditEntry) {
  await d.query(
    `insert into audit_log (workspace_id, actor_id, actor, action, project_id, project_key, target_type, target_id, target, before, after, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [e.workspaceId === undefined ? who.me?.workspaceId ?? null : e.workspaceId, who.me?.id ?? null, who.me?.email ?? who.system ?? 'system',
     e.action, e.project?.id ?? null, e.project?.key ?? null, e.type, e.id ?? null, e.name ?? null,
     e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), who.ip ?? null])
}

/** Just the fields that changed, before and after. */
export function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  return { before: Object.fromEntries(keys.map(k => [k, before[k]])), after: Object.fromEntries(keys.map(k => [k, after[k]])), changed: keys.length > 0 }
}
