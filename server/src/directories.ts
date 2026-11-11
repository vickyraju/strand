// User directories (spec 0712), as Jira's: Active Directory or another LDAP server, Read Only. The login form checks
// passwords against them, in order (the first directory that has the username decides), and a synchronisation copies
// their users, groups and memberships into Strand on a schedule. People are never deleted: missing means deactivated.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { escapeFilter, FilterParser } from 'ldapts'
import { db, pool, tx, type Db } from './db.ts'
import { HttpError, initials, joinSystemGroup, type Identity } from './auth.ts'
import { audit, changes, type Actor } from './audit.ts'
import { attr, connect, type Entry, type Ldap } from './ldap.ts'
import { unseal } from './secrets.ts'
import { enqueue, registerJob } from './jobs.ts'
import { addPasswordChecker } from './routes/authentication.ts'

const name = z.string().trim().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9;-]*$/, 'An attribute name')
const filter = z.string().trim().min(3).max(2000).refine(f => { try { FilterParser.parseString(f); return true } catch { return false } }, 'Not a valid LDAP filter')
const dn = z.string().trim().max(512)

/** A directory's settings, with Jira's names (R2). The bind password is kept apart, encrypted (R3). */
export const directoryConfig = z.object({
  host: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9.:[\]-]+$/, 'A host name or address'),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['none', 'ldaps', 'starttls']).describe('none sends passwords in the clear: allowed, as in Jira, with a warning'),
  bindDn: dn.min(1).describe('Username: the service account Strand reads the directory as (a DN, or user@domain for Active Directory)'),
  baseDn: dn.min(1),
  userDn: dn.default('').describe('Additional user DN: under the base DN'),
  groupDn: dn.default('').describe('Additional group DN: under the base DN'),
  pageSize: z.number().int().min(10).max(10_000).default(1000),
  syncMinutes: z.number().int().min(5).max(10_080).default(60).describe('Synchronise every this many minutes'),
  incremental: z.boolean().default(false).describe('Active Directory: read only what changed since the last run (uSNChanged), as Jira’s Enable Incremental Synchronization (spec 0713)'),
  fullSyncHours: z.number().int().min(1).max(720).default(24).describe('A full synchronisation at least this often, which applies deletions and objects moved out of scope (spec 0713)'),
  connectTimeoutSeconds: z.number().int().min(1).max(120).default(10),
  readTimeoutSeconds: z.number().int().min(1).max(600).default(120),
  user: z.object({ objectClass: name, filter, username: name, firstName: name, lastName: name, displayName: name, email: name, guid: name.describe('Unique id attribute') }),
  group: z.object({ objectClass: name, filter, name, description: name }),
  membership: z.object({
    groupMember: name.describe('A group’s members'), userMemberOf: name.describe('A user’s groups'),
    useMemberOf: z.boolean().describe('Read memberships from each user (Active Directory) instead of each group'),
    nested: z.boolean().describe('Members of a group inside a group are members of both'),
  }),
})
export type DirectoryConfig = z.infer<typeof directoryConfig>
export type DirectoryType = 'ad' | 'ldap'

/** Jira's defaults for each type (R2), less what only the admin knows: host, service account and base DN. */
export const PRESETS: Record<DirectoryType, Omit<DirectoryConfig, 'host' | 'bindDn' | 'baseDn'>> = {
  ad: {
    port: 389, security: 'none', userDn: '', groupDn: '', pageSize: 1000, syncMinutes: 60, incremental: true, fullSyncHours: 24, connectTimeoutSeconds: 10, readTimeoutSeconds: 120,
    user: { objectClass: 'user', filter: '(&(objectCategory=Person)(sAMAccountName=*))', username: 'sAMAccountName', firstName: 'givenName', lastName: 'sn', displayName: 'displayName', email: 'mail', guid: 'objectGUID' },
    group: { objectClass: 'group', filter: '(objectCategory=Group)', name: 'cn', description: 'description' },
    membership: { groupMember: 'member', userMemberOf: 'memberOf', useMemberOf: true, nested: false },
  },
  ldap: {
    port: 389, security: 'none', userDn: '', groupDn: '', pageSize: 1000, syncMinutes: 60, incremental: false, fullSyncHours: 24, connectTimeoutSeconds: 10, readTimeoutSeconds: 120,
    user: { objectClass: 'inetOrgPerson', filter: '(objectClass=inetOrgPerson)', username: 'uid', firstName: 'givenName', lastName: 'sn', displayName: 'displayName', email: 'mail', guid: 'entryUUID' },
    group: { objectClass: 'groupOfNames', filter: '(objectClass=groupOfNames)', name: 'cn', description: 'description' },
    membership: { groupMember: 'member', userMemberOf: 'memberOf', useMemberOf: false, nested: false },
  },
}

