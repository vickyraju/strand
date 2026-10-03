import { useRef, useState } from 'react'
import { Plus, Trash2, FileText, Upload, AlertTriangle } from 'lucide-react'
import { useStore, uid, type ItemTemplate, type Project, type IssueType, type Priority } from '../data/store'
import { parseCsv, guessMapping, mapRows, IMPORT_FIELDS, type ImportField } from '../data/csv'
import { useApp } from '../appContext'
import { Modal, TypeIcon, TYPE_META, PRIORITY_META, PRIORITIES, plural } from './ui'

// ── Templates ──────────────────────────────────────────────

export function TemplatesPanel({ project }: { project: Project }) {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [editing, setEditing] = useState<ItemTemplate | null>(null)
  const setTemplates = (templates: ItemTemplate[]) => dispatch({ type: 'updateProject', id: project.id, patch: { templates } })

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Templates</h2>
          <p className="muted">Starting points for work items you create often. Pick one in the Create dialog, or use “Save as template” on any work item.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setEditing(blankTemplate())}><Plus size={14} />Add template</button>
      </div>
      {project.templates.length === 0 ? <p className="muted sm">No templates yet.</p> : (
        <div className="people">
          {project.templates.map(t => (
            <div key={t.id} className="person">
              <TypeIcon type={t.type} size={18} />
              <div className="person-text">
                <span className="strong">{t.name}</span>
                <span className="muted sm">{TYPE_META[t.type].label} · {PRIORITY_META[t.priority].label}{t.labels.length ? ` · ${t.labels.join(', ')}` : ''}</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(t)}>Edit</button>
              <button className="icon-btn" onClick={() => { setTemplates(project.templates.filter(x => x.id !== t.id)); toast(`Deleted ${t.name}`) }} aria-label={`Delete ${t.name}`} title="Delete"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <TemplateDialog template={editing} onClose={() => setEditing(null)} onSave={t => {
          setTemplates(project.templates.some(x => x.id === t.id) ? project.templates.map(x => x.id === t.id ? t : x) : [...project.templates, t])
          toast(`Saved ${t.name}`); setEditing(null)
        }} />
      )}
    </section>
  )
}

export const blankTemplate = (): ItemTemplate => ({ id: uid(), name: '', type: 'task', title: '', description: '', priority: 'medium', labels: [] })

