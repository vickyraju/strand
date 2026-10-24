import { useEffect, useState } from 'react'
import { Trash2, FolderPlus } from 'lucide-react'
import { useStore, type FieldDef, type Status } from '../../data/store'
import {
  LIMITS, RULE_FIELDS, SETTABLE, DATE_FIELDS, isGroup,
  type Action, type Condition, type ConditionGroup, type TransitionRules, type Validator,
} from '../../data/transitionRules'
import { api, apiEnabled } from '../../api/client'
import { UserSelect } from '../UserPicker'

// The Rules tab of a transition, in Jira's order: Restrict transition (who and when, in groups that must all or can any
// be met), Validate details (checked when the move is made), Ask for input (the transition screen), Perform actions
// (changes made by the move). Every rule reads as a sentence, so the list says what the transition does.

interface Props {
  rules: TransitionRules; onChange: (r: TransitionRules) => void
  statuses: Status[]; fields: FieldDef[]; projectKey: string
}
type Group = { id: string; name: string }

const ROLE = { admin: 'Project admins', member: 'Members' } as const
const WHO = { assignee: 'the assignee', reporter: 'the reporter', lead: 'the project lead' } as const
const OPS = { empty: 'is empty', notEmpty: 'has a value', is: 'is', isNot: 'is not' } as const

export default function RulesEditor({ rules, onChange, statuses, fields, projectKey }: Props) {
  const [groups, setGroups] = useState<Group[]>([])
  useEffect(() => { if (apiEnabled) api<Group[]>('GET', '/api/groups/search').then(setGroups, () => {}) }, [])
  const fieldList = [...Object.entries(RULE_FIELDS).map(([k, v]) => ({ key: k, name: v })), ...fields.map(f => ({ key: `custom.${f.id}`, name: f.name }))]
  const fieldName = (k: string) => (k === 'comment' ? 'Comment' : fieldList.find(f => f.key === k)?.name ?? 'A field that was removed')
  const statusName = (id: string) => statuses.find(s => s.id === id)?.name ?? 'a removed status'
  const ctx = { groups, fieldList, fieldName, statusName, statuses, projectKey }
  const set = (patch: Partial<TransitionRules>) => onChange(clean({ ...rules, ...patch }))

  const restrict = rules.restrict ?? { op: 'all' as const, items: [] }
  return (
    <div className="rules">
      <section aria-label="Restrict transition">
        <h3 className="subhead">Restrict transition</h3>
        <p className="hint">Who can use it, and when. People it isn’t for don’t see it.</p>
        <GroupEditor group={restrict} depth={1} onChange={g => set({ restrict: g })} ctx={ctx} />
      </section>

      <section aria-label="Validate details">
        <h3 className="subhead">Validate details</h3>
        <p className="hint">Checked when someone makes the move. If one isn’t met, the move is refused and they are told why.</p>
        <List items={rules.validate ?? []} limit={LIMITS.validators} onChange={validate => set({ validate })}
          add={validators(statuses)}
          render={(v, put) => <ValidatorRow v={v} put={put} ctx={ctx} />} />
      </section>

      <section aria-label="Ask for input">
        <h3 className="subhead">Ask for input</h3>
        <p className="hint">Fields shown while moving, so people can fill them in on the way.</p>
        <MultiSelect label="Fields on the transition screen" all={[{ key: 'comment', name: 'Comment' }, ...fieldList.filter(f => f.key !== 'type')]}
          value={rules.screen ?? []} onChange={screen => set({ screen })} />
      </section>

      <section aria-label="Perform actions">
        <h3 className="subhead">Perform actions</h3>
        <p className="hint">Changes made as part of the move, recorded in the item’s history as done by this transition.</p>
        <List items={rules.actions ?? []} limit={LIMITS.actions} onChange={actions => set({ actions })}
          add={ACTIONS}
          render={(a, put) => <ActionRow a={a} put={put} ctx={ctx} />} />
      </section>
    </div>
  )
}

/** Drops empty parts, so a transition with no rules saves as `{}`. */
function clean(r: TransitionRules): TransitionRules {
  const out: TransitionRules = {}
  if (r.restrict?.items.length) out.restrict = r.restrict
  if (r.validate?.length) out.validate = r.validate
  if (r.screen?.length) out.screen = r.screen
  if (r.actions?.length) out.actions = r.actions
  return out
}

