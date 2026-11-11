// Global custom fields and their contexts (spec 0503), as Jira's: a field belongs to the workspace; each context says where
// it applies (projects, or global) and for which work types, with its own options and default value. A project is in at
// most one context of a field; its own context wins over the global one. The view field_defs lists, per project, the fields
// that apply there; this module changes fields and contexts and keeps items' values in step.
import { randomUUID } from 'node:crypto'
import type { Db } from './db.ts'
import { HttpError } from './auth.ts'
import { publish } from './events.ts'
import { valueProblem, hasOptions, type FieldKind, type FieldValue, type Option } from './shared/customFields.ts'
import { SYSTEM_FIELDS, isEmpty, valueOf, type FieldRules } from './shared/fieldRules.ts'

export type Opt = { id?: string; name: string; disabled?: boolean; parentId?: string | null }

/** Options with ids (a new one gets one), names unique ignoring case under the same parent (spec 0105 R2, R6); a cascading
 *  field's child options name an option of the field as their parent (spec 0502 R2). */
export function withOptionIds(options: Opt[], kind?: string) {
  const seen = new Set<string>()
  const out = options.map(o => {
    const key = `${o.parentId ?? ''}|${o.name.trim().toLowerCase()}`
    if (seen.has(key)) throw new HttpError(400, `“${o.name.trim()}” is an option twice`, { options: 'Each option once' })
    seen.add(key)
    return { id: o.id ?? randomUUID(), name: o.name.trim(), disabled: !!o.disabled, ...(o.parentId ? { parentId: o.parentId } : {}) }
  })
  for (const o of out) if (o.parentId && (kind !== 'cascading' || !out.some(p => p.id === o.parentId && !p.parentId)))
    throw new HttpError(400, 'Only a cascading field’s options have child options, under one of its options', { options: 'Child options belong under an option' })
  return out
}

/** The projects a context's options reach: those whose field resolves to this context. */
const projectsOf = (d: Db, contextId: string) => d.query<{ projectId: string }>('select project_id from field_defs where context_id = $1', [contextId]).then(r => r.map(x => x.projectId))

/** Items take an option's new name, and lose an option that was deleted, single and multiple values and cascading pairs
 *  alike, in every project the context covers (renames may swap names: every value is worked out from the names before). */
export async function carryOptions(d: Db, contextId: string, fieldId: string, kind: string, before: Opt[], after: Opt[]) {
  const next = new Map(after.map(o => [o.id, o.name]))
  if (before.every(o => next.get(o.id) === o.name)) return
  const renamed = (name: unknown, parentId: string | null): string | null => {
    const o = before.find(x => x.name === name && (x.parentId ?? null) === parentId)
    return o ? next.get(o.id) ?? null : String(name)
  }
  const projects = await projectsOf(d, contextId)
  const rows = await d.query<{ id: string; projectId: string; v: any }>(
    'select id, project_id, custom -> $2 as v from issues where project_id = any($1::uuid[]) and custom ? $2', [projects, fieldId])
  const ids: string[] = [], values: string[] = [], touched = new Set<string>()
  for (const r of rows) {
    let nv: unknown
    if (kind === 'cascading' && Array.isArray(r.v)) {
      const p = renamed(r.v[0], null)
      const parent = before.find(x => x.name === r.v[0] && !x.parentId)
      const c = r.v[1] === undefined ? undefined : parent ? renamed(r.v[1], parent.id!) : null
      nv = p === null ? null : c ? [p, c] : [p]
    } else if (Array.isArray(r.v)) { const l = r.v.map((x: unknown) => renamed(x, null)).filter((x: unknown) => x !== null); nv = l.length ? l : null }
    else nv = renamed(r.v, null)
    if (JSON.stringify(nv) !== JSON.stringify(r.v)) { ids.push(r.id); values.push(JSON.stringify(nv)); touched.add(r.projectId) }
  }
  if (!ids.length) return
  await d.query(
    `update issues i set custom = case when x.v = 'null'::jsonb then i.custom - $1 else jsonb_set(i.custom, array[$1], x.v) end, version = version + 1, updated_at = now()
       from (select unnest($2::uuid[]) as id, unnest($3::jsonb[]) as v) x where i.id = x.id`, [fieldId, ids, values])
  for (const p of touched) await publish(d, p, { type: 'issues.reranked' })          // open boards and lists load them again
}

