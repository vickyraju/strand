// Converts API payloads (camelCased rows, ISO dates, nullable columns) into the app's own types
// (epoch-millisecond numbers, optional fields). Pure: no React, no fetch, so it is unit-tested.
import {
  DEFAULT_BOARD_PREFS, type Project, type Sprint, type State, type User,
  type Status, type Transition, type Rule, type FieldDef, type Release, type ItemTemplate,
} from '../data/reducer.ts'

type Row = Record<string, any>

const ms = (iso: unknown): number | undefined => (iso ? new Date(String(iso)).getTime() : undefined)

export const mapUser = (u: Row): User => ({
  id: u.id, name: u.name, initials: u.initials, color: u.color, ...(u.title ? { title: u.title } : {}),
})

const mapStatus = (s: Row): Status => ({ id: s.id, name: s.name, color: s.color, category: s.category, ...(s.wipLimit ? { wipLimit: s.wipLimit } : {}) })
const mapTransition = (t: Row): Transition => ({ id: t.id, name: t.name, from: t.fromIds ?? 'any', to: t.toId })
const mapRule = (r: Row): Rule => ({ id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger, actions: r.actions, runs: r.runs ?? 0 })
const mapField = (f: Row): FieldDef => ({ id: f.id, name: f.name, kind: f.kind, ...(f.options ? { options: f.options } : {}) })
const mapRelease = (r: Row): Release => ({
  id: r.id, name: r.name, description: r.description ?? '', released: !!r.released,
  ...(r.startDate ? { startDate: r.startDate } : {}), ...(r.releaseDate ? { releaseDate: r.releaseDate } : {}),
  ...(r.releasedAt ? { releasedAt: ms(r.releasedAt) } : {}),
})
const mapTemplate = (t: Row): ItemTemplate => ({
  id: t.id, name: t.name, type: t.type, title: t.title, description: t.description ?? '', priority: t.priority,
  labels: t.labels ?? [], ...(t.estimate != null ? { estimate: t.estimate } : {}),
})

export const mapSprint = (s: Row): Sprint => ({
  id: s.id, projectId: s.projectId, name: s.name, goal: s.goal ?? '', state: s.state,
  startedAt: ms(s.startedAt), endsAt: ms(s.endsAt), completedAt: ms(s.completedAt),
  ...(s.committed != null ? { committed: s.committed } : {}), ...(s.completed != null ? { completed: s.completed } : {}),
  ...(s.issueIds ? { issueIds: s.issueIds } : {}),
})

/** `GET /api/projects/:key` → Project. Server-side `{}` board prefs fall back to the app defaults. */
export function mapProject(p: Row): Project {
  const prefs = p.boardPrefs ?? {}
  return {
    id: p.id, key: p.key, name: p.name, description: p.description ?? '', color: p.color, template: p.template,
    leadId: p.leadId ?? '',
    statuses: (p.statuses ?? []).map(mapStatus),
    transitions: (p.transitions ?? []).map(mapTransition),
    layout: p.layout ?? {},
    boardPrefs: { ...DEFAULT_BOARD_PREFS, ...prefs, fields: { ...DEFAULT_BOARD_PREFS.fields, ...(prefs.fields ?? {}) } },
    nextNumber: p.nextNumber ?? 1,
    createdAt: ms(p.createdAt) ?? Date.now(),
    rules: (p.rules ?? []).map(mapRule),
    fields: (p.fields ?? []).map(mapField),
    releases: (p.releases ?? []).map(mapRelease),
    templates: (p.templates ?? []).map(mapTemplate),
    ...(p.sample ? { sample: true } : {}),
  }
}

/** Everything slice 2 loads: who you are, the people, and the projects with their sprints. */
export function mapWorkspace(me: Row, users: Row[], projects: Row[], starredIds: string[]): State {
  return {
    version: 4, workspaceName: 'Strand',
    ownerId: me.id, actingAsId: null,
    users: users.map(mapUser),
    projects: projects.map(mapProject),
    sprints: projects.flatMap(p => (p.sprints ?? []).map(mapSprint)),
    issues: [], comments: [], activity: [], notifications: [],
    starred: starredIds, viewed: [], sampleIds: [], views: [], dashboards: [],
  }
}