export function TemplateDialog({ template, onClose, onSave }: { template: ItemTemplate; onClose: () => void; onSave: (t: ItemTemplate) => void }) {
  const [t, setT] = useState(template)
  const [labels, setLabels] = useState(template.labels.join(', '))
  return (
    <Modal title={template.name ? `Edit ${template.name}` : 'Template'} onClose={onClose} width={560}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!t.name.trim()} onClick={() => onSave({ ...t, name: t.name.trim(), labels: labels.split(',').map(l => l.trim()).filter(Boolean) })}>Save template</button>
      </>}>
      <label className="label" htmlFor="tp-name">Template name</label>
      <input id="tp-name" className="input" value={t.name} onChange={e => setT({ ...t, name: e.target.value })} placeholder="e.g. Customer bug report" autoFocus />
      <div className="form-row" style={{ marginTop: 14 }}>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="tp-type">Type</label>
          <select id="tp-type" className="input" value={t.type} onChange={e => setT({ ...t, type: e.target.value as IssueType })}>
            {(Object.keys(TYPE_META) as IssueType[]).map(k => <option key={k} value={k}>{TYPE_META[k].label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label className="label" htmlFor="tp-pri">Priority</label>
          <select id="tp-pri" className="input" value={t.priority} onChange={e => setT({ ...t, priority: e.target.value as Priority })}>
            {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </select>
        </div>
        <div style={{ width: 110 }}>
          <label className="label" htmlFor="tp-est">Story points</label>
          <input id="tp-est" className="input" type="number" min={0} value={t.estimate ?? ''} onChange={e => setT({ ...t, estimate: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </div>
      </div>
      <label className="label" htmlFor="tp-title" style={{ marginTop: 14 }}>Title starts with</label>
      <input id="tp-title" className="input" value={t.title} onChange={e => setT({ ...t, title: e.target.value })} placeholder="e.g. [Customer] " />
      <label className="label" htmlFor="tp-desc" style={{ marginTop: 14 }}>Description</label>
      <textarea id="tp-desc" className="input" rows={5} value={t.description} onChange={e => setT({ ...t, description: e.target.value })} placeholder="Headings and checklists people should fill in. Markdown is supported." />
      <label className="label" htmlFor="tp-labels" style={{ marginTop: 14 }}>Labels</label>
      <input id="tp-labels" className="input" value={labels} onChange={e => setLabels(e.target.value)} placeholder="Comma separated" />
    </Modal>
  )
}

// ── CSV import ─────────────────────────────────────────────

export function ImportPanel({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Import work items</h2>
          <p className="muted">Bring work in from a CSV file, such as a Jira, Linear or spreadsheet export. You can check how columns map before importing.</p>
        </div>
        <button className="btn btn-secondary" onClick={() => setOpen(true)}><Upload size={14} />Import CSV</button>
      </div>
      {open && <ImportDialog project={project} onClose={() => setOpen(false)} />}
    </section>
  )
}

function ImportDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const { toast, openProject } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<Partial<Record<ImportField, number>>>({})
  const [error, setError] = useState('')

  const load = async (file: File) => {
    setError('')
    if (file.size > 5 * 1024 * 1024) { setError('That file is larger than 5 MB.'); return }
    const parsed = parseCsv(await file.text())
    if (parsed.length < 2) { setError('The file needs a header row and at least one row of data.'); return }
    setFileName(file.name)
    setHeaders(parsed[0])
    setRows(parsed.slice(1))
    setMapping(guessMapping(parsed[0]))
  }

  const mapped = rows.length ? mapRows(rows, mapping, project, state.users) : []
  const valid = mapped.filter(r => r.issue.title)
  const warnings = mapped.flatMap(r => r.warnings)

  const run = () => {
    for (const r of valid) dispatch({ type: 'createIssue', id: uid(), issue: r.issue })
    toast(`Imported ${plural(valid.length, 'work item')} into ${project.name}`)
    onClose()
    openProject(project.id, 'list')
  }

  return (
    <Modal title={`Import into ${project.name}`} onClose={onClose} width={640}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={valid.length === 0 || mapping.title === undefined} onClick={run}>
          <Upload size={15} />{valid.length ? `Import ${plural(valid.length, 'work item')}` : 'Import'}
        </button>
      </>}>
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = '' }} />
      <button className="attach-drop" onClick={() => fileRef.current?.click()}>
        <FileText size={16} />{fileName ? <><b>{fileName}</b><span className="muted sm">{plural(rows.length, 'row')} · choose another file</span></> : <>Choose a CSV file<span className="muted sm">First row must be column names</span></>}
      </button>
      {error && <p className="hint error">{error}</p>}

      {headers.length > 0 && (
        <>
          <h3 className="section-label" style={{ marginTop: 18 }}>Columns</h3>
          <div className="import-map">
            {IMPORT_FIELDS.map(f => (
              <label key={f.id} className="import-map-row">
                <span>{f.label}{f.id === 'title' && <span className="text-danger"> *</span>}</span>
                <select className="input" value={mapping[f.id] ?? ''} onChange={e => setMapping(m => ({ ...m, [f.id]: e.target.value === '' ? undefined : Number(e.target.value) }))} aria-label={`Column for ${f.label}`}>
                  <option value="">Don’t import</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          {mapping.title === undefined && <p className="hint error">Choose which column holds the title.</p>}
          {mapping.title !== undefined && (
            <p className="muted sm" style={{ marginTop: 10 }}>
              {plural(valid.length, 'work item')} will be created{mapped.length - valid.length ? `; ${plural(mapped.length - valid.length, 'row')} without a title will be skipped` : ''}. Example: “{valid[0]?.issue.title}”.
            </p>
          )}
          {warnings.length > 0 && (
            <div className="callout callout-warn" style={{ marginTop: 10 }}>
              <AlertTriangle size={15} />
              <div>
                <b>{plural(warnings.length, 'value')} couldn’t be matched</b> and will use defaults:
                <ul>{[...new Set(warnings)].slice(0, 5).map(w => <li key={w}>{w}</li>)}</ul>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
