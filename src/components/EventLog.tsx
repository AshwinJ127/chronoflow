'use client'
import { useRunStore } from '@/store/runStore'
import { DbEvent } from '@/lib/types'

const eventColor: Record<string, string> = {
  RUN_STARTED:    'text-green-400',
  STEP_STARTED:   'text-blue-400',
  STEP_COMPLETED: 'text-violet-400',
  STEP_FAILED:    'text-red-400',
  RUN_COMPLETED:  'text-green-400',
  RUN_FAILED:     'text-red-400',
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false })
}

export default function EventLog() {
  const events = useRunStore((s) => s.events)

  return (
    <div className="h-full overflow-y-auto p-3 font-mono">
      <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Event Log</div>
      {events.length === 0 && (
        <div className="text-slate-600 text-xs">Waiting for run...</div>
      )}
      {events.map((e: DbEvent) => (
        <div key={e.id} className="text-xs leading-relaxed">
          <span className="text-slate-500">{formatTime(e.created_at)} </span>
          <span className={eventColor[e.event_type] ?? 'text-slate-300'}>{e.event_type}</span>
          {e.step_id && <span className="text-slate-400"> {e.step_id}</span>}
        </div>
      ))}
    </div>
  )
}
