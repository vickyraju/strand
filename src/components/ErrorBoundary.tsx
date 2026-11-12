import { Component, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

/** Keeps a crash in one screen from blanking the whole app. Resets when `resetKey` changes (e.g. the route). */
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) { return { error } }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty" role="alert">
        <div className="empty-icon" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}><TriangleAlert size={22} strokeWidth={1.5} /></div>
        <div className="empty-title">Something went wrong on this page</div>
        <div className="empty-body">Your data is safe. Reload the page, or go back and try again.</div>
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
          <button className="btn btn-secondary" onClick={() => history.back()}>Go back</button>
        </div>
        <details className="muted sm" style={{ marginTop: 12, maxWidth: 520 }}>
          <summary>Technical details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>{this.state.error.message}</pre>
        </details>
      </div>
    )
  }
}
