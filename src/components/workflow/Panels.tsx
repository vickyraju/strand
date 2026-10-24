import { useState } from 'react'
import { MousePointerClick, Trash2 } from 'lucide-react'
import type { Category, FieldDef, Status, Transition, WorkType } from '../../data/store'
import RulesEditor, { rulesSummary } from './RulesEditor'
import { hasGlobal, type Workflow } from '../../data/workflow'
import { Checkbox, Toggle, plural } from '../ui'

const CATS: { id: Category; label: string }[] = [{ id: 'todo', label: 'To do' }, { id: 'in-progress', label: 'In progress' }, { id: 'done', label: 'Done' }]

/** `key` names the kind of edit, so a burst of typing or colour picking is one undo step. */
export type Change<T> = (patch: Partial<T>, key?: string) => void

export function StatusPanel({ status, workflow, count, onChange, onGlobal, onSetStart, onDelete }: {
  status: Status; workflow: Workflow; count: number
  onChange: Change<Status>; onGlobal: (on: boolean) => void; onSetStart: () => void; onDelete: () => void
}) {
  const isStart = workflow.statuses[0]?.id === status.id
  return (
    <>
      <div className="wf-panel-kind">Status</div>
      <label className="label" htmlFor="wf-name">Name</label>
      <input id="wf-name" className="input" value={status.name} onChange={e => onChange({ name: e.target.value }, `name:${status.id}`)} />
      <label className="label" htmlFor="wf-desc" style={{ marginTop: 12 }}>Description</label>
      <textarea id="wf-desc" className="input" rows={3} maxLength={500} value={status.description ?? ''} placeholder="What this status means, for example “Waiting for the customer to reply”"
        onChange={e => onChange({ description: e.target.value || undefined }, `desc:${status.id}`)} />
      <label className="label" style={{ marginTop: 12 }}>Category</label>
      <div className="segmented full" role="radiogroup" aria-label="Category">
        {CATS.map(c => (
          <button key={c.id} role="radio" aria-checked={status.category === c.id} className={status.category === c.id ? 'on' : ''} onClick={() => onChange({ category: c.id })}>{c.label}</button>
        ))}
      </div>
      <p className="hint">Categories drive reports and decide when work counts as finished.</p>
      <div className="form-row" style={{ marginTop: 12 }}>
        <div>
          <label className="label" htmlFor="wf-color">Color</label>
          <input id="wf-color" type="color" className="color-input" value={status.color} onChange={e => onChange({ color: e.target.value }, `color:${status.id}`)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="wf-wip">WIP limit</label>
          <input id="wf-wip" className="input" type="number" min={1} placeholder="No limit" value={status.wipLimit ?? ''}
            onChange={e => onChange({ wipLimit: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) }, `wip:${status.id}`)} />
        </div>
      </div>
      <label className="toggle-row" style={{ marginTop: 14 }}>
        <span>Allow all statuses to move here</span>
        <Toggle on={hasGlobal(workflow, status.id)} label="Allow all statuses to move here" onChange={onGlobal} />
      </label>
      <div className="toggle-row" style={{ marginTop: 6 }}>
        <span>{isStart ? 'New work items start here' : 'Where new work items start'}</span>
        {!isStart && <button className="btn btn-secondary btn-sm" onClick={onSetStart}>Set as start</button>}
      </div>
      {!isStart && <p className="hint">Moves this status to the front. The first status is also the first column on the board.</p>}
      <div className="wf-panel-foot">
        <span className="muted sm">{plural(count, 'work item')} in this status</span>
        <button className="btn btn-secondary text-danger" disabled={workflow.statuses.length <= 1} onClick={onDelete}><Trash2 size={14} />Delete status</button>
      </div>
    </>
  )
}

