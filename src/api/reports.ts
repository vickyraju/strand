// Reports need every item of a project and its whole status history, not the pages and opened items the
// app happens to hold. With an API they are loaded from /projects/:key/report-data; without one the local
// store already has everything.
import { useEffect, useState } from 'react'
import { api, apiEnabled } from './client'
import { toReportData, type Row, type StatusChange } from './map'
import { useStore } from '../data/store'
import type { Activity, Issue, Project, State } from '../data/reducer'

/** The state to calculate a project's reports from: the store, with the project's complete items and history when there is an API.
 *  `null` while loading; `error` set if the data could not be loaded. */
export function useReportState(project: Project): { state: State | null; error: string } {
  const { state } = useStore()
  const [data, setData] = useState<{ key: string; issues: Issue[]; activity: Activity[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!apiEnabled) return
    let live = true
    setError('')
    api<{ issues: Row[]; statusChanges: StatusChange[] }>('GET', `/api/projects/${encodeURIComponent(project.key)}/report-data`)
      .then(d => { if (live) setData({ key: project.key, ...toReportData(d.issues, d.statusChanges) }) },
            () => { if (live) setError('Could not load the report data. Try again in a moment.') })
    return () => { live = false }
  }, [project.key])
  if (!apiEnabled) return { state, error: '' }
  if (!data || data.key !== project.key) return { state: null, error }
  return { state: { ...state, issues: data.issues, activity: data.activity }, error }
}