/** Removes a field's values from the items of these projects (a deleted context or field, spec 0503 R6). */
export async function clearValues(d: Db, fieldId: string, projectIds: string[]) {
  const gone = await d.query<{ projectId: string }>(
    `update issues set custom = custom - $1, version = version + 1, updated_at = now() where project_id = any($2::uuid[]) and custom ? $1 returning project_id`, [fieldId, projectIds])
  for (const p of new Set(gone.map(g => g.projectId))) await publish(d, p, { type: 'issues.reranked' })
  return gone.length
}

/** After projects change context (one deleted, or taken from another), values the context now covering them doesn't
 *  have as options are removed (spec 0503 R6): a project's values always fit its field's options. */
export async function fitOptions(d: Db, fieldId: string, kind: string, projectIds: string[]) {
  if (!hasOptions(kind as FieldKind) || !projectIds.length) return
  const defs = await d.query<{ projectId: string; options: Opt[] | null }>('select project_id, options from field_defs where id = $1 and project_id = any($2::uuid[])', [fieldId, projectIds])
  const ids: string[] = [], values: string[] = [], touched = new Set<string>()
  for (const def of defs) {
    const opts = def.options ?? []
    const has = (name: unknown, parentId: string | null) => opts.some(o => o.name === name && (o.parentId ?? null) === parentId)
    const rows = await d.query<{ id: string; v: any }>('select id, custom -> $2 as v from issues where project_id = $1 and custom ? $2', [def.projectId, fieldId])
    for (const r of rows) {
      let nv: unknown
      if (kind === 'cascading' && Array.isArray(r.v)) {
        const parent = opts.find(o => o.name === r.v[0] && !o.parentId)
        nv = !parent ? null : r.v[1] !== undefined && has(r.v[1], parent.id!) ? r.v : [r.v[0]]
      } else if (Array.isArray(r.v)) { const l = r.v.filter((x: unknown) => has(x, null)); nv = l.length ? l : null }
      else nv = has(r.v, null) ? r.v : null
      if (JSON.stringify(nv) !== JSON.stringify(r.v)) { ids.push(r.id); values.push(JSON.stringify(nv)); touched.add(def.projectId) }
    }
  }
  if (!ids.length) return
  await d.query(
    `update issues i set custom = case when x.v = 'null'::jsonb then i.custom - $1 else jsonb_set(i.custom, array[$1], x.v) end, version = version + 1, updated_at = now()
       from (select unnest($2::uuid[]) as id, unnest($3::jsonb[]) as v) x where i.id = x.id`, [fieldId, ids, values])
  for (const p of touched) await publish(d, p, { type: 'issues.reranked' })
}

/** A context's settings checked: projects (by id) not already in another context of the field, one global context, work
 *  types, options and the default value. */
export async function checkContext(d: Db, field: { id: string; kind: FieldKind; name: string }, c: { projectIds: string[] | null; typeKeys: string[] | null; options?: Opt[] | null; defaultValue?: FieldValue | null }, except?: string) {
  if (c.projectIds === null) {
    const [g] = await d.query<{ name: string }>('select name from field_contexts where field_id = $1 and project_ids is null and id is distinct from $2', [field.id, except ?? null])
    if (g) throw new HttpError(400, `${field.name} already has a global context: ${g.name}`, { projects: 'One global context per field' })
  } else {
    if (!c.projectIds.length) throw new HttpError(400, 'Choose the projects, or make it global', { projects: 'No projects' })
    const [clash] = await d.query<{ name: string; key: string }>(
      `select c.name, p.key from field_contexts c join projects p on p.id = any(c.project_ids) where c.field_id = $1 and c.id is distinct from $2 and p.id = any($3::uuid[]) limit 1`,
      [field.id, except ?? null, c.projectIds])
    if (clash) throw new HttpError(400, `${clash.key} is already in the context ${clash.name}: a project is in one context of a field`, { projects: `${clash.key} is in ${clash.name}` })
  }
  if (c.options?.length && !hasOptions(field.kind)) throw new HttpError(400, `A ${field.kind} field has no options`, { options: 'No options for this type' })
  if (c.defaultValue != null) {
    const problem = valueProblem({ name: field.name, kind: field.kind, options: (c.options ?? []) as Option[] }, c.defaultValue)
    if (problem) throw new HttpError(400, `Default value: ${problem}`, { defaultValue: problem })
  }
}

