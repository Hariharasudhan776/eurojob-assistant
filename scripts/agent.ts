/**
 * The autonomous agent. Run it on a schedule and the app tends itself:
 *
 *   npm run agent               against the database .env points at (local dev)
 *   npm run agent -- --live     against the deployed database (TARGET_DATABASE_URL)
 *
 * Each run it:
 *   1. collects from every source (shared, once for everyone),
 *   2. re-scores the whole feed for every user with a profile,
 *   3. writes an in-app notification per user for each job that has newly
 *      become a top match -- once per job, ever, and never for a job the person
 *      has already applied to or closed.
 *
 * What it deliberately does NOT do: spend money. Everything here is
 * deterministic and free. Tailored resumes and cover letters stay one click
 * away behind the notification, on the user's own account and daily cap --
 * an agent that generated documents unprompted would quietly drain the API
 * budget on jobs nobody chose to pursue.
 *
 * `--live` maps TARGET_DATABASE_URL (the direct Neon string already in .env for
 * db:copy) onto DATABASE_URL for this process only. The pool reads the
 * environment lazily, so setting it before the first query is sufficient.
 */

import 'dotenv/config';
import { collect, SOURCES } from '../src/lib/jobs/registry.ts';
import { contentHash } from '../src/lib/jobs/parse.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { getPool } from '../src/lib/db/pool.ts';
import {
  ensureSources, latestProfile, linkDuplicates, notifyNewTopMatches, sweepClosedJobs,
  recordSourceRun, saveMatches, upsertJob, usersWithProfiles,
} from '../src/lib/db/repo.ts';
import { targetCountriesFor } from '../src/lib/match/rescore.ts';
import { DEFAULT_SEARCH } from '../src/lib/search-config.ts';

async function main() {
  const live = process.argv.includes('--live');
  if (live) {
    const target = process.env.TARGET_DATABASE_URL;
    if (!target) {
      console.error('--live needs TARGET_DATABASE_URL in .env (the direct Neon connection string).');
      process.exit(1);
    }
    process.env.DATABASE_URL = target;
    console.log('agent: running against the LIVE database\n');
  }

  const startedAt = Date.now();
  await ensureSources(SOURCES.map((s) => ({ slug: s.slug, displayName: s.displayName, requiresKey: s.requiresKey })));

  const users = await usersWithProfiles();
  if (users.length === 0) {
    console.error('No profile in the database; nothing to score for.');
    process.exit(1);
  }

  // --- collect (once, for everyone) ---------------------------------------
  console.log('collecting...');
  const { jobs, perSource, duplicatesCollapsed } = await collect(DEFAULT_SEARCH);
  for (const source of perSource) {
    const status = source.configured ? `${source.fetched} jobs in ${(source.ms / 1000).toFixed(1)}s` : 'not configured';
    console.log(`  ${source.slug.padEnd(10)} ${status}`);
    for (const w of source.warnings) console.log(`             ${w}`);
    await recordSourceRun(
      source.slug,
      source.configured ? 'ok' : 'skipped',
      source.warnings.length ? source.warnings.join(' | ') : null
    );
  }
  console.log(`  ${jobs.length} unique in memory (${duplicatesCollapsed} collapsed across sources)\n`);

  // --- persist ------------------------------------------------------------
  const storedIds: number[] = [];
  for (const job of jobs) {
    storedIds.push(await upsertJob(job, contentHash(job)));
  }
  const linked = await linkDuplicates();
  // AFTER the upsert, never before: a posting this run returned has just had
  // its last_seen_at refreshed, so the sweep cannot close something it just saw.
  const { closed, reopened } = await sweepClosedJobs();
  console.log(`${storedIds.length} jobs stored, ${linked} marked as duplicates`);
  console.log(`${closed} closed as expired, ${reopened} reopened\n`);

  // --- score and notify, per user ------------------------------------------
  const byId = new Map(storedIds.map((id, index) => [id, jobs[index]!]));

  for (const user of users) {
    const profile = await latestProfile(user.user_id);
    if (!profile) continue;
    const preferredCountries = await targetCountriesFor(user.user_id);

    const entries = [...byId.entries()].map(([jobId, job]) => ({
      jobId,
      match: scoreJob(profile.data, job, { preferredCountries }),
    }));
    const saved = await saveMatches(profile.id, entries);

    const notified = await notifyNewTopMatches(user.user_id);
    console.log(
      `${user.email.padEnd(28)} v${profile.data.version}  ${saved} scored, ` +
        `${notified.length} new top match${notified.length === 1 ? '' : 'es'}`
    );
    for (const n of notified.slice(0, 5)) console.log(`  → ${n.title}`);
    if (notified.length > 5) console.log(`  → …and ${notified.length - 5} more`);
  }

  console.log(`\nagent finished in ${((Date.now() - startedAt) / 1000).toFixed(0)}s. Nothing was spent.`);
  await getPool().end();
}

main().catch((err) => {
  console.error('\nagent failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
