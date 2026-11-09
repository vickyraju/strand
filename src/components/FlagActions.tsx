import { useState } from 'react'
import { Flag } from 'lucide-react'
import { useStore, type Issue } from '../data/store'
import { useApp } from '../appContext'
import { Modal, type MenuItem } from './ui'

// Jira's flag (spec 0408): "Add flag" / "Remove flag", or the same with a comment, from an item's menu.

/** The menu entries, and the comment dialog they may open (render `dialog` next to the menu). */
export function useFlagActions(issue: Issue | undefined, canEdit: boolean): { items: MenuItem[]; dialog: React.ReactNode } {
  const { dispatch } = useStore()
  const { toast } = useApp()
  const [commenting, setCommenting] = useState(false)
  const [body, setBody] = useState('')
  if (!issue) return { items: [], dialog: null }
  const flag = (on: boolean, comment?: string) => {
    dispatch({ type: 'updateIssues', ids: [issue.id], patch: { flagged: on } })
    if (comment?.trim()) dispatch({ type: 'addComment', issueId: issue.id, body: `${on ? 'Flag added' : 'Flag removed'}\n\n${comment.trim()}` })
    toast(on ? `${issue.key} flagged` : `Flag removed from ${issue.key}`)
  }
  const on = !issue.flagged
  const items: MenuItem[] = canEdit ? [
    { label: on ? 'Add flag' : 'Remove flag', icon: <Flag size={14} />, divider: true, onClick: () => flag(on) },
    { label: on ? 'Add flag and comment' : 'Remove flag and add comment', icon: <Flag size={14} />, onClick: () => { setBody(''); setCommenting(true) } },
  ] : []
  const dialog = commenting && (
    <Modal title={on ? `Flag ${issue.key}` : `Remove the flag from ${issue.key}`} onClose={() => setCommenting(false)} footer={<>
      <button className="btn btn-secondary" onClick={() => setCommenting(false)}>Cancel</button>
      <button className="btn btn-primary" onClick={() => { flag(on, body); setCommenting(false) }}>{on ? 'Add flag' : 'Remove flag'}</button>
    </>}>
      <label className="label" htmlFor="flag-comment">Comment</label>
      <textarea id="flag-comment" className="input" rows={3} value={body} onChange={e => setBody(e.target.value)} autoFocus placeholder="Why it is blocked, or what unblocked it" />
    </Modal>
  )
  return { items, dialog }
}
