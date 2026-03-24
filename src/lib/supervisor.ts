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
