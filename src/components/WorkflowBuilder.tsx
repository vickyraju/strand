import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ArrowLeft, AlertTriangle, Workflow as WorkflowIcon, List as ListIcon, Undo2, Redo2, Network, PanelRightClose, PanelRightOpen, History } from 'lucide-react'
import { useApp } from '../appContext'
import { Checkbox, Loading, LoadError, Modal } from './ui'
import {
  addStatus, addTransition, autoLayout, canRedo, canUndo, deleteStatusMoving, moveStatus, pushHistory, reconnectSource, reconnectTarget, redo, removeTransition,
  resolveMove, sameWorkflow, setGlobal, setStart, startHistory, transitionsTouching, undo, updateStatus, updateTransition, validateWorkflow,
  type Draft, type Pos, type Workflow, type WorkflowIssue,
} from '../data/workflow'
import WorkflowCanvas from './workflow/WorkflowCanvas'
import { AddStatusDialog, CreateTransitionDialog, DeleteStatusDialog, type NewStatusInput, type NewTransition } from './workflow/dialogs'
import { EmptyPanel, StatusPanel, TransitionPanel } from './workflow/Panels'
import TextView from './workflow/TextView'
import { PublishDialog, VersionsDialog, workflowOf, type Impact } from './workflow/Versions'
import { api, errorMessage } from '../api/client'
import { sprintDeps } from '../api/sprints'
import { sameSelection, type Selection } from './workflow/types'
import type { Status } from '../data/store'

// A shared workflow (Administration › Workflows), edited by a system administrator. Updating it applies it to every
// project whose scheme uses it, as in Jira; statuses taken out send their work items where the administrator chooses.

type Dialog = null | { kind: 'transition'; initial: NewTransition } | { kind: 'status' } | { kind: 'delete'; id: string }
interface LibWorkflow { id: string; name: string; version: number; updatedAt: string; statuses: any[]; transitions: any[]; layout: Workflow['layout']; projects: { key: string; name: string }[] }