export interface Directory {
  id: string; name: string; type: DirectoryType; position: number; enabled: boolean
  config: DirectoryConfig; passwordEnc: Buffer | null; lastSync: unknown; syncState: SyncState | null
}
/** Where incremental runs pick up (spec 0713): the highest uSNChanged seen (null: the directory doesn't report it), the
 *  settings' fingerprint at the last full run, and when that was. */
interface SyncState { highestUsn: number | null; fingerprint: string; fullAt: string }

const under = (sub: string, base: string) => (sub ? `${sub},${base}` : base)
const actor = (d: Pick<Directory, 'name'>): Actor => ({ system: `User directory ${d.name}` })

/** Connected and signed in as the service account. */
export async function openDirectory(c: DirectoryConfig, password: string): Promise<Ldap> {
  if (!password) throw new Error('The service account has no password')            // an empty one would be an anonymous bind
  const l = await connect({ host: c.host, port: c.port, security: c.security, connectTimeoutMs: c.connectTimeoutSeconds * 1000, timeoutMs: c.readTimeoutSeconds * 1000 })
  try { await l.bind(c.bindDn, password); return l } catch (e) { await l.close(); throw e }
}
export const bindPassword = (d: Directory) => (d.passwordEnc ? unseal(d.passwordEnc, d.id) : '')

/** A person as the directory has them. */
export interface Person { dn: string; username: string; email: string; name: string; guid: string; disabled: boolean; groups: string[] }
const userAttributes = (c: DirectoryConfig) =>
  [c.user.username, c.user.firstName, c.user.lastName, c.user.displayName, c.user.email, c.user.guid, 'userAccountControl', 'uSNChanged', ...(c.membership.useMemberOf ? [c.membership.userMemberOf] : [])]
/** An entry's uSNChanged, 0 when it has none (spec 0713). */
const usnOf = (e: Entry) => Number(attr(e, 'uSNChanged')[0]) || 0

function person(c: DirectoryConfig, e: Entry): Person | null {
  const one = (a: string) => attr(e, a)[0]?.trim() ?? ''
  const username = one(c.user.username), guid = one(c.user.guid)
  if (!username || !guid) return null
  const name = one(c.user.displayName) || [one(c.user.firstName), one(c.user.lastName)].filter(Boolean).join(' ') || username
  return {
    dn: e.dn, username, guid, name, email: one(c.user.email).toLowerCase(),
    disabled: (Number(one('userAccountControl') || 0) & 2) !== 0,                   // Active Directory: ACCOUNTDISABLE
    groups: c.membership.useMemberOf ? attr(e, c.membership.userMemberOf) : [],
  }
}

/** The user with this username, or null. The username is escaped (RFC 4515): it can't change the filter (R5). */
export async function findPerson(l: Ldap, c: DirectoryConfig, username: string): Promise<Person | null> {
  const f = `(&${c.user.filter}(${c.user.username}=${escapeFilter`${username}`}))`
  for await (const page of l.search(under(c.userDn, c.baseDn), f, userAttributes(c), 2))
    for (const e of page) { const p = person(c, e); if (p) return p }
  return null
}

type Upsert = { id: string; change: 'created' | 'updated' | 'linked' | 'same'; status?: 'deactivated' | 'reactivated' } | { skipped: string; known?: string }

