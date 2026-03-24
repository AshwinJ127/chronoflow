# Chronoflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a distributed workflow orchestration engine with a live React Flow execution canvas, PostgreSQL event log, Redis/BullMQ queue, and a crash-recovery demo.

**Architecture:** Next.js 14 custom server spawns a Node.js worker as a supervised child process on the same VM. The worker pulls jobs from BullMQ, writes events to an append-only PostgreSQL event log, and replays that log on restart to resume crashed runs. The browser visualizes execution via Server-Sent Events.

**Tech Stack:** Next.js 14, TypeScript, PostgreSQL (pg), Redis (ioredis + bullmq), React Flow v11, Zustand, Tailwind CSS, Vitest, Fly.io

---

## File Structure

```
chronoflow/
├── server.ts                          # Custom Next.js server; starts worker supervisor
├── src/
│   ├── app/
│   │   ├── layout.tsx                 # Root layout with Tailwind
│   │   ├── page.tsx                   # Main UI: canvas + event log + controls
│   │   └── api/
│   │       ├── workflows/route.ts     # GET /api/workflows
│   │       ├── runs/
│   │       │   ├── route.ts           # GET /api/runs, POST /api/runs
│   │       │   └── [id]/route.ts      # GET /api/runs/:id
│   │       ├── events/route.ts        # GET /api/events?runId=X&after=N (SSE)
│   │       ├── worker/
│   │       │   └── status/route.ts    # GET /api/worker/status
│   │       └── debug/
│   │           └── kill-worker/route.ts  # POST /api/debug/kill-worker
│   ├── lib/
│   │   ├── db.ts                      # pg Pool singleton
│   │   ├── redis.ts                   # ioredis connection singleton
│   │   ├── supervisor.ts              # Worker child process management + kill
│   │   ├── workflow-engine.ts         # Core replay/execution logic (no BullMQ dep)
│   │   └── types.ts                   # Shared TypeScript types
│   ├── components/
│   │   ├── WorkflowCanvas.tsx         # React Flow DAG with dagre layout
│   │   ├── StepNode.tsx               # Custom React Flow node (state colors)
│   │   └── EventLog.tsx               # SSE event log sidebar
│   ├── store/
│   │   └── runStore.ts                # Zustand store: events → node states
│   ├── workflows/
│   │   ├── index.ts                   # Workflow registry array
│   │   ├── data-pipeline.ts           # WorkflowDefinition object
│   │   └── steps/
│   │       ├── fetch.ts               # fetchGitHubStats (HTTP + 1.5s delay)
│   │       ├── transform.ts           # transformData (normalize + derive)
│   │       └── aggregate.ts           # aggregateResults (format summary)
│   └── worker.ts                      # Worker entry point (compiled → dist/worker.js)
├── db/
│   └── schema.sql                     # CREATE TABLE IF NOT EXISTS (idempotent)
├── __tests__/
│   ├── workflow-engine.test.ts        # Unit: replay logic, idempotency guard
│   └── runs-api.test.ts               # Integration: POST /api/runs round-trip
├── docker-compose.yml                 # Local dev: postgres + redis
├── fly.toml                           # Fly.io deployment
├── package.json
├── tsconfig.json                      # Next.js tsconfig
├── tsconfig.worker.json               # Worker tsconfig (CommonJS output → dist/)
├── tailwind.config.ts
└── vitest.config.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.worker.json`
- Create: `tailwind.config.ts`
- Create: `vitest.config.ts`
- Create: `docker-compose.yml`
- Create: `.gitignore`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "chronoflow",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "npx tsx server.ts",
    "build": "next build && tsc --project tsconfig.worker.json",
    "start": "NODE_ENV=production node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "psql $DATABASE_URL -f db/schema.sql"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "^18",
    "react-dom": "^18",
    "pg": "^8.12.0",
    "ioredis": "^5.3.2",
    "bullmq": "^5.4.2",
    "reactflow": "^11.11.4",
    "@dagrejs/dagre": "^1.1.2",
    "zustand": "^4.5.2",
    "uuid": "^10.0.0"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "@types/pg": "^8.11.6",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.15.7",
    "tailwindcss": "^3.4.4",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.39",
    "vitest": "^1.6.0",
    "@vitejs/plugin-react": "^4.3.1"
  }
}
```

- [ ] **Step 2: Create tsconfig.json** (Next.js app)

```json
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/worker.ts"]
}
```

- [ ] **Step 3: Create tsconfig.worker.json** (Worker + server, CommonJS output)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["server.ts", "src/worker.ts", "src/lib/**/*.ts", "src/workflows/**/*.ts"],
  "exclude": ["node_modules", "src/app", "src/components", "src/store", "__tests__"]
}
```

