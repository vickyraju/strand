import { useEffect, useState } from 'react'
import { Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import type { Issue, TestSpec, TestStep } from '../data/store'
import { uid } from '../data/store'

// What a Test or Pre-Condition says to do (Xray's test kinds): manual steps (action, data, expected result), a Cucumber
// scenario in Gherkin, or a generic definition for an automated test. Edits are kept as a draft and saved together.

const KINDS: { kind: TestSpec['kind']; label: string; hint: string }[] = [
  { kind: 'manual', label: 'Manual', hint: 'Steps a person follows' },
  { kind: 'cucumber', label: 'Cucumber', hint: 'A Gherkin scenario' },
  { kind: 'generic', label: 'Generic', hint: 'An automated test, by name or definition' },
]
const empty = (kind: TestSpec['kind']): TestSpec => kind === 'manual' ? { kind, steps: [] } : kind === 'cucumber' ? { kind, gherkin: '' } : { kind, definition: '' }
const newStep = (): TestStep => ({ id: uid(), action: '', data: '', expected: '', attachmentIds: [] })

export default function TestSpecEditor({ issue, readOnly, onSave }: { issue: Issue; readOnly: boolean; onSave: (spec: TestSpec) => void }) {
  const saved = issue.testSpec ?? empty('manual')
  const [draft, setDraft] = useState<TestSpec>(saved)
  useEffect(() => { setDraft(issue.testSpec ?? empty('manual')) }, [issue.id, JSON.stringify(issue.testSpec)])   // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const steps = draft.kind === 'manual' ? draft.steps : []
  const setSteps = (s: TestStep[]) => setDraft({ kind: 'manual', steps: s })
  const move = (i: number, by: number) => { const s = [...steps]; [s[i], s[i + by]] = [s[i + by]!, s[i]!]; setSteps(s) }
  const label = issue.type === 'precondition' ? 'Pre-condition' : 'Test details'

  return (
    <section className="detail-section" aria-label={label}>
      <div className="section-title-row">
        <h2 className="section-title">{label}</h2>
        <div className="segmented sm" role="radiogroup" aria-label="Kind of test">
          {KINDS.map(k => (
            <button key={k.kind} role="radio" aria-checked={draft.kind === k.kind} title={k.hint} disabled={readOnly}
              className={draft.kind === k.kind ? 'on' : ''}
              onClick={() => draft.kind !== k.kind && setDraft(k.kind === saved.kind ? saved : empty(k.kind))}>{k.label}</button>
          ))}
        </div>
      </div>

      {draft.kind === 'manual' && (
        <ol className="test-steps">
          {steps.length === 0 && <li className="muted sm">No steps yet.</li>}
          {steps.map((s, i) => (
            <li key={s.id} className="test-step">
              <span className="test-step-n" aria-hidden>{i + 1}</span>
              <div className="test-step-fields">
                {(['action', 'data', 'expected'] as const).map(f => (
                  <label key={f} className="test-step-field">
                    <span className="muted sm">{f === 'action' ? 'Action' : f === 'data' ? 'Data' : 'Expected result'}</span>
                    <textarea className="input" rows={f === 'action' ? 2 : 1} value={s[f]} readOnly={readOnly} aria-label={`Step ${i + 1} ${f === 'expected' ? 'expected result' : f}`}
                      onChange={e => setSteps(steps.map(x => (x.id === s.id ? { ...x, [f]: e.target.value } : x)))} />
                  </label>
                ))}
              </div>
              {!readOnly && (
                <div className="test-step-tools">
                  <button className="icon-btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}><ArrowUp size={13} /></button>
                  <button className="icon-btn sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}><ArrowDown size={13} /></button>
                  <button className="icon-btn sm" onClick={() => setSteps(steps.filter(x => x.id !== s.id))} aria-label={`Remove step ${i + 1}`}><Trash2 size={13} /></button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {draft.kind === 'manual' && !readOnly && (
        <button className="btn btn-ghost btn-sm" onClick={() => setSteps([...steps, newStep()])}><Plus size={14} />Add step</button>
      )}
      {draft.kind === 'cucumber' && (
        <textarea className="input mono" rows={8} readOnly={readOnly} aria-label="Gherkin scenario" value={draft.gherkin}
          placeholder={'Scenario: Sign in\n  Given a registered user\n  When they sign in\n  Then they see their home page'}
          onChange={e => setDraft({ kind: 'cucumber', gherkin: e.target.value })} />
      )}
      {draft.kind === 'generic' && (
        <textarea className="input mono" rows={2} readOnly={readOnly} aria-label="Test definition" value={draft.definition}
          placeholder="e.g. com.example.LoginTest.signsIn" onChange={e => setDraft({ kind: 'generic', definition: e.target.value })} />
      )}

      {dirty && !readOnly && (
        <div className="row-actions">
          <button className="btn btn-primary btn-sm" disabled={draft.kind === 'manual' && draft.steps.some(s => !s.action.trim())} onClick={() => onSave(draft)}>Save</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDraft(saved)}>Cancel</button>
          {draft.kind === 'manual' && draft.steps.some(s => !s.action.trim()) && <span className="hint error">Every step needs an action.</span>}
        </div>
      )}
    </section>
  )
}
