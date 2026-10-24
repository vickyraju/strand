import { useEffect, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { parseJql, JqlError } from '../../server/src/shared/jql.ts'
import { Popover } from './ui'

/** Jira's advanced search: a JQL query, checked as it is typed (the same parser as the server), run on Enter. */
export default function JqlBox({ value, onRun, serverError }: { value: string; onRun: (jql: string) => void; serverError?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  let mistake: { message: string; at: number } | null = null
  try { parseJql(text) } catch (e) { if (e instanceof JqlError) mistake = { message: e.message, at: e.at } }
  const run = () => { if (!mistake) onRun(text.trim()) }
  return (
    <div className="jql">
      <div className="jql-row">
        <textarea className="input mono jql-input" rows={2} spellCheck={false} value={text} aria-label="JQL query" aria-invalid={!!mistake || !!serverError}
          placeholder='project = PAY AND status != Done AND assignee = currentUser() ORDER BY priority DESC'
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run() } }} />
        <button className="btn btn-primary" disabled={!!mistake} onClick={run}>Search</button>
        <Popover title="JQL help" className="icon-btn" align="right" width={420} trigger={<HelpCircle size={16} />}>
          <div className="jql-help">
            <p><b>Fields</b>: project, type, status, statusCategory, priority, assignee, reporter, labels, component, fixVersion, affectedVersion, sprint, parent, resolution, summary, description, text, created, updated, resolved, due, start, estimate, and any custom field by its name (in quotes if it has spaces).</p>
            <p><b>Operators</b>: = != in (…) not in (…) ~ (contains) !~ &gt; &gt;= &lt; &lt;= is empty, is not empty.</p>
            <p><b>Values</b>: words, "quoted text", numbers, dates (2026-10-01), relative dates (-7d, 2w), currentUser(), now(), startOfDay(), endOfDay(), startOfWeek(), openSprints(), membersOf("Group").</p>
            <p>Join with AND, OR, NOT and (parentheses). Sort with ORDER BY created DESC, priority.</p>
          </div>
        </Popover>
      </div>
      {mistake ? <p className="hint error" role="alert">{mistake.message} (at character {mistake.at + 1})</p>
        : serverError ? <p className="hint error" role="alert">{serverError.replace(/^JQL: /, '')}</p>
        : <p className="hint">Press Enter to search. Shift+Enter for a new line.</p>}
    </div>
  )
}