/** Create or update Strand's copy of a directory user: by the directory's id for them, then by email (R6, R7). */
async function upsertPerson(d: Db, dir: Directory, p: Person, workspaceId: string): Promise<Upsert> {
  if (!p.email) return { skipped: 'No email address' }
  type U = { id: string; active: boolean; email: string; name: string; username: string | null; directoryId: string | null }
  const cols = 'id, active, email, name, username, directory_id'
  let [u] = await d.query<U>(`select ${cols} from users where directory_id = $1 and directory_guid = $2`, [dir.id, p.guid])
  let change: 'created' | 'updated' | 'linked' | 'same' = 'same'
  if (!u) {
    ;[u] = await d.query<U>(`select ${cols} from users where email = $1`, [p.email])
    if (u?.directoryId) return { skipped: 'Its email belongs to a user of another directory' }
    if (u) {
      // whoever controls the directory's mail attribute could otherwise take over an administrator's account
      const [x] = await d.query<{ privileged: boolean }>(
        `select is_system_admin($1) or exists (select 1 from memberships where user_id = $1 and role in ('owner', 'admin')) as privileged`, [u.id])
      if (x!.privileged) return { skipped: 'Its email belongs to a Strand administrator, whose account is never linked by email' }
      change = 'linked'
    }
  }
  const [taken] = await d.query<{ why: string }>(
    `select case when email = $2 then 'Its email belongs to someone else in Strand' else 'Its username belongs to someone else in Strand' end as why
       from users where (email = $2 or lower(username) = lower($3)) and id is distinct from $1 limit 1`, [u?.id ?? null, p.email, p.username])
  if (taken) return { skipped: taken.why, ...(change === 'same' && u ? { known: u.id } : {}) }   // known: still in the directory, so not missing
  const active = !p.disabled
  if (!u) {
    const [n] = await d.query<{ id: string }>(
      `insert into users (email, name, initials, username, directory_id, directory_guid, active, directory_dn) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [p.email, p.name, initials(p.name), p.username, dir.id, p.guid, active, p.dn])
    await d.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing`, [workspaceId, n!.id])
    await joinSystemGroup(d, n!.id, 'default-users')
    return { id: n!.id, change: 'created' }
  }
  if (change === 'same' && (u.email !== p.email || u.name !== p.name || u.username !== p.username)) change = 'updated'
  if (change !== 'same' || u.active !== active)
    await d.query(`update users set email = $2, name = $3, initials = $4, username = $5, directory_id = $6, directory_guid = $7, active = $8 where id = $1`,
      [u.id, p.email, p.name, initials(p.name), p.username, dir.id, p.guid, active])
  await d.query('update users set directory_dn = $2 where id = $1 and directory_dn is distinct from $2', [u.id, p.dn])   // a group's members, matched by DN (spec 0713)
  // a changed email, name or username is recorded as a change of that field (R7)
  const was = { email: u.email, name: u.name, username: u.username }, now = { email: p.email, name: p.name, username: p.username }
  const c = changes(was, now)
  if (c.changed) await audit(d, actor(dir), { workspaceId, action: change === 'linked' ? 'user.linked' : 'user.updated', type: 'user', id: u.id, name: p.email, before: c.before, after: { ...c.after, why: change === 'linked' ? 'Linked to the directory by email' : 'Changed in the directory' } })
  if (u.active !== active)
    await audit(d, actor(dir), { workspaceId, action: active ? 'user.reactivated' : 'user.deactivated', type: 'user', id: u.id, name: p.email, after: { why: active ? 'Active in the directory again' : 'Disabled in the directory' } })
  await d.query(`insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member') on conflict do nothing`, [workspaceId, u.id])
  return { id: u.id, change, ...(u.active !== active ? { status: active ? 'reactivated' as const : 'deactivated' as const } : {}) }
}

const oldestWorkspace = async (d: Db = db) => (await d.query<{ id: string }>('select id from workspaces order by created_at limit 1'))[0]?.id

