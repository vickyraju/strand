// Project settings → API: details, board WIP limits, custom fields, templates, rules, releases, stars and project
// deletion. (Workflows are changed in Administration, on the server.) Same approach as the other syncs: diff against what the server last saw.
import { api } from './client.ts'
import { createCollectionSync } from './collections.ts'
import { enqueue } from './queue.ts'
import type { Issue, Project } from '../data/reducer.ts'

/** What the settings sync needs from the running app (set by useIssueSync). */
export const settingsDeps = {
  getProjects: (): Project[] => [],
  getIssues: (): Issue[] => [],
  /** The issues the server last returned (before local edits), used to work out where released work went. */
  baseIssues: (): Issue[] => [],
  isUnfinished: (_issue: Issue): boolean => true,
  reloadProject: async (_projectId: string) => {},
  reloadAll: async () => {},
  onError: (_m: string) => {},
}

// ── Serializers: one place that says what the server stores for each kind ──

export type Kind = 'statuses' | 'fields' | 'templates' | 'rules' | 'releases' | 'components'
export interface Item { id: string; projectId: string; body: Record<string, unknown>; released?: boolean }

export function itemsOf(projects: Project[], kind: Kind): Item[] {
  return projects.flatMap(p => {
    const mk = (v: { id: string }, body: Record<string, unknown>, released?: boolean): Item => ({ id: v.id, projectId: p.id, body, ...(released !== undefined ? { released } : {}) })
    switch (kind) {
      case 'statuses':    return p.statuses.map(s => mk(s, { wipLimit: s.wipLimit ?? null }))       // the board's WIP limit is all a project sets
      case 'fields':      return p.fields.filter(f => !f.shared).map((f, position) => mk(f, { name: f.name, kind: f.kind, options: f.options ?? null, position }))   // shared fields are Administration's (spec 0503)
      case 'templates':   return p.templates.map(t => mk(t, { name: t.name, type: t.type, title: t.title, description: t.description, priority: t.priority, labels: t.labels, estimate: t.estimate ?? null }))
      case 'rules':       return p.rules.map(r => mk(r, { name: r.name, enabled: r.enabled, trigger: r.trigger, actions: r.actions, condition: r.condition?.trim() || null }))
      case 'components':  return (p.components ?? []).map(c => mk(c, { name: c.name, description: c.description, leadId: c.leadId ?? null, defaultAssignee: c.defaultAssignee }))
      case 'releases':    return p.releases.map(r => mk(r, { name: r.name, description: r.description, startDate: r.startDate ?? null, releaseDate: r.releaseDate ?? null, archived: !!r.archived }, r.released))
    }
  })
}

/** Did a select field's options lose or rename one (which changes items on the server)? */
export function optionsCarried(before: unknown, after: unknown) {
  const next = new Map(((after ?? []) as { id: string; name: string }[]).map(o => [o.id, o.name]))
  return ((before ?? []) as { id: string; name: string }[]).some(o => next.get(o.id) !== o.name)
}

/** Where unfinished work went when a release was shipped locally: the fix version that replaced it on those issues, else none. */
export function releaseMoveTo(releaseId: string, before: Issue[], now: Issue[], isUnfinished: (i: Issue) => boolean): string | null {
  const byId = new Map(now.map(i => [i.id, i]))
  for (const b of before.filter(i => i.fixReleaseIds?.includes(releaseId) && isUnfinished(i))) {
    const after = byId.get(b.id)?.fixReleaseIds ?? []
    const to = !after.includes(releaseId) && after.find(r => !b.fixReleaseIds!.includes(r))
    if (to) return to
  }
  return null
}

