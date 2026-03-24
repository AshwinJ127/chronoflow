import { NextResponse } from 'next/server'
import { getWorkerStatus } from '@/lib/supervisor'

export async function GET() {
  return NextResponse.json(getWorkerStatus())
}