/** The login form (R5): the enabled directories in order; the first that has the username decides. */
export async function signInWithDirectory(username: string, password: string): Promise<Identity | null> {
  if (!password) return null                                                     // an empty password is an anonymous bind: never sent
  const dirs = await db.query<Directory>('select * from user_directories where enabled order by position')
  for (const dir of dirs) {
    let l: Ldap
    try { l = await openDirectory(dir.config, bindPassword(dir)) }
    catch { throw new HttpError(503, `The user directory “${dir.name}” can’t be reached right now. Try again later.`) }
    try {
      const p = await findPerson(l, dir.config, username)
      if (!p) continue
      if (p.disabled) return null
      try { await l.bind(p.dn, password) } catch { return null }
      const ws = await oldestWorkspace()
      if (!ws) return null                                                       // Strand's first person signs in with Entra
      const r = await tx(async d => {
        const r = await upsertPerson(d, dir, p, ws)
        if ('id' in r && dir.config.membership.useMemberOf) await joinDirectoryGroups(d, dir, r.id, p.groups)
        return r
      })
      return 'id' in r ? { username: p.username, email: p.email, name: p.name, admin: false } : null
    } finally { await l.close() }
  }
  return null
}
addPasswordChecker(signInWithDirectory)

/** First sign-in before a synchronisation (R6): into the directory's groups Strand already has. */
async function joinDirectoryGroups(d: Db, dir: Directory, userId: string, groupDns: string[]) {
  if (!groupDns.length) return
  await d.query(
    `insert into group_members (group_id, user_id) select id, $3 from groups where directory_id = $1 and lower(directory_dn) = any($2::text[]) on conflict do nothing`,
    [dir.id, groupDns.map(g => g.toLowerCase()), userId])
}

// —— Synchronisation (R7–R11) ——

interface SyncResult {
  at: string; ok: boolean; ms: number; error?: string
  /** spec 0713: whether only changes were read, and why a full run was chosen */
  mode?: 'full' | 'incremental'; why?: string
  users?: { found: number; created: number; updated: number; linked: number; deactivated: number; reactivated: number; skipped: { name: string; why: string }[] }
  groups?: { found: number; created: number; renamed: number; emptied: number; skipped: { name: string; why: string }[] }
}
const SKIPPED_SHOWN = 50
type Users = NonNullable<SyncResult['users']>
type Groups = NonNullable<SyncResult['groups']>
const noUsers = (): Users => ({ found: 0, created: 0, updated: 0, linked: 0, deactivated: 0, reactivated: 0, skipped: [] })
const noGroups = (): Groups => ({ found: 0, created: 0, renamed: 0, emptied: 0, skipped: [] })

/** One synchronisation; only one per directory runs at a time, across servers (R11). `full` asks for a full one (spec 0713). */
export async function syncDirectory(id: string, job?: { id: string }, o: { full?: boolean } = {}): Promise<SyncResult | { skipped: string }> {
  const lock = await pool.connect()
  try {
    const { rows: [l] } = await lock.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [`directory.sync:${id}`])
    if (!l!.ok) return { skipped: 'This directory is being synchronised already' }
    try { return await synchronise(id, job, o) }
    finally { await lock.query('select pg_advisory_unlock(hashtext($1))', [`directory.sync:${id}`]) }
  } finally { lock.release() }
}

/** Why this run must read everything (spec 0713 R2), or '' when only changes are read. */
function fullBecause(dir: Directory, fingerprint: string, asked: boolean): string {
  const c = dir.config, st = dir.syncState
  if (asked) return 'A full synchronisation was asked for'
  if (dir.type !== 'ad' || !c.incremental) return 'Incremental synchronisation is off'
  if (!st) return 'The first synchronisation'
  if (st.fingerprint !== fingerprint) return 'The directory’s settings changed'
  if (!(dir.lastSync as { ok?: boolean } | null)?.ok) return 'The last synchronisation failed'
  if (st.highestUsn == null) return 'The directory doesn’t report uSNChanged'
  if (Date.now() - Date.parse(st.fullAt) >= c.fullSyncHours * 3_600_000) return `The last full synchronisation was over ${c.fullSyncHours} hours ago`
  return ''
}

