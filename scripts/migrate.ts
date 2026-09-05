/**
 * Creates the database if needed and applies every migration in db/. Safe to
 * re-run: each file is written to be idempotent (CREATE IF NOT EXISTS, ADD
 * COLUMN IF NOT EXISTS), and nothing is ever dropped or truncated.
 *
 *   npm run db:migrate
 *
 * Works against a local PostgreSQL (PG* variables) or a managed one
 * (DATABASE_URL, e.g. Neon). With a connection string the database itself is
 * assumed to exist, because a managed provider creates it for you and the
 * account usually has no permission to CREATE DATABASE.
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { getPool } from '../src/lib/db/pool.ts';
import {
  backfillCountries,
  backfillSponsorship,
  backfillRoleCategories,
  ensureUser,
  ensureSources,
  promoteToAdmin,
  saveProfile,
} from '../src/lib/db/repo.ts';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import { SOURCES } from '../src/lib/jobs/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.env.PGDATABASE || 'eurojob';
const usingConnectionString = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);

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
  if (usingConnectionString) {
    console.log('using DATABASE_URL; assuming the database already exists');
  } else {
    const created = await ensureDatabase(target);
    console.log(created ? `created database "${target}"` : `database "${target}" already exists`);
  }

  const pool = getPool();

  // Applied in filename order, so 002 always follows 001. Numbering the files is
  // what makes that ordering explicit rather than accidental.
  const migrations = readdirSync(join(here, '..', 'db'))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    await pool.query(readFileSync(join(here, '..', 'db', file), 'utf8'));
    console.log(`applied ${file}`);
  }

  const email = process.env.APP_USER_EMAIL || 'local@eurojob';
  const userId = await ensureUser(email);
  console.log(`user ready: ${email} (id ${userId})`);

  // The admin account (this one, unless APP_ADMIN_EMAIL overrides it) gets the
  // admin flag and is marked active, so there is always someone who can approve
  // new sign-up requests. Idempotent.
  const adminEmail = process.env.APP_ADMIN_EMAIL || email;
  await promoteToAdmin(adminEmail);
  console.log(`admin: ${adminEmail}`);

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

  // Classify anything collected before role_category existed. Reads and updates
  // only; no row is removed.
  const backfill = await backfillRoleCategories();
  console.log(`role categories: ${backfill.updated} updated of ${backfill.scanned} jobs`);

  // A parser improvement does not reach stored rows on its own. Cheap when
  // there is nothing to do -- it only reads rows whose country is already NULL.
  const places = await backfillCountries();
  console.log(`countries: ${places.placed} placed of ${places.scanned} unplaced jobs`);

  // Same reason, and it reads every row rather than only the blank ones: this
  // detector corrects in both directions, and a posting wrongly marked "no" is
  // the most valuable thing it fixes for a candidate who needs sponsorship.
  const visas = await backfillSponsorship();
  console.log(
    `sponsorship: ${visas.sponsorship} changed, relocation: ${visas.relocation} changed, of ${visas.scanned} jobs`
  );

  await pool.end();
  console.log('\nready. next: npm run sync');
}

main().catch((err) => {
  console.error('\nmigrate failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