- [ ] **Step 4: Create tailwind.config.ts**

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
export default config
```

- [ ] **Step 5: Create postcss.config.js**

```js
module.exports = {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
```

- [ ] **Step 6: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
```

- [ ] **Step 7: Create docker-compose.yml** (local dev only)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: chronoflow
      POSTGRES_USER: chronoflow
      POSTGRES_PASSWORD: chronoflow
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'

volumes:
  postgres_data:
```

- [ ] **Step 8: Create .gitignore**

```
node_modules/
.next/
dist/
.env
.env.local
*.pid
```

- [ ] **Step 9: Create .env.local** (local dev values)

```
DATABASE_URL=postgres://chronoflow:chronoflow@localhost:5432/chronoflow
REDIS_URL=redis://localhost:6379
WORKER_RESPAWN_DELAY_MS=1000
```

- [ ] **Step 10: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 11: Start local services**

```bash
docker compose up -d
```

Expected: postgres on :5432, redis on :6379.

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.json tsconfig.worker.json tailwind.config.ts postcss.config.js vitest.config.ts docker-compose.yml .gitignore .env.local
git commit -m "chore: project scaffolding"
```

---

## Task 2: Database Schema + Client

**Files:**
- Create: `db/schema.sql`
- Create: `src/lib/db.ts`

- [ ] **Step 1: Create db/schema.sql**

```sql
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  definition  JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  status       TEXT NOT NULL DEFAULT 'running',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES runs(id),
  step_id      TEXT,
  event_type   TEXT NOT NULL,
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id, id);
```

- [ ] **Step 2: Apply schema**

```bash
npm run db:migrate
```

Expected: Tables created, no errors.

- [ ] **Step 3: Create src/lib/db.ts**

```ts
import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
})

export default pool
```

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql src/lib/db.ts
git commit -m "feat: database schema and pg client"
```

---

## Task 3: Shared Types + Redis Client

**Files:**
- Create: `src/lib/types.ts`
- Create: `src/lib/redis.ts`

- [ ] **Step 1: Create src/lib/types.ts**

```ts
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
```

- [ ] **Step 2: Create src/lib/redis.ts**

```ts
import Redis from 'ioredis'

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
})

export default redis
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts src/lib/redis.ts
git commit -m "feat: shared types and redis client"
```

---

## Task 4: Workflow Step Functions + Registry

**Files:**
- Create: `src/workflows/steps/fetch.ts`
- Create: `src/workflows/steps/transform.ts`
- Create: `src/workflows/steps/aggregate.ts`
- Create: `src/workflows/data-pipeline.ts`
- Create: `src/workflows/index.ts`

- [ ] **Step 1: Create src/workflows/steps/fetch.ts**

```ts
import { StepFn } from '@/lib/types'

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
```

- [ ] **Step 2: Create src/workflows/steps/transform.ts**

```ts
import { StepFn } from '@/lib/types'

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
```

- [ ] **Step 3: Create src/workflows/steps/aggregate.ts**

```ts
import { StepFn } from '@/lib/types'

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
```

- [ ] **Step 4: Create src/workflows/data-pipeline.ts**

```ts
import { WorkflowDefinition } from '@/lib/types'
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
```

- [ ] **Step 5: Create src/workflows/index.ts**

```ts
import { WorkflowDefinition } from '@/lib/types'
import { dataPipelineWorkflow } from './data-pipeline'