async function synchronise(id: string, job?: { id: string }, o: { full?: boolean } = {}): Promise<SyncResult | { skipped: string }> {
  const [dir] = await db.query<Directory>('select * from user_directories where id = $1', [id])
  if (!dir?.enabled) return { skipped: 'The directory is disabled' }               // R12
  const started = Date.now(), c = dir.config
  const fingerprint = createHash('sha256').update(JSON.stringify(c)).digest('hex')
  let why = fullBecause(dir, fingerprint, !!o.full)
  let users = noUsers(), groups = noGroups()
  const done = async (r: Omit<SyncResult, 'at' | 'ms' | 'users' | 'groups'>, state?: SyncState) => {
    users.skipped.splice(SKIPPED_SHOWN); groups.skipped.splice(SKIPPED_SHOWN)
    const result: SyncResult = { at: new Date().toISOString(), ms: Date.now() - started, ...r, users, groups }
    await db.query('update user_directories set last_sync = $2, sync_state = coalesce($3, sync_state) where id = $1', [id, JSON.stringify(result), state ? JSON.stringify(state) : null])
    return result
  }
  const progress = async (n: number) => { if (job) await db.query(`update jobs set progress = $2, locked_until = now() + interval '5 minutes' where id = $1`, [job.id, JSON.stringify({ done: n })]) }
  let l: Ldap | undefined
  try {
    const ws = await oldestWorkspace()
    if (!ws) throw new Error('Nobody has signed in to Strand yet')
    l = await openDirectory(c, bindPassword(dir))
    if (!why) {
      try {
        const top = await incrementalRun(l, dir, ws, dir.syncState!.highestUsn! + 1, users, groups, progress)
        return await done({ ok: true, mode: 'incremental' }, { ...dir.syncState!, highestUsn: Math.max(dir.syncState!.highestUsn!, top) })
      } catch (e) {
        // R3: a failed incremental run becomes a full one at once
        why = `The incremental synchronisation failed (${String((e as Error)?.message ?? e).slice(0, 200)}), so a full one ran`
        users = noUsers(); groups = noGroups()
      }
    }
    const top = await fullRun(l, dir, ws, users, groups, progress)
    return await done({ ok: true, mode: 'full', why }, { highestUsn: top || null, fingerprint, fullAt: new Date(started).toISOString() })
  } catch (e) {
    return await done({ ok: false, mode: why ? 'full' : 'incremental', ...(why ? { why } : {}), error: String((e as Error)?.message ?? e).slice(0, 500) })
  } finally { await l?.close() }
}

/** Everyone and every group (R7–R10). Returns the highest uSNChanged seen (0: the directory doesn't report it). */
async function fullRun(l: Ldap, dir: Directory, ws: string, users: Users, groups: Groups, progress: (n: number) => Promise<void>): Promise<number> {
  const c = dir.config, id = dir.id
  let top = 0
  // users, a page at a time (R7)
  const seen: string[] = []
  const idOfDn = new Map<string, string>()                                     // lower(DN) → user id
  const groupsOf = new Map<string, string[]>()                                 // user id → group DNs (memberOf)
  for await (const page of l.search(under(c.userDn, c.baseDn), c.user.filter, userAttributes(c), c.pageSize)) {
    users.found += page.length
    await tx(async d => {
      for (const e of page) {
        top = Math.max(top, usnOf(e))
        const p = person(c, e)
        if (!p) { users.skipped.push({ name: e.dn, why: 'No username or unique id' }); continue }
        const r = await upsertPerson(d, dir, p, ws)
        if (!('id' in r)) { users.skipped.push({ name: p.username, why: r.skipped }); if (r.known) seen.push(r.known); continue }
        if (r.change !== 'same') users[r.change]++
        if (r.status) users[r.status]++
        seen.push(r.id); idOfDn.set(p.dn.toLowerCase(), r.id); groupsOf.set(r.id, p.groups)
      }
    })
    await progress(users.found)
  }
  // a directory that had people and now finds none is misconfigured, not empty: change nothing (R11)
  if (!seen.length && (await db.query('select 1 from users where directory_id = $1 and active limit 1', [id])).length)
    throw new Error('The directory found no users, so nothing was changed. Check the base DN, the user DN and the user filter.')
  // missing from the directory: deactivated, never deleted (R8)
  await tx(async d => {
    const gone = await d.query<{ id: string; email: string }>(
      `update users set active = false where directory_id = $1 and active and not (id = any($2::uuid[])) returning id, email`, [id, seen])
    for (const g of gone) await audit(d, actor(dir), { workspaceId: ws, action: 'user.deactivated', type: 'user', id: g.id, name: g.email, after: { why: 'No longer in the directory' } })
    users.deactivated += gone.length
  })
  return Math.max(top, await groupsPhase(l, dir, ws, groups, idOfDn, c.membership.useMemberOf ? groupsOf : null))
}

