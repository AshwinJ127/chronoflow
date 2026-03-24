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

  if (!workerProcess.pid) {
    console.error('[supervisor] Worker failed to start')
    return
  }
  console.log(`[supervisor] Worker started (pid=${workerProcess.pid})`)

  workerProcess.on('exit', (code, signal) => {
    console.log(`[supervisor] Worker exited (code=${code} signal=${signal})`)
    workerProcess = null
    const raw = parseInt(process.env.WORKER_RESPAWN_DELAY_MS || '1000', 10)
    const delay = isNaN(raw) ? 1000 : raw
    if (!respawning) {
      respawning = true
      setTimeout(() => {
        respawning = false
        console.log('[supervisor] Respawning worker...')
        spawnWorker()
      }, delay)
    }
  })

}

export function startWorker(): void {
  if (workerProcess && workerProcess.exitCode === null) {
    console.warn('[supervisor] Worker already running')
    return
  }
  spawnWorker()
}

export function killWorker(): { pid: number } | null {
  if (!workerProcess || workerProcess.exitCode !== null) return null
  const pid = workerProcess.pid
  if (pid === undefined) return null
  workerProcess.kill('SIGKILL')
  return { pid }
}

export function getWorkerStatus(): { status: 'online' | 'offline'; pid?: number } {
  if (workerProcess && workerProcess.exitCode === null) {
    return { status: 'online', pid: workerProcess.pid }
  }
  return { status: 'offline' }
}
