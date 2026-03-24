# Chronoflow Design Spec

**Date:** 2026-03-23

## Overview

Chronoflow is a distributed workflow orchestration engine — a Temporal-like system built with Next.js 14, PostgreSQL, Redis/BullMQ, and React Flow. Workflows are defined in TypeScript and executed by a persistent worker process. A live React Flow canvas visualizes execution state in real time via Server-Sent Events. The headline demo is crash recovery: a "Kill Worker" button SIGKILLs the worker mid-run; it restarts automatically, replays the event log, and resumes from the correct step.

---

## Architecture

### Services

One Fly VM running two processes:

| Process | Role |
|---|---|
| Next.js server | Serves frontend + all API routes; spawns and supervises the worker as a child process |
| Worker (child) | Node.js child process spawned by the Next.js server on startup; pulls jobs from BullMQ, executes steps, writes events |

The worker runs as a `child_process.spawn` subprocess of the Next.js server. When the kill endpoint sends `SIGKILL`, the Next.js server detects the child exit via `workerProcess.on('exit', ...)` and respawns it. Both processes share the same VM, so PID-based signaling works without cross-machine coordination.

External managed services:
- **Fly Postgres** — event log, workflow definitions, run records
- **Upstash Redis** — BullMQ job queue (priority + delay support)

### Request Flow

1. User clicks **Run** → `POST /api/runs` → inserts run with `status = 'running'`, inserts `RUN_STARTED` event, enqueues BullMQ job with `{ runId }`
2. Worker dequeues job → executes steps in dependency order, writing `STEP_STARTED` / `STEP_COMPLETED` events per step, updating `runs.status` on completion
3. Browser holds open `GET /api/events?runId=X` (SSE) → API tails the event log every 500ms, pushes new events
4. React Flow canvas consumes SSE stream and updates node states

### Crash Recovery Flow

1. User clicks **Kill Worker** → `POST /api/debug/kill-worker` → Next.js server calls `workerProcess.kill('SIGKILL')` on the supervised child process reference
2. Next.js server's child exit handler detects the crash and respawns the worker
3. Worker boot: queries `runs` for all rows with `status = 'running'` AND at least one event in the log
4. For each: fetch all events ordered by `id ASC`, reconstruct `completedSteps` map (`stepId → payload`) from `STEP_COMPLETED` events, execute remaining steps (not in `completedSteps`) in order, passing reconstructed outputs as inputs
5. Idempotency guard: before executing any step, `SELECT id FROM events WHERE run_id=$1 AND step_id=$2 AND event_type='STEP_COMPLETED'` — if found, load its payload and skip execution

---

## Data Model

```sql
-- Static workflow definitions (registered at startup from TypeScript files)
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  definition  JSONB NOT NULL,   -- { steps: [{id, dependsOn[]}] }
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- One row per execution; status set to 'running' at INSERT time
CREATE TABLE runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  status       TEXT NOT NULL DEFAULT 'running',  -- running|completed|failed
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Append-only event log — never updated, only inserted
CREATE TABLE events (
  id           BIGSERIAL PRIMARY KEY,  -- monotonic, used for replay ordering
  run_id       UUID NOT NULL REFERENCES runs(id),
  step_id      TEXT,                   -- null for run-level events
  event_type   TEXT NOT NULL,
  -- RUN_STARTED | STEP_STARTED | STEP_COMPLETED | STEP_FAILED | RUN_COMPLETED | RUN_FAILED
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_events_run_id ON events(run_id, id);
```

### `runs.status` Rules

`status` defaults to `'running'` at INSERT — no separate UPDATE needed on creation.

| Transition | When | Who | SQL |
|---|---|---|---|
| inserted as `running` | On `POST /api/runs` | API | `INSERT INTO runs (workflow_id) VALUES ($1)` |
| `running` → `completed` | After emitting `RUN_COMPLETED` | Worker | `UPDATE runs SET status='completed', updated_at=now() WHERE id=$1` |
| `running` → `failed` | After emitting `RUN_FAILED` | Worker | `UPDATE runs SET status='failed', updated_at=now() WHERE id=$1` |