export const workflows: WorkflowDefinition[] = [dataPipelineWorkflow]

export function findWorkflow(id: string): WorkflowDefinition | undefined {
  return workflows.find((w) => w.id === id)
}
```

- [ ] **Step 6: Commit**

```bash
git add src/workflows/
git commit -m "feat: workflow definitions and step functions"
```

---

## Task 5: WorkflowEngine (Core Logic + Tests)

This is the most important file — it contains all the replay, idempotency, and execution logic completely decoupled from BullMQ.

**Files:**
- Create: `src/lib/workflow-engine.ts`
- Create: `__tests__/workflow-engine.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `__tests__/workflow-engine.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowEngine } from '../src/lib/workflow-engine'
import type { DbEvent, WorkflowDefinition } from '../src/lib/types'

// Mock pg pool — db.query is called as db.query(sqlString, valuesArray)
// so mock.calls[i] = [sqlString, valuesArray]
const mockQuery = vi.fn()
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- workflow-engine
```

Expected: FAIL — `WorkflowEngine` not defined yet.

- [ ] **Step 3: Create src/lib/workflow-engine.ts**

```ts
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test -- workflow-engine
```

Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workflow-engine.ts __tests__/workflow-engine.test.ts
git commit -m "feat: WorkflowEngine with replay and idempotency (tested)"
```

---

## Task 6: Worker Entry Point

**Files:**
- Create: `src/worker.ts`

- [ ] **Step 1: Create src/worker.ts**

```ts
import { Worker, Queue } from 'bullmq'
import db from './lib/db'
import redis from './lib/redis'
import { WorkflowEngine } from './lib/workflow-engine'
import { findWorkflow, workflows } from './workflows/index'

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
      connection: redis,
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
```

- [ ] **Step 2: Compile worker to verify no TypeScript errors**

```bash
npx tsc --project tsconfig.worker.json --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: worker entry point with BullMQ + crash recovery"
```

---

## Task 7: Worker Supervisor + Custom Server

**Files:**
- Create: `src/lib/supervisor.ts`
- Create: `server.ts`

- [ ] **Step 1: Create src/lib/supervisor.ts**

```ts
import { spawn, ChildProcess } from 'child_process'
import path from 'path'

let workerProcess: ChildProcess | null = null
let respawning = false

function spawnWorker(): void {
  const workerPath = path.join(process.cwd(), 'dist', 'worker.js')
  workerProcess = spawn('node', [workerPath], {
    stdio: 'inherit',
    env: process.env,
  })

  workerProcess.on('exit', (code, signal) => {
    console.log(`[supervisor] Worker exited (code=${code} signal=${signal})`)
    workerProcess = null
    const delay = parseInt(process.env.WORKER_RESPAWN_DELAY_MS || '1000', 10)
    if (!respawning) {
      respawning = true
      setTimeout(() => {
        respawning = false
        console.log('[supervisor] Respawning worker...')
        spawnWorker()
      }, delay)
    }
  })

  console.log(`[supervisor] Worker started (pid=${workerProcess.pid})`)
}

export function startWorker(): void {
  spawnWorker()
}

export function killWorker(): { pid: number } | null {
  if (!workerProcess || workerProcess.exitCode !== null) return null
  const pid = workerProcess.pid!
  workerProcess.kill('SIGKILL')
  return { pid }
}

