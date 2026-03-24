import { Worker } from 'bullmq'
import db from './src/lib/db'
import { WorkflowEngine } from './src/lib/workflow-engine'
import { findWorkflow, workflows } from './src/workflows/index'

const QUEUE_NAME = 'runs'

async function registerWorkflows(): Promise<void> {
  for (const wf of workflows) {
    const def = { steps: wf.steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn })) }
    await db.query(
      `INSERT INTO workflows (id, name, definition)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`,
      [wf.id, wf.name, JSON.stringify(def)]
    )
  }
  console.log('[worker] Workflows registered')
}

async function recoverRunningRuns(): Promise<void> {
  const { rows } = await db.query<{ id: string; workflow_id: string }>(
    `SELECT id, workflow_id FROM runs WHERE status = 'running'`
  )
  console.log(`[worker] Crash recovery: ${rows.length} running run(s) found`)
  for (const run of rows) {
    const workflow = findWorkflow(run.workflow_id)
    if (!workflow) {
      console.warn(`[worker] Unknown workflow ${run.workflow_id} for run ${run.id}, skipping`)
      continue
    }
    console.log(`[worker] Resuming run ${run.id}`)
    const engine = new WorkflowEngine(workflow, run.id)
    engine.execute().catch((e) => console.error(`[worker] Run ${run.id} failed:`, e))
  }
}

async function main(): Promise<void> {
  await registerWorkflows()
  await recoverRunningRuns()

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { runId, workflowId } = job.data as { runId: string; workflowId: string }
      console.log(`[worker] Processing run ${runId}`)

      // Guard: skip if run already terminal
      const { rows } = await db.query<{ status: string }>(
        `SELECT status FROM runs WHERE id = $1`,
        [runId]
      )
      if (!rows[0] || rows[0].status !== 'running') {
        console.log(`[worker] Run ${runId} is ${rows[0]?.status}, skipping`)
        return
      }

      const workflow = findWorkflow(workflowId)
      if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`)

      const engine = new WorkflowEngine(workflow, runId)
      await engine.execute()
    },
    {
      connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
      concurrency: 5,
      lockDuration: 30_000,
      stalledInterval: 15_000,
    }
  )

  worker.on('completed', (job) => console.log(`[worker] Job ${job.id} completed`))
  worker.on('failed', (job, err) => console.error(`[worker] Job ${job?.id} failed:`, err))
  console.log('[worker] Listening for jobs...')
}

main().catch((e) => {
  console.error('[worker] Fatal error:', e)
  process.exit(1)
})
