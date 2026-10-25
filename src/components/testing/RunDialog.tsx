import { useEffect, useRef, useState } from 'react'
import { Bug, Paperclip, RotateCcw, X } from 'lucide-react'
import { api } from '../../api/client'
import { attachmentUrl } from '../../api/attachments'
import { useStore, userOf, timeAgo } from '../../data/store'
import { useApp } from '../../appContext'
import { href } from '../../router'
import { Modal } from '../ui'
import { enc, message, StatusLozenge, useItems, useTestStatuses, type TestRun } from './shared'

// Running one test (Xray's execution screen): the test as it was when the run was made, a result for each step (status,
// actual result, comment, defects, evidence), and the run's own status, which follows the steps unless set directly.
// Each change is saved at once; the server works out the run's status and records who finished it and when.

export default function RunDialog({ runId, readOnly, onClose, onChanged }: { runId: string; readOnly: boolean; onClose: () => void; onChanged?: () => void }) {
  const { state } = useStore()
  const { toast } = useApp()
  const statuses = useTestStatuses()
  const [run, setRun] = useState<TestRun | null>(null)
  const [files, setFiles] = useState<Record<string, string>>({})
  const [defectFor, setDefectFor] = useState<string | null>(null)      // a step id, or '' for the whole run
  const [defectTitle, setDefectTitle] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [evidenceFor, setEvidenceFor] = useState<string>('')
  const item = useItems(run ? [...new Set([...run.defectIds, ...run.steps.flatMap(s => s.defectIds)])] : [])

  const loadFiles = (r: TestRun) => api<{ attachments: { id: string; name: string }[] }>('GET', `/api/issues/${enc(r.executionKey)}?expand=attachments`)
    .then(i => setFiles(Object.fromEntries((i.attachments ?? []).map(a => [a.id, a.name]))), () => {})
  useEffect(() => { api<TestRun>('GET', `/api/test-runs/${runId}`).then(r => { setRun(r); void loadFiles(r) }, e => toast(message(e), { tone: 'warn' })) }, [runId])   // eslint-disable-line react-hooks/exhaustive-deps
  const save = (body: object) => api<TestRun>('PATCH', `/api/test-runs/${runId}`, { ...body, version: run!.version })
    .then(r => { setRun(r); onChanged?.() }, e => { toast(message(e), { tone: 'warn' }); api<TestRun>('GET', `/api/test-runs/${runId}`).then(setRun) })
  const raise = () => api<{ run: TestRun; defect: { key: string } }>('POST', `/api/test-runs/${runId}/defects`, { title: defectTitle.trim(), ...(defectFor ? { stepId: defectFor } : {}) })
    .then(r => { setRun(r.run); setDefectFor(null); setDefectTitle(''); toast(`Raised ${r.defect.key}`); onChanged?.() }, e => toast(message(e), { tone: 'warn' }))
  const unlink = (id: string) => api<TestRun>('DELETE', `/api/test-runs/${runId}/defects/${id}`).then(setRun, e => toast(message(e), { tone: 'warn' }))
  const reset = () => window.confirm('Start this run again from the test as it is now? Its results are cleared.') &&
    api<TestRun>('POST', `/api/test-runs/${runId}/reset`).then(r => { setRun(r); onChanged?.() }, e => toast(message(e), { tone: 'warn' }))
  const upload = async (file: File) => {
    try {
      const type = file.type || 'application/octet-stream'
      const t = await api<{ id: string; uploadUrl: string }>('POST', `/api/issues/${enc(run!.executionKey)}/attachments`, { name: file.name, size: file.size, type })
      const put = await fetch(t.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': type } })
      if (!put.ok) throw new Error(`the upload failed (${put.status})`)
      await api('POST', `/api/attachments/${t.id}/complete`)
      setFiles(f => ({ ...f, [t.id]: file.name }))
      setRun(await api<TestRun>('POST', `/api/test-runs/${runId}/evidence`, { attachmentId: t.id, ...(evidenceFor ? { stepId: evidenceFor } : {}) }))
    } catch (e) { toast(e instanceof Error && !('status' in e) ? `Couldn't attach that file: ${e.message}` : message(e), { tone: 'warn' }) }
  }
  const open = (id: string) => attachmentUrl(id).then(u => window.open(u, '_blank', 'noopener'), e => toast(message(e), { tone: 'warn' }))

  if (!run) return <Modal title="Test run" onClose={onClose}><p className="muted" role="status">Loading…</p></Modal>
  const runStatuses = statuses.filter(s => s.kind === 'run'), stepStatuses = statuses.filter(s => s.kind === 'step')
  const specSteps: any[] = run.spec?.kind === 'manual' ? run.spec.steps : []
  const who = (id: string | null) => userOf(state, id ?? undefined)?.name
  const Defects = ({ ids }: { ids: string[] }) => <>{ids.map(id => (
    <span key={id} className="chip-static"><Bug size={11} /><a href={item(id) ? href({ name: 'issue', key: item(id)!.key }) : undefined}>{item(id)?.key ?? '…'}</a>
      {!readOnly && <button className="chip-x" aria-label={`Unlink ${item(id)?.key ?? 'defect'}`} onClick={() => unlink(id)}>×</button>}</span>
  ))}</>
  const Evidence = ({ ids }: { ids: string[] }) => <>{ids.map(id => <button key={id} className="chip-static" onClick={() => open(id)}><Paperclip size={11} />{files[id] ?? 'file'}</button>)}</>
  const tools = (stepId: string) => !readOnly && (
    <span className="run-tools">
      <button className="btn btn-ghost btn-sm" onClick={() => { setDefectFor(stepId); setDefectTitle('') }}><Bug size={13} />Defect</button>
      <button className="btn btn-ghost btn-sm" onClick={() => { setEvidenceFor(stepId); fileRef.current?.click() }}><Paperclip size={13} />Evidence</button>
    </span>
  )

  return (
    <Modal title={`${run.testKey} in ${run.executionKey}`} onClose={onClose} width={960}>
      <input ref={fileRef} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }} />
      <div className="run-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <a href={href({ name: 'issue', key: run.testKey })} className="strong">{run.testTitle}</a>
          <p className="muted sm">
            {run.environments.length ? `${run.environments.join(', ')} · ` : ''}
            {run.startedAt ? `Started ${timeAgo(Date.parse(run.startedAt))}` : 'Not started'}
            {run.finishedAt ? ` · finished ${timeAgo(Date.parse(run.finishedAt))}${who(run.executedBy) ? ` by ${who(run.executedBy)}` : ''}` : ''}
          </p>
        </div>
        <label className="run-status">
          <span className="muted sm">Status</span>
          <select className="input" aria-label="Run status" value={run.status} disabled={readOnly} onChange={e => save({ status: e.target.value })}>
            {runStatuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </label>
        <StatusLozenge statuses={statuses} status={run.status} />
      </div>
      {run.specChanged && (
        <div className="callout callout-warn" style={{ marginTop: 10 }}>
          <div style={{ flex: 1 }}>The test has changed since this run was made. The run shows it as it was.</div>
          {!readOnly && <button className="btn btn-secondary btn-sm" onClick={reset}><RotateCcw size={13} />Use the new version</button>}
        </div>
      )}

      {specSteps.length > 0 ? (
        <ol className="run-steps">
          {specSteps.map((s, i) => {
            const res = run.steps.find(x => x.id === s.id)
            if (!res) return null
            return (
              <li key={s.id} className="run-step">
                <span className="test-step-n" aria-hidden>{i + 1}</span>
                <div className="run-step-spec">
                  <p>{s.action}</p>
                  {s.data && <p className="muted sm"><b>Data:</b> {s.data}</p>}
                  {s.expected && <p className="muted sm"><b>Expected:</b> {s.expected}</p>}
                </div>
                <div className="run-step-result">
                  <select className="input input-sm" aria-label={`Step ${i + 1} status`} value={res.status} disabled={readOnly}
                    onChange={e => save({ steps: [{ id: s.id, status: e.target.value }] })}>
                    {stepStatuses.map(x => <option key={x.key} value={x.key}>{x.name}</option>)}
                  </select>
                  <textarea className="input" rows={1} placeholder="Actual result" aria-label={`Step ${i + 1} actual result`} defaultValue={res.actual} readOnly={readOnly}
                    onBlur={e => e.target.value !== res.actual && save({ steps: [{ id: s.id, actual: e.target.value }] })} />
                  <div className="run-chips"><Defects ids={res.defectIds} /><Evidence ids={res.evidenceIds} />{tools(s.id)}</div>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="run-spec-other">
          {run.spec?.kind === 'cucumber' && <pre className="mono">{run.spec.gherkin}</pre>}
          {run.spec?.kind === 'generic' && <p className="mono">{run.spec.definition}</p>}
          {!run.spec && <p className="muted sm">This test has no steps: set the run’s status directly.</p>}
        </div>
      )}

      <h3 className="subhead" style={{ marginTop: 16 }}>Run</h3>
      <textarea className="input" rows={2} placeholder="Comment on this run" aria-label="Run comment" defaultValue={run.comment} readOnly={readOnly}
        onBlur={e => e.target.value !== run.comment && save({ comment: e.target.value })} />
      <div className="run-chips" style={{ marginTop: 6 }}><Defects ids={run.defectIds.filter(id => !run.steps.some(s => s.defectIds.includes(id)))} /><Evidence ids={run.evidenceIds} />{tools('')}</div>

      {defectFor !== null && (
        <div className="run-defect">
          <input className="input" autoFocus placeholder={`What went wrong${defectFor ? ` in step ${specSteps.findIndex(s => s.id === defectFor) + 1}` : ''}?`} aria-label="Defect title"
            value={defectTitle} onChange={e => setDefectTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && defectTitle.trim() && raise()} />
          <button className="btn btn-primary btn-sm" disabled={!defectTitle.trim()} onClick={raise}>Raise bug</button>
          <button className="icon-btn sm" aria-label="Cancel" onClick={() => setDefectFor(null)}><X size={14} /></button>
        </div>
      )}
    </Modal>
  )
}
