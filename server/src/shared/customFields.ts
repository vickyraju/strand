// Custom field types, Jira DC's (spec 0502): what each kind is called, what a value of it looks like, and how it reads as
// text. Pure (no database, no React): the server checks values with it and the web app edits and shows them.

export type FieldKind = 'text' | 'textarea' | 'readonly' | 'number' | 'date' | 'datetime' | 'url'
  | 'select' | 'radio' | 'multiselect' | 'checkboxes' | 'cascading' | 'labels'
  | 'user' | 'users' | 'group' | 'groups' | 'project' | 'version' | 'versions'
export type FieldValue = string | number | string[]
export interface Option { id: string; name: string; disabled?: boolean; parentId?: string | null }

/** Every kind, in the order Jira lists them, with Jira's name. */
export const FIELD_KINDS: Record<FieldKind, { jira: string; advanced?: boolean }> = {
  checkboxes: { jira: 'Checkboxes' }, date: { jira: 'Date picker' }, datetime: { jira: 'Date time picker' }, labels: { jira: 'Labels' },
  number: { jira: 'Number field' }, radio: { jira: 'Radio buttons' }, cascading: { jira: 'Select list (cascading)' },
  multiselect: { jira: 'Select list (multiple choices)' }, select: { jira: 'Select list (single choice)' },
  textarea: { jira: 'Text field (multi-line)' }, text: { jira: 'Text field (single line)' }, url: { jira: 'URL field' }, user: { jira: 'User picker (single user)' },
  groups: { jira: 'Group picker (multiple groups)', advanced: true }, group: { jira: 'Group picker (single group)', advanced: true },
  project: { jira: 'Project picker (single project)', advanced: true }, readonly: { jira: 'Text field (read only)', advanced: true },
  users: { jira: 'User picker (multiple users)', advanced: true }, versions: { jira: 'Version picker (multiple versions)', advanced: true },
  version: { jira: 'Version picker (single version)', advanced: true },
}
export const KIND_LIST = Object.keys(FIELD_KINDS) as FieldKind[]
/** Kinds whose values are chosen from the field's options. */
export const OPTION_KINDS: FieldKind[] = ['select', 'radio', 'multiselect', 'checkboxes', 'cascading']
/** Kinds whose value is a list. */
export const MULTI_KINDS: FieldKind[] = ['multiselect', 'checkboxes', 'labels', 'users', 'groups', 'versions', 'cascading']
/** Kinds whose values name something by its id (a person, a group, a project, a version). */
export const REF_KINDS: Partial<Record<FieldKind, 'users' | 'groups' | 'projects' | 'releases'>> = {
  user: 'users', users: 'users', group: 'groups', groups: 'groups', project: 'projects', version: 'releases', versions: 'releases',
}
export const hasOptions = (k: FieldKind) => OPTION_KINDS.includes(k)
export const isMulti = (k: FieldKind) => MULTI_KINDS.includes(k)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Why a value can't be this field's (null: it can). References (people, versions…) are checked to exist by the caller. */
export function valueProblem(f: { name: string; kind: FieldKind; options?: Option[] | null }, v: unknown): string | null {
  const live = (f.options ?? []).filter(o => !o.disabled)
  const choice = (name: unknown, parentId: string | null = null) => typeof name === 'string' && live.some(o => o.name === name && (o.parentId ?? null) === parentId)
  const list = (ok: (x: unknown) => boolean) => Array.isArray(v) && v.length <= 100 && new Set(v).size === v.length && v.every(ok)
  switch (f.kind) {
    case 'text': case 'readonly': return typeof v === 'string' && v.length <= 255 ? null : `${f.name} is text of at most 255 characters`
    case 'textarea': return typeof v === 'string' && v.length <= 32_767 ? null : `${f.name} is text of at most 32,767 characters`
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : `${f.name} must be a number`
    case 'date': return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? null : `${f.name} must be a date (2026-11-11)`
    case 'datetime': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? null : `${f.name} must be a date and time`
    case 'url': { try { const u = new URL(String(v)); return typeof v === 'string' && v.length <= 2000 && (u.protocol === 'http:' || u.protocol === 'https:') ? null : `${f.name} must be an http or https address` } catch { return `${f.name} must be an http or https address` } }
    case 'select': case 'radio': return choice(v) ? null : `${f.name} must be one of: ${live.filter(o => !o.parentId).map(o => o.name).join(', ')}`
    case 'multiselect': case 'checkboxes': return list(x => choice(x)) ? null : `${f.name} must be some of: ${live.filter(o => !o.parentId).map(o => o.name).join(', ')}`
    case 'cascading': {
      if (!Array.isArray(v) || v.length < 1 || v.length > 2 || !choice(v[0])) return `${f.name} must be one of: ${live.filter(o => !o.parentId).map(o => o.name).join(', ')}, then optionally one of its options`
      const parent = live.find(o => o.name === v[0] && !o.parentId)!
      return v.length === 1 || choice(v[1], parent.id) ? null : `${String(v[1])} isn’t an option under ${String(v[0])}`
    }
    case 'labels': return list(x => typeof x === 'string' && /^\S{1,255}$/.test(x)) ? null : `${f.name} is words without spaces`
    case 'user': case 'group': case 'project': case 'version': return typeof v === 'string' && UUID.test(v) ? null : `${f.name} must name one by its id`
    case 'users': case 'groups': case 'versions': return list(x => typeof x === 'string' && UUID.test(x)) ? null : `${f.name} must name them by their ids`
  }
}

/** A value as people read it, given names for the ids it holds. */
export function valueText(kind: FieldKind, v: FieldValue | undefined | null, nameOf: (id: string) => string | undefined = () => undefined): string {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return ''
  if (kind === 'cascading' && Array.isArray(v)) return v.join(' › ')
  if (REF_KINDS[kind]) return (Array.isArray(v) ? v : [v]).map(x => nameOf(String(x)) ?? String(x)).join(', ')
  if (Array.isArray(v)) return v.join(', ')
  if (kind === 'number') return Number(v).toLocaleString()
  return String(v)
}