/** Only what changed since `since` (spec 0713 R1): changed users; and when any group changed, every group again, with
 *  memberships from the groups' member attribute (a membership change touches the group, not the person). */
async function incrementalRun(l: Ldap, dir: Directory, ws: string, since: number, users: Users, groups: Groups, progress: (n: number) => Promise<void>): Promise<number> {
  const c = dir.config
  let top = 0
  for await (const page of l.search(under(c.userDn, c.baseDn), `(&${c.user.filter}(uSNChanged>=${since}))`, userAttributes(c), c.pageSize)) {
    users.found += page.length
    await tx(async d => {
      for (const e of page) {
        top = Math.max(top, usnOf(e))
        const p = person(c, e)
        if (!p) { users.skipped.push({ name: e.dn, why: 'No username or unique id' }); continue }
        const r = await upsertPerson(d, dir, p, ws)
        if (!('id' in r)) { users.skipped.push({ name: p.username, why: r.skipped }); continue }
        if (r.change !== 'same') users[r.change]++
        if (r.status) users[r.status]++
        if (r.change === 'created' && c.membership.useMemberOf) await joinDirectoryGroups(d, dir, r.id, p.groups)
      }
    })
    await progress(users.found)
  }
  let changed = false
  for await (const page of l.search(under(c.groupDn, c.baseDn), `(&${c.group.filter}(uSNChanged>=${since}))`, [c.group.name, 'uSNChanged'], c.pageSize))
    for (const e of page) { changed = true; top = Math.max(top, usnOf(e)) }
  if (changed) {
    const idOfDn = new Map((await db.query<{ id: string; dn: string }>('select id, lower(directory_dn) as dn from users where directory_id = $1 and directory_dn is not null', [dir.id])).map(u => [u.dn, u.id]))
    top = Math.max(top, await groupsPhase(l, dir, ws, groups, idOfDn, null))
  }
  return top
}

/** Every group (R9) and its members (R10): from each user's memberOf (`groupsOf`), or else each group's member attribute.
 *  Returns the highest uSNChanged seen. */
