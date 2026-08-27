/**
 * Copy a local database into a managed one (Neon, Supabase, RDS).
 *
 *   npm run db:copy                 # dry run: counts only, writes nothing
 *   npm run db:copy -- --write      # actually copy
 *
 * Source: the PG* variables (your local PostgreSQL).
 * Target: TARGET_DATABASE_URL, or DATABASE_URL if that is not set.
 *
 * Why this rather than pg_dump | psql: it is **additive and idempotent**. Every
 * insert carries ON CONFLICT DO NOTHING, so a row that already exists in the
 * target is left exactly as it is, a half-finished run can simply be run again,
 * and nothing in either database is ever dropped, truncated, or deleted. A
 * restore from a dump does not have that property.
 *
 * Ids are copied verbatim so foreign keys stay valid, and the sequences are
 * moved past the highest copied id afterwards -- otherwise the next insert on
 * the target would collide with a row this script just wrote.
 */
import 'dotenv/config';
import { Client, type ClientConfig } from 'pg';

/**
 * Parents before children. Copying `matches` before `jobs` would fail on a
 * foreign key, so this order is load-bearing, not cosmetic.
 */
const TABLES = [
  'users',
  'profiles',
  'profile_skills',
  'search_preferences',
  'job_sources',
  'jobs',
  'matches',
  'applications',
  'application_events',
  'documents',
  'notifications',
  'ai_cache',
  'ai_spend',
  // `sessions` is deliberately not copied: a browser cookie signed for the old
  // deployment is of no use on the new one, and carrying live sessions across
  // hosts is a security decision nobody asked for. Users sign in again.
];

const BATCH = 200;

/**
 * Columns that point at another row in the SAME table.
 *
 * `jobs.duplicate_of` references `jobs.id`, and the batch containing a duplicate
 * is not necessarily the batch containing its canonical row -- Postgres checks
 * the foreign key at the end of each statement, so the insert fails with
 * `jobs_duplicate_of_fkey`. Found on the first real run of this script.
 *
 * The fix is two passes: insert with the column NULL, then set it once every row
 * exists. Only rows that actually have a value are updated, and the values come
 * straight from the source, so the duplicate links survive the copy intact.
 */
const SELF_REFERENCES: Record<string, string[]> = {
  jobs: ['duplicate_of'],
};

function sourceConfig(): ClientConfig {
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'eurojob',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  };
}

function targetConfig(url: string): ClientConfig {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return {
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' },
    connectionTimeoutMillis: 20_000,
  };
}

interface Column {
  name: string;
  type: string;
}

async function columnsOf(client: Client, table: string): Promise<Column[]> {
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  return rows.map((r) => ({ name: r.column_name as string, type: r.data_type as string }));
}

async function main() {
  const write = process.argv.includes('--write');
  const url = process.env.TARGET_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('Set TARGET_DATABASE_URL (or DATABASE_URL) to the managed database connection string.');
    process.exit(1);
  }

  const source = new Client(sourceConfig());
  const target = new Client(targetConfig(url));
  await source.connect();
  await target.connect();

  const { rows: whoami } = await target.query('SELECT current_database() AS db, version() AS v');
  console.log(`source : ${sourceConfig().database} on ${sourceConfig().host}`);
  console.log(`target : ${whoami[0].db}`);
  console.log(write ? 'mode   : WRITE\n' : 'mode   : dry run (pass --write to copy)\n');

  let grandTotal = 0;

  for (const table of TABLES) {
    const sourceColumns = await columnsOf(source, table);
    const targetColumns = await columnsOf(target, table);
    if (sourceColumns.length === 0) {
      console.log(`${table.padEnd(20)} not present locally, skipped`);
      continue;
    }
    if (targetColumns.length === 0) {
      console.log(`${table.padEnd(20)} MISSING IN TARGET -- run npm run db:migrate against it first`);
      continue;
    }

    // Only columns both sides agree on, so a target that is a migration ahead
    // (or behind) does not abort the copy.
    const targetByName = new Map(targetColumns.map((c) => [c.name, c]));
    const shared = sourceColumns.filter((c) => targetByName.has(c.name));

    const { rows: countRows } = await source.query(`SELECT count(*)::int AS n FROM ${table}`);
    const total = countRows[0].n as number;
    if (!write) {
      console.log(`${table.padEnd(20)} ${String(total).padStart(6)} rows would be copied (${shared.length} columns)`);
      grandTotal += total;
      continue;
    }

    const names = shared.map((c) => `"${c.name}"`).join(', ');
    let copied = 0;
    let offset = 0;

    // Ordered by ctid rather than id: not every table has an id (search_preferences
    // is keyed by user_id), and ctid gives a stable full-table walk regardless.
    for (;;) {
      const { rows } = await source.query(
        `SELECT ${names} FROM ${table} ORDER BY ctid LIMIT ${BATCH} OFFSET ${offset}`
      );
      if (rows.length === 0) break;

      const selfRefs = SELF_REFERENCES[table] ?? [];
      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const [index, row] of rows.entries()) {
        const base = index * shared.length;
        tuples.push(`(${shared.map((_, i) => `$${base + i + 1}`).join(',')})`);
        for (const column of shared) {
          const value = row[column.name];
          // Nulled on the way in and restored in a second pass; see SELF_REFERENCES.
          if (selfRefs.includes(column.name)) {
            values.push(null);
            continue;
          }
          // A JSON column holding an array must be sent as JSON text, or the
          // driver would encode it as a PostgreSQL array and the insert would
          // fail with a type error.
          const isJson = column.type === 'json' || column.type === 'jsonb';
          values.push(isJson && value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
        }
      }

      const result = await target.query(
        `INSERT INTO ${table} (${names}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
        values
      );
      copied += result.rowCount ?? 0;
      offset += rows.length;
    }

    console.log(`${table.padEnd(20)} ${String(copied).padStart(6)} inserted of ${total} (existing rows left untouched)`);

    // Second pass: now that every row exists, restore the links that point
    // within this same table.
    for (const column of SELF_REFERENCES[table] ?? []) {
      if (!shared.some((c) => c.name === column)) continue;
      const { rows: links } = await source.query(
        `SELECT id, "${column}" AS ref FROM ${table} WHERE "${column}" IS NOT NULL`
      );
      for (let i = 0; i < links.length; i += BATCH) {
        const slice = links.slice(i, i + BATCH);
        const tuples = slice.map((_, n) => `($${n * 2 + 1}::bigint, $${n * 2 + 2}::bigint)`).join(',');
        await target.query(
          `UPDATE ${table} t SET "${column}" = v.ref
             FROM (VALUES ${tuples}) AS v(id, ref)
            WHERE t.id = v.id AND t."${column}" IS NULL`,
          slice.flatMap((r) => [r.id, r.ref])
        );
      }
      if (links.length) console.log(`${''.padEnd(20)} ${String(links.length).padStart(6)} ${column} links restored`);
    }

    // Move the target's sequence past what was just written.
    if (shared.some((c) => c.name === 'id')) {
      await target.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       GREATEST((SELECT COALESCE(max(id), 1) FROM ${table}), 1))`
      );
    }

    grandTotal += copied;
  }

  console.log(`\n${write ? 'copied' : 'would copy'} ${grandTotal} rows in total`);
  if (!write) console.log('Nothing was written. Re-run with --write when the numbers look right.');

  await source.end();
  await target.end();
}

main().catch((err) => {
  console.error('\ncopy failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
