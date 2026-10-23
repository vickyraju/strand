// Project backups: before a project is deleted, everything in it is written to S3 so it can be restored.
// The backup is one JSON document (every row of the project, as stored) plus a copy of each attachment's file.
// Both deleting and restoring run as background jobs (jobs.ts): they can take a while and must survive restarts.
// ponytail: the whole project is held in memory while it is written; stream it table by table if projects get very large.
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { db, pool, type Db } from './db.ts'
import { HttpError } from './auth.ts'
import { audit } from './audit.ts'
import { registerJob } from './jobs.ts'
import { s3, filesBucket } from './storage.ts'

export interface BackupSettings { enabled: boolean; bucket?: string; prefix?: string }

/** The workspace's backup setting. Backups are on unless a global admin turns them off. */
export async function backupSettings(d: Db, workspaceId: string): Promise<BackupSettings> {
  const [r] = await d.query<{ projectBackups: BackupSettings }>('select project_backups from workspace_settings where workspace_id = $1', [workspaceId])
  return { ...r?.projectBackups, enabled: r?.projectBackups?.enabled ?? true }
}

/** Where backups go: the workspace's chosen bucket, else BACKUP_BUCKET, else the attachments bucket. Empty: nowhere configured. */
export const backupBucket = (s: BackupSettings) => s.bucket || process.env.BACKUP_BUCKET || filesBucket()
const prefixOf = (s: BackupSettings) => (s.prefix ?? 'project-backups/').replace(/^\/+/, '')

/** The project's rows, table by table, in the order they must be restored (parents before children). */
const TABLES: [table: string, where: string][] = [
  ['projects', 'id = $1'],
  ['statuses', 'project_id = $1'],
  ['transitions', 'project_id = $1'],
  ['field_defs', 'project_id = $1'],
  ['releases', 'project_id = $1'],
  ['item_templates', 'project_id = $1'],
  ['rules', 'project_id = $1'],
  ['sprints', 'project_id = $1'],
  ['project_members', 'project_id = $1'],
  ['stars', 'project_id = $1'],
  ['issues', 'project_id = $1'],
  ['issue_links', 'issue_id in (select id from issues where project_id = $1) or target_id in (select id from issues where project_id = $1)'],
  ['issue_watchers', 'issue_id in (select id from issues where project_id = $1)'],
  ['comments', 'issue_id in (select id from issues where project_id = $1)'],
  ['activity', 'issue_id in (select id from issues where project_id = $1)'],
  ['worklogs', 'issue_id in (select id from issues where project_id = $1)'],
  ['attachments', 'issue_id in (select id from issues where project_id = $1) and uploaded_at is not null'],
]

/** Columns that name a person. On restore, a person who no longer exists is left out rather than failing the restore. */
const PERSON = ['lead_id', 'assignee_id', 'reporter_id', 'author_id', 'actor_id', 'added_by', 'created_by']
/** Rows that only mean something with their person (a membership, a watcher, a star). */
const NEEDS_PERSON = new Set(['project_members', 'issue_watchers', 'stars'])

interface BackupDoc { format: 1; takenAt: string; project: { id: string; key: string; name: string }; tables: Record<string, Record<string, unknown>[]> }

async function readProject(projectId: string): Promise<BackupDoc['tables']> {
  const tables: BackupDoc['tables'] = {}
  for (const [t, where] of TABLES) tables[t] = (await pool.query(`select * from ${t} where ${where}`, [projectId])).rows
  return tables
}

/** Deletes a project that is marked "being deleted", taking a backup first when the workspace has backups on.
 *  Safe to run again after a crash: files and the document are written under the job's own id, and the project
 *  is deleted in the same transaction that records the backup. */