async function groupsPhase(l: Ldap, dir: Directory, ws: string, groups: Groups, idOfDn: Map<string, string>, groupsOf: Map<string, string[]> | null): Promise<number> {
  const c = dir.config, id = dir.id
  let top = 0
  const groupIds = new Map<string, string>()                                   // lower(DN) → group id
  const members = new Map<string, string[]>()                                  // group id → member DNs
  const memberAttr = c.membership.groupMember
  const read = [c.group.name, c.group.description, c.user.guid, 'uSNChanged', ...(!groupsOf || c.membership.nested ? [memberAttr] : [])]
  for await (const page of l.search(under(c.groupDn, c.baseDn), c.group.filter, read, c.pageSize)) {
    groups.found += page.length
    await tx(async d => {
      for (const e of page) {
        top = Math.max(top, usnOf(e))
        const gName = attr(e, c.group.name)[0]?.trim(), guid = attr(e, c.user.guid)[0]
        if (!gName || !guid) { groups.skipped.push({ name: e.dn, why: gName ? 'No unique id' : 'No name' }); continue }
        const r = await upsertGroup(d, dir, { dn: e.dn, guid, name: gName, description: attr(e, c.group.description)[0] ?? '' }, ws)
        if (!('id' in r)) { groups.skipped.push({ name: gName, why: r.skipped }); continue }
        if (r.change !== 'same') groups[r.change]++
        groupIds.set(e.dn.toLowerCase(), r.id); members.set(r.id, attr(e, memberAttr))
      }
    })
  }
  // memberships mirror the directory (R10)
  const want = new Map<string, Set<string>>([...groupIds.values()].map(g => [g, new Set<string>()]))
  if (groupsOf) {
    for (const [user, dns] of groupsOf) for (const g of dns) want.get(groupIds.get(g.toLowerCase()) ?? '')?.add(user)
  } else {
    for (const [g, dns] of members) for (const m of dns) { const u = idOfDn.get(m.toLowerCase()); if (u) want.get(g)!.add(u) }
  }
  if (c.membership.nested) {
    const children = new Map([...members].map(([g, dns]) => [g, dns.map(m => groupIds.get(m.toLowerCase())).filter((x): x is string => !!x)]))
    const all = (g: string, seenG = new Set<string>()): Set<string> => {
      if (seenG.has(g)) return new Set()
      seenG.add(g)
      const s = new Set(want.get(g))
      for (const ch of children.get(g) ?? []) for (const u of all(ch, seenG)) s.add(u)
      return s
    }
    const flat = new Map([...want.keys()].map(g => [g, all(g)]))
    for (const [g, s] of flat) want.set(g, s)
  }
  for (const [g, us] of want) await tx(async d => {
    await d.query('delete from group_members where group_id = $1 and not (user_id = any($2::uuid[]))', [g, [...us]])
    await d.query('insert into group_members (group_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [g, [...us]])
  })
  // a group gone from the directory keeps its row (and so its project roles) but loses its members (R9)
  const emptied = await db.query<{ id: string }>(
    `delete from group_members where group_id in (select id from groups where directory_id = $1 and not (id = any($2::uuid[]))) returning group_id as id`, [id, [...groupIds.values()]])
  groups.emptied = new Set(emptied.map(e => e.id)).size
  return top
}

type GroupUpsert = { id: string; change: 'created' | 'renamed' | 'same' } | { skipped: string }
/** Strand's copy of a directory group, found by the directory's id for it (a rename changes its name and DN, not its id). */
async function upsertGroup(d: Db, dir: Directory, x: { dn: string; guid: string; name: string; description: string }, workspaceId: string): Promise<GroupUpsert> {
  const gName = x.name, description = x.description.slice(0, 500)
  const [g] = await d.query<{ id: string; displayName: string }>('select id, display_name from groups where directory_id = $1 and directory_guid = $2', [dir.id, x.guid])
  const [clash] = await d.query('select 1 from groups where lower(display_name) = lower($1) and id is distinct from $2', [gName, g?.id ?? null])
  if (clash) return { skipped: 'A group with this name is already in Strand' }
  if (!g) {
    const [n] = await d.query<{ id: string }>(
      `insert into groups (display_name, description, source, directory_id, directory_guid, directory_dn) values ($1, $2, 'directory', $3, $4, $5) returning id`,
      [gName, description, dir.id, x.guid, x.dn])
    return { id: n!.id, change: 'created' }
  }
  await d.query('update groups set display_name = $2, description = $3, directory_dn = $4 where id = $1', [g.id, gName, description, x.dn])
  if (g.displayName === gName) return { id: g.id, change: 'same' }
  await audit(d, actor(dir), { workspaceId, action: 'group.renamed', type: 'group', id: g.id, name: gName, before: { name: g.displayName }, after: { name: gName, why: 'Renamed in the directory' } })
  return { id: g.id, change: 'renamed' }
}

// —— Scheduling (R11) ——

/** The next scheduled synchronisation of this directory (one queued at a time). */
export async function scheduleSync(d: Db, dir: Pick<Directory, 'id' | 'config'>, now = false) {
  const runAt = new Date(Date.now() + (now ? 0 : dir.config.syncMinutes * 60_000))
  return enqueue(d, 'directory.sync', { directoryId: dir.id, scheduled: true }, { runAt, dedupeKey: `directory.sync:${dir.id}`, maxAttempts: 1 })
}
/** "Synchronise now": at once, besides the schedule; while one is waiting or running, that one is returned. */
export const syncNow = (d: Db, id: string, by: string, full = false) =>
  enqueue(d, 'directory.sync', { directoryId: id, full }, { createdBy: by, dedupeKey: `directory.sync-now:${id}`, maxAttempts: 1 })

registerJob('directory.sync', async (p: { directoryId: string; scheduled?: boolean; full?: boolean }, job) => {
  if (p.scheduled) await db.query('update jobs set dedupe_key = null where id = $1', [job.id])   // so the next one can be queued
  const r = await syncDirectory(p.directoryId, job, { full: !!p.full })
  const [dir] = await db.query<Directory>('select * from user_directories where id = $1 and enabled', [p.directoryId])
  if (p.scheduled && dir) await scheduleSync(db, dir)
  return r
})

/** At start: every enabled directory has its next synchronisation queued. */
export async function startDirectories() {
  for (const dir of await db.query<Directory>('select id, config from user_directories where enabled')) await scheduleSync(db, dir)
}

// —— Test settings (R4) ——

export interface TestStep { step: string; ok: boolean; detail: string }
const why = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 300)