### Event Types

| Event | Emitted by | When | `step_id` | `payload` |
|---|---|---|---|---|
| `RUN_STARTED` | API | On `POST /api/runs` | null | `{ "workflow_id": "..." }` |
| `STEP_STARTED` | Worker | Before executing a step | step id | null |
| `STEP_COMPLETED` | Worker | After successful step execution | step id | step return value (any JSON) |
| `STEP_FAILED` | Worker | After step throws | step id | `{ "error": "message" }` |
| `RUN_COMPLETED` | Worker | After all steps complete | null | null |
| `RUN_FAILED` | Worker | After any step fails terminally | null | `{ "failed_step_id": "..." }` |

---

## Workflow Definition Format

Workflows are TypeScript files in `src/workflows/`. Registered into the `workflows` table at worker startup via `INSERT ... ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`.

```ts
export const dataPipelineWorkflow: WorkflowDefinition = {
  id: 'data-pipeline',
  name: 'Data Pipeline',
  steps: [
    { id: 'fetch',     run: fetchGitHubStats,  dependsOn: [] },
    { id: 'transform', run: transformData,     dependsOn: ['fetch'] },
    { id: 'aggregate', run: aggregateResults,  dependsOn: ['transform'] },
  ],
}

// Step function signature
type StepFn = (inputs: Record<string, unknown>) => Promise<unknown>
// `inputs` keys are step IDs from dependsOn[]; values are their STEP_COMPLETED payloads
```

### Demo Workflow: Data Pipeline

- `fetch`: Calls `https://api.github.com/repos/torvalds/linux` (public, no auth). Returns raw repo JSON. ~1.5s simulated delay.
- `transform`: Normalizes fields, computes `stars_per_year = stargazers_count / age_years`. Returns `{ name, stars, forks, stars_per_year }`.
- `aggregate`: Formats a human-readable summary string. Returns `{ summary: "..." }`.

---

## API Routes

### `GET /api/runs`

Returns the 20 most recent runs across all workflows, ordered by `created_at DESC`. Used by the frontend to populate run history and reconnect to in-progress runs on page reload.

**Response `200`:**
```json
[
  {
    "id": "550e8400-...",
    "workflow_id": "data-pipeline",
    "status": "running",
    "created_at": "2026-03-23T12:04:00Z"
  }
]
```

SQL: `SELECT id, workflow_id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 20`

### `GET /api/worker/status`

Returns the current state of the supervised worker child process. The Next.js supervisor module exposes a `getWorkerStatus()` function that inspects the `workerProcess` reference.

**Response `200`:**
```json
{ "status": "online", "pid": 1234 }
```

`status` is `"online"` if `workerProcess` is set and has not exited, `"offline"` otherwise. The frontend polls this endpoint every 2 seconds to update the worker status badge in the UI header.

### `GET /api/workflows`

Returns all registered workflows. Response includes `definition.steps` so the frontend can build the initial DAG.

**Response `200`:**
```json
[
  {
    "id": "data-pipeline",
    "name": "Data Pipeline",
    "definition": {
      "steps": [
        { "id": "fetch",     "dependsOn": [] },
        { "id": "transform", "dependsOn": ["fetch"] },
        { "id": "aggregate", "dependsOn": ["transform"] }
      ]
    },
    "created_at": "2026-03-23T00:00:00Z"
  }
]
```

### `POST /api/runs`

Creates and enqueues a new workflow run.

**Request body:**
```json
{ "workflow_id": "data-pipeline" }
```

