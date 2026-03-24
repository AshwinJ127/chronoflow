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
}).catch((err: unknown) => {
  console.error('[server] Failed to start:', err)
  process.exit(1)
})
