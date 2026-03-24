import { NextResponse } from 'next/server'
import db from '@/lib/db'

export async function GET() {
  try {
    const { rows } = await db.query(
      `SELECT id, name, definition, created_at FROM workflows ORDER BY created_at ASC`
    )
    return NextResponse.json(rows)
  } catch (err) {
    console.error('[api/workflows] Error:', err)
    return NextResponse.json({ error: 'internal server error' }, { status: 500 })
  }
}
