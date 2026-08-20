import 'dotenv/config';
import { Pool, types } from 'pg';

/**
 * PostgreSQL access.
 *
 * bigint (OID 20) arrives from node-postgres as a STRING, because a Postgres
 * bigint can exceed Number.MAX_SAFE_INTEGER. Every id and every score column
 * here is well inside the safe range, so they are converted to numbers -- with a
 * check, so a value that genuinely could not survive the conversion throws
 * instead of silently losing precision.
 */
types.setTypeParser(types.builtins.INT8, (value) => {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${value} exceeds the safe integer range`);
  return n;
});
types.setTypeParser(types.builtins.NUMERIC, (value) => (value === null ? null : Number(value)));

let pool: Pool | null = null;

/**
 * One pool for the whole process.
 *
 * Next.js hot-reloads modules in development, so a pool created at module scope
 * leaks a new one on every reload until Postgres refuses connections. Stashing
 * it on globalThis survives the reload.
 */
export function getPool(): Pool {
  const globalRef = globalThis as typeof globalThis & { __eurojobPool?: Pool };
  if (globalRef.__eurojobPool) return globalRef.__eurojobPool;

  pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'eurojob',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
    max: Number(process.env.PGPOOL_MAX || 10),
  });
  globalRef.__eurojobPool = pool;
  return pool;
}

export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already broken; the original error is the useful one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** True when the database is reachable and migrated. Used by the UI to guide setup. */
export async function isReady(): Promise<{ ready: boolean; reason?: string }> {
  try {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'jobs'`
    );
    if (rows[0]?.n === 0) return { ready: false, reason: 'Database reachable but not migrated. Run: npm run db:migrate' };
    return { ready: true };
  } catch (err) {
    return { ready: false, reason: `Cannot reach PostgreSQL: ${err instanceof Error ? err.message : String(err)}` };
  }
}
