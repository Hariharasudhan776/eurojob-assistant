/**
 * Collect, score, and persist. This is the command that keeps the app fed.
 *
 *   npm run sync                        collect + score for every user (no AI, no cost)
 *   npm run sync -- --explain 5         also generate AI explanations for the top 5
 *   npm run sync -- --explain 5 --user someone@example.com
 *
 * Costs nothing unless --explain is passed: collection and scoring are entirely
 * deterministic. Run it on a schedule (Task Scheduler / cron) and the web UI
 * always has fresh jobs without you doing anything.
 *
 * Multi-user shape, and why:
 *
 *  * **Jobs are collected once**, for everyone. A posting is public data, and
 *    fetching every board once per account would multiply the requests for
 *    identical results.
 *  * **Scoring runs per user**, against that person's own latest profile and
 *    their own target countries. It is free, so every user gets every job scored.
 *  * **Explanations cost money**, so they are generated for ONE user per run --
 *    by default whoever APP_USER_EMAIL is -- and charged against that user's own
 *    daily cap. Nobody's spend is ever charged to somebody else.
 */

import 'dotenv/config';
import { collect, SOURCES } from '../src/lib/jobs/registry.ts';
import { contentHash } from '../src/lib/jobs/parse.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { getPool } from '../src/lib/db/pool.ts';
import {
  ensureUser, ensureSources, findUserByEmail, latestProfile, linkDuplicates, listJobs,
  recordSourceRun, saveAiSummary, saveMatches, upsertJob, dashboardStats, usersWithProfiles,
} from '../src/lib/db/repo.ts';
import { STAGE_MODELS } from '../src/lib/ai/client.ts';
import { AiClient } from '../src/lib/ai/client.ts';
import { shouldAnalyse } from '../src/lib/ai/services.ts';
import { aiRuntime } from '../src/lib/ai/runtime.ts';
import { BudgetExceededError, DEFAULT_LIMITS } from '../src/lib/ai/budget.ts';
import { rowToJob, targetCountriesFor } from '../src/lib/match/rescore.ts';
import { DEFAULT_SEARCH } from '../src/lib/search-config.ts';

async function main() {
  const args = process.argv.slice(2);
  const explainIndex = args.indexOf('--explain');
  const explainCount = explainIndex === -1 ? 0 : Number(args[explainIndex + 1] ?? 5);
  const userIndex = args.indexOf('--user');
  const explainEmail = userIndex === -1 ? (process.env.APP_USER_EMAIL || 'local@eurojob') : String(args[userIndex + 1]);

  // Creates the CLI's own row if it does not exist yet, so a fresh install has
  // somebody to attribute the run to.
  await ensureUser(process.env.APP_USER_EMAIL || 'local@eurojob');
  await ensureSources(SOURCES.map((s) => ({ slug: s.slug, displayName: s.displayName, requiresKey: s.requiresKey })));

  const users = await usersWithProfiles();
  if (users.length === 0) {
    console.error('No profile in the database. Sign up in the web app, or run: npm run db:migrate');
    process.exit(1);
  }
  console.log(`${users.length} user${users.length === 1 ? '' : 's'} with a profile to score for\n`);

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
  console.log('storing...');
  const storedIds: number[] = [];
  for (const job of jobs) {
    storedIds.push(await upsertJob(job, contentHash(job)));
  }
  const linked = await linkDuplicates();
  console.log(`  ${storedIds.length} jobs stored, ${linked} marked as duplicates\n`);

  // --- score, per user ----------------------------------------------------
  console.log('scoring...');
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
    const highly = entries.filter((e) => e.match.recommendation === 'highly_recommended').length;
    console.log(`  ${user.email.padEnd(28)} v${profile.data.version}  ${saved} scored, ${highly} highly recommended`);
  }
  console.log('');

  // --- optional AI explanations, for one user, on their own cap -----------
  if (explainCount > 0) {
    if (!AiClient.isConfigured()) {
      console.log('ANTHROPIC_API_KEY not set, skipping explanations.');
    } else {
      await explainFor(explainEmail, explainCount);
    }
  } else {
    console.log('(no AI used, nothing spent. Pass --explain 5 to generate explanations.)');
  }

  const first = users[0]!;
  const stats = await dashboardStats(first.user_id);
  console.log(`\n${stats.total_jobs} jobs | ${stats.sponsoring} mention sponsorship`);
  console.log('\nopen the app with: npm run dev');

  await getPool().end();
}

/**
 * Explain the top matches for one user.
 *
 * Charged against that user's own ledger, so the daily cap that stops this is
 * theirs and nobody else's.
 */
async function explainFor(email: string, count: number) {
  const user = await findUserByEmail(email);
  if (!user) {
    console.log(`no account for ${email}; skipping explanations`);
    return;
  }
  const profile = await latestProfile(user.id);
  if (!profile) {
    console.log(`${email} has no profile; skipping explanations`);
    return;
  }

  const { client, services, guard } = await aiRuntime(user.id, profile.data);
  const preferredCountries = await targetCountriesFor(user.id);

  console.log(
    `explaining the top ${count} for ${email} (model ${STAGE_MODELS['match-summary']}, ` +
      `caps $${DEFAULT_LIMITS.perRunUsd.toFixed(2)}/run and $${DEFAULT_LIMITS.dailyUsd.toFixed(2)}/day, ` +
      `$${guard.spentLast24h().toFixed(4)} spent today)`
  );

  const { rows } = await listJobs(user.id, {
    minScore: Number(process.env.AI_MIN_SCORE ?? 70),
    limit: count * 3,
  });
  let done = 0;

  for (const row of rows) {
    if (done >= count) break;
    if (row.ai_summary) continue; // already explained; nothing to pay for
    const breakdown = row.breakdown as { relevance?: { outOfScope?: boolean } } | null;
    if (breakdown?.relevance?.outOfScope) continue;

    try {
      const job = rowToJob(row);
      const match = scoreJob(profile.data, job, { preferredCountries });
      if (!shouldAnalyse(match)) continue;

      const summary = await services.explainMatch(job, match);
      await saveAiSummary(row.id, profile.id, { ...summary.output, violations: summary.violations, safe: summary.safe }, client.model);
      console.log(`  ${row.overall}% ${summary.output.applyPriority.padEnd(5)} ${row.title.slice(0, 58)}`);
      done += 1;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(`  STOPPED: ${err.message}`);
        break;
      }
      console.log(`  failed on "${row.title.slice(0, 40)}": ${err instanceof Error ? err.message : err}`);
    }
  }

  // Durable before the process exits, so a charge cannot go unrecorded.
  await guard.flush();
  console.log(
    `\n  ${done} explained, $${client.stats.estimatedCostUsd.toFixed(4)} this run, ` +
      `$${guard.spentLast24h().toFixed(4)} in the last 24h for ${email}`
  );
}

main().catch((err) => {
  console.error('\nsync failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