export function getWorkerStatus(): { status: 'online' | 'offline'; pid?: number } {
  if (workerProcess && workerProcess.exitCode === null) {
    return { status: 'online', pid: workerProcess.pid }
  }
  return { status: 'offline' }
}
```

- [ ] **Step 2: Create server.ts**

```ts
import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { startWorker } from './src/lib/supervisor'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  // Start the worker supervisor (spawns dist/worker.js as child process)
  if (process.env.NODE_ENV === 'production' || process.env.START_WORKER === 'true') {
    startWorker()
  }

  createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  }).listen(3000, () => {
    console.log(`> Ready on http://localhost:3000`)
  })
})
```

**Note:** In dev mode, set `START_WORKER=true` in `.env.local` OR run the worker separately with `npx tsx src/worker.ts`. For production, the worker starts automatically.

- [ ] **Step 3: Add START_WORKER to .env.local**

Add this line to `.env.local`:
```
START_WORKER=true
```

- [ ] **Step 4: Compile and verify**

```bash
npx tsc --project tsconfig.worker.json --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/supervisor.ts server.ts
git commit -m "feat: worker supervisor and custom Next.js server"
```

---

## Task 8: API Routes

**Files:**
- Create: `src/app/api/workflows/route.ts`
- Create: `src/app/api/runs/route.ts`
- Create: `src/app/api/runs/[id]/route.ts`
- Create: `src/app/api/worker/status/route.ts`
- Create: `src/app/api/debug/kill-worker/route.ts`

- [ ] **Step 1: Create src/app/api/workflows/route.ts**

```ts
import { NextResponse } from 'next/server'
import db from '@/lib/db'

export async function GET() {
  const { rows } = await db.query(
    `SELECT id, name, definition, created_at FROM workflows ORDER BY created_at ASC`
  )
  return NextResponse.json(rows)
}
```

- [ ] **Step 2: Create src/app/api/runs/route.ts**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { Queue } from 'bullmq'
import db from '@/lib/db'
import redis from '@/lib/redis'

const queue = new Queue('runs', { connection: redis })

export async function GET() {
  const { rows } = await db.query(
    `SELECT id, workflow_id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 20`
  )
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.workflow_id) {
    return NextResponse.json({ error: 'workflow_id is required' }, { status: 400 })
  }

  const { rows: wfRows } = await db.query(
    `SELECT id FROM workflows WHERE id = $1`,
    [body.workflow_id]
  )
  if (wfRows.length === 0) {
    return NextResponse.json({ error: 'workflow not found' }, { status: 404 })
  }

  const { rows } = await db.query<{ id: string; workflow_id: string; status: string; created_at: string }>(
    `INSERT INTO runs (workflow_id) VALUES ($1) RETURNING id, workflow_id, status, created_at`,
    [body.workflow_id]
  )
  const run = rows[0]

  await db.query(
    `INSERT INTO events (run_id, step_id, event_type, payload) VALUES ($1, NULL, 'RUN_STARTED', $2)`,
    [run.id, JSON.stringify({ workflow_id: body.workflow_id })]
  )

  await queue.add('run', { runId: run.id, workflowId: body.workflow_id }, { jobId: run.id })

  return NextResponse.json(run, { status: 201 })
}
```

- [ ] **Step 3: Create src/app/api/runs/[id]/route.ts**

```ts
import { NextRequest, NextResponse } from 'next/server'
import db from '@/lib/db'
import { DbEvent, StepStatus } from '@/lib/types'

function deriveStepStates(events: DbEvent[], stepIds: string[]): Array<{ id: string; status: StepStatus }> {
  const stateMap = new Map<string, StepStatus>()
  for (const e of events) {
    if (!e.step_id) continue
    if (e.event_type === 'STEP_COMPLETED') stateMap.set(e.step_id, 'completed')
    else if (e.event_type === 'STEP_FAILED') stateMap.set(e.step_id, 'failed')
    else if (e.event_type === 'STEP_STARTED' && !stateMap.has(e.step_id)) stateMap.set(e.step_id, 'running')
  }
  return stepIds.map((id) => ({ id, status: stateMap.get(id) ?? 'pending' }))
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { rows: runRows } = await db.query(
    `SELECT id, workflow_id, status, created_at FROM runs WHERE id = $1`,
    [params.id]
  )
  if (runRows.length === 0) {
    return NextResponse.json({ error: 'run not found' }, { status: 404 })
  }
  const run = runRows[0]

  const { rows: wfRows } = await db.query(
    `SELECT definition FROM workflows WHERE id = $1`,
    [run.workflow_id]
  )
  const stepIds: string[] = (wfRows[0]?.definition?.steps ?? []).map((s: { id: string }) => s.id)

  const { rows: events } = await db.query<DbEvent>(
    `SELECT * FROM events WHERE run_id = $1 ORDER BY id ASC`,
    [params.id]
  )

  return NextResponse.json({
    ...run,
    steps: deriveStepStates(events, stepIds),
  })
}
```

