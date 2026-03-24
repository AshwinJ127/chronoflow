'use client'
import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import EventLog from '@/components/EventLog'
import { useRunStore } from '@/store/runStore'

const WorkflowCanvas = dynamic(() => import('@/components/WorkflowCanvas'), { ssr: false })

interface Workflow {
  id: string
  name: string
  definition: { steps: Array<{ id: string; dependsOn: string[] }> }
}

export default function HomePage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [selectedWf, setSelectedWf] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastEventIdRef = useRef(0)

  const { startRun, addEvent, setComplete, setWorkerStatus, runId, stepStates, workerStatus, isComplete, events } = useRunStore()

  useEffect(() => {
    fetch('/api/workflows').then((r) => r.json()).then((data: Workflow[]) => {
      setWorkflows(data)
      if (data.length > 0) setSelectedWf(data[0].id)
    })
  }, [])

  useEffect(() => {
    const poll = () => {
      fetch('/api/worker/status')
        .then((r) => r.json())
        .then((d) => setWorkerStatus(d.status))
        .catch(() => setWorkerStatus('offline'))
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [setWorkerStatus])

  function openSSE(runId: string, after = 0) {
    eventSourceRef.current?.close()
    const es = new EventSource(`/api/events?runId=${runId}&after=${after}`)
    eventSourceRef.current = es

    es.onmessage = (e) => {
      const event = JSON.parse(e.data)
      lastEventIdRef.current = event.id
      addEvent(event)
    }
    es.addEventListener('done', () => {
      setComplete()
      es.close()
    })
    es.onerror = () => {
      es.close()
      setTimeout(() => openSSE(runId, lastEventIdRef.current), 1000)
    }
  }

  async function handleRun() {
    if (!selectedWf || loading) return
    setLoading(true)
    lastEventIdRef.current = 0

    const wf = workflows.find((w) => w.id === selectedWf)!
    const stepIds = wf.definition.steps.map((s) => s.id)

    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: selectedWf }),
    })
    const run = await res.json()
    startRun(run.id, stepIds)
    openSSE(run.id)
    setLoading(false)
  }

  async function handleKill() {
    await fetch('/api/debug/kill-worker', { method: 'POST' })
  }

  const selectedWorkflow = workflows.find((w) => w.id === selectedWf)
  const steps = selectedWorkflow?.definition.steps ?? []

  const completedCount = Array.from(stepStates.values()).filter((s) => s === 'completed').length
  const status = isComplete
    ? (stepStates.get(steps[steps.length - 1]?.id) === 'failed' ? 'failed' : 'completed')
    : runId ? 'running' : 'idle'

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900 shrink-0">
        <span className="text-xs text-slate-500 uppercase tracking-wider">Workflow</span>
        <select
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none"
          value={selectedWf}
          onChange={(e) => setSelectedWf(e.target.value)}
        >
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <button
          onClick={handleRun}
          disabled={loading || !selectedWf}
          className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded"
        >
          ▶ Run
        </button>
        <div className="flex-1" />
        <span className="text-xs text-slate-500">Worker:</span>
        <span className={`text-xs px-2 py-0.5 rounded ${workerStatus === 'online' ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
          ● {workerStatus}
        </span>
        <button
          onClick={handleKill}
          className="text-xs px-3 py-1.5 rounded border border-red-800 text-red-400 hover:bg-red-950"
        >
          ⚡ Kill Worker
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1">
          <WorkflowCanvas steps={steps} />
        </div>
        <div className="w-72 border-l border-slate-800 bg-slate-950">
          <EventLog />
        </div>
      </div>

      <div className="px-4 py-2 border-t border-slate-800 bg-slate-900 text-xs text-slate-500 flex gap-4 shrink-0">
        <span>Run: <span className="text-violet-400">{runId ? runId.slice(0, 8) + '...' : '—'}</span></span>
        <span>Status: <span className="text-slate-300">{status}</span></span>
        <span>Steps: <span className="text-slate-300">{completedCount}/{steps.length} completed</span></span>
        <span>Events: <span className="text-slate-300">{events.length}</span></span>
      </div>
    </div>
  )
}
