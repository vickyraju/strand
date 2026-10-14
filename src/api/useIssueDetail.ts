import { useEffect } from 'react'
import { apiEnabled } from './client'
import { detailLoaded, fetchIssueDetail } from './comments'
import { adoptDetail } from './detail'
import { issueSync } from './sync'
import { useStore } from '../data/store'

/** With an API, loads an opened issue's comments, history, time logs, links and watchers (list rows don't carry them). */
export function useIssueDetail(issueId: string | undefined) {
  const { state, dispatch } = useStore()
  const issue = issueId ? state.issues.find(i => i.id === issueId) : undefined
  const known = !!issue && issueSync.known(issue.id)       // not before the server has the issue (a brand-new one)

  useEffect(() => {
    if (!apiEnabled || !issue || !known || detailLoaded.has(issue.id)) return
    let cancelled = false
    fetchIssueDetail(issue).then(d => {
      if (cancelled) return
      adoptDetail(d, state.ownerId)
      dispatch({ type: 'loadIssueDetail', ...d })
    }, () => { /* the panel simply shows no comments; opening it again retries */ })
    return () => { cancelled = true }
  }, [issue?.id, known]) // eslint-disable-line react-hooks/exhaustive-deps
}
