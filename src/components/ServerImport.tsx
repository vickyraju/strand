import { useEffect, useRef, useState } from 'react'
import { FileText, Upload, Download, AlertTriangle } from 'lucide-react'
import type { Project } from '../data/store'
import { parseCsv, guessMapping } from '../data/csv'
import { api, ApiError } from '../api/client'
import { sprintDeps } from '../api/sprints'
import { csvCell } from '../../server/src/shared/csv.ts'
import { useApp } from '../appContext'
import { Modal, plural } from './ui'

// Jira's CSV importer: choose a file, match its columns to fields, see what every row will become (the server checks
// it all first and nothing is created), then import. The import runs in the background; rows with problems can be
// downloaded to fix and import again.

interface RowReport { row: number; title: string; ok: boolean; errors: string[]; warnings: string[] }
interface Check { rows: number; ready: number; skipped: number; report: RowReport[]; jobId: string | null; importId?: string }

const FIELDS: { id: string; label: string; aliases: string[] }[] = [
  { id: 'title', label: 'Title', aliases: ['title', 'summary', 'name', 'task', 'subject'] },
  { id: 'description', label: 'Description', aliases: ['description', 'details', 'body', 'notes'] },
  { id: 'type', label: 'Work type', aliases: ['type', 'issue type', 'work type', 'issuetype'] },
  { id: 'status', label: 'Status', aliases: ['status', 'state'] },
  { id: 'priority', label: 'Priority', aliases: ['priority'] },
  { id: 'assignee', label: 'Assignee', aliases: ['assignee', 'owner', 'assigned to'] },
  { id: 'labels', label: 'Labels', aliases: ['labels', 'label', 'tags'] },
  { id: 'estimate', label: 'Story points', aliases: ['story points', 'points', 'estimate', 'story point estimate'] },
  { id: 'dueDate', label: 'Due date', aliases: ['due date', 'due', 'deadline'] },
  { id: 'startDate', label: 'Start date', aliases: ['start date', 'start'] },
  { id: 'components', label: 'Components', aliases: ['component/s', 'components', 'component'] },
  { id: 'fixVersion', label: 'Fix version', aliases: ['fix version/s', 'fix version', 'fixversion', 'release'] },
]

