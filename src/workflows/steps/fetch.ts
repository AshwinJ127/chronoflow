import { StepFn } from '../../lib/types'

export const fetchGitHubStats: StepFn = async (_inputs) => {
  await new Promise((r) => setTimeout(r, 1500))
  const res = await fetch('https://api.github.com/repos/torvalds/linux', {
    headers: { 'User-Agent': 'chronoflow-demo' },
  })
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`)
  const data = await res.json()
  return {
    name: data.full_name,
    stars: data.stargazers_count,
    forks: data.forks_count,
    created_at: data.created_at,
    description: data.description,
  }
}
