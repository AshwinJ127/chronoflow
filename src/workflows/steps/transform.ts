import { StepFn } from '../../lib/types'

export const transformData: StepFn = async (inputs) => {
  await new Promise((r) => setTimeout(r, 1500))
  const raw = inputs['fetch'] as {
    name: string
    stars: number
    forks: number
    created_at: string
    description: string
  }
  const createdYear = new Date(raw.created_at).getFullYear()
  const currentYear = new Date().getFullYear()
  const ageYears = Math.max(currentYear - createdYear, 1)
  return {
    name: raw.name,
    stars: raw.stars,
    forks: raw.forks,
    stars_per_year: Math.round(raw.stars / ageYears),
    age_years: ageYears,
    description: raw.description,
  }
}