export default function WorkflowBuilder({ id, onBack }: { id: string; onBack: () => void }) {
  const [lib, setLib] = useState<LibWorkflow | null>(null)
  const [known, setKnown] = useState<Status[]>([])
  const [error, setError] = useState('')
  const load = () => {
    setError('')
    api<LibWorkflow>('GET', `/api/workflows/${encodeURIComponent(id)}`).then(setLib, e => setError(errorMessage(e)))
    api<Status[]>('GET', '/api/admin/statuses').then(setKnown, () => {})
  }
  useEffect(load, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div style={{ padding: 24 }}><LoadError error={error} onRetry={load} /><button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={onBack}>Back to workflows</button></div>
  if (!lib) return <div style={{ padding: 24 }}><Loading rows={6} /></div>
  return <Editor key={`${lib.id}:${lib.updatedAt}`} lib={lib} known={known} onBack={onBack} onSaved={setLib} />
}

function Editor({ lib, known, onBack, onSaved }: { lib: LibWorkflow; known: Status[]; onBack: () => void; onSaved: (w: LibWorkflow) => void }) {
  const { toast } = useApp()
  const original = useMemo<Workflow>(() => workflowOf(lib, lib.layout ?? {}), [lib])
  const [hist, setHist] = useState(() => startHistory<Draft>({ workflow: original, moves: {} }))
  const { workflow, moves } = hist.present
  const [selected, setSelected] = useState<Selection>(null)
  const [view, setView] = useState<'diagram' | 'list'>('diagram')
  const [showLabels, setShowLabels] = useState(true)
  const [showIssues, setShowIssues] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [leaving, setLeaving] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [focus, setFocus] = useState<{ id?: string; tick: number }>()
  const [publishing, setPublishing] = useState<Impact[] | null | false>(false)   // false: closed; null: working out the projects
  const [versionsOpen, setVersionsOpen] = useState(false)

  const dirty = !sameWorkflow(workflow, original)
  const counts = useMemo<Record<string, number>>(() => ({}), [])   // items live in many projects: the editor doesn't count them
  const issues = useMemo<WorkflowIssue[]>(() => (showIssues ? validateWorkflow(workflow) : []), [showIssues, workflow])

  // ── Editing: every change goes through the history, so undo and redo cover all of it ──
  /** `key` joins a burst of the same kind of edit (typing a name, dragging a box) into one undo step. */
  const edit = useCallback((fn: (w: Workflow) => Workflow, key?: string) =>
    setHist(h => { const next = fn(h.present.workflow); return next === h.present.workflow ? h : pushHistory(h, { ...h.present, workflow: next }, { coalesce: key }) }), [])
  const onSelect = useCallback((s: Selection) => { setSelected(prev => (sameSelection(prev, s) ? prev : s)); if (s) setPanelOpen(true) }, [])
  const focusOn = (id?: string) => setFocus(f => ({ id, tick: (f?.tick ?? 0) + 1 }))

  // A selection that no longer exists (after an undo, say) is treated as none.
  const selStatus = selected?.kind === 'status' ? workflow.statuses.find(s => s.id === selected.id) : undefined
  const selTransition = selected?.kind === 'transition' ? workflow.transitions.find(t => t.id === selected.id) : undefined
  const activeSelection: Selection = selStatus || selTransition ? selected : null

  const onMoveNodes = useCallback((positions: Record<string, Pos>) => edit(w => ({ ...w, layout: positions }), 'move'), [edit])

  const connectStatuses = useCallback((from: string, to: string) => {
    const existing = workflow.transitions.find(t => t.to === to && (t.from === 'any' || t.from.includes(from)))
    if (existing) { setSelected({ kind: 'transition', id: existing.id }); toast(`“${existing.name}” already allows that move`); return }
    setDialog({ kind: 'transition', initial: { from: [from], to, name: workflow.statuses.find(s => s.id === to)?.name ?? '' } })
  }, [workflow, toast])

  const reconnect = useCallback((transitionId: string, end: 'source' | 'target', from: string, newId: string) => {
    const apply = (w: Workflow) => (end === 'source' ? reconnectSource(w, transitionId, from, newId) : reconnectTarget(w, transitionId, newId))
    if (apply(workflow) === workflow) { toast('A transition needs at least one status to start from', { tone: 'warn' }); return }
    edit(apply)
  }, [workflow, edit, toast])

  const createTransition = (t: NewTransition) => {
    const r = addTransition(workflow, t)
    edit(() => r.workflow)
    setSelected(r.id ? { kind: 'transition', id: r.id } : null)
    setDialog(null)
  }

  /** A status by a known name is that global status (its colour and category); otherwise a new one. */
  const createStatus = (n: NewStatusInput) => {
    const same = known.find(k => k.name.toLowerCase() === n.name.toLowerCase())
    const r = addStatus(workflow, same ? { ...n, id: same.id, name: same.name, category: same.category, color: same.color } : n)
    edit(() => r.workflow)
    setSelected({ kind: 'status', id: r.id })
    focusOn(r.id)
    setDialog(null)
  }

  const removeStatus = (id: string, moveTo: string) => {
    setHist(h => { const next = deleteStatusMoving(h.present, id, moveTo); return next === h.present ? h : pushHistory(h, next) })
    setSelected(null)
    setDialog(null)
  }
  /** A published status may hold work items in some project: ask where they go. One added since needs no answer. */
  const requestDeleteStatus = (id: string) => {
    if (workflow.statuses.length <= 1) return
    if (original.statuses.some(s => s.id === id)) setDialog({ kind: 'delete', id })
    else removeStatus(id, workflow.statuses.find(s => s.id !== id)!.id)
  }
  const deleteSelection = () => {
    if (selStatus) requestDeleteStatus(selStatus.id)
    else if (selTransition) { edit(w => removeTransition(w, selTransition.id)); setSelected(null) }
  }

  const moveInOrder = useCallback((id: string, toIndex: number) => edit(w => moveStatus(w, id, toIndex)), [edit])
  const layOut = () => { edit(w => ({ ...w, layout: autoLayout(w) })); focusOn() }
  const openAddTransition = () => setDialog({ kind: 'transition', initial: { from: [workflow.statuses[0]!.id], to: workflow.statuses[1]!.id, name: workflow.statuses[1]!.name } })

  // ── Save and discard ──
  const exists = (id: string) => workflow.statuses.some(s => s.id === id)
  const moveTarget = (id: string) => resolveMove(moves, id, exists) ?? workflow.statuses[0]!.id
  const removed = original.statuses.filter(s => !exists(s.id))
  const body = (o: { note?: string; dryRun?: boolean }) => ({
    statuses: workflow.statuses.map(s => ({ id: s.id, name: s.name, color: s.color, category: s.category, description: s.description ?? '' })),
    transitions: workflow.transitions.map(t => ({ id: t.id, name: t.name, fromIds: t.from === 'any' ? null : t.from, toId: t.to, rules: t.rules ?? {} })),
    layout: Object.fromEntries(Object.entries(workflow.layout).filter(([id]) => exists(id))),
    statusMap: Object.fromEntries(removed.map(s => [s.id, moveTarget(s.id)])), ...o,
  })
  /** Check first; then "Update workflow" says what changes, and for which projects, before anything is saved. */
  const save = () => {
    const found = validateWorkflow(workflow)
    setShowIssues(true)
    if (found.some(i => i.level === 'error')) return
    if (!found.length) setShowIssues(false)
    setPublishing(null)
    api<{ projects: Impact[] }>('POST', `/api/admin/workflows/${lib.id}/publish`, body({ dryRun: true }))
      .then(r => setPublishing(p => (p === false ? p : r.projects)), e => { setPublishing(false); toast(errorMessage(e), { tone: 'warn' }) })
  }
  const publish = async (note: string) => {
    setPublishing(false)
    try {
      const r = await api<{ workflow: LibWorkflow; version: number; created: boolean; projects: Impact[] }>('POST', `/api/admin/workflows/${lib.id}/publish`, body({ note }))
      toast(r.created ? `Workflow updated: version ${r.version}${r.projects.length ? `, in ${r.projects.length} project${r.projects.length === 1 ? '' : 's'}` : ''}` : 'Workflow updated')
      onSaved(r.workflow)
      // projects open here now have other statuses, and maybe items in other places
      if (r.projects.length) { await sprintDeps.reloadAll(); for (const i of r.projects) await sprintDeps.reloadProject(i.project.id) }
    } catch (e) { toast(errorMessage(e), { tone: 'warn' }) }
  }
  /** A published version into the editor, as an edit (undo goes back). Statuses it lacks send their items to one of its own. */
  const loadVersion = (v: Parameters<typeof workflowOf>[0] & { version: number }) => {
    const next = workflowOf(v, workflow.layout)
    const has = (id: string) => next.statuses.some(s => s.id === id)
    const extra: Record<string, string> = {}
    for (const s of original.statuses) if (!has(s.id))
      extra[s.id] = next.statuses.find(x => x.category === s.category)?.id ?? next.statuses[0]!.id
    setHist(h => pushHistory(h, { workflow: next, moves: { ...h.present.moves, ...extra } }))
    setVersionsOpen(false); setSelected(null)
    toast(`Version ${v.version} is in the editor. Update the workflow to use it.`)
  }
  const discard = () => { setHist(startHistory({ workflow: original, moves: {} })); setShowIssues(false); setSelected(null) }

  // Undo and redo from the keyboard, unless the person is typing (the field has its own undo) or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || (e.target as HTMLElement).closest('input, textarea, select') || document.querySelector('.modal')) return
      const k = e.key.toLowerCase()
      if (k === 'z') { e.preventDefault(); setHist(e.shiftKey ? redo : undo) }
      else if (k === 'y') { e.preventDefault(); setHist(redo) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Closing the tab with unsaved changes
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const jump = (i: WorkflowIssue) => {
    if (!i.target) return
    setSelected({ kind: i.target.kind, id: i.target.id })
    if (i.target.kind === 'status' && view === 'diagram') focusOn(i.target.id)
  }
  const errors = issues.filter(i => i.level === 'error'), warnings = issues.filter(i => i.level === 'warning')
  const issueList = (list: WorkflowIssue[]) => (
    <ul>{list.map((i, n) => (
      <li key={`${i.code}:${i.target?.id ?? ''}:${n}`}>
        {i.target ? <button type="button" className="wf-issue" onClick={() => jump(i)}>{i.message}</button> : i.message}
      </li>
    ))}</ul>
  )

  return (
    <div className="wf">
      <div className="wf-bar">
        <button className="btn btn-ghost" onClick={() => (dirty ? setLeaving(true) : onBack())}><ArrowLeft size={15} />Workflows</button>
        <h2 className="wf-title">{lib.name}</h2>
        <span className="muted sm">{lib.projects.length ? `Used by ${lib.projects.map(p => p.key).join(', ')}` : 'No project uses it yet'}</span>
        {dirty && <span className="lozenge lozenge-in-progress">Unsaved changes</span>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={() => setVersionsOpen(true)}><History size={15} />Versions</button>
        <button className="btn btn-secondary" onClick={discard} disabled={!dirty}>Discard changes</button>
        <button className="btn btn-primary" onClick={save} disabled={!dirty}>Update workflow</button>
      </div>
      <div className="wf-tools">
        <div className="segmented" role="tablist" aria-label="Workflow view">
          <button role="tab" aria-selected={view === 'diagram'} className={view === 'diagram' ? 'on' : ''} onClick={() => setView('diagram')}><WorkflowIcon size={14} />Diagram</button>
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}><ListIcon size={14} />List</button>
        </div>
        {view === 'diagram' && (
          <label className="check-row wf-labels"><Checkbox checked={showLabels} label="Show transition labels" onChange={setShowLabels} />Show transition labels</label>
        )}
        <button className="icon-btn" onClick={() => setHist(undo)} disabled={!canUndo(hist)} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 size={16} /></button>
        <button className="icon-btn" onClick={() => setHist(redo)} disabled={!canRedo(hist)} aria-label="Redo" title="Redo (Shift+Ctrl+Z)"><Redo2 size={16} /></button>
        {view === 'diagram' && <button className="icon-btn" onClick={layOut} aria-label="Arrange automatically" title="Arrange automatically"><Network size={16} /></button>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'status' })}><Plus size={15} />Add status</button>
        <button className="btn btn-secondary" onClick={openAddTransition} disabled={workflow.statuses.length < 2}><Plus size={15} />Add transition</button>
        <button className="icon-btn" onClick={() => setPanelOpen(o => !o)} aria-label={panelOpen ? 'Hide properties' : 'Show properties'} aria-pressed={panelOpen} title={panelOpen ? 'Hide properties' : 'Show properties'}>
          {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </button>
      </div>

      {errors.length > 0 && (
        <div className="callout callout-danger wf-errors" role="alert">
          <AlertTriangle size={16} />
          <div><b>Fix these before saving:</b>{issueList(errors)}</div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="callout callout-warn wf-errors" role="status">
          <AlertTriangle size={16} />
          <div><b>Worth a look (you can still save):</b>{issueList(warnings)}</div>
        </div>
      )}

      <div className="wf-body">
        <div className={`wf-canvas${view === 'diagram' ? ' diagram' : ''}`}>
          {view === 'diagram' ? (
            <WorkflowCanvas workflow={workflow} usage={counts} selection={activeSelection} showLabels={showLabels} onSelect={onSelect} onMoveNodes={onMoveNodes}
              onConnectStatuses={connectStatuses} onReconnect={reconnect} onDelete={deleteSelection} focus={focus} />
          ) : (
            <TextView workflow={workflow} counts={counts} selection={activeSelection} onSelect={onSelect} onMoveStatus={moveInOrder} />
          )}
        </div>

        {panelOpen && <aside className="wf-panel" aria-label="Properties">
          {selStatus ? (
            <StatusPanel status={selStatus} workflow={workflow}
              onChange={(patch, key) => edit(w => updateStatus(w, selStatus.id, patch), key)}
              onGlobal={on => edit(w => setGlobal(w, selStatus.id, on))}
              onSetStart={() => edit(w => setStart(w, selStatus.id))}
              onDelete={() => requestDeleteStatus(selStatus.id)} />
          ) : selTransition ? (
            <TransitionPanel key={selTransition.id} transition={selTransition} statuses={workflow.statuses}
              onChange={(patch, key) => edit(w => updateTransition(w, selTransition.id, patch), key)}
              onDelete={deleteSelection} />
          ) : <EmptyPanel />}
        </aside>}
      </div>

      {publishing !== false && <PublishDialog before={original} after={workflow} impact={publishing}
        moved={removed.map(s => ({ from: s.name, to: workflow.statuses.find(x => x.id === moveTarget(s.id))?.name ?? '' }))}
        onClose={() => setPublishing(false)} onPublish={note => void publish(note)} />}
      {versionsOpen && <VersionsDialog workflowId={lib.id} current={workflow} onClose={() => setVersionsOpen(false)} onRestore={loadVersion} />}
      {dialog?.kind === 'transition' && <CreateTransitionDialog statuses={workflow.statuses} initial={dialog.initial} onCreate={createTransition} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'status' && <AddStatusDialog existing={workflow.statuses} known={known} onAdd={createStatus} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (() => {
        const status = workflow.statuses.find(s => s.id === dialog.id)
        return status && (
          <DeleteStatusDialog status={status} transitions={transitionsTouching(workflow, status.id)}
            others={workflow.statuses.filter(s => s.id !== status.id)} onConfirm={to => removeStatus(status.id, to)} onClose={() => setDialog(null)} />
        )
      })()}
      {leaving && (
        <Modal title="Discard unsaved changes?" onClose={() => setLeaving(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setLeaving(false)}>Keep editing</button>
            <button className="btn btn-danger" onClick={onBack}>Discard and leave</button>
          </>}>
          <p>Your workflow changes haven’t been saved.</p>
        </Modal>
      )}
    </div>
  )
}
