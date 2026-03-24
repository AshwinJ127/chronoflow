import { create } from 'zustand'
import { DbEvent, StepStatus } from '@/lib/types'

export interface StepNodeState {
  id: string
  status: StepStatus
}

interface RunState {
  runId: string | null
  events: DbEvent[]
  stepStates: Map<string, StepStatus>
  isComplete: boolean
  workerStatus: 'online' | 'offline'

  startRun: (runId: string, stepIds: string[]) => void
  addEvent: (event: DbEvent) => void
  setComplete: () => void
  setWorkerStatus: (s: 'online' | 'offline') => void
  reset: () => void
}

export const useRunStore = create<RunState>((set) => ({
  runId: null,
  events: [],
  stepStates: new Map(),
  isComplete: false,
  workerStatus: 'offline',

  startRun: (runId, stepIds) =>
    set({
      runId,
      events: [],
      stepStates: new Map(stepIds.map((id) => [id, 'pending'])),
      isComplete: false,
    }),

  addEvent: (event) =>
    set((state) => {
      const newStates = new Map(state.stepStates)
      if (event.step_id) {
        if (event.event_type === 'STEP_STARTED') newStates.set(event.step_id, 'running')
        if (event.event_type === 'STEP_COMPLETED') newStates.set(event.step_id, 'completed')
        if (event.event_type === 'STEP_FAILED') newStates.set(event.step_id, 'failed')
      }
      return { events: [...state.events, event], stepStates: newStates }
    }),

  setComplete: () => set({ isComplete: true }),
  setWorkerStatus: (workerStatus) => set({ workerStatus }),
  reset: () => set({ runId: null, events: [], stepStates: new Map(), isComplete: false }),
}))
