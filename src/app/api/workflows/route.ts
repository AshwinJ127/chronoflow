import { NextResponse } from 'next/server'
import db from '@/lib/db'

export async function GET() {
  const { rows } = await db.query(
    `SELECT id, name, definition, created_at FROM workflows ORDER BY created_at ASC`
  )
  return NextResponse.json(rows)
}
