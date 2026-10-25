// Test management (what Xray adds to Jira). Stage 2: which tests a Test Set, Test Plan or Pre-Condition holds, and each
// project's test repository folders. Tests and their containers are work items, so access is theirs: you see a container's
// tests only where you could see them yourself (project and security level), and change it as you would edit the item.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db, tx, type Db } from '../db.ts'
import { HttpError, type Me } from '../auth.ts'
import { levelOk, visibleAs } from '../access.ts'
import { publish } from '../events.ts'
import { audit } from '../audit.ts'
import { getSetting } from '../settings.ts'
import { ISSUE_ROW, issueByKey } from './issues.ts'
import { projectByKey } from './projects.ts'
import { searchWhere } from './misc.ts'

const uuid = z.string().uuid()
const T = ['Testing']
const keyP = z.object({ key: z.string() })
const memberP = keyP.extend({ test: z.string() })
const CONTAINERS = ['test_set', 'test_plan', 'precondition']
const what = (type: string) => type === 'test_set' ? 'Test Set' : type === 'test_plan' ? 'Test Plan' : 'Pre-Condition'

/** The container, which must be a Test Set, Test Plan or Pre-Condition. */
async function containerOf(d: Db, req: { me: Me; method: string }, key: string) {
  const c = await issueByKey(d, req, key)
  if (!CONTAINERS.includes(c.type)) throw new HttpError(400, 'Only Test Sets, Test Plans and Pre-Conditions hold tests')
  return c
}

/** A container's tests that I can see, in order (plans: by folder, then order). */
const membersOf = (d: Db, me: Me, containerId: string) => d.query<any>(
  `${ISSUE_ROW.replace('select i.id,', 'select ti.folder, ti.position as item_position, i.id,')}
     join test_items ti on ti.member_id = i.id
    where ti.container_id = $1 and i.deleted_at is null and ${visibleAs(me, 'i.project_id', 2)} and ${levelOk(me, 2)}
    order by ti.folder, ti.position, i.number`, [containerId, me.id])

