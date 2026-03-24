import { Pool } from 'pg'

const globalForPg = globalThis as typeof globalThis & { pgPool?: Pool }

if (!globalForPg.pgPool) {
  globalForPg.pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  })
}

export default globalForPg.pgPool
