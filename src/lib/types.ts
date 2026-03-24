export type StepFn = (inputs: Record<string, unknown>) => Promise<unknown>

export interface StepDefinition {
  id: string
  run: StepFn
  dependsOn: string[]
}

export interface WorkflowDefinition {
  id: string
  name: string
  steps: StepDefinition[]
}

export type EventType =
  | 'RUN_STARTED'
  | 'STEP_STARTED'
  | 'STEP_COMPLETED'
  | 'STEP_FAILED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'

export interface DbEvent {
  id: number
  run_id: string
  step_id: string | null
  event_type: EventType
  payload: Record<string, unknown> | null
  created_at: string
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface StepState {
  id: string
  status: StepStatus
}

export interface RunRow {
  id: string
  workflow_id: string
  status: 'running' | 'completed' | 'failed'
  created_at: string
  updated_at: string
}
