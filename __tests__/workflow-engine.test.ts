import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowEngine } from '../src/lib/workflow-engine'
import type { DbEvent, WorkflowDefinition } from '../src/lib/types'

// Mock pg pool — db.query is called as db.query(sqlString, valuesArray)
// so mock.calls[i] = [sqlString, valuesArray]
const mockQuery = vi.hoisted(() => vi.fn())
vi.mock('../src/lib/db', () => ({ default: { query: mockQuery } }))

const workflow: WorkflowDefinition = {
  id: 'test',
  name: 'Test',
  steps: [
    { id: 'a', run: vi.fn().mockResolvedValue({ val: 1 }), dependsOn: [] },
    { id: 'b', run: vi.fn().mockResolvedValue({ val: 2 }), dependsOn: ['a'] },
    { id: 'c', run: vi.fn().mockResolvedValue({ val: 3 }), dependsOn: ['b'] },
  ],
}

function makeEvent(overrides: Partial<DbEvent>): DbEvent {
  return {
    id: 1,
    run_id: 'run-1',
    step_id: null,
    event_type: 'RUN_STARTED',
    payload: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('WorkflowEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workflow.steps.forEach((s) => vi.mocked(s.run).mockResolvedValue({ val: 1 }))
  })

  it('executes all steps in order on a fresh run', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const engine = new WorkflowEngine(workflow, 'run-1')
    await engine.execute()
    expect(workflow.steps[0].run).toHaveBeenCalledOnce()
    expect(workflow.steps[1].run).toHaveBeenCalledOnce()
    expect(workflow.steps[2].run).toHaveBeenCalledOnce()
  })

  it('skips already-completed steps on replay', async () => {
    // step 'a' already completed — first two SELECT calls per step return rows
    mockQuery.mockImplementation((sql: string, values: unknown[]) => {
      // STEP_COMPLETED check for step 'a'
      if (sql.includes('STEP_COMPLETED') && values[1] === 'a') {
        return { rows: [makeEvent({ step_id: 'a', event_type: 'STEP_COMPLETED', payload: { val: 1 } })] }
      }
      // STEP_COMPLETED check for steps 'b' and 'c' — not yet done
      if (sql.includes('STEP_COMPLETED')) return { rows: [] }
      // STEP_STARTED check
      if (sql.includes('STEP_STARTED') && sql.includes('SELECT')) return { rows: [] }
      return { rows: [] }
    })
    const engine = new WorkflowEngine(workflow, 'run-1')
    await engine.execute()
    expect(workflow.steps[0].run).not.toHaveBeenCalled() // 'a' skipped
    expect(workflow.steps[1].run).toHaveBeenCalledOnce() // 'b' ran
    expect(workflow.steps[2].run).toHaveBeenCalledOnce() // 'c' ran
  })

  it('does not insert duplicate STEP_STARTED if already in log', async () => {
    // step 'a' started but not completed (crashed mid-step)
    mockQuery.mockImplementation((sql: string, values: unknown[]) => {
      if (sql.includes('STEP_COMPLETED')) return { rows: [] }
      if (sql.includes('STEP_STARTED') && sql.includes('SELECT') && values[1] === 'a') {
        return { rows: [makeEvent({ step_id: 'a', event_type: 'STEP_STARTED' })] }
      }
      return { rows: [] }
    })
    const engine = new WorkflowEngine(workflow, 'run-1')
    await engine.execute()
    // Find INSERT STEP_STARTED calls where step_id = 'a'
    const aStartedInserts = mockQuery.mock.calls.filter(
      ([sql, vals]: [string, unknown[]]) =>
        sql.includes('INSERT') && sql.includes('STEP_STARTED') && vals[1] === 'a'
    )
    expect(aStartedInserts).toHaveLength(0)
  })

  it('passes dependency outputs to downstream steps', async () => {
    mockQuery.mockImplementation((sql: string, values: unknown[]) => {
      if (sql.includes('STEP_COMPLETED') && values[1] === 'a') {
        return { rows: [makeEvent({ step_id: 'a', event_type: 'STEP_COMPLETED', payload: { val: 42 } })] }
      }
      return { rows: [] }
    })
    const engine = new WorkflowEngine(workflow, 'run-1')
    await engine.execute()
    expect(workflow.steps[1].run).toHaveBeenCalledWith({ a: { val: 42 } })
  })

  it('marks run failed and stops on step error', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    vi.mocked(workflow.steps[0].run).mockRejectedValue(new Error('network fail'))
    const engine = new WorkflowEngine(workflow, 'run-1')
    await engine.execute()
    expect(workflow.steps[1].run).not.toHaveBeenCalled()
    const runFailedInsert = mockQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes('RUN_FAILED')
    )
    expect(runFailedInsert).toBeDefined()
  })
})
