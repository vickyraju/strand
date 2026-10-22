import pg from 'pg'

// bigint/numeric → number, date → 'YYYY-MM-DD' string (not a JS Date)
pg.types.setTypeParser(20, Number)
pg.types.setTypeParser(1700, Number)
pg.types.setTypeParser(1082, v => v)
// timestamps → ISO strings (what JSON would produce anyway), so response schemas can say `string` and nothing is a Date
for (const oid of [1114, 1184]) pg.types.setTypeParser(oid, v => new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(v) ? v : v + 'Z').toISOString())

// DATABASE_URL: the RDS Proxy endpoint (pooled). TLS: use ?sslmode=verify-full; the container trusts the RDS CA bundle.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL ?? 10),
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
})
// A dropped idle connection (database failover, proxy restart) emits 'error'; unhandled, that would kill the process.
pool.on('error', err => console.error(JSON.stringify({ level: 'error', msg: 'idle database connection failed', err: err.message })))

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
export const snake = (s: string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase())

export interface Db { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }

const wrap = (c: pg.Pool | pg.PoolClient): Db => ({
  async query(sql, params) {
    const r = await c.query(sql, params as any[])
    return r.rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]))) as any
  },
})

export const db = wrap(pool)

export async function tx<T>(fn: (d: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    const r = await fn(wrap(c))
    await c.query('commit')
    return r
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

/** Insert/update helpers: only whitelisted camelCase keys are written; jsonb columns are stringified. */
export function pick(data: Record<string, unknown>, cols: string[], json: string[] = []) {
  const keys = Object.keys(data).filter(k => cols.includes(k) && data[k] !== undefined)
  return {
    keys,
    cols: keys.map(snake),
    vals: keys.map(k => (json.includes(k) ? JSON.stringify(data[k]) : data[k])),
  }
}
