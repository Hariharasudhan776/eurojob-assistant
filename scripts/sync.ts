/**
 * Collect, score, and persist. This is the command that keeps the app fed.
 *
 *   npm run sync                 collect + score everything (no AI, no cost)
 *   npm run sync -- --explain 5  also generate AI explanations for the top 5
 *
 * Costs nothing unless --explain is passed: collection and scoring are entirely
 * deterministic. Run it on a schedule (Task Scheduler / cron) and the web UI
 * always has fresh jobs without you doing anything.
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collect, SOURCES } from '../src/lib/jobs/registry.ts';
import { contentHash } from '../src/lib/jobs/parse.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { getPool } from '../src/lib/db/pool.ts';
import {
  ensureUser, ensureSources, latestProfile, linkDuplicates, listJobs,
  recordSourceRun, saveAiSummary, saveMatch, upsertJob, dashboardStats,
} from '../src/lib/db/repo.ts';
import { AiClient, STAGE_MODELS } from '../src/lib/ai/client.ts';
import { AiServices, shouldAnalyse } from '../src/lib/ai/services.ts';
import { FileCache } from '../src/lib/ai/cache.ts';
import { BudgetGuard, BudgetExceededError, SpendLedger, defaultLedgerPath, DEFAULT_LIMITS } from '../src/lib/ai/budget.ts';
import { DEFAULT_SEARCH } from '../src/lib/search-config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function main() {
  const args = process.argv.slice(2);
  const explainIndex = args.indexOf('--explain');
  const explainCount = explainIndex === -1 ? 0 : Number(args[explainIndex + 1] ?? 5);

  const email = process.env.APP_USER_EMAIL || 'local@eurojob';
  const userId = await ensureUser(email);
  await ensureSources(SOURCES.map((s) => ({ slug: s.slug, displayName: s.displayName, requiresKey: s.requiresKey })));

  const profile = await latestProfile(userId);
  if (!profile) {
    console.error('No profile in the database. Run: npm run db:migrate');
    process.exit(1);
  }
  console.log(`profile v${profile.data.version}: ${profile.data.skills.length} evidenced skills\n`);

  // --- collect ------------------------------------------------------------
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

  // --- persist + score ----------------------------------------------------
  console.log('storing and scoring...');
  let stored = 0;
  for (const job of jobs) {
    const jobId = await upsertJob(job, contentHash(job));
    const match = scoreJob(profile.data, job, { preferredCountries: DEFAULT_SEARCH.countries });
    await saveMatch(jobId, profile.id, match);
    stored += 1;
  }
  const linked = await linkDuplicates();
  console.log(`  ${stored} jobs stored and scored, ${linked} marked as duplicates\n`);

  // --- optional AI explanations -------------------------------------------
  if (explainCount > 0) {
    if (!AiClient.isConfigured()) {
      console.log('ANTHROPIC_API_KEY not set, skipping explanations.');
    } else {
      const cache = new FileCache(join(root, 'data', 'ai-cache'));
      const ledger = new SpendLedger(defaultLedgerPath(root));
      const guard = new BudgetGuard(ledger);
      const ai = new AiClient(cache, { budget: guard });
      const services = new AiServices(ai, profile.data);

      console.log(
        `explaining the top ${explainCount} (model ${STAGE_MODELS['match-summary']}, ` +
          `caps $${DEFAULT_LIMITS.perRunUsd.toFixed(2)}/run and $${DEFAULT_LIMITS.dailyUsd.toFixed(2)}/day, ` +
          `$${ledger.spentLast24h().toFixed(4)} spent today)`
      );

      const { rows } = await listJobs(userId, { minScore: Number(process.env.AI_MIN_SCORE ?? 70), limit: explainCount * 3 });
      let done = 0;

      for (const row of rows) {
        if (done >= explainCount) break;
        if (row.ai_summary) continue; // already explained; nothing to pay for
        const breakdown = row.breakdown as { relevance?: { outOfScope?: boolean } } | null;
        if (breakdown?.relevance?.outOfScope) continue;

        try {
          const job = rowToJob(row);
          const match = scoreJob(profile.data, job, { preferredCountries: DEFAULT_SEARCH.countries });
          if (!shouldAnalyse(match)) continue;

          const summary = await services.explainMatch(job, match);
          await saveAiSummary(row.id, profile.id, { ...summary.output, violations: summary.violations, safe: summary.safe }, ai.model);
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
      console.log(
        `\n  ${done} explained, $${ai.stats.estimatedCostUsd.toFixed(4)} this run, ` +
          `$${ledger.spentLast24h().toFixed(4)} in the last 24h`
      );
    }
  } else {
    console.log('(no AI used, nothing spent. Pass --explain 5 to generate explanations.)');
  }

  const stats = await dashboardStats(userId);
  console.log(`\n${stats.total_jobs} jobs | ${stats.highly_matched} highly recommended | ${stats.sponsoring} mention sponsorship`);
  console.log('\nopen the app with: npm run dev');

  await getPool().end();
}

/** Rebuild the normalised shape from a stored row, so scoring stays one code path. */
function rowToJob(row: Awaited<ReturnType<typeof listJobs>>['rows'][number]) {
  return {
    sourceSlug: row.source_slug,
    sourceJobId: String(row.id),
    url: row.url,
    title: row.title,
    company: row.company,
    country: row.country,
    city: row.city,
    remote: row.remote as 'remote' | 'hybrid' | 'onsite' | 'unknown',
    employmentType: row.employment_type,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    description: row.description,
    descriptionComplete: row.description_complete,
    languages: row.languages ?? [],
    visaSponsorship: row.visa_sponsorship as 'yes' | 'no' | 'not_specified',
    relocationSupport: row.relocation_support as 'yes' | 'no' | 'not_specified',
    postedAt: row.posted_at ? new Date(row.posted_at) : null,
    raw: {},
  };
}

main().catch((err) => {
  console.error('\nsync failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
