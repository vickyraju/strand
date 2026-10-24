import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ArrowLeft, AlertTriangle, Workflow as WorkflowIcon, List as ListIcon, Undo2, Redo2, Network, PanelRightClose, PanelRightOpen, History } from 'lucide-react'
import { useStore, typesOf, type Project } from '../data/store'
import { useApp } from '../appContext'
import { Checkbox, Modal } from './ui'
import {
  addStatus, addTransition, autoLayout, canRedo, canUndo, deleteStatusMoving, moveStatus, pushHistory, reconnectSource, reconnectTarget, redo, removeTransition,
  resolveMove, sameWorkflow, setGlobal, setStart, startHistory, transitionsTouching, undo, updateStatus, updateTransition, validateWorkflow,
  type Draft, type Pos, type Workflow, type WorkflowIssue,
} from '../data/workflow'
import WorkflowCanvas from './workflow/WorkflowCanvas'
import { AddStatusDialog, CreateTransitionDialog, DeleteStatusDialog, type NewStatusInput, type NewTransition } from './workflow/dialogs'
import { EmptyPanel, StatusPanel, TransitionPanel } from './workflow/Panels'
import TextView from './workflow/TextView'
import { PublishDialog, VersionsDialog, workflowOf } from './workflow/Versions'
import { api, apiEnabled } from '../api/client'
import { idle as queueIdle } from '../api/queue'
import { statusMoves } from '../api/settings'
import { sameSelection, type Selection } from './workflow/types'

type Dialog = null | { kind: 'transition'; initial: NewTransition } | { kind: 'status' } | { kind: 'delete'; id: string }

