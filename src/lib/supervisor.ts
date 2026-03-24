import { spawn, ChildProcess } from 'child_process'
import path from 'path'

// Store on globalThis so the same instance is shared between server.ts and
// Next.js API routes (which run in a separate module context in dev mode).
const g = globalThis as typeof globalThis & {
  __workerProcess?: ChildProcess | null
  __respawning?: boolean
}
if (g.__workerProcess === undefined) g.__workerProcess = null
if (g.__respawning === undefined) g.__respawning = false

function getWorkerProcess() { return g.__workerProcess ?? null }
function setWorkerProcess(p: ChildProcess | null) { g.__workerProcess = p }
function isRespawning() { return g.__respawning ?? false }
function setRespawning(v: boolean) { g.__respawning = v }

function spawnWorker(): void {
  const workerPath = path.join(process.cwd(), 'dist', 'worker.js')
  const workerProcess = spawn('node', [workerPath], {
    stdio: 'inherit',
    env: process.env,
  })
  setWorkerProcess(workerProcess)

  if (!workerProcess.pid) {
    console.error('[supervisor] Worker failed to start')
    return
  }
  console.log(`[supervisor] Worker started (pid=${workerProcess.pid})`)

  workerProcess.on('exit', (code, signal) => {
    console.log(`[supervisor] Worker exited (code=${code} signal=${signal})`)
    setWorkerProcess(null)
    const raw = parseInt(process.env.WORKER_RESPAWN_DELAY_MS || '1000', 10)
    const delay = isNaN(raw) ? 1000 : raw
    if (!isRespawning()) {
      setRespawning(true)
      setTimeout(() => {
        setRespawning(false)
        console.log('[supervisor] Respawning worker...')
        spawnWorker()
      }, delay)
    }
  })

}

export function startWorker(): void {
  const wp = getWorkerProcess()
  if (wp && wp.exitCode === null) {
    console.warn('[supervisor] Worker already running')
    return
  }
  spawnWorker()
}

export function killWorker(): { pid: number } | null {
  const wp = getWorkerProcess()
  if (!wp || wp.exitCode !== null) return null
  const pid = wp.pid
  if (pid === undefined) return null
  wp.kill('SIGKILL')
  return { pid }
}

export function getWorkerStatus(): { status: 'online' | 'offline'; pid?: number } {
  const wp = getWorkerProcess()
  if (wp && wp.exitCode === null) {
    return { status: 'online', pid: wp.pid }
  }
  return { status: 'offline' }
}
