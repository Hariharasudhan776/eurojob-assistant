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
/**
 * Connection settings.
 *
 * `DATABASE_URL` wins when present, because that is how every managed provider
 * (Neon, Supabase, RDS) and every deployment platform hands over a database.
 * The discrete PG* variables remain the local-development path, so nothing about
 * running this on your own machine changes.
 *
 * TLS is required for a remote host and skipped for loopback: demanding it
 * locally would break a default PostgreSQL install for no gain, and *not*
 * demanding it remotely would send the password over the open internet.
 * PGSSL_NO_VERIFY exists for providers that present a self-signed certificate;
 * it weakens the check to encryption-without-identity, so it is opt-in and
 * never the default.
 */
function connectionSettings() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  // A serverless function is one short-lived process per request, so a large
  // pool per instance is how a provider's connection limit gets exhausted.
  const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const max = Number(process.env.PGPOOL_MAX || (serverless ? 3 : 10));

  if (url) {
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    return {
      connectionString: url,
      max,
      ssl: local ? undefined : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' },
      // A cold serverless invocation talking to a sleeping Neon instance needs
      // more than the 0ms default before it gives up.
      connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 15_000),
      idleTimeoutMillis: serverless ? 5_000 : 30_000,
    };
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'eurojob',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
    max,
  };
}

export function getPool(): Pool {
  const globalRef = globalThis as typeof globalThis & { __eurojobPool?: Pool };
  if (globalRef.__eurojobPool) return globalRef.__eurojobPool;

  pool = new Pool(connectionSettings());
  // An idle client dropped by the provider (Neon closes idle connections)
  // surfaces as an unhandled 'error' event that would take the process down.
  pool.on('error', (err) => {
    console.warn('[db] idle client error:', err.message);
  });
  globalRef.__eurojobPool = pool;
  return pool;
}

/** True when the app is pointed at a managed/remote database rather than loopback. */
export const isRemoteDatabase = (): boolean => {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return !['127.0.0.1', 'localhost', '::1', ''].includes(process.env.PGHOST ?? '');
  return !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
};

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
