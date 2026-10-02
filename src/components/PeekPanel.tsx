import WorkItemDetail from './WorkItemDetail'

export default function PeekPanel({ issueId, onExpandFull, onClose }: {
  issueId:      string
  onExpandFull: () => void
  onClose:      () => void
}) {
  return (
    <>
      <div className="peek-dim" onClick={onClose} />
      <div className="peek-panel" role="dialog" aria-label="Work item">
        <WorkItemDetail issueId={issueId} mode="peek" onExpand={onExpandFull} onClose={onClose} />
      </div>
    </>
  )
}
