import { StepFn } from '../../lib/types'

export const aggregateResults: StepFn = async (inputs) => {
  await new Promise((r) => setTimeout(r, 1000))
  const data = inputs['transform'] as {
    name: string
    stars: number
    forks: number
    stars_per_year: number
    age_years: number
    description: string
  }
  return {
    summary: `${data.name}: ${data.stars.toLocaleString()} stars (${data.stars_per_year.toLocaleString()}/yr), ${data.forks.toLocaleString()} forks, ${data.age_years} years old. ${data.description}`,
  }
}
