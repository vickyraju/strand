import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { StatusNode as StatusNodeType } from './types'

const SIDES = [['t', Position.Top], ['r', Position.Right], ['b', Position.Bottom], ['l', Position.Left]] as const

/** One status on the canvas. Drag from one of the four dots to another status to add a transition. */
function StatusNode({ data, selected }: NodeProps<StatusNodeType>) {
  const over = data.wipLimit != null && data.count > data.wipLimit
  return (
    <div className={`wf2-node${selected ? ' on' : ''}`} style={{ ['--status' as string]: data.color }} title={data.description || undefined}>
      {data.start && (
        <svg className="wf2-start" width="64" height="36" viewBox="0 0 64 36" aria-hidden="true">
          <circle cx="18" cy="18" r="18" /><text x="18" y="21" textAnchor="middle">START</text><path d="M36 18H58" /><polygon points="57,13 64,18 57,23" />
        </svg>
      )}
      {data.anyId && (
        <button type="button" className="wf2-any nodrag nopan" onClick={e => { e.stopPropagation(); data.onSelectAny(data.anyId!) }}
          aria-label={`Any status can move to ${data.name}. Select this transition`}>Any</button>
      )}
      <span className="wf2-node-name" title={data.name}>{data.name}</span>
      <span className={`wf2-count${over ? ' over' : ''}`} title={data.wipLimit != null ? `${data.count} of ${data.wipLimit} allowed` : `${data.count} work items`}>
        {data.wipLimit != null ? `${data.count}/${data.wipLimit}` : data.count}
      </span>
      {SIDES.map(([id, position]) => <Handle key={id} id={id} type="source" position={position} />)}
    </div>
  )
}

export default memo(StatusNode)