type Ctx = { groups: Group[]; fieldList: { key: string; name: string }[]; fieldName: (k: string) => string; statusName: (id: string) => string; statuses: Status[]; projectKey: string }

/** A list of rules with an "Add" menu; each row edits one rule and can be removed. */
function List<T>({ items, limit, onChange, add, render }: {
  items: T[]; limit: number; onChange: (items: T[]) => void; add: [string, T][]; render: (item: T, put: (next: T) => void) => React.ReactNode
}) {
  return (
    <>
      {items.map((it, i) => (
        <div key={i} className="rule-row">
          <div className="rule-body">{render(it, next => onChange(items.map((x, k) => (k === i ? next : x))))}</div>
          <button className="icon-btn sm" aria-label="Remove rule" title="Remove rule" onClick={() => onChange(items.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
        </div>
      ))}
      {items.length < limit && <AddMenu options={add} onAdd={v => onChange([...items, v])} />}
    </>
  )
}

function AddMenu<T>({ options, onAdd, label = 'Add rule' }: { options: [string, T][]; onAdd: (v: T) => void; label?: string }) {
  return (
    <select className="input rule-add" aria-label={label} value="" onChange={e => { const o = options[Number(e.target.value)]; if (o) onAdd(structuredClone(o[1])) }}>
      <option value="">+ {label}…</option>
      {options.map(([l], i) => <option key={l} value={i}>{l}</option>)}
    </select>
  )
}

const validators = (statuses: Status[]): [string, Validator][] => [
  ['Fields are required', { kind: 'required', fields: ['assigneeId'] }],
  ['A field is changed in the move', { kind: 'changed', field: 'assigneeId' }],
  ['The parent is in a status', { kind: 'parentStatus', statusIds: statuses[0] ? [statuses[0].id] : [] }],
]
const ACTIONS: [string, Action][] = [
  ['Assign', { kind: 'assign', to: 'mover' }],
  ['Set or clear a field', { kind: 'set', field: 'priority', value: 'high' }],
  ['Copy a field from the parent', { kind: 'copyFromParent', field: 'releaseId' }],
  ['Add a comment', { kind: 'comment', body: '' }],
]
const CONDITIONS: [string, Condition][] = [
  ['Only a certain person (assignee, reporter, lead)', { kind: 'person', who: 'assignee' }],
  ['Only these people', { kind: 'users', userIds: [] }],
  ['Only a project role', { kind: 'role', roles: ['admin'] }],
  ['Only a group', { kind: 'group', groupIds: [] }],
  ['When a field has a value', { kind: 'field', field: 'priority', op: 'is', value: 'high' }],
  ['When all child items are done', { kind: 'childrenDone' }],
  ['Hide from everyone (automation only)', { kind: 'hidden' }],
]

/** A Restrict group: its rules and nested groups must all be met ("Must be all") or any one ("Can be any"). */
function GroupEditor({ group, depth, onChange, ctx }: { group: ConditionGroup; depth: number; onChange: (g: ConditionGroup) => void; ctx: Ctx }) {
  const put = (i: number, x: Condition | ConditionGroup) => onChange({ ...group, items: group.items.map((y, k) => (k === i ? x : y)) })
  const drop = (i: number) => onChange({ ...group, items: group.items.filter((_, k) => k !== i) })
  return (
    <div className={`rule-group${depth > 1 ? ' nested' : ''}`}>
      {group.items.length > 1 && (
        <div className="segmented sm" role="radiogroup" aria-label="How the rules combine">
          <button type="button" role="radio" aria-checked={group.op === 'all'} className={group.op === 'all' ? 'on' : ''} onClick={() => onChange({ ...group, op: 'all' })}>Must be all</button>
          <button type="button" role="radio" aria-checked={group.op === 'any'} className={group.op === 'any' ? 'on' : ''} onClick={() => onChange({ ...group, op: 'any' })}>Can be any</button>
        </div>
      )}
      {group.items.length === 0 && depth === 1 && <p className="muted sm">No restriction: everyone who can edit the item can use it.</p>}
      {group.items.map((x, i) => (
        <div key={i}>
          {i > 0 && <div className="rule-join">{group.op === 'all' ? 'and' : 'or'}</div>}
          {isGroup(x)
            ? <div className="rule-row"><div className="rule-body"><GroupEditor group={x} depth={depth + 1} onChange={g => put(i, g)} ctx={ctx} /></div>
                <button className="icon-btn sm" aria-label="Remove group" title="Remove group" onClick={() => drop(i)}><Trash2 size={14} /></button></div>
            : <div className="rule-row"><div className="rule-body"><ConditionRow c={x} put={c => put(i, c)} ctx={ctx} /></div>
                <button className="icon-btn sm" aria-label="Remove rule" title="Remove rule" onClick={() => drop(i)}><Trash2 size={14} /></button></div>}
        </div>
      ))}
      {group.items.length < LIMITS.rulesPerGroup && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          <AddMenu options={CONDITIONS} onAdd={c => onChange({ ...group, items: [...group.items, c] })} />
          {depth < LIMITS.depth && (
            <button className="btn btn-ghost btn-sm" onClick={() => onChange({ ...group, items: [...group.items, { op: group.op === 'all' ? 'any' : 'all', items: [] }] })}>
              <FolderPlus size={14} />Add group
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ConditionRow({ c, put, ctx }: { c: Condition; put: (c: Condition) => void; ctx: Ctx }) {
  switch (c.kind) {
    case 'person': return <span className="rule-line">Only
      <select className="input input-sm" aria-label="Who" value={c.who} onChange={e => put({ ...c, who: e.target.value as typeof c.who })}>
        {Object.entries(WHO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>can use it</span>
    case 'users': return <PeopleRule ids={c.userIds} onChange={userIds => put({ ...c, userIds })} ctx={ctx} />
    case 'role': return <span className="rule-line">Only
      {(['admin', 'member'] as const).map(r => (
        <label key={r} className="check-row inline"><input type="checkbox" checked={c.roles.includes(r)} onChange={e => put({ ...c, roles: e.target.checked ? [...c.roles, r] : c.roles.filter(x => x !== r) })} />{ROLE[r]}</label>
      ))}can use it</span>
    case 'group': return ctx.groups.length
      ? <span className="rule-line">Only people in
          <MultiSelect label="Groups" all={ctx.groups.map(g => ({ key: g.id, name: g.name }))} value={c.groupIds} onChange={groupIds => put({ ...c, groupIds })} />
        </span>
      : <span className="rule-line muted">Only people in a group (no groups are set up: they come from your directory)</span>
    case 'field': return <span className="rule-line">When
      <FieldSelect value={c.field} fields={ctx.fieldList} onChange={field => put({ ...c, field })} />
      <select className="input input-sm" aria-label="Condition" value={c.op} onChange={e => put({ ...c, op: e.target.value as typeof c.op })}>
        {Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      {(c.op === 'is' || c.op === 'isNot') && <input className="input input-sm" aria-label="Value" value={c.value ?? ''} onChange={e => put({ ...c, value: e.target.value })} />}
    </span>
    case 'childrenDone': return <span className="rule-line">When all its child items are done</span>
    case 'hidden': return <span className="rule-line">Hidden from everyone: only automation can use it</span>
  }
}

function ValidatorRow({ v, put, ctx }: { v: Validator; put: (v: Validator) => void; ctx: Ctx }) {
  switch (v.kind) {
    case 'required': return <span className="rule-line">Required:
      <MultiSelect label="Required fields" all={[{ key: 'comment', name: 'Comment' }, ...ctx.fieldList]} value={v.fields} onChange={fields => put({ ...v, fields })} />
    </span>
    case 'changed': return <span className="rule-line">
      <FieldSelect value={v.field} fields={ctx.fieldList} onChange={field => put({ ...v, field })} />must be changed in the move</span>
    case 'parentStatus': return <span className="rule-line">The parent item must be in
      <MultiSelect label="Parent statuses" all={ctx.statuses.map(s => ({ key: s.id, name: s.name }))} value={v.statusIds} onChange={statusIds => put({ ...v, statusIds })} />
    </span>
  }
}

function ActionRow({ a, put, ctx }: { a: Action; put: (a: Action) => void; ctx: Ctx }) {
  switch (a.kind) {
    case 'assign': return <span className="rule-line">Assign to
      <select className="input input-sm" aria-label="Assign to" value={a.to} onChange={e => put({ kind: 'assign', to: e.target.value as typeof a.to })}>
        <option value="mover">the person moving it</option><option value="reporter">the reporter</option><option value="lead">the project lead</option>
        <option value="none">nobody (unassign)</option><option value="user">someone…</option>
      </select>
      {a.to === 'user' && <UserSelect label="Person" projectId={ctx.projectKey} value={a.userId} onChange={userId => put({ ...a, userId })} />}
    </span>
    case 'set': {
      const settable = ctx.fieldList.filter(f => SETTABLE.includes(f.key) || f.key.startsWith('custom.'))
      return <span className="rule-line">Set
        <FieldSelect value={a.field} fields={settable} onChange={field => put({ ...a, field })} />to
        <input className="input input-sm" aria-label="Value" placeholder={DATE_FIELDS.includes(a.field) ? 'today, or YYYY-MM-DD' : 'empty: clear it'} value={a.value ?? ''}
          onChange={e => put({ ...a, value: e.target.value === '' ? null : e.target.value })} />
      </span>
    }
    case 'copyFromParent': return <span className="rule-line">Copy
      <FieldSelect value={a.field} fields={ctx.fieldList} onChange={field => put({ ...a, field })} />from the parent item</span>
    case 'comment': return <span className="rule-line" style={{ flex: 1 }}>Comment
      <input className="input input-sm" style={{ flex: 1 }} aria-label="Comment" value={a.body} placeholder="What to write" onChange={e => put({ ...a, body: e.target.value })} />
    </span>
  }
}

function FieldSelect({ value, fields, onChange }: { value: string; fields: { key: string; name: string }[]; onChange: (f: string) => void }) {
  return (
    <select className="input input-sm" aria-label="Field" value={value} onChange={e => onChange(e.target.value)}>
      {fields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
    </select>
  )
}

/** Picks several from a short list, as chips with an add menu. */
function MultiSelect({ label, all, value, onChange }: { label: string; all: { key: string; name: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const rest = all.filter(a => !value.includes(a.key))
  return (
    <span className="rule-chips">
      {value.map(k => (
        <span key={k} className="chip-static">{all.find(a => a.key === k)?.name ?? 'Removed'}
          <button className="chip-x" aria-label={`Remove ${all.find(a => a.key === k)?.name ?? 'item'}`} onClick={() => onChange(value.filter(x => x !== k))}>×</button>
        </span>
      ))}
      {rest.length > 0 && (
        <select className="input input-sm" aria-label={`Add to ${label.toLowerCase()}`} value="" onChange={e => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{value.length ? '+ Add' : 'Choose…'}</option>
          {rest.map(a => <option key={a.key} value={a.key}>{a.name}</option>)}
        </select>
      )}
    </span>
  )
}

function PeopleRule({ ids, onChange, ctx }: { ids: string[]; onChange: (ids: string[]) => void; ctx: Ctx }) {
  return (
    <span className="rule-line">Only
      {ids.map(id => <span key={id} className="chip-static"><UserName id={id} /><button className="chip-x" aria-label="Remove person" onClick={() => onChange(ids.filter(x => x !== id))}>×</button></span>)}
      <UserSelect label="Add a person" projectId={ctx.projectKey} value={undefined} placeholder="+ Add a person" onChange={id => id && !ids.includes(id) && onChange([...ids, id])} />
      can use it
    </span>
  )
}

function UserName({ id }: { id: string }) {
  const { state } = useStore()
  return <>{state.users.find(u => u.id === id)?.name ?? 'Someone'}</>
}

/** One line describing a transition's rules, for lists ("Only the assignee · 2 checks · 1 action"). */
export function rulesSummary(r: TransitionRules | undefined): string {
  if (!r) return ''
  const parts: string[] = []
  const n = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${count} ${many}`)
  const restrict = r.restrict ? countConditions(r.restrict) : 0
  if (restrict) parts.push(n(restrict, 'restriction', 'restrictions'))
  if (r.validate?.length) parts.push(n(r.validate.length, 'check', 'checks'))
  if (r.screen?.length) parts.push(n(r.screen.length, 'field to fill in', 'fields to fill in'))
  if (r.actions?.length) parts.push(n(r.actions.length, 'action', 'actions'))
  return parts.join(' · ')
}
const countConditions = (g: ConditionGroup): number => g.items.reduce((s, x) => s + (isGroup(x) ? countConditions(x) : 1), 0)

