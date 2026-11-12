import { useState } from 'react'
import { useStore, typesOf, TEST_TYPES, type Project, type WorkType } from '../../data/store'
import { api, ApiError } from '../../api/client'
import { useApp } from '../../appContext'
import { Toggle } from '../ui'

// Project settings › Testing: turns on test management (Xray's Tests, Pre-Conditions, Test Sets, Test Plans and Test
// Executions, as work types the project can rename). Turning it off needs the project to have no items of those types.
export default function TestingPanel({ project, admin }: { project: Project; admin: boolean }) {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const origin = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || window.location.origin
  const requirementTypes = project.requirementTypes ?? typesOf(project).map(t => t.key).filter(k => k !== 'bug' && !TEST_TYPES.includes(k as any))
  const saveTypes = async (types: string[]) => {
    setBusy(true)
    try {
      const r = await api<{ requirementTypes: string[] | null }>('PUT', `/api/projects/${encodeURIComponent(project.key)}/testing`, { enabled: true, requirementTypes: types })
      dispatch({ type: 'updateProject', id: project.id, patch: { requirementTypes: r.requirementTypes ?? undefined } })
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not reach the server.', { tone: 'warn' }) }
    setBusy(false)
  }
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
      {project.testing && (
        <div style={{ marginTop: 12 }}>
          <h3 className="subhead">Requirements</h3>
          <p className="muted sm">Work types whose items tests cover and that show test coverage.</p>
          <div className="check-grid">
            {typesOf(project).filter(t => !TEST_TYPES.includes(t.key as any)).map(t => (
              <label key={t.key} className="check-row">
                <input type="checkbox" disabled={!admin || busy} checked={requirementTypes.includes(t.key)}
                  onChange={e => void saveTypes(e.target.checked ? [...requirementTypes, t.key] : requirementTypes.filter(k => k !== t.key))} /> {t.name}
              </label>
            ))}
          </div>
          <h3 className="subhead" style={{ marginTop: 14 }}>Results from CI</h3>
          <p className="muted sm">Pipelines send results with a personal access token, to the same addresses Xray uses (so one that sent them to Xray only needs this server’s address and a token):</p>
          <pre className="mono ci-hint">{`POST ${origin}/rest/raven/1.0/import/execution/junit?projectKey=${project.key}   (JUnit XML, multipart "file")
POST ${origin}/rest/raven/1.0/import/execution/cucumber?projectKey=${project.key}   (Cucumber JSON)
POST ${origin}/rest/raven/1.0/import/execution   (Xray JSON)
Authorization: Bearer <token>    Optional: testExecKey, testPlanKey, testEnvironments=a;b, fixVersion, revision`}</pre>
        </div>
      )}
    </section>
  )
}