export default function ServerImport({ project, onClose }: { project: Project; onClose: () => void }) {
  const { toast, openProject } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const [check, setCheck] = useState<Check | null>(null)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<'pick' | 'checking' | 'importing'>('pick')
  const fields = [...FIELDS, ...project.fields.map(f => ({ id: `custom.${f.id}`, label: f.name, aliases: [f.name.toLowerCase()] }))]

  const load = async (file: File) => {
    setError(''); setCheck(null)
    const text = await file.text()
    const rows = parseCsv(text)
    if (rows.length < 2) { setError('The file needs a header row and at least one row of data.'); return }
    setFileName(file.name); setCsv(text); setHeaders(rows[0]!)
    const guess: Record<string, number> = Object.fromEntries(Object.entries(guessMapping(rows[0]!)).filter(([, v]) => v !== undefined)) as Record<string, number>
    rows[0]!.forEach((h, i) => { const f = fields.find(x => x.aliases.includes(h.trim().toLowerCase())); if (f && guess[f.id] === undefined) guess[f.id] = i })
    setMapping(guess)
  }

  // Every change of file or mapping is checked by the server (nothing is created)
  useEffect(() => {
    if (!csv || mapping.title === undefined) { setCheck(null); return }
    let live = true
    setPhase('checking')
    const t = setTimeout(() => api<Check>('POST', `/api/projects/${encodeURIComponent(project.key)}/import`, { csv, mapping, dryRun: true })
      .then(c => { if (live) { setCheck(c); setError('') } }, e => { if (live) setError(e instanceof ApiError ? e.message : 'Could not reach the server.') })
      .finally(() => { if (live) setPhase('pick') }), 300)
    return () => { live = false; clearTimeout(t) }
  }, [csv, JSON.stringify(mapping), project.key])   // eslint-disable-line react-hooks/exhaustive-deps

  const problems = check?.report.filter(r => !r.ok || r.warnings.length) ?? []
  const downloadProblems = () => {
    const lines = ['Row,Title,Problems', ...problems.map(r => [r.row, r.title, [...r.errors, ...r.warnings].join('; ')].map(csvCell).join(','))]
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }))
    Object.assign(document.createElement('a'), { href: url, download: `${fileName.replace(/\.csv$/i, '')}-problems.csv` }).click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  const run = async () => {
    setPhase('importing'); setError('')
    try {
      const started = await api<Check>('POST', `/api/projects/${encodeURIComponent(project.key)}/import`, { csv, mapping, dryRun: false })
      for (let n = 0; n < 600; n++) {
        await new Promise(r => setTimeout(r, 1000))
        const j = await api<{ status: string; result: { created: number; already: number } | null; lastError: string | null }>('GET', `/api/jobs/${started.jobId}`)
        if (j.status === 'done') {
          await sprintDeps.reloadProject(project.id)
          toast(`Imported ${plural(j.result?.created ?? 0, 'work item')} into ${project.name}`)
          onClose(); openProject(project.id, 'list'); return
        }
        if (j.status === 'failed') { setError(`The import failed: ${j.lastError ?? 'unknown error'}. Nothing was imported; try again.`); break }
      }
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not reach the server.') }
    setPhase('pick')
  }

  return (
    <Modal title={`Import into ${project.name}`} onClose={onClose} width={680}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!check?.ready || phase !== 'pick'} onClick={run}>
          <Upload size={15} />{phase === 'importing' ? 'Importing…' : check?.ready ? `Import ${plural(check.ready, 'work item')}` : 'Import'}
        </button>
      </>}>
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = '' }} />
      <button className="attach-drop" onClick={() => fileRef.current?.click()} disabled={phase === 'importing'}>
        <FileText size={16} />{fileName ? <><b>{fileName}</b><span className="muted sm">choose another file</span></> : <>Choose a CSV file<span className="muted sm">First row must be column names. A Jira export works as it is.</span></>}
      </button>
      {error && <p className="hint error" role="alert">{error}</p>}
      {headers.length > 0 && <>
        <h3 className="section-label" style={{ marginTop: 18 }}>Columns</h3>
        <div className="import-map">
          {fields.map(f => (
            <label key={f.id} className="import-map-row">
              <span>{f.label}{f.id === 'title' && <span className="text-danger"> *</span>}</span>
              <select className="input" value={mapping[f.id] ?? ''} aria-label={`Column for ${f.label}`}
                onChange={e => setMapping(m => { const n = { ...m }; if (e.target.value === '') delete n[f.id]; else n[f.id] = Number(e.target.value); return n })}>
                <option value="">Don’t import</option>
                {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </select>
            </label>
          ))}
        </div>
        {mapping.title === undefined && <p className="hint error">Choose which column holds the title.</p>}
        {phase === 'checking' && <p className="muted sm" role="status">Checking every row…</p>}
        {check && phase !== 'checking' && <>
          <p style={{ marginTop: 12 }}>
            <b>{plural(check.ready, 'work item')}</b> will be created from {plural(check.rows, 'row')}
            {check.skipped ? <>; <span className="text-danger">{plural(check.skipped, 'row')} will be left out</span></> : ''}.
          </p>
          {problems.length > 0 && (
            <div className="callout callout-warn" style={{ marginTop: 8 }}>
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {problems.slice(0, 8).map(r => <li key={r.row}>Row {r.row}{r.title ? ` (“${r.title.slice(0, 40)}”)` : ''}: {[...r.errors, ...r.warnings].join('; ')}</li>)}
                </ul>
                {problems.length > 8 && <p className="muted sm">…and {plural(problems.length - 8, 'more row')}.</p>}
                <button className="btn btn-ghost btn-sm" onClick={downloadProblems}><Download size={14} />Download the rows with problems</button>
              </div>
            </div>
          )}
        </>}
      </>}
    </Modal>
  )
}
