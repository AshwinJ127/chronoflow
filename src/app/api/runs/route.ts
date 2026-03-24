import { NextRequest, NextResponse } from 'next/server'
import { Queue } from 'bullmq'
import db from '@/lib/db'

const queue = new Queue('runs', { connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' } })

export async function GET() {
  try {
    const { rows } = await db.query(
      `SELECT id, workflow_id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 20`
    )
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[api/runs] Error:', err)
    return NextResponse.json({ error: 'internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body?.workflow_id) {
      return NextResponse.json({ error: 'workflow_id is required' }, { status: 400 })
    }

    const { rows: wfRows } = await db.query(
      `SELECT id FROM workflows WHERE id = $1`,
      [body.workflow_id]
    )
    if (wfRows.length === 0) {
      return NextResponse.json({ error: 'workflow not found' }, { status: 404 })
    }

    const { rows } = await db.query<{ id: string; workflow_id: string; status: string; created_at: string }>(
      `INSERT INTO runs (workflow_id) VALUES ($1) RETURNING id, workflow_id, status, created_at`,
      [body.workflow_id]
    )
    const run = rows[0]

    await db.query(
      `INSERT INTO events (run_id, step_id, event_type, payload) VALUES ($1, NULL, 'RUN_STARTED', $2)`,
      [run.id, JSON.stringify({ workflow_id: body.workflow_id })]
    )

    await queue.add('run', { runId: run.id, workflowId: body.workflow_id }, { jobId: run.id })

    return NextResponse.json(run, { status: 201 })
  } catch (err) {
    console.error('[api/runs] Error:', err)
    return NextResponse.json({ error: 'internal server error' }, { status: 500 })
  }
}
