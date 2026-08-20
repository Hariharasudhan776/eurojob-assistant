/**
 * Creates the database if needed and applies the schema. Safe to re-run.
 *
 *   npm run db:migrate
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { getPool } from '../src/lib/db/pool.ts';
import { ensureUser, ensureSources, saveProfile } from '../src/lib/db/repo.ts';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import { SOURCES } from '../src/lib/jobs/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.env.PGDATABASE || 'eurojob';

async function ensureDatabase(name: string): Promise<boolean> {
  const admin = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: 'postgres',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length) return false;
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await admin.end();
  }
}

async function main() {
  const created = await ensureDatabase(target);
  console.log(created ? `created database "${target}"` : `database "${target}" already exists`);

  const pool = getPool();
  await pool.query(readFileSync(join(here, '..', 'db', '001_schema.sql'), 'utf8'));
  console.log('schema applied');

  const email = process.env.APP_USER_EMAIL || 'local@eurojob';
  const userId = await ensureUser(email);
  console.log(`user ready: ${email} (id ${userId})`);

  await ensureSources(SOURCES.map((s) => ({ slug: s.slug, displayName: s.displayName, requiresKey: s.requiresKey })));
  console.log(`sources registered: ${SOURCES.map((s) => s.slug).join(', ')}`);

  // Load the newest profile file that exists, so a fresh clone is usable at once.
  for (const version of [9, 8, 7, 6, 5, 4, 3, 2, 1]) {
    const path = join(here, '..', 'data', `profile.v${version}.json`);
    try {
      const profile = CandidateProfile.parse(JSON.parse(readFileSync(path, 'utf8')));
      const profileId = await saveProfile(userId, profile);
      console.log(`profile v${profile.version} loaded (id ${profileId}, ${profile.skills.length} skills)`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }

  await pool.end();
  console.log('\nready. next: npm run sync');
}

main().catch((err) => {
  console.error('\nmigrate failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