export async function testDirectory(c: DirectoryConfig, password: string, testUser?: { username: string; password: string }): Promise<TestStep[]> {
  const steps: TestStep[] = []
  let l: Ldap
  try { l = await openDirectory(c, password); steps.push({ step: 'Connect and sign in', ok: true, detail: `${c.host}:${c.port} as ${c.bindDn}` }) }
  catch (e) { steps.push({ step: 'Connect and sign in', ok: false, detail: why(e) }); return steps }
  try {
    const sample = async (base: string, f: string, a: string) => {
      for await (const page of l.search(base, f, [a], c.pageSize)) return page
      return []
    }
    try {
      const page = await sample(under(c.userDn, c.baseDn), c.user.filter, c.user.username)
      steps.push({ step: 'Find users', ok: page.length > 0, detail: page.length ? `${page.length}${page.length >= c.pageSize ? ' or more' : ''} users, such as ${page.slice(0, 3).map(e => attr(e, c.user.username)[0]).join(', ')}` : 'No users found: check the base DN, the user DN and the user filter' })
    } catch (e) { steps.push({ step: 'Find users', ok: false, detail: why(e) }) }
    try {
      const page = await sample(under(c.groupDn, c.baseDn), c.group.filter, c.group.name)
      steps.push({ step: 'Find groups', ok: true, detail: page.length ? `${page.length}${page.length >= c.pageSize ? ' or more' : ''} groups, such as ${page.slice(0, 3).map(e => attr(e, c.group.name)[0]).join(', ')}` : 'No groups found' })
    } catch (e) { steps.push({ step: 'Find groups', ok: false, detail: why(e) }) }
    if (testUser?.username) {
      const p = await findPerson(l, c, testUser.username).catch(() => null)
      steps.push({ step: 'Find the test user', ok: !!p, detail: p ? `${p.name} <${p.email || 'no email'}>${p.disabled ? ', disabled in the directory' : ''}` : 'Not found' })
      if (p && c.membership.useMemberOf) steps.push({ step: 'The test user’s groups', ok: true, detail: p.groups.length ? p.groups.slice(0, 5).join('; ') : 'None' })
      if (p && testUser.password) {
        const ok = await l.bind(p.dn, testUser.password).then(() => true, () => false)
        steps.push({ step: 'The test user’s password', ok, detail: ok ? 'Accepted' : 'Refused' })
      }
    }
  } finally { await l.close() }
  return steps
}
