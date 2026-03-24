# Chronoflow

A distributed workflow orchestration engine built from scratch — think a minimal Temporal or Conductor. Workflows are defined in code, executed by a supervised worker process, and survive crashes by replaying an append-only PostgreSQL event log.

**Live demo:** https://chronoflow.fly.dev

![Chronoflow UI](https://raw.githubusercontent.com/AshwinJ127/chronoflow/main/docs/screenshot.png)

---

## What it does

You define a workflow as a DAG of typed steps:

```ts
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

Submit a run, and the engine:
- Executes steps in dependency order, passing outputs downstream
- Writes every state transition to an immutable event log
- Streams live updates to the browser via SSE
- Automatically recovers from crashes by replaying the log

---

## Architecture

```
Browser (Next.js)
  │  SSE stream (/api/events)
  │  REST API  (/api/runs, /api/workflows, /api/worker/*)
  ▼
Next.js custom server (server.ts)
  │  spawns + supervises
  ▼
Worker process (dist/worker.js)
  │  pulls jobs from          writes events to
  ▼                           ▼
BullMQ queue (Redis)     PostgreSQL event log
```

**Key design decisions:**

- **Event sourcing** — the `events` table is the source of truth. Every `STEP_STARTED`, `STEP_COMPLETED`, `RUN_FAILED` is an immutable append. No state lives in memory.
- **Replay-based recovery** — on worker restart, `WorkflowEngine` queries the event log, skips already-completed steps, and resumes from the crash point. Steps are never double-executed.
- **Same-VM supervisor** — the Next.js server spawns the worker as a child process. This means `SIGKILL` (the crash demo) and automatic respawn are achievable without a separate process manager.
- **SSE over WebSockets** — the event stream is a long-poll over HTTP. Simple, proxy-friendly, no additional infrastructure.

---

## Crash recovery demo

The UI has a **⚡ Kill Worker** button that SIGKILLs the worker process mid-run.

```
[worker] Processing run abc-123
POST /api/debug/kill-worker 200
[supervisor] Worker exited (code=null signal=SIGKILL)
[supervisor] Respawning worker...
[worker] Crash recovery: 1 running run(s) found
[worker] Resuming run abc-123         ← picks up exactly where it left off
```

The run resumes from the last completed step. Kill it again mid-recovery — same result.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 14 (App Router, custom server) |
| Language | TypeScript |
| Queue | BullMQ + Redis |
| Database | PostgreSQL (pg) |
| Visualization | React Flow v11 + dagre auto-layout |
| State | Zustand |
| Styling | Tailwind CSS |
| Tests | Vitest |
| Deploy | Fly.io |

---

## Running locally

**Prerequisites:** Docker, Node.js 18+

```bash
git clone https://github.com/AshwinJ127/chronoflow.git
cd chronoflow
npm install
```

Start Postgres and Redis:
```bash
docker compose up -d
```

Run the DB migration:
```bash
psql postgres://chronoflow:chronoflow@localhost:5433/chronoflow -f db/schema.sql
```

Build the worker (required before starting — the server spawns `dist/worker.js`):
```bash
npx tsc --project tsconfig.worker.json
```

Start the app:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Project structure

```
chronoflow/
├── server.ts                    # Custom Next.js server; starts worker supervisor
├── worker.ts                    # Worker entry point: BullMQ consumer + crash recovery
├── src/
│   ├── app/
│   │   ├── page.tsx             # Main UI: canvas + event log + controls
│   │   └── api/
│   │       ├── runs/            # GET/POST runs, GET /runs/:id
│   │       ├── events/          # SSE stream (poll-and-push, 500ms interval)
│   │       ├── worker/status/   # Worker liveness check
│   │       └── debug/kill-worker/  # SIGKILL for crash demo
│   ├── lib/
│   │   ├── workflow-engine.ts   # Core replay + idempotency logic (no BullMQ dep)
│   │   ├── supervisor.ts        # Child process management; globalThis for shared state
│   │   ├── db.ts                # pg Pool singleton (globalThis to survive HMR)
│   │   └── types.ts             # Shared TypeScript types
│   ├── components/
│   │   ├── WorkflowCanvas.tsx   # React Flow DAG with dagre layout
│   │   ├── StepNode.tsx         # Custom node: pending/running/completed/failed states
│   │   └── EventLog.tsx         # Live event stream sidebar
│   ├── store/runStore.ts        # Zustand: events → step states
│   └── workflows/
│       ├── data-pipeline.ts     # Example: fetch GitHub API → transform → aggregate
│       └── steps/               # Individual step implementations
├── db/schema.sql                # workflows, runs, events tables
├── docker-compose.yml           # Postgres + Redis for local dev
└── fly.toml                     # Fly.io deployment config
```

---

## How WorkflowEngine works

```ts
for (const step of workflow.steps) {
  // 1. Already completed on a previous attempt? Skip and use stored output.
  const completed = await db.query(
    `SELECT payload FROM events WHERE run_id=$1 AND step_id=$2 AND event_type='STEP_COMPLETED'`,
    [runId, step.id]
  )
  if (completed.rows.length > 0) {
    inputs[step.id] = completed.rows[0].payload
    continue
  }

  // 2. Started but not completed (crashed mid-step)? Don't insert duplicate STEP_STARTED.
  const started = await db.query(
    `SELECT id FROM events WHERE run_id=$1 AND step_id=$2 AND event_type='STEP_STARTED'`,
    [runId, step.id]
  )
  if (started.rows.length === 0) {
    await db.query(`INSERT INTO events ...STEP_STARTED...`)
  }

  // 3. Execute and record result.
  const output = await step.run(pick(inputs, step.dependsOn))
  await db.query(`INSERT INTO events ...STEP_COMPLETED...`)
  inputs[step.id] = output
}
```

This is the same pattern used by production workflow engines — the event log is the lock, the checkpoint, and the audit trail simultaneously.

---

## Deploying to Fly.io

```bash
fly launch --no-deploy --name chronoflow
fly postgres create --name chronoflow-db --region iad --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 1
fly postgres attach chronoflow-db
fly redis create --name chronoflow-redis --region iad --plan free
fly secrets set REDIS_URL=<url-from-above>
fly deploy
```

The `release_command` in `fly.toml` runs `npm run db:migrate` automatically on each deploy.