export function TransitionPanel({ transition, statuses, fields, types, projectKey, onChange, onDelete }: {
  transition: Transition; statuses: Status[]; fields: FieldDef[]; types: WorkType[]; projectKey: string; onChange: Change<Transition>; onDelete: () => void
}) {
  const [tab, setTab] = useState<'details' | 'rules'>('details')
  const from = transition.from
  const summary = rulesSummary(transition.rules)
  return (
    <>
      <div className="wf-panel-kind">{transition.to === null ? 'Transition (loop)' : 'Transition'}</div>
      <div className="segmented full" role="tablist" aria-label="Transition" style={{ marginBottom: 12 }}>
        <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>Details</button>
        <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Rules{summary ? ` (${summary.split(' · ').length})` : ''}</button>
      </div>
      {tab === 'rules' ? (
        <RulesEditor rules={transition.rules ?? {}} statuses={statuses} fields={fields} projectKey={projectKey}
          onChange={rules => onChange({ rules }, `rules:${transition.id}`)} />
      ) : <>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>Transitions are the moves people can make. Only these appear in status menus and on the board.</p>
        <label className="label" htmlFor="wf-tname">Name</label>
        <input id="wf-tname" className="input" value={transition.name} onChange={e => onChange({ name: e.target.value }, `tname:${transition.id}`)} />
        <fieldset className="wf-fieldset" style={{ marginTop: 12 }}>
          <legend className="label">From statuses</legend>
          <label className="check-row">
            <Checkbox checked={from === 'any'} label="Any status"
              onChange={on => onChange({ from: on ? 'any' : statuses.filter(s => s.id !== transition.to).slice(0, 1).map(s => s.id) })} />Any status
          </label>
          {from !== 'any' && statuses.filter(s => s.id !== transition.to).map(s => (
            <label key={s.id} className="check-row">
              <Checkbox checked={from.includes(s.id)} label={s.name} onChange={on => onChange({ from: on ? [...from, s.id] : from.filter(f => f !== s.id) })} />
              <span className="status-dot" style={{ background: s.color }} />{s.name}
            </label>
          ))}
          {from !== 'any' && from.length === 0 && <p className="hint error" role="alert">Choose at least one status, or Any status.</p>}
        </fieldset>
        <label className="label" htmlFor="wf-to" style={{ marginTop: 12 }}>To status</label>
        <select id="wf-to" className="input" value={transition.to ?? LOOP} onChange={e => onChange({ to: e.target.value === LOOP ? null : e.target.value })}>
          {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          <option value={LOOP}>Stays in its status (an action)</option>
        </select>
        <fieldset className="wf-fieldset" style={{ marginTop: 12 }}>
          <legend className="label">For work types</legend>
          <label className="check-row">
            <Checkbox checked={!transition.types?.length} label="Every work type" onChange={on => onChange({ types: on ? undefined : types.map(t => t.key) })} />Every work type
          </label>
          {!!transition.types?.length && types.map(t => (
            <label key={t.key} className="check-row">
              <Checkbox checked={transition.types!.includes(t.key)} label={t.name}
                onChange={on => onChange({ types: on ? [...transition.types!, t.key] : transition.types!.filter(k => k !== t.key).length ? transition.types!.filter(k => k !== t.key) : undefined })} />{t.name}
            </label>
          ))}
          {!!transition.types?.length && <p className="hint">Only these follow it: each work type has its own workflow over the project’s statuses.</p>}
        </fieldset>
        {transition.to === null && <p className="hint">A loop: people find it in the work item’s Actions menu. It changes nothing by itself; give it rules to ask for input or perform actions, like “Log progress”.</p>}
      </>}
      <div className="wf-panel-foot">
        <span />
        <button className="btn btn-secondary text-danger" onClick={onDelete}><Trash2 size={14} />Delete transition</button>
      </div>
    </>
  )
}

/** The "To status" choice that means the item stays where it is. */
export const LOOP = '__loop'

export function EmptyPanel() {
  return (
    <div className="wf-panel-empty">
      <MousePointerClick size={22} strokeWidth={1.5} />
      <p>Select a status or transition to edit it. Drag statuses to rearrange them. Drag from a dot on a status to another status to add a transition. Scroll to zoom, drag the background to pan.</p>
      <ul className="wf-legend">
        <li><span className="wf-any-pill">Any</span> every status can move here</li>
        <li><span className="wf-arrow" /> an allowed move between two statuses</li>
      </ul>
    </div>
  )
}
