import { WorkflowDefinition } from '../lib/types'
import { fetchGitHubStats } from './steps/fetch'
import { transformData } from './steps/transform'
import { aggregateResults } from './steps/aggregate'

export const dataPipelineWorkflow: WorkflowDefinition = {
  id: 'data-pipeline',
  name: 'Data Pipeline',
  steps: [
    { id: 'fetch',     run: fetchGitHubStats, dependsOn: [] },
    { id: 'transform', run: transformData,    dependsOn: ['fetch'] },
    { id: 'aggregate', run: aggregateResults, dependsOn: ['transform'] },
  ],
}
