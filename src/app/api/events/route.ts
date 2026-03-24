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
        try {
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
        } catch (err) {
          console.error('[api/events] DB error:', err)
          done = true
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