**Response `201`:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "workflow_id": "data-pipeline",
  "status": "running",
  "created_at": "2026-03-23T12:04:00Z"
}
```

**Error `400`:** `{ "error": "workflow_id is required" }` if body is missing `workflow_id`.
**Error `404`:** `{ "error": "workflow not found" }` if `workflow_id` does not exist in the `workflows` table.

### `GET /api/runs/:id`

Returns run status and derived step states (computed from the event log, not stored).

**Response `200`:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "workflow_id": "data-pipeline",
  "status": "running",
  "created_at": "2026-03-23T12:04:00Z",
  "steps": [
    { "id": "fetch",     "status": "completed" },
    { "id": "transform", "status": "running"   },
    { "id": "aggregate", "status": "pending"   }
  ]
}
```

**Step status derivation** (scan events for run, in `id ASC` order):
- `STEP_COMPLETED` for step → `completed`
- `STEP_STARTED` with no matching `STEP_COMPLETED` → `running`
- `STEP_FAILED` for step → `failed`
- No events for step → `pending` (includes steps that were never reached due to earlier failure)

**Error `404`:** `{ "error": "run not found" }` if run ID does not exist.

### `GET /api/events?runId=X[&after=N]`

SSE stream of events for a run. `after` is the last event `id` seen by the client (integer, defaults to `0`).

Server polls every 500ms:
```sql
SELECT * FROM events WHERE run_id = $1 AND id > $2 ORDER BY id ASC
```

Each event is sent as:
```
data: {"id":42,"run_id":"...","step_id":"fetch","event_type":"STEP_COMPLETED","payload":{...},"created_at":"..."}

```

**Stream close:** After each poll, check whether the returned batch contains an event with `event_type IN ('RUN_COMPLETED', 'RUN_FAILED')`. If found, send all events from the batch, then send `event: done\ndata: {}\n\n`, then end the response.

**Client reconnect:** `EventSource` does not support query params on reconnect natively. Use a custom wrapper that:
1. Tracks `lastEventId` from the `id` field of each received event
2. On `EventSource` `error`, closes it and opens a new `EventSource` with `?runId=X&after=lastEventId`

### `POST /api/debug/kill-worker`

Kills the worker child process. Next.js server holds a module-level reference to the child process (`let workerProcess: ChildProcess`).

**Procedure:**
1. Check if `workerProcess` is set and has not already exited
2. Call `workerProcess.kill('SIGKILL')`
3. Supervisor respawns the worker automatically (see Worker Supervision below)

**Response `200`:** `{ "killed": true, "pid": 1234 }`
**Response `503`:** `{ "error": "worker not running" }` if no active child process.

**Error responses for all routes:** Unhandled exceptions return `500 { "error": "internal server error" }`.

---

## Worker Supervision

The Next.js server (`src/lib/supervisor.ts`) manages the worker as a child process:

```ts
import { spawn, ChildProcess } from 'child_process'

let workerProcess: ChildProcess | null = null

export function startWorker() {
  workerProcess = spawn('node', ['dist/worker.js'], {
    stdio: 'inherit',
    env: process.env,
  })
  workerProcess.on('exit', (code, signal) => {
    console.log(`Worker exited (code=${code} signal=${signal}), restarting in 1s`)
    setTimeout(startWorker, 1000)
  })
}

export function killWorker() {
  if (!workerProcess || workerProcess.exitCode !== null) return null
  const pid = workerProcess.pid
  workerProcess.kill('SIGKILL')
  return pid
}
```

`startWorker()` is called once from the Next.js custom server entry point (`server.ts`) on process start.

---

## Worker

### Startup Sequence

1. Upsert all workflow definitions into `workflows` table
2. Query `SELECT * FROM runs WHERE status = 'running'` for crash recovery. No additional filter — all running runs are candidates regardless of event count.
3. For each: fetch all events for that run ordered by `id ASC`, reconstruct `completedSteps` map (`stepId → payload`) from `STEP_COMPLETED` events, resume execution skipping already-completed steps
4. Start BullMQ worker