const plugin: FastifyPluginAsyncZod = async app => {
  app.get('/issues/:key/tests', { schema: { tags: T, summary: 'The tests a Test Set, Test Plan or Pre-Condition holds (those you can see)', params: keyP } }, async req => {
    const c = await containerOf(db, req, req.params.key)
    return membersOf(db, req.me, c.id)
  })

  app.post('/issues/:key/tests', { schema: {
    tags: T, summary: 'Add tests to a Test Set, Test Plan or Pre-Condition, by key or by JQL (up to the bulk-change limit in System settings)', params: keyP,
    body: z.object({ keys: z.array(z.string().max(40)).max(5000).optional(), jql: z.string().max(5000).optional(), folder: z.string().max(500).optional() })
      .refine(b => !!b.keys?.length || !!b.jql?.trim(), 'Give keys or a JQL query'),
  } }, async req => {
    return tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      const args: unknown[] = []
      const { where } = await searchWhere(req.me, { q: '', resolution: 'all', jql: req.body.jql }, args)
      if (req.body.keys?.length) {
        args.push(req.body.keys.map(k => k.toUpperCase()))
        where.push(`(p.key || '-' || i.number) = any($${args.length}::text[])`)
      }
      const { bulkMaxItems } = await getSetting(req.me.workspaceId, 'searchAndBulk')
      args.push(bulkMaxItems + 1)
      const found = await d.query<{ id: string; key: string; type: string }>(
        `select i.id, p.key || '-' || i.number as key, i.type from issues i join projects p on p.id = i.project_id join statuses st on st.id = i.status_id
          where ${where.join(' and ')} order by i.number limit $${args.length}`, args)
      if (found.length > bulkMaxItems) throw new HttpError(400, `At most ${bulkMaxItems} tests at a time (the bulk-change limit in System settings)`)
      const notTests = found.filter(f => f.type !== 'test')
      if (req.body.keys?.length) {
        const missing = req.body.keys.filter(k => !found.some(f => f.key === k.toUpperCase()))
        if (missing.length) throw new HttpError(400, `Not found: ${missing.slice(0, 10).join(', ')}`, { keys: 'Unknown work items' })
        if (notTests.length) throw new HttpError(400, `Not tests: ${notTests.slice(0, 10).map(f => f.key).join(', ')}`, { keys: 'Only Tests can be added' })
      }
      const tests = found.filter(f => f.type === 'test')
      const [{ max }] = await d.query<{ max: number }>('select coalesce(max(position), 0) as max from test_items where container_id = $1', [c.id]) as any
      const added = await d.query<{ memberId: string }>(
        `insert into test_items (container_id, member_id, position, folder)
         select $1, t.id, $3 + t.n, $4 from unnest($2::uuid[]) with ordinality t(id, n)
         on conflict do nothing returning member_id`, [c.id, tests.map(t => t.id), max, req.body.folder ?? ''])
      if (added.length) {
        await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [c.id, req.me.id, `Added ${added.length} test${added.length === 1 ? '' : 's'}`])
        await publish(d, c.projectId, { type: 'tests.changed', id: c.id })
      }
      return { added: added.length, already: tests.length - added.length, items: await membersOf(d, req.me, c.id) }
    })
  })

  app.patch('/issues/:key/tests/:test', { schema: { tags: T, summary: 'Move a test within a Test Plan (its folder, its place)', params: memberP,
    body: z.object({ folder: z.string().max(500), position: z.number() }).partial() } }, async req => {
    return tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      const t = await issueByKey(d, { me: req.me, method: 'GET' }, req.params.test)
      const folder = req.body.folder?.split('/').map(s => s.trim()).filter(Boolean).join('/')
      const [row] = await d.query('update test_items set folder = coalesce($3, folder), position = coalesce($4, position) where container_id = $1 and member_id = $2 returning 1',
        [c.id, t.id, folder ?? null, req.body.position ?? null])
      if (!row) throw new HttpError(404, `${t.key} isn’t in this ${what(c.type)}`)
      return membersOf(d, req.me, c.id)
    })
  })

  app.delete('/issues/:key/tests/:test', { schema: { tags: T, summary: 'Take a test out of a Test Set, Test Plan or Pre-Condition', params: memberP } }, async (req, reply) => {
    await tx(async d => {
      const c = await containerOf(d, req, req.params.key)
      const t = await issueByKey(d, { me: req.me, method: 'GET' }, req.params.test)
      const r = await d.query('delete from test_items where container_id = $1 and member_id = $2 returning 1', [c.id, t.id])
      if (!r.length) throw new HttpError(404, `${t.key} isn’t in this ${what(c.type)}`)
      await d.query('insert into activity (issue_id, actor_id, text) values ($1, $2, $3)', [c.id, req.me.id, `Removed test ${t.key}`])
      await publish(d, c.projectId, { type: 'tests.changed', id: c.id })
    })
    reply.code(204).send()
  })

  // A test's side: the sets, plans and pre-conditions it is in
  app.get('/issues/:key/test-containers', { schema: { tags: T, summary: 'The Test Sets, Test Plans and Pre-Conditions a test is in (those you can see)', params: keyP } }, async req => {
    const t = await issueByKey(db, req, req.params.key)
    return db.query(
      `select i.id, p.key || '-' || i.number as key, i.type, i.title, i.project_id from test_items ti
         join issues i on i.id = ti.container_id join projects p on p.id = i.project_id
        where ti.member_id = $1 and i.deleted_at is null and ${visibleAs(req.me, 'i.project_id', 2)} and ${levelOk(req.me, 2)}
        order by i.type, i.number`, [t.id, req.me.id])
  })

  // ── Test repository folders ──
  const folderBody = z.object({ name: z.string().trim().min(1).max(100).refine(n => !n.includes('/'), 'A folder name can’t contain “/”'), parentId: uuid.nullable().optional(), position: z.number().optional() })
  const folderP = keyP.extend({ folderId: uuid })
  const folders = (d: Db, projectId: string) => d.query(
    `select f.id, f.parent_id, f.name, f.position, (select count(*)::int from issues i where i.test_folder_id = f.id and i.deleted_at is null) as tests
       from test_folders f where f.project_id = $1 order by f.position, lower(f.name)`, [projectId])
  /** The parent must be one of the project's folders, and not the folder itself or inside it. */
  async function checkParent(d: Db, projectId: string, parentId: string | null | undefined, self?: string) {
    if (!parentId) return
    const [ok] = await d.query<{ n: number; loops: boolean }>(
      `with recursive up as (select id, parent_id from test_folders where id = $2 and project_id = $1
                             union all select f.id, f.parent_id from test_folders f join up on f.id = up.parent_id)
       select count(*)::int as n, coalesce(bool_or(id = $3::uuid), false) as loops from up`, [projectId, parentId, self ?? null])
    if (!ok?.n) throw new HttpError(400, 'No such folder in this project', { parentId: 'Unknown folder' })
    if (ok.loops) throw new HttpError(400, 'A folder can’t go inside itself', { parentId: 'Inside itself' })
  }
  const nameTaken = (e: any) => { if (e?.code === '23505') throw new HttpError(409, 'There is already a folder with that name here', { name: 'Already used' }); throw e }

  app.get('/projects/:key/test-folders', { schema: { tags: T, summary: 'The project’s test repository folders, with how many tests each holds', params: keyP } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return folders(db, p.id)
  })
  app.post('/projects/:key/test-folders', { schema: { tags: T, summary: 'Add a test repository folder', params: keyP, body: folderBody } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      await checkParent(d, p.id, req.body.parentId)
      const [row] = await d.query<{ id: string }>(
        `insert into test_folders (project_id, parent_id, name, position)
         values ($1, $2, $3, coalesce($4, (select coalesce(max(position), 0) + 1 from test_folders where project_id = $1))) returning id`,
        [p.id, req.body.parentId ?? null, req.body.name, req.body.position ?? null]).catch(nameTaken)
      await publish(d, p.id, { type: 'test-folders.changed' })
      reply.code(201)
      return (await folders(d, p.id)).find((f: any) => f.id === row!.id)
    })
  })
  app.patch('/projects/:key/test-folders/:folderId', { schema: { tags: T, summary: 'Rename or move a test repository folder', params: folderP, body: folderBody.partial() } }, async req => {
    const p = await projectByKey(db, req, req.params.key)
    return tx(async d => {
      const [cur] = await d.query<any>('select * from test_folders where id = $1 and project_id = $2 for update', [req.params.folderId, p.id])
      if (!cur) throw new HttpError(404, 'No such folder')
      if (req.body.parentId !== undefined) await checkParent(d, p.id, req.body.parentId, cur.id)
      await d.query('update test_folders set name = $2, parent_id = $3, position = $4 where id = $1',
        [cur.id, req.body.name ?? cur.name, req.body.parentId !== undefined ? req.body.parentId : cur.parentId, req.body.position ?? cur.position]).catch(nameTaken)
      await publish(d, p.id, { type: 'test-folders.changed' })
      return (await folders(d, p.id)).find((f: any) => f.id === cur.id)
    })
  })
  app.delete('/projects/:key/test-folders/:folderId', { schema: { tags: T, summary: 'Remove a test repository folder: its tests and folders move up to its parent', params: folderP } }, async (req, reply) => {
    const p = await projectByKey(db, req, req.params.key)
    await tx(async d => {
      const [cur] = await d.query<any>('select * from test_folders where id = $1 and project_id = $2 for update', [req.params.folderId, p.id])
      if (!cur) throw new HttpError(404, 'No such folder')
      await d.query('update test_folders set parent_id = $2 where parent_id = $1', [cur.id, cur.parentId]).catch(nameTaken)
      await d.query('update issues set test_folder_id = $2, version = version + 1, updated_at = now() where test_folder_id = $1', [cur.id, cur.parentId])
      await d.query('delete from test_folders where id = $1', [cur.id])
      await audit(d, req, { action: 'project.test_folder.deleted', type: 'test folder', id: cur.id, name: cur.name, project: p })
      await publish(d, p.id, { type: 'test-folders.changed' })
    })
    reply.code(204).send()
  })
}
export default plugin
