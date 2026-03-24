import { WorkflowDefinition } from '../lib/types'
import { dataPipelineWorkflow } from './data-pipeline'

export const workflows: WorkflowDefinition[] = [dataPipelineWorkflow]

export function findWorkflow(id: string): WorkflowDefinition | undefined {
  return workflows.find((w) => w.id === id)
}
