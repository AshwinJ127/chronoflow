'use client'
import { useEffect } from 'react'
import ReactFlow, { Node, Edge, Background, Controls, useNodesState, useEdgesState } from 'reactflow'
// @ts-ignore
import dagre from '@dagrejs/dagre'
import 'reactflow/dist/style.css'
import StepNode from './StepNode'
import { useRunStore } from '@/store/runStore'
import { StepStatus } from '@/lib/types'

interface StepDef {
  id: string
  dependsOn: string[]
}

const nodeTypes = { step: StepNode }

function buildLayout(steps: StepDef[], stepStates: Map<string, StepStatus>) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 40 })

  steps.forEach((s) => g.setNode(s.id, { width: 160, height: 70 }))
  steps.forEach((s) => s.dependsOn.forEach((dep) => g.setEdge(dep, s.id)))
  dagre.layout(g)

  const nodes: Node[] = steps.map((s) => {
    const { x, y } = g.node(s.id)
    return {
      id: s.id,
      type: 'step',
      position: { x: x - 80, y: y - 35 },
      data: { label: s.id, status: stepStates.get(s.id) ?? 'pending' },
    }
  })

  const edges: Edge[] = steps.flatMap((s) =>
    s.dependsOn.map((dep) => ({
      id: `${dep}-${s.id}`,
      source: dep,
      target: s.id,
      style: { stroke: '#475569' },
      animated: stepStates.get(dep) === 'completed' && stepStates.get(s.id) === 'running',
    }))
  )

  return { nodes, edges }
}

export default function WorkflowCanvas({ steps }: { steps: StepDef[] }) {
  const stepStates = useRunStore((s) => s.stepStates)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout(steps, stepStates)
    setNodes(n)
    setEdges(e)
  }, [steps, stepStates])

  return (
    <div className="w-full h-full bg-slate-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" />
        <Controls className="!bg-slate-800 !border-slate-600" />
      </ReactFlow>
    </div>
  )
}