- [ ] **Step 4: Create src/app/api/worker/status/route.ts**

```ts
import { NextResponse } from 'next/server'
import { getWorkerStatus } from '@/lib/supervisor'

export async function GET() {
  return NextResponse.json(getWorkerStatus())
}
```

- [ ] **Step 5: Create src/app/api/debug/kill-worker/route.ts**

```ts
import { NextResponse } from 'next/server'
import { killWorker } from '@/lib/supervisor'

export async function POST() {
  const result = killWorker()
  if (!result) {
    return NextResponse.json({ error: 'worker not running' }, { status: 503 })
  }
  return NextResponse.json({ killed: true, pid: result.pid })
}
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/
git commit -m "feat: API routes (workflows, runs, worker status, kill)"
```

---

## Task 9: SSE Events Route

**Files:**
- Create: `src/app/api/events/route.ts`

- [ ] **Step 1: Create src/app/api/events/route.ts**

```ts
import { NextRequest } from 'next/server'
import db from '@/lib/db'

const POLL_INTERVAL_MS = 500
const TERMINAL_EVENTS = new Set(['RUN_COMPLETED', 'RUN_FAILED'])

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const runId = searchParams.get('runId')
  const after = parseInt(searchParams.get('after') ?? '0', 10)

  if (!runId) {
    return new Response('runId required', { status: 400 })
  }

  let cursor = after
  let done = false

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      }

      while (!done) {
        const { rows } = await db.query(
          `SELECT * FROM events WHERE run_id = $1 AND id > $2 ORDER BY id ASC`,
          [runId, cursor]
        )

        for (const row of rows) {
          send(JSON.stringify(row))
          cursor = row.id
          if (TERMINAL_EVENTS.has(row.event_type)) {
            done = true
          }
        }

        if (done) {
          controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'))
          controller.close()
          return
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
    },
    cancel() {
      done = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/events/route.ts
git commit -m "feat: SSE events route with poll-and-push"
```

---

## Task 10: Zustand Store

**Files:**
- Create: `src/store/runStore.ts`

- [ ] **Step 1: Create src/store/runStore.ts**

```ts
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
```

- [ ] **Step 2: Commit**

```bash
git add src/store/runStore.ts
git commit -m "feat: Zustand store for run state"
```

---

## Task 11: React Flow Components

**Files:**
- Create: `src/components/StepNode.tsx`
- Create: `src/components/WorkflowCanvas.tsx`

- [ ] **Step 1: Create src/components/StepNode.tsx**

```tsx
import { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { StepStatus } from '@/lib/types'

interface StepNodeData {
  label: string
  status: StepStatus
}

const statusStyles: Record<StepStatus, string> = {
  pending:   'bg-slate-800 border-slate-600 text-slate-400',
  running:   'bg-blue-900 border-blue-400 text-white shadow-[0_0_12px_rgba(96,165,250,0.4)]',
  completed: 'bg-violet-800 border-violet-400 text-white',
  failed:    'bg-red-900 border-red-500 text-white',
}

const statusLabel: Record<StepStatus, string> = {
  pending:   'PENDING',
  running:   'RUNNING ···',
  completed: 'COMPLETED',
  failed:    'FAILED',
}

function StepNode({ data }: NodeProps<StepNodeData>) {
  const style = statusStyles[data.status]
  return (
    <div className={`border-2 rounded-lg px-6 py-3 min-w-[140px] text-center transition-all duration-300 ${style}`}>
      <Handle type="target" position={Position.Top} className="!bg-slate-500" />
      <div className="text-[10px] mb-1 opacity-70">{statusLabel[data.status]}</div>
      <div className="text-sm font-mono">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-slate-500" />
    </div>
  )
}

export default memo(StepNode)
```

