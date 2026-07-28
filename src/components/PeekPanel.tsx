import WorkItemDetail from './WorkItemDetail'

interface PeekPanelProps {
  onExpandFull: () => void
  onClose:      () => void
}

export default function PeekPanel({ onExpandFull, onClose }: PeekPanelProps) {
  return (
    <>
      {/* Dim overlay — click to close */}
      <div className="peek-dim" onClick={onClose} />

      {/* Sliding panel */}
      <div className="peek-panel">
        <WorkItemDetail mode="peek" onExpandFull={onExpandFull} onClose={onClose} />
      </div>
    </>
  )
}