**Zero-events edge case:** If a `running` run has no events in the log (BullMQ job enqueued but never dequeued before crash), `completedSteps` is empty — all steps execute from the start. BullMQ persists jobs in Redis across restarts, so the job will be dequeued and processed normally after respawn. The crash recovery loop and the BullMQ dequeue are additive: both paths produce correct behavior via the idempotency guard.

### Step Execution (per BullMQ job)

```
// At job start, guard against re-processing a terminal run
const run = await db.query('SELECT status FROM runs WHERE id = $1', [runId])
if (run.status !== 'running') return  // skip: already completed or failed
// Note: concurrency=5 means up to 5 concurrent *runs*, not concurrent steps within
// a single run. Steps within one run always execute sequentially. BullMQ will only
// re-enqueue a job after lockDuration if the worker hasn't renewed the lock — an
// active worker renews every lockDuration/2. The terminal-run guard above handles
// the rare case where a re-enqueued stalled job races with a surviving execution.

inputs = {}  // accumulated step outputs, keyed by step id

for each step in definition order (sequential):
  1. completed = await db.query(
       'SELECT payload FROM events WHERE run_id=$1 AND step_id=$2 AND event_type=$3',
       [runId, step.id, 'STEP_COMPLETED']
     )
     if completed row found:
       inputs[step.id] = completed.payload
       continue  // idempotency: step already done, load its output and skip

  2. Check if STEP_STARTED already recorded (crashed after start, before complete):
     started = await db.query(
       'SELECT id FROM events WHERE run_id=$1 AND step_id=$2 AND event_type=$3',
       [runId, step.id, 'STEP_STARTED']
     )
     if not started: INSERT event: STEP_STARTED (run_id, step_id)
     // If already started, skip the insert — avoid duplicate STEP_STARTED events

  3. try:
       output = await step.run(pick(inputs, step.dependsOn))
       INSERT event: STEP_COMPLETED (run_id, step_id, payload=output)
       inputs[step.id] = output
     catch e:
       INSERT event: STEP_FAILED (run_id, step_id, payload={ error: e.message })
       INSERT event: RUN_FAILED (run_id, payload={ failed_step_id: step.id })
       UPDATE runs SET status='failed', updated_at=now() WHERE id=runId
       return  // stop processing

INSERT event: RUN_COMPLETED (run_id)
UPDATE runs SET status='completed', updated_at=now() WHERE id=runId
```

### BullMQ Configuration

```ts
const worker = new Worker('runs', processor, {
  connection: redisConnection,
  concurrency: 5,           // up to 5 concurrent runs
  lockDuration: 30_000,     // job considered stalled after 30s without heartbeat
  stalledInterval: 15_000,  // check for stalled jobs every 15s; re-enqueues after 1 stall check
})
```

Re-enqueued stalled jobs go to the front of the queue (BullMQ default). The terminal-run guard at the start of the processor (`if run.status !== 'running' return`) prevents double-execution.

---

## UI

### Single-page layout

```
┌─────────────────────────────────────────────────────┐
│  [workflow selector ▾]  [▶ Run]    Worker: ● online  [⚡ Kill Worker] │
├──────────────────────────────────┬──────────────────┤
│                                  │  Event Log       │
│      React Flow DAG Canvas       │  12:04:01 RUN_STARTED    │
│      (nodes animate via SSE)     │  12:04:01 STEP_STARTED fetch │
│                                  │  12:04:02 STEP_COMPLETED fetch │
│                                  │  ···             │
├──────────────────────────────────┴──────────────────┤
│  Run: abc-123  |  Status: running  |  Steps: 1/3   │
└─────────────────────────────────────────────────────┘
```

### Node State → Visual Style

| State | Background | Border | Label |
|---|---|---|---|
| `pending` | `#1e293b` | `#334155` | gray |
| `running` | `#1e40af` | `#60a5fa` (glow) | `RUNNING ···` |
| `completed` | `#7c3aed` | `#a78bfa` | `COMPLETED` |
| `failed` | `#7f1d1d` | `#ef4444` | `FAILED` |