export default function WorkflowBuilder({ project }: { project: Project }) {
  const { state, dispatch } = useStore()
  const { openProject, toast } = useApp()
  const original = useMemo<Workflow>(() => ({ statuses: project.statuses, transitions: project.transitions, layout: project.layout }), [project.statuses, project.transitions, project.layout])
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
  const [publishing, setPublishing] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)

  const dirty = !sameWorkflow(workflow, original)
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const i of state.issues) if (i.projectId === project.id) c[i.status] = (c[i.status] ?? 0) + 1
    return c
  }, [state.issues, project.id])
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

  const createStatus = (n: NewStatusInput) => {
    const r = addStatus(workflow, n)
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
  /** Ask where the work items go when there are any; otherwise just delete (undo is there). */
  const requestDeleteStatus = (id: string) => {
    if (workflow.statuses.length <= 1) return
    if (counts[id]) setDialog({ kind: 'delete', id })
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
  /** Check first; then "Update workflow" says what changes before anything is saved. */
  const save = () => {
    const found = validateWorkflow(workflow)
    setShowIssues(true)
    if (found.some(i => i.level === 'error')) return
    if (!found.length) setShowIssues(false)
    setPublishing(true)
  }
  const publish = async (note: string) => {
    setPublishing(false)
    const removedAll = project.statuses.filter(s => !exists(s.id))
    // With a server, removing a status moves every one of its items there, also those not loaded here
    if (apiEnabled) for (const s of removedAll) statusMoves.set(s.id, moveTarget(s.id))
    // Move the items shown here off deleted statuses first, while both statuses still exist
    const removed = removedAll.filter(s => counts[s.id])
    if (removed.length) {
      dispatch({ type: 'updateProject', id: project.id, patch: { statuses: [...workflow.statuses, ...removed] } })
      for (const s of removed) dispatch({ type: 'remapStatus', projectId: project.id, from: s.id, to: moveTarget(s.id) })
    }
    const layout = Object.fromEntries(Object.entries(workflow.layout).filter(([id]) => exists(id)))
    dispatch({ type: 'updateProject', id: project.id, patch: { statuses: workflow.statuses, transitions: workflow.transitions, layout } })
    setHist(startHistory({ workflow: { ...workflow, layout }, moves: {} }))
    if (!apiEnabled) { toast('Workflow updated'); return }
    // once every change has reached the server, record it as a version
    await new Promise(r => setTimeout(r, 0))
    await queueIdle()
    try {
      const v = await api<{ version: number; created: boolean }>('POST', `/api/projects/${encodeURIComponent(project.key)}/workflow/versions`, { note })
      toast(v.created ? `Workflow updated: version ${v.version}` : 'Workflow updated')
    } catch { toast('Workflow updated, but the version wasn’t recorded', { tone: 'warn' }) }
  }
  /** A published version into the editor, as an edit (undo goes back). Statuses it lacks send their items to one of its own. */
  const loadVersion = (v: Parameters<typeof workflowOf>[0]) => {
    const next = workflowOf(v, workflow.layout, typesOf(project).map(t => t.key))
    const has = (id: string) => next.statuses.some(s => s.id === id)
    const extra: Record<string, string> = {}
    for (const s of project.statuses) if (!has(s.id))
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
        <button className="btn btn-ghost" onClick={() => dirty ? setLeaving(true) : openProject(project.id, 'settings')}><ArrowLeft size={15} />Settings</button>
        <h2 className="wf-title">Workflow</h2>
        {dirty && <span className="lozenge lozenge-in-progress">Unsaved changes</span>}
        <div style={{ flex: 1 }} />
        {apiEnabled && <button className="btn btn-ghost" onClick={() => setVersionsOpen(true)}><History size={15} />Versions</button>}
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
            <TextView workflow={workflow} counts={counts} selection={activeSelection} onSelect={onSelect} onMoveStatus={moveInOrder} typeName={k => typesOf(project).find(t => t.key === k)?.name ?? 'a removed type'} />
          )}
        </div>

        {panelOpen && <aside className="wf-panel" aria-label="Properties">
          {selStatus ? (
            <StatusPanel status={selStatus} workflow={workflow} count={counts[selStatus.id] ?? 0}
              onChange={(patch, key) => edit(w => updateStatus(w, selStatus.id, patch), key)}
              onGlobal={on => edit(w => setGlobal(w, selStatus.id, on))}
              onSetStart={() => edit(w => setStart(w, selStatus.id))}
              onDelete={() => requestDeleteStatus(selStatus.id)} />
          ) : selTransition ? (
            <TransitionPanel key={selTransition.id} transition={selTransition} statuses={workflow.statuses} fields={project.fields} types={typesOf(project)} projectKey={project.key}
              onChange={(patch, key) => edit(w => updateTransition(w, selTransition.id, patch), key)}
              onDelete={deleteSelection} />
          ) : <EmptyPanel />}
        </aside>}
      </div>

      {publishing && <PublishDialog before={original} after={workflow} server={apiEnabled}
        moved={project.statuses.filter(s => !exists(s.id)).map(s => ({ from: s.name, to: workflow.statuses.find(x => x.id === moveTarget(s.id))?.name ?? '', count: counts[s.id] ?? 0 }))}
        onClose={() => setPublishing(false)} onPublish={note => void publish(note)} />}
      {versionsOpen && <VersionsDialog projectKey={encodeURIComponent(project.key)} current={workflow} onClose={() => setVersionsOpen(false)} onRestore={loadVersion} />}
      {dialog?.kind === 'transition' && <CreateTransitionDialog statuses={workflow.statuses} initial={dialog.initial} onCreate={createTransition} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'status' && <AddStatusDialog existing={workflow.statuses} onAdd={createStatus} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (() => {
        const status = workflow.statuses.find(s => s.id === dialog.id)
        return status && (
          <DeleteStatusDialog status={status} count={counts[status.id] ?? 0} transitions={transitionsTouching(workflow, status.id)}
            others={workflow.statuses.filter(s => s.id !== status.id)} onConfirm={to => removeStatus(status.id, to)} onClose={() => setDialog(null)} />
        )
      })()}
      {leaving && (
        <Modal title="Discard unsaved changes?" onClose={() => setLeaving(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setLeaving(false)}>Keep editing</button>
            <button className="btn btn-danger" onClick={() => openProject(project.id, 'settings')}>Discard and leave</button>
          </>}>
          <p>Your workflow changes haven’t been saved.</p>
        </Modal>
      )}
    </div>
  )
}
