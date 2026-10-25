import { useState } from 'react'
import { useStore, type Project, type WorkType } from '../../data/store'
import { api, ApiError } from '../../api/client'
import { useApp } from '../../appContext'
import { Toggle } from '../ui'

// Project settings › Testing: turns on test management (Xray's Tests, Pre-Conditions, Test Sets, Test Plans and Test
// Executions, as work types the project can rename). Turning it off needs the project to have no items of those types.
export default function TestingPanel({ project, admin }: { project: Project; admin: boolean }) {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const turn = async (enabled: boolean) => {
    setBusy(true)
    try {
      await api('PUT', `/api/projects/${encodeURIComponent(project.key)}/testing`, { enabled })
      const p = await api<{ testing: boolean; types: WorkType[] }>('GET', `/api/projects/${encodeURIComponent(project.key)}`)
      dispatch({ type: 'updateProject', id: project.id, patch: { testing: p.testing, types: p.types.map(t => ({ key: t.key, name: t.name, color: t.color, icon: t.icon })) } })
      toast(enabled ? 'Testing is on: Tests, Test Plans and Test Executions are now work types' : 'Testing is off')
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not reach the server.', { tone: 'warn' }) }
    setBusy(false)
  }
  return (
    <section className="panel" aria-label="Testing">
      <div className="panel-title-row">
        <div>
          <h2 className="panel-title">Testing</h2>
          <p className="muted">Write tests, group them into sets and plans, run them and track which requirements they cover. Adds the work types Test, Pre-Condition, Test Set, Test Plan and Test Execution.</p>
        </div>
        <Toggle on={!!project.testing} label="Test management" onChange={v => { if (admin && !busy) void turn(v) }} />
      </div>
    </section>
  )
}