### Tech

- **React Flow** — DAG canvas, custom node renderer
- **EventSource API** — SSE client with manual reconnect wrapper using `after` cursor
- **Zustand** — client-side run state (events array, node states derived from events)
- **Tailwind CSS** — styling
- **Next.js App Router** — pages + API routes in one project

---

## Build & Deployment

### TypeScript Compilation

Two TypeScript configs:

**`tsconfig.json`** — used by Next.js for the app:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "outDir": ".next"
  },
  "include": ["src/app", "src/lib", "src/components", "src/workflows"]
}
```

**`tsconfig.worker.json`** — used to compile the worker to `dist/worker.js`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist",
    "jsx": undefined
  },
  "include": ["src/worker.ts", "src/lib", "src/workflows"]
}
```

Build command: `npm run build` → `next build && tsc --project tsconfig.worker.json`

### Schema Migration

Schema is applied via `db/schema.sql` run once on first deploy:

```bash
npm run db:migrate
# → psql $DATABASE_URL -f db/schema.sql
```

No migration framework for v1. Schema is idempotent using `CREATE TABLE IF NOT EXISTS`.

### Fly.io Configuration

One Fly app, one VM, two processes managed by the Node.js supervisor:

```toml
# fly.toml
[build]
  [build.args]
    NODE_ENV = "production"

[[services]]
  internal_port = 3000
  protocol = "tcp"

[env]
  WORKER_RESPAWN_DELAY_MS = "1000"
```

Deploy command: `fly deploy`. The `web` process is `next start` (started via custom `server.ts` that also calls `startWorker()`).

Managed services:
- `fly postgres create` — Fly Postgres (shared-cpu-1x, 1GB)
- Upstash Redis via Fly Redis add-on (free tier)

Two VMs total: one app VM + one postgres VM — within Fly's free allowance.

### Environment Variables

```
DATABASE_URL              postgres://...
REDIS_URL                 redis://...
WORKER_RESPAWN_DELAY_MS   1000
```

Set via `fly secrets set DATABASE_URL=... REDIS_URL=...`

---

## Error Handling

- **Step failure:** Worker inserts `STEP_FAILED` + `RUN_FAILED`, sets `runs.status = 'failed'`. Terminal — no retry in v1.
- **Worker crash mid-step:** `STEP_STARTED` exists but no `STEP_COMPLETED`. On recovery, step re-executes from scratch. Step functions must be idempotent — documented constraint.
- **Re-enqueued job for terminal run:** Worker checks `runs.status` at job start; skips if `completed` or `failed`.
- **SSE disconnect:** Client reconnect wrapper opens new `EventSource` with `?after=lastEventId`.
- **BullMQ job stall:** Re-enqueued after `lockDuration` (30s). Terminal-run guard prevents double-execution.
- **Kill endpoint called with no active worker:** Returns `503 { "error": "worker not running" }`.

---

## Testing

| Layer | What | How |
|---|---|---|
| Unit | WorkflowEngine replay logic (reconstruct state from events) | Jest, mock DB |
| Unit | Step idempotency guard | Jest |
| Integration | Full run end-to-end | Jest + real Postgres (Docker Compose) |
| Integration | Crash recovery: kill child process mid-run, wait for respawn, assert correct step resumption | Jest + `child_process` |
| E2E | UI + SSE updates | Playwright (optional) |

---

## Known Limitations

- No intra-run parallelism (fan-out/fan-in) in v1 — steps execute sequentially per run
- Step functions must be idempotent (documented, not enforced)
- No authentication on API routes — demo project
- Kill Worker endpoint is always enabled (no env flag guard in v1)
- No workflow versioning — definition upsert at startup affects all future runs
- Steps after a failed step show as `pending` in the UI (not `skipped`) — acceptable for v1
