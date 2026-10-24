// Project backups: before a project is deleted, everything in it is written to S3 so it can be restored.
// The backup is one JSON document (every row of the project, as stored) plus a copy of each attachment's file.
// Both deleting and restoring run as background jobs (jobs.ts): they can take a while and must survive restarts.
// ponytail: the whole project is held in memory while it is written; stream it table by table if projects get very large.
import { createHash } from 'node:crypto'
import { CopyObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { db, pool, type Db } from './db.ts'
import { HttpError } from './auth.ts'
import { audit } from './audit.ts'
import { registerJob } from './jobs.ts'
import { getSetting } from './settings.ts'
import { s3, filesBucket } from './storage.ts'

export interface BackupSettings { enabled: boolean; bucket?: string; prefix?: string }

/** The workspace's backup setting (System settings). Backups are on unless a global admin turns them off. */
export const backupSettings = (d: Db, workspaceId: string): Promise<BackupSettings> => getSetting(workspaceId, 'projectBackups', d)

/** Buckets a workspace may choose for its backups (operators list them in BACKUP_BUCKETS, comma-separated). A workspace
 *  admin cannot send backups, or take restores, from anywhere else. */
export const allowedBackupBuckets = () => (process.env.BACKUP_BUCKETS ?? '').split(',').map(b => b.trim()).filter(Boolean)

/** Where backups go: the workspace's chosen bucket, else BACKUP_BUCKET, else the attachments bucket. Empty: nowhere configured. */
export const backupBucket = (s: BackupSettings) =>
  (s.bucket && allowedBackupBuckets().includes(s.bucket) ? s.bucket : '') || process.env.BACKUP_BUCKET || filesBucket()
const prefixOf = (s: BackupSettings) => (s.prefix ?? 'project-backups/').replace(/^\/+/, '')

/** The project's rows, table by table, in the order they must be restored (parents before children). */
const TABLES: [table: string, where: string][] = [
  ['projects', 'id = $1'],
  ['statuses', 'project_id = $1'],
  ['work_types', 'project_id = $1'],
  ['transitions', 'project_id = $1'],
  ['field_defs', 'project_id = $1'],
  ['releases', 'project_id = $1'],
  ['item_templates', 'project_id = $1'],
  ['rules', 'project_id = $1'],
  ['sprints', 'project_id = $1'],
  ['project_members', 'project_id = $1'],
  ['project_group_roles', 'project_id = $1'],
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
  let backup: { id: string; bucket: string; objectKey: string; items: number; files: number; bytes: number; sha256: string } | null = null

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
    backup = { id: job.id, bucket, objectKey: `${base}/project.json`, items: tables.issues?.length ?? 0, files: tables.attachments?.length ?? 0, bytes: bytes + body.length,
      sha256: createHash('sha256').update(body).digest('hex') }
  }

  const c = await pool.connect()
  const d = wrapClient(c)
  try {
    await c.query('begin')
    if (backup) await c.query(
      `insert into project_backups (id, workspace_id, project_id, project_key, project_name, bucket, object_key, items, files, bytes, created_by, sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (id) do nothing`,
      [backup.id, proj.workspace_id, proj.id, proj.key, proj.name, backup.bucket, backup.objectKey, backup.items, backup.files, backup.bytes, p.actorId, backup.sha256])
    await audit(d, who, { action: 'project.deleted', type: 'project', id: proj.id, name: proj.key, project: { id: proj.id, key: proj.key },
      before: { name: proj.name }, after: backup ? { backupId: backup.id, items: backup.items, files: backup.files } : { backup: 'off' } })
    await c.query('delete from projects where id = $1', [proj.id])
    await c.query('commit')
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
  return backup ? { backupId: backup.id, items: backup.items, files: backup.files } : { backup: 'off' }
}

/** Refuses a backup that reaches outside its own project and workspace (defence in depth: the checksum already proves
 *  the document is the one this server wrote). */
function checkBackup(doc: BackupDoc, b: { project_id: string; project_key: string; workspace_id: string }) {
  const fail = (why: string) => { throw new Error(`The backup does not match its record (${why}); it will not be restored`) }
  if (doc.format !== 1 || doc.project?.id !== b.project_id || doc.project?.key !== b.project_key) fail('project')
  const t = doc.tables ?? {}
  if (t.projects?.length !== 1 || t.projects[0]!.id !== b.project_id || t.projects[0]!.workspace_id !== b.workspace_id) fail('project row')
  for (const [table] of TABLES) {
    if (table === 'projects') continue
    for (const r of t[table] ?? []) {
      if ('project_id' in r && r.project_id !== b.project_id) fail(table)
      if ('workspace_id' in r && r.workspace_id !== b.workspace_id) fail(table)
    }
  }
  const items = new Set((t.issues ?? []).map(i => i.id))
  for (const table of ['issue_watchers', 'comments', 'activity', 'worklogs', 'attachments'])
    for (const r of t[table] ?? []) if (!items.has(r.issue_id)) fail(table)
  for (const l of t.issue_links ?? []) if (!items.has(l.issue_id) && !items.has(l.target_id)) fail('issue_links')
  for (const a of t.attachments ?? []) if (!String(a.object_key).startsWith(`${b.workspace_id}/`) || String(a.object_key).includes('..')) fail('attachment')
}

/** Puts a backed-up project back exactly as it was (same ids, keys and history), with its files. */
async function restoreProject(p: { backupId: string; actorId: string | null; actorEmail: string; ip?: string }) {
  const [b] = (await pool.query('select * from project_backups where id = $1', [p.backupId])).rows
  if (!b) return { skipped: 'backup not found' }
  if (b.restored_at) return { skipped: 'already restored' }
  const got = await s3().send(new GetObjectCommand({ Bucket: b.bucket, Key: b.object_key }))
  const body = await got.Body!.transformToString()
  // the document must be exactly what was written, and only about this project in this workspace
  if (!b.sha256 || createHash('sha256').update(body).digest('hex') !== b.sha256) throw new Error('The backup document has changed since it was written; it will not be restored')
  const doc = JSON.parse(body) as BackupDoc
  checkBackup(doc, b)
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
      // a new project row seeds the built-in work types; the backup's own (renamed, added) replace them
      if (table === 'work_types') await c.query('delete from work_types where project_id = $1', [doc.project.id])
      const groups = table === 'project_group_roles' ? new Set((await c.query('select id from groups')).rows.map(r => r.id as string)) : null
      for (const r0 of rows) {
        const r = { ...r0 }
        if (table === 'projects') r.deleting_at = null
        if (table === 'issues') r.parent_id = null                     // set below, once every item exists
        if (NEEDS_PERSON.has(table) && !people.has(String(r.user_id))) continue
        if (groups && !groups.has(String(r.group_id))) continue        // a group removed from the directory since
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