/** Defaults of the fields that apply to a new item of this type, for those it has no value for (spec 0503 R3). */
export async function defaultsFor(d: Db, projectId: string, type: string, given: Record<string, FieldValue> = {}) {
  const rows = await d.query<{ id: string; defaultValue: FieldValue }>(
    `select id, default_value from field_defs where project_id = $1 and default_value is not null and (type_keys is null or $2 = any(type_keys))`, [projectId, type])
  return Object.fromEntries(rows.filter(r => !(r.id in given)).map(r => [r.id, r.defaultValue]))
}

// ── Field configurations (spec 0504) ──

/** The workspace's Default Field Configuration (made when first needed, as every workspace has one). */
export async function defaultConfigId(d: Db, ws: string) {
  const [c] = await d.query<{ id: string }>('select id from field_configurations where workspace_id = $1 and is_default', [ws])
  if (c) return c.id
  const [n] = await d.query<{ id: string }>(
    `insert into field_configurations (workspace_id, name, description, is_default) values ($1, 'Default Field Configuration', 'Used by every project without a field configuration scheme', true)
     on conflict (workspace_id) where is_default do update set name = excluded.name returning id`, [ws])
  return n!.id
}

/** Each work type's field rules in a project: its scheme's configuration for the type, else the scheme's default, else the Default Field Configuration. */
export async function rulesFor(d: Db, projectId: string): Promise<Record<string, FieldRules>> {
  const [p] = await d.query<{ workspaceId: string; schemeId: string | null }>('select workspace_id, field_config_scheme_id as scheme_id from projects where id = $1', [projectId])
  if (!p) return {}
  const types = (await d.query<{ key: string }>('select key from work_types where project_id = $1', [projectId])).map(t => t.key)
  const def = await defaultConfigId(d, p.workspaceId)
  const [s] = p.schemeId ? await d.query<{ defaultConfigId: string; mappings: Record<string, string> }>('select default_config_id, mappings from field_config_schemes where id = $1', [p.schemeId]) : []
  const configOf = (t: string) => s?.mappings?.[t] ?? s?.defaultConfigId ?? def
  const ids = [...new Set(types.map(configOf))]
  const items = new Map((await d.query<{ id: string; items: FieldRules }>('select id, items from field_configurations where id = any($1::uuid[])', [ids])).map(c => [c.id, c.items]))
  return Object.fromEntries(types.map(t => [t, items.get(configOf(t)) ?? {}]))
}

/** Hidden fields set, or required fields left empty, by an item's values (spec 0504 R4). `keys`: the fields being set
 *  (null: creating, every required field must have a value). Throws a 400 naming each field. */
export async function enforceRules(d: Db, projectId: string, type: string, item: Record<string, any>, keys: string[] | null) {
  const rules = (await rulesFor(d, projectId))[type] ?? {}
  if (!Object.keys(rules).length) return
  const defs = await d.query<{ id: string; name: string; kind: string; options: Opt[] | null }>('select id, name, kind, options from field_defs where project_id = $1', [projectId])
  const nameOf = (k: string) => (k.startsWith('custom.') ? defs.find(f => f.id === k.slice(7))?.name ?? 'A custom field' : SYSTEM_FIELDS[k] ?? k)
  const needsChild = (k: string, v: unknown) => {
    const f = k.startsWith('custom.') ? defs.find(x => x.id === k.slice(7)) : undefined
    if (f?.kind !== 'cascading' || !Array.isArray(v) || !v.length) return false
    const parent = (f.options ?? []).find(o => o.name === v[0] && !o.parentId)
    return !!parent && (f.options ?? []).some(o => o.parentId === parent.id && !o.disabled)
  }
  const errors: Record<string, string> = {}
  for (const [k, r] of Object.entries(rules)) {
    const touched = keys === null || keys.includes(k)
    if (!touched) continue
    const v = valueOf(item, k)
    if (r.hidden && !isEmpty(v)) errors[k] = `${nameOf(k)} isn’t shown in this project for this work type`
    else if (r.required && !r.hidden && isEmpty(v, needsChild(k, v))) errors[k] = `${nameOf(k)} is required`
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors).join('; '), errors)
}
