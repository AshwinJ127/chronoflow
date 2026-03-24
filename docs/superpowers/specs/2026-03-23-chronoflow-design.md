# Chronoflow Design Spec

**Date:** 2026-03-23

## Overview

Chronoflow is a distributed workflow orchestration engine — a Temporal-like system built with Next.js 14, PostgreSQL, Redis/BullMQ, and React Flow. Workflows are defined in TypeScript and executed by a persistent worker process. A live React Flow canvas visualizes execution state in real time via Server-Sent Events. The headline demo is crash recovery: a "Kill Worker" button SIGKILLs the worker mid-run; it restarts, replays the event log, and resumes from the correct step.

---

## Architecture

### Services

Two process groups deployed as one Fly app (`chronoflow-api`):

| Process | Role |
|---|---|
| `web` | Next.js 14 — serves frontend + all API routes |
| `worker` | Node.js — pulls jobs from BullMQ, executes steps, writes events |

External managed services:
- **Fly Postgres** — event log, workflow definitions, run records
- **Upstash Redis** — BullMQ job queue (priority + delay support)

### Request Flow

1. User clicks **Run** → `POST /api/runs` → inserts `RUN_STARTED` event + enqueues BullMQ job
2. Worker dequeues job → executes steps in dependency order, writing `STEP_STARTED` / `STEP_COMPLETED` events per step
3. Browser holds open `GET /api/events?runId=X` (SSE) → API tails the event log every 500ms, pushes new events
4. React Flow canvas consumes SSE stream and updates node states

### Crash Recovery Flow

1. User clicks **Kill Worker** → `POST /api/debug/kill-worker` → `process.kill(workerPid, 'SIGKILL')`
2. Fly restarts the worker process automatically (process group behavior)
3. Worker boot: queries `events` for all `running` runs, finds last `STEP_COMPLETED` per run, resumes from next step
4. Idempotency guard: before executing any step, check for existing `STEP_COMPLETED` event for `(run_id, step_id)` — skip if found

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

-- One row per execution
CREATE TABLE runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id  TEXT NOT NULL REFERENCES workflows(id),
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|running|completed|failed
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Append-only event log — never updated, only inserted
CREATE TABLE events (
  id           BIGSERIAL PRIMARY KEY,  -- monotonic, used for replay ordering
  run_id       UUID NOT NULL REFERENCES runs(id),
  step_id      TEXT,                   -- null for run-level events
  event_type   TEXT NOT NULL,          -- RUN_STARTED|STEP_STARTED|STEP_COMPLETED|STEP_FAILED|RUN_COMPLETED
  payload      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_events_run_id ON events(run_id, id);
```

### Event Types

| Event | Emitted by | When |
|---|---|---|
| `RUN_STARTED` | API | On `POST /api/runs` |
| `STEP_STARTED` | Worker | Before executing a step |
| `STEP_COMPLETED` | Worker | After successful step execution |
| `STEP_FAILED` | Worker | After step throws |
| `RUN_COMPLETED` | Worker | After all steps complete |

---

## Workflow Definition Format

Workflows are TypeScript files in `src/workflows/`. Registered into the `workflows` table at worker startup.

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
```

The `run` function receives the outputs of its `dependsOn` steps as arguments. Output is serialized to `payload` in the `STEP_COMPLETED` event and passed to dependent steps on replay.

### Demo Workflow: Data Pipeline

Fetches GitHub repository stats (public API, no auth needed), transforms the data (normalize fields, compute derived metrics), aggregates into a summary object. Each step has a realistic ~1–2s delay. Three sequential steps with clear data passing between them.

---

## API Routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/workflows` | List registered workflows |
| `POST` | `/api/runs` | Create and enqueue a new run |
| `GET` | `/api/runs/:id` | Get run status + step states |
| `GET` | `/api/events?runId=X` | SSE stream of events for a run |
| `POST` | `/api/debug/kill-worker` | SIGKILL worker process (dev/demo only) |

### SSE Implementation

`GET /api/events?runId=X` opens a persistent HTTP connection. Server polls:
```sql
SELECT * FROM events WHERE run_id = $1 AND id > $2 ORDER BY id ASC
```
Every 500ms, advancing the cursor. Each new event is sent as `data: <json>\n\n`. Connection closes on `RUN_COMPLETED` or `RUN_FAILED`.

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
- **EventSource API** — SSE client, reconnects automatically
- **Zustand** — client-side run state (current events, node states)
- **Tailwind CSS** — styling
- **Next.js App Router** — pages + API routes in one project

---

## Worker

### Startup Sequence

1. Register workflows into `workflows` table (upsert)
2. Query for any `running` runs (crash recovery)
3. For each: replay event log → resume from last incomplete step
4. Start BullMQ worker, begin polling queue

### Step Execution

```
for each ready step (dependsOn all completed):
  1. Check for existing STEP_COMPLETED — skip if found (idempotency)
  2. Insert STEP_STARTED event
  3. Call step.run(dependencyOutputs)
  4. On success: insert STEP_COMPLETED with output in payload
  5. On error: insert STEP_FAILED, mark run failed
```

Steps are executed sequentially within a run (no intra-run parallelism in v1). Multiple concurrent runs are handled by separate BullMQ jobs.

---

## Deployment

### Fly.io Configuration

One Fly app with two process groups:

```toml
# fly.toml
[processes]
  web    = "node server.js"
  worker = "node worker.js"
```

Managed services:
- `fly postgres create` — Fly Postgres (shared-cpu-1x, 1GB)
- Upstash Redis via Fly Redis extension (free tier)

Three total VMs: web, worker, postgres — within Fly's free allowance.

### Environment Variables

```
DATABASE_URL       postgres://...
REDIS_URL          redis://...
WORKER_PID_FILE    /tmp/worker.pid   # written by worker on start, read by kill endpoint
```

---

## Error Handling

- **Step failure:** Insert `STEP_FAILED`, mark run `failed`, stop executing. Run is terminal — no automatic retry in v1.
- **Worker crash mid-step:** `STEP_STARTED` exists but no `STEP_COMPLETED`. On recovery, step is re-executed from scratch (step functions must be idempotent for correct behavior — documented constraint).
- **SSE disconnect:** Client `EventSource` reconnects automatically. API resumes from last received event ID (passed as query param on reconnect).
- **BullMQ job stall:** BullMQ marks jobs stalled after 30s and re-enqueues. Worker idempotency guard prevents double-execution.

---

## Testing

| Layer | What | How |
|---|---|---|
| Unit | WorkflowEngine replay logic | Jest, mock DB |
| Unit | Step idempotency guard | Jest |
| Integration | Full run end-to-end | Jest + real Postgres (Docker) |
| Integration | Crash recovery | Kill worker process in test, restart, assert correct step resumption |
| E2E | UI + SSE updates | Playwright (optional) |

---

## Known Limitations

- No intra-run parallelism (fan-out/fan-in) in v1 — steps execute sequentially
- Step functions must be idempotent (documented, not enforced)
- No authentication on API routes — demo project
- Kill Worker endpoint is always enabled (guarded by env flag in prod-like deployments)
- No workflow versioning — definition changes affect all future runs