- [ ] **Step 2: Create src/components/WorkflowCanvas.tsx**

```tsx
'use client'
import { useEffect, useMemo } from 'react'
import ReactFlow, { Node, Edge, Background, Controls, useNodesState, useEdgesState } from 'reactflow'
import dagre from '@dagrejs/dagre'
import 'reactflow/dist/style.css'
import StepNode from './StepNode'
import { useRunStore } from '@/store/runStore'
import { StepStatus } from '@/lib/types'

interface StepDef {
  id: string
  dependsOn: string[]
}

const nodeTypes = { step: StepNode }

function buildLayout(steps: StepDef[], stepStates: Map<string, StepStatus>) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 40 })

  steps.forEach((s) => g.setNode(s.id, { width: 160, height: 70 }))
  steps.forEach((s) => s.dependsOn.forEach((dep) => g.setEdge(dep, s.id)))
  dagre.layout(g)

  const nodes: Node[] = steps.map((s) => {
    const { x, y } = g.node(s.id)
    return {
      id: s.id,
      type: 'step',
      position: { x: x - 80, y: y - 35 },
      data: { label: s.id, status: stepStates.get(s.id) ?? 'pending' },
    }
  })

  const edges: Edge[] = steps.flatMap((s) =>
    s.dependsOn.map((dep) => ({
      id: `${dep}-${s.id}`,
      source: dep,
      target: s.id,
      style: { stroke: '#475569' },
      animated: stepStates.get(dep) === 'completed' && stepStates.get(s.id) === 'running',
    }))
  )

  return { nodes, edges }
}

export default function WorkflowCanvas({ steps }: { steps: StepDef[] }) {
  const stepStates = useRunStore((s) => s.stepStates)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout(steps, stepStates)
    setNodes(n)
    setEdges(e)
  }, [steps, stepStates])

  return (
    <div className="w-full h-full bg-slate-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" />
        <Controls className="!bg-slate-800 !border-slate-600" />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add src/components/StepNode.tsx src/components/WorkflowCanvas.tsx
git commit -m "feat: React Flow canvas with custom step nodes"
```

---

## Task 12: Event Log + Main Page

**Files:**
- Create: `src/components/EventLog.tsx`
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.tsx`

- [ ] **Step 1: Create src/app/globals.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 2: Create src/app/layout.tsx**

```tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Chronoflow',
  description: 'Distributed workflow orchestration engine',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-200 antialiased">{children}</body>
    </html>
  )
}
```

- [ ] **Step 3: Create src/components/EventLog.tsx**

```tsx
'use client'
import { useRunStore } from '@/store/runStore'
import { DbEvent } from '@/lib/types'

const eventColor: Record<string, string> = {
  RUN_STARTED:    'text-green-400',
  STEP_STARTED:   'text-blue-400',
  STEP_COMPLETED: 'text-violet-400',
  STEP_FAILED:    'text-red-400',
  RUN_COMPLETED:  'text-green-400',
  RUN_FAILED:     'text-red-400',
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false })
}