const keyOf = (projectId: string) => {
  const k = settingsDeps.getProjects().find(p => p.id === projectId)?.key
  if (!k) throw new Error('Project not found')
  return encodeURIComponent(k)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function kindSync(kind: Kind) {
  const path = (i: Item) => `/api/projects/${keyOf(i.projectId)}/${kind}`
  return createCollectionSync<Item>({
    id: i => i.id,
    changed: (a, b) => !same(a.body, b.body) || a.released !== b.released,
    create: async i => { await api('POST', path(i), { id: i.id, ...i.body }) },
    update: async (a, b) => {
      if (!same(a.body, b.body)) await api('PATCH', `${path(b)}/${b.id}`, b.body)
      // the server renamed or cleared those options on the items that had them (spec 0105): take the items again
      if (kind === 'fields' && optionsCarried(a.body.options, b.body.options)) await settingsDeps.reloadProject(b.projectId)
      if (kind === 'releases' && a.released && !b.released) await api('PATCH', `${path(b)}/${b.id}`, { released: false })   // Jira's Unrelease
      if (kind === 'releases' && !a.released && b.released) {
        const moveTo = releaseMoveTo(b.id, settingsDeps.baseIssues(), settingsDeps.getIssues(), settingsDeps.isUnfinished)
        await api('POST', `${path(b)}/${b.id}/release`, { moveTo })
        await settingsDeps.reloadProject(b.projectId)          // the server moved work between releases
      }
    },
    remove: async i => { await api('DELETE', `${path(i)}/${i.id}`) },
    // the whole project went away: the project delete removes these, a separate request is not needed
    shouldDelete: i => settingsDeps.getProjects().some(p => p.id === i.projectId),
    recover: () => settingsDeps.reloadAll(),
    onError: m => settingsDeps.onError(m),
  })
}

export const KINDS: Kind[] = ['statuses', 'fields', 'releases', 'components', 'templates', 'rules']
export const kindSyncs = Object.fromEntries(KINDS.map(k => [k, kindSync(k)])) as Record<Kind, ReturnType<typeof kindSync>>

/** A change the server makes to a project's versions or components and to every item that has them (deleting with a
 *  move, merging: spec 0304). After the call, `next` (the project afterwards) becomes what the server has and is shown in
 *  the same step (`show`), so the sync never sees the old list against the new base; then the items are taken again. */
export async function changeOnServer(kind: 'releases' | 'components', call: () => Promise<unknown>, next: Project, show: () => void) {
  await call()
  kindSyncs[kind].load(itemsOf([next], kind), i => i.projectId === next.id)
  show()
  await settingsDeps.reloadProject(next.id)
}

/** Load every kind from a freshly loaded project list, so the server's data is not sent back. */
export function loadSettingsBase(projects: Project[], starredIds: string[]) {
  for (const k of KINDS) kindSyncs[k].load(itemsOf(projects, k))
  projectSync.load(projects.map(projectItem))
  starSync.load(starredIds.map(id => ({ id })))
  forgetDetails(projects)
}

/** A project the server just created (or changed): its settings are the server's, so the syncs must not send them back. */
export function adoptProject(project: Project) {
  for (const k of KINDS) kindSyncs[k].load(itemsOf([project], k), i => i.projectId === project.id)
  projectSync.load([projectItem(project)], i => i.id === project.id)
  forgetDetails([project])
}

// ── Project details (name, colour, lead, board prefs, layout) ──

interface ProjectItem { id: string; key: string; body: Record<string, unknown> }
const projectItem = (p: Project): ProjectItem => ({
  id: p.id, key: p.key,
  body: { name: p.name, description: p.description, color: p.color, leadId: p.leadId || null, boardPrefs: p.boardPrefs, layout: p.layout },
})

/** Details are sent after a short pause (dragging a node in the workflow builder changes the layout many times a second). */
const DEBOUNCE_MS = 600
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const sentBody = new Map<string, Record<string, unknown>>()   // what the server has, per project

export const projectSync = createCollectionSync<ProjectItem>({
  id: p => p.id,
  changed: () => false,                                       // edits go through sendDetails (debounced), not through update
  create: async () => {},                                     // projects are created through the API directly (the create modal)
  update: async () => {},
  remove: async p => {
    clearTimeout(pending.get(p.id)); pending.delete(p.id)
    await api('DELETE', `/api/projects/${encodeURIComponent(p.key)}`)
  },
  recover: () => settingsDeps.reloadAll(),
  onError: m => settingsDeps.onError(m),
})

export function sendDetails(projects: Project[]) {
  for (const p of projects) {
    const item = projectItem(p)
    const known = sentBody.get(p.id)
    if (!known) { sentBody.set(p.id, item.body); continue }   // first sight: assume the server already has it
    if (same(known, item.body)) continue
    clearTimeout(pending.get(p.id))
    pending.set(p.id, setTimeout(() => {
      pending.delete(p.id)
      const latest = settingsDeps.getProjects().find(x => x.id === p.id)
      if (!latest) return
      const body = projectItem(latest).body
      const have = sentBody.get(p.id) ?? {}
      const patch = Object.fromEntries(Object.entries(body).filter(([k, v]) => !same(have[k], v)))
      if (!Object.keys(patch).length) return
      sentBody.set(p.id, body)
      enqueue(async () => {
        try { await api('PATCH', `/api/projects/${encodeURIComponent(latest.key)}`, patch) } catch (e) {
          sentBody.delete(p.id)
          settingsDeps.onError(e instanceof Error ? e.message : 'Could not save your change')
          try { await settingsDeps.reloadAll() } catch { /* offline: the next change retries */ }
        }
      })
    }, DEBOUNCE_MS))
  }
}
export const forgetDetails = (projects: Project[]) => { for (const p of projects) sentBody.set(p.id, projectItem(p).body) }

// ── Stars ──

export const starSync = createCollectionSync<{ id: string }>({
  id: s => s.id,
  changed: () => false,
  create: async s => { await api('PUT', `/api/projects/${keyOf(s.id)}/star`) },
  update: async () => {},
  remove: async s => {
    // an unstarred project that was also deleted needs no request
    if (settingsDeps.getProjects().some(p => p.id === s.id)) await api('DELETE', `/api/projects/${keyOf(s.id)}/star`)
  },
  recover: () => settingsDeps.reloadAll(),
  onError: m => settingsDeps.onError(m),
})
