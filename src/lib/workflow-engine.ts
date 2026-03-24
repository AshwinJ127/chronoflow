import db from './db'
import { WorkflowDefinition } from './types'

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]))
}

export class WorkflowEngine {
  constructor(
    private workflow: WorkflowDefinition,
    private runId: string
  ) {}

  async execute(): Promise<void> {
    const inputs: Record<string, unknown> = {}

    for (const step of this.workflow.steps) {
      // 1. Idempotency: check if step already completed
      const { rows: completed } = await db.query(
        `SELECT payload FROM events WHERE run_id=$1 AND step_id=$2 AND event_type='STEP_COMPLETED'`,
        [this.runId, step.id]
      )
      if (completed.length > 0) {
        inputs[step.id] = completed[0].payload
        continue
      }

      // 2. Avoid duplicate STEP_STARTED if crashed after start
      const { rows: started } = await db.query(
        `SELECT id FROM events WHERE run_id=$1 AND step_id=$2 AND event_type='STEP_STARTED'`,
        [this.runId, step.id]
      )
      if (started.length === 0) {
        await db.query(
          `INSERT INTO events (run_id, step_id, event_type) VALUES ($1, $2, 'STEP_STARTED')`,
          [this.runId, step.id]
        )
      }

      // 3. Execute step
      try {
        const output = await step.run(pick(inputs, step.dependsOn))
        await db.query(
          `INSERT INTO events (run_id, step_id, event_type, payload) VALUES ($1, $2, 'STEP_COMPLETED', $3)`,
          [this.runId, step.id, JSON.stringify(output)]
        )
        inputs[step.id] = output
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        try {
          await db.query(
            `INSERT INTO events (run_id, step_id, event_type, payload) VALUES ($1, $2, 'STEP_FAILED', $3)`,
            [this.runId, step.id, JSON.stringify({ error: message })]
          )
          await db.query(
            `INSERT INTO events (run_id, step_id, event_type, payload) VALUES ($1, NULL, 'RUN_FAILED', $2)`,
            [this.runId, JSON.stringify({ failed_step_id: step.id })]
          )
          await db.query(
            `UPDATE runs SET status='failed', updated_at=now() WHERE id=$1`,
            [this.runId]
          )
        } catch (dbErr) {
          console.error(`[WorkflowEngine] Failed to write failure events for run ${this.runId}:`, dbErr)
        }
        return
      }
    }

    // All steps done
    await db.query(
      `INSERT INTO events (run_id, step_id, event_type) VALUES ($1, NULL, 'RUN_COMPLETED')`,
      [this.runId]
    )
    await db.query(
      `UPDATE runs SET status='completed', updated_at=now() WHERE id=$1`,
      [this.runId]
    )
  }
}
