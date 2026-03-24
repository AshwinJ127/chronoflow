import { NextResponse } from 'next/server'
import { killWorker } from '@/lib/supervisor'

export async function POST() {
  const result = killWorker()
  if (!result) {
    return NextResponse.json({ error: 'worker not running' }, { status: 503 })
  }
  return NextResponse.json({ killed: true, pid: result.pid })
}
