import { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { StepStatus } from '@/lib/types'

interface StepNodeData {
  label: string
  status: StepStatus
}

const statusStyles: Record<StepStatus, string> = {
  pending:   'bg-slate-800 border-slate-600 text-slate-400',
  running:   'bg-blue-900 border-blue-400 text-white shadow-[0_0_12px_rgba(96,165,250,0.4)]',
  completed: 'bg-violet-800 border-violet-400 text-white',
  failed:    'bg-red-900 border-red-500 text-white',
}

const statusLabel: Record<StepStatus, string> = {
  pending:   'PENDING',
  running:   'RUNNING ···',
  completed: 'COMPLETED',
  failed:    'FAILED',
}

function StepNode({ data }: NodeProps<StepNodeData>) {
  const style = statusStyles[data.status]
  return (
    <div className={`border-2 rounded-lg px-6 py-3 min-w-[140px] text-center transition-all duration-300 ${style}`}>
      <Handle type="target" position={Position.Top} className="!bg-slate-500" />
      <div className="text-[10px] mb-1 opacity-70">{statusLabel[data.status]}</div>
      <div className="text-sm font-mono">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500" />
    </div>
  )
}

export default memo(StepNode)
