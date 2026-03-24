import { NextRequest, NextResponse } from 'next/server'
import db from '@/lib/db'
import { DbEvent, StepStatus } from '@/lib/types'

function deriveStepStates(events: DbEvent[], stepIds: string[]): Array<{ id: string; status: StepStatus }> {
  const stateMap = new Map<string, StepStatus>()
  for (const e of events) {
    if (!e.step_id) continue
    if (e.event_type === 'STEP_COMPLETED') stateMap.set(e.step_id, 'completed')
    else if (e.event_type === 'STEP_FAILED') stateMap.set(e.step_id, 'failed')
    else if (e.event_type === 'STEP_STARTED' && !stateMap.has(e.step_id)) stateMap.set(e.step_id, 'running')
  }
  return stepIds.map((id) => ({ id, status: stateMap.get(id) ?? 'pending' }))
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { rows: runRows } = await db.query(
      `SELECT id, workflow_id, status, created_at FROM runs WHERE id = $1`,
      [params.id]
    )
    if (runRows.length === 0) {
      return NextResponse.json({ error: 'run not found' }, { status: 404 })
    }
    const run = runRows[0]

    const { rows: wfRows } = await db.query(
      `SELECT definition FROM workflows WHERE id = $1`,
      [run.workflow_id]
    )
    const stepIds: string[] = (wfRows[0]?.definition?.steps ?? []).map((s: { id: string }) => s.id)

    const { rows: events } = await db.query<DbEvent>(
      `SELECT * FROM events WHERE run_id = $1 ORDER BY id ASC`,
      [params.id]
    )

    return NextResponse.json({
      ...run,
      steps: deriveStepStates(events, stepIds),
    })
  } catch (err) {
    console.error('[api/runs/[id]] Error:', err)
    return NextResponse.json({ error: 'internal server error' }, { status: 500 })
  }
}