export default function EventLog() {
  const events = useRunStore((s) => s.events)

  return (
    <div className="h-full overflow-y-auto p-3 font-mono">
      <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Event Log</div>
      {events.length === 0 && (
        <div className="text-slate-600 text-xs">Waiting for run...</div>
      )}
      {events.map((e: DbEvent) => (
        <div key={e.id} className="text-xs leading-relaxed">
          <span className="text-slate-500">{formatTime(e.created_at)} </span>
          <span className={eventColor[e.event_type] ?? 'text-slate-300'}>{e.event_type}</span>
          {e.step_id && <span className="text-slate-400"> {e.step_id}</span>}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Create src/app/page.tsx**

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import EventLog from '@/components/EventLog'
import { useRunStore } from '@/store/runStore'

// React Flow must be loaded client-side only (uses browser APIs)
const WorkflowCanvas = dynamic(() => import('@/components/WorkflowCanvas'), { ssr: false })

interface Workflow {
  id: string
  name: string
  definition: { steps: Array<{ id: string; dependsOn: string[] }> }
}

export default function HomePage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [selectedWf, setSelectedWf] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastEventIdRef = useRef(0)

  const { startRun, addEvent, setComplete, setWorkerStatus, runId, stepStates, workerStatus, isComplete, events } = useRunStore()

  // Load workflows on mount
  useEffect(() => {
    fetch('/api/workflows').then((r) => r.json()).then((data: Workflow[]) => {
      setWorkflows(data)
      if (data.length > 0) setSelectedWf(data[0].id)
    })
  }, [])

  // Poll worker status every 2s
  useEffect(() => {
    const poll = () => {
      fetch('/api/worker/status')
        .then((r) => r.json())
        .then((d) => setWorkerStatus(d.status))
        .catch(() => setWorkerStatus('offline'))
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [setWorkerStatus])

  function openSSE(runId: string, after = 0) {
    eventSourceRef.current?.close()
    const es = new EventSource(`/api/events?runId=${runId}&after=${after}`)
    eventSourceRef.current = es

    es.onmessage = (e) => {
      const event = JSON.parse(e.data)
      lastEventIdRef.current = event.id
      addEvent(event)
    }
    es.addEventListener('done', () => {
      setComplete()
      es.close()
    })
    es.onerror = () => {
      es.close()
      // Reconnect with cursor
      setTimeout(() => openSSE(runId, lastEventIdRef.current), 1000)
    }
  }

  async function handleRun() {
    if (!selectedWf || loading) return
    setLoading(true)
    lastEventIdRef.current = 0

    const wf = workflows.find((w) => w.id === selectedWf)!
    const stepIds = wf.definition.steps.map((s) => s.id)

    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: selectedWf }),
    })
    const run = await res.json()
    startRun(run.id, stepIds)
    openSSE(run.id)
    setLoading(false)
  }

  async function handleKill() {
    await fetch('/api/debug/kill-worker', { method: 'POST' })
  }

  const selectedWorkflow = workflows.find((w) => w.id === selectedWf)
  const steps = selectedWorkflow?.definition.steps ?? []

  const completedCount = Array.from(stepStates.values()).filter((s) => s === 'completed').length
  const status = isComplete
    ? (stepStates.get(steps[steps.length - 1]?.id) === 'failed' ? 'failed' : 'completed')
    : runId ? 'running' : 'idle'

  return (
    <div className="flex flex-col h-screen">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900 shrink-0">
        <span className="text-xs text-slate-500 uppercase tracking-wider">Workflow</span>
        <select
          className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 focus:outline-none"
          value={selectedWf}
          onChange={(e) => setSelectedWf(e.target.value)}
        >
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <button
          onClick={handleRun}
          disabled={loading || !selectedWf}
          className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded"
        >
          ▶ Run
        </button>
        <div className="flex-1" />
        <span className="text-xs text-slate-500">Worker:</span>
        <span className={`text-xs px-2 py-0.5 rounded ${workerStatus === 'online' ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>
          ● {workerStatus}
        </span>
        <button
          onClick={handleKill}
          className="text-xs px-3 py-1.5 rounded border border-red-800 text-red-400 hover:bg-red-950"
        >
          ⚡ Kill Worker
        </button>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* DAG Canvas */}
        <div className="flex-1">
          <WorkflowCanvas steps={steps} />
        </div>
        {/* Event log sidebar */}
        <div className="w-72 border-l border-slate-800 bg-slate-950">
          <EventLog />
        </div>
      </div>

      {/* Status bar */}
      <div className="px-4 py-2 border-t border-slate-800 bg-slate-900 text-xs text-slate-500 flex gap-4 shrink-0">
        <span>Run: <span className="text-violet-400">{runId ? runId.slice(0, 8) + '...' : '—'}</span></span>
        <span>Status: <span className="text-slate-300">{status}</span></span>
        <span>Steps: <span className="text-slate-300">{completedCount}/{steps.length} completed</span></span>
        <span>Events: <span className="text-slate-300">{events.length}</span></span>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add src/app/ src/components/EventLog.tsx
git commit -m "feat: main page UI with canvas, event log, and controls"
```

---

## Task 13: Smoke Test End-to-End

- [ ] **Step 1: Build the worker** (must happen before starting dev — server spawns `dist/worker.js`)

```bash
npx tsc --project tsconfig.worker.json
```

Expected: `dist/worker.js` and `dist/server.js` created, no errors.

- [ ] **Step 2: Start the app in dev mode**

```bash
npm run dev
```

Expected: Next.js starts on :3000, worker spawns (you'll see `[worker] Workflows registered` in terminal).

- [ ] **Step 3: Verify the UI loads**

Open http://localhost:3000. You should see:
- "Data Pipeline" in the workflow dropdown
- Worker badge shows `● online`
- DAG canvas shows 3 nodes (fetch, transform, aggregate) in `PENDING` state

- [ ] **Step 4: Run a workflow**

Click **▶ Run**. Watch:
- `fetch` node turns blue (`RUNNING`)
- Event log shows `STEP_STARTED fetch`
- After ~1.5s: `fetch` turns purple (`COMPLETED`)
- `transform` starts running
- After ~1.5s: `transform` completes, `aggregate` starts
- After ~1s: `aggregate` completes, all nodes purple

- [ ] **Step 5: Test crash recovery**

Start another run. While `transform` is running, click **⚡ Kill Worker**. Observe:
- Worker badge briefly shows `● offline`
- Canvas pauses mid-step
- After ~1s: worker restarts, badge returns to `● online`
- Canvas resumes from where it left off — `transform` re-executes (step functions are idempotent)

- [ ] **Step 6: Run unit tests**

```bash
npm test
```

Expected: All tests passing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: complete Chronoflow MVP"
```

---

## Task 14: Fly.io Deployment

**Files:**
- Create: `fly.toml`

- [ ] **Step 1: Create fly.toml**

```toml
app = "chronoflow"
primary_region = "iad"

[build]

[env]
  NODE_ENV = "production"
  WORKER_RESPAWN_DELAY_MS = "1000"
  START_WORKER = "true"

[[services]]
  internal_port = 3000
  protocol = "tcp"
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0

  [[services.ports]]
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  cpus = 1

[deploy]
  release_command = "npm run db:migrate"
```

- [ ] **Step 2: Install Fly CLI and login**

```bash
# If not installed:
curl -L https://fly.io/install.sh | sh
fly auth login
```

- [ ] **Step 3: Create Fly app**

```bash
fly launch --no-deploy --name chronoflow
```

Expected: `fly.toml` updated with app name.

- [ ] **Step 4: Create Postgres**

```bash
fly postgres create --name chronoflow-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach chronoflow-db --app chronoflow
```

Expected: `DATABASE_URL` secret set on app.

- [ ] **Step 5: Create Redis (Upstash)**

```bash
fly redis create --name chronoflow-redis --region iad --plan free
```

Copy the Redis URL from the output, then:

```bash
fly secrets set REDIS_URL=<redis-url-from-output>
```

- [ ] **Step 6: Deploy** (migrations run automatically via `release_command` in fly.toml)

```bash
fly deploy
```

Expected: Build succeeds, migrations run automatically, app deployed. Visit `https://chronoflow.fly.dev`.

- [ ] **Step 8: Commit**

```bash
git add fly.toml
git commit -m "chore: Fly.io deployment config"
```