async function deleteProject(p: { projectId: string; actorId: string | null; actorEmail: string; ip?: string }, job: { id: string }) {
  const [proj] = (await pool.query('select * from projects where id = $1 and deleting_at is not null', [p.projectId])).rows
  if (!proj) return { skipped: 'project not found or not being deleted' }
  const settings = await backupSettings(wrapPool(), proj.workspace_id)
  const who = { me: { id: p.actorId ?? '', email: p.actorEmail, workspaceId: proj.workspace_id } as any, ip: p.ip }
  let backup: { id: string; bucket: string; objectKey: string; items: number; files: number; bytes: number } | null = null

  if (settings.enabled) {
    const bucket = backupBucket(settings)
    if (!bucket) throw new Error('Project backups are on but no storage is configured')
    const tables = await readProject(proj.id)
    const base = `${prefixOf(settings)}${proj.workspace_id}/${proj.key}-${proj.id}/${job.id}`
    let bytes = 0
    for (const a of tables.attachments ?? []) {
      await s3().send(new CopyObjectCommand({ Bucket: bucket, Key: `${base}/files/${a.id}`, CopySource: `${filesBucket()}/${encodeURIComponent(String(a.object_key)).replace(/%2F/g, '/')}` }))
      bytes += Number(a.size)
    }
    const doc: BackupDoc = { format: 1, takenAt: new Date().toISOString(), project: { id: proj.id, key: proj.key, name: proj.name }, tables }
    const body = JSON.stringify(doc)
    await s3().send(new PutObjectCommand({ Bucket: bucket, Key: `${base}/project.json`, Body: body, ContentType: 'application/json' }))
    backup = { id: job.id, bucket, objectKey: `${base}/project.json`, items: tables.issues?.length ?? 0, files: tables.attachments?.length ?? 0, bytes: bytes + body.length }
  }

  const c = await pool.connect()
  const d = wrapClient(c)
  try {
    await c.query('begin')
    if (backup) await c.query(
      `insert into project_backups (id, workspace_id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (id) do nothing`,
      [backup.id, proj.workspace_id, proj.id, proj.key, proj.name, backup.bucket, backup.objectKey, backup.items, backup.files, backup.bytes, p.actorId])
    await audit(d, who, { action: 'project.deleted', type: 'project', id: proj.id, name: proj.key, project: { id: proj.id, key: proj.key },
      before: { name: proj.name }, after: backup ? { backupId: backup.id, items: backup.items, files: backup.files } : { backup: 'off' } })
    await c.query('delete from projects where id = $1', [proj.id])
    await c.query('commit')
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
  return backup ? { backupId: backup.id, items: backup.items, files: backup.files } : { backup: 'off' }
}

/** Puts a backed-up project back exactly as it was (same ids, keys and history), with its files. */
async function restoreProject(p: { backupId: string; actorId: string | null; actorEmail: string; ip?: string }) {
  const [b] = (await pool.query('select * from project_backups where id = $1', [p.backupId])).rows
  if (!b) return { skipped: 'backup not found' }
  if (b.restored_at) return { skipped: 'already restored' }
  const got = await s3().send(new GetObjectCommand({ Bucket: b.bucket, Key: b.object_key }))
  const doc = JSON.parse(await got.Body!.transformToString()) as BackupDoc
  const base = b.object_key.replace(/\/project\.json$/, '')

  // the files first: copying again on a retry is harmless
  for (const a of doc.tables.attachments ?? [])
    await s3().send(new CopyObjectCommand({ Bucket: filesBucket(), Key: String(a.object_key), CopySource: `${b.bucket}/${base}/files/${a.id}` }))

  const c = await pool.connect()
  const d = wrapClient(c)
  try {
    await c.query('begin')
    const [taken] = (await c.query('select key from projects where id = $1 or (workspace_id = $2 and key = $3)', [doc.project.id, b.workspace_id, doc.project.key])).rows
    if (taken) throw new HttpError(409, `A project with the key ${doc.project.key} (or this project itself) already exists`)
    const people = new Set((await c.query('select id from users')).rows.map(r => r.id as string))
    const issueIds = new Set((doc.tables.issues ?? []).map(r => r.id as string))
    const existing = new Set((await c.query('select id from issues where id = any($1::uuid[])',
      [[...new Set((doc.tables.issue_links ?? []).flatMap(l => [l.issue_id, l.target_id]))]])).rows.map(r => r.id as string))
    for (const [table] of TABLES) {
      const rows = doc.tables[table] ?? []
      if (!rows.length) continue
      const cols = (await c.query(
        `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'`, [table])).rows
      const json = new Set(cols.filter(x => x.data_type === 'jsonb' || x.data_type === 'json').map(x => x.column_name as string))
      const names = cols.map(x => x.column_name as string)
      for (const r0 of rows) {
        const r = { ...r0 }
        if (table === 'projects') r.deleting_at = null
        if (table === 'issues') r.parent_id = null                     // set below, once every item exists
        if (NEEDS_PERSON.has(table) && !people.has(String(r.user_id))) continue
        for (const k of PERSON) if (r[k] != null && !people.has(String(r[k]))) r[k] = null
        if (table === 'issue_links' && !(issueIds.has(String(r.issue_id)) || existing.has(String(r.issue_id))) ||
            table === 'issue_links' && !(issueIds.has(String(r.target_id)) || existing.has(String(r.target_id)))) continue
        const use = names.filter(n => n in r)
        await c.query(`insert into ${table} (${use.join(', ')}) values (${use.map((_, i) => `$${i + 1}`).join(', ')}) on conflict do nothing`,
          use.map(n => (json.has(n) && r[n] != null ? JSON.stringify(r[n]) : r[n])))
      }
    }
    for (const i of doc.tables.issues ?? []) if (i.parent_id && issueIds.has(String(i.parent_id)))
      await c.query('update issues set parent_id = $2 where id = $1', [i.id, i.parent_id])
    // the restored files must not be removed by deletions queued when the project was deleted
    await c.query('delete from file_deletions where object_key = any($1::text[])', [(doc.tables.attachments ?? []).map(a => a.object_key)])
    await c.query('update project_backups set restored_at = now() where id = $1', [b.id])
    await audit(d, { me: { id: p.actorId ?? '', email: p.actorEmail, workspaceId: b.workspace_id } as any, ip: p.ip },
      { action: 'project.restored_from_backup', type: 'project', id: doc.project.id, name: doc.project.key, project: { id: doc.project.id, key: doc.project.key }, after: { backupId: b.id, items: (doc.tables.issues ?? []).length } })
    await c.query('commit')
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
  return { projectKey: doc.project.key, items: (doc.tables.issues ?? []).length, files: (doc.tables.attachments ?? []).length }
}

// The shared db wrapper camelCases rows; these jobs work with the raw rows the backup stores.
const wrapPool = (): Db => db
const wrapClient = (c: import('pg').PoolClient): Db => ({ query: async (sql, params) => (await c.query(sql, params as any[])).rows })

registerJob('project.delete', deleteProject)
registerJob('project.restore', restoreProject)
