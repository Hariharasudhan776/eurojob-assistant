/**
 * Full pipeline including the AI stages, against live jobs.
 *
 *   npm run jobs:analyse            # top 3 matches
 *   npm run jobs:analyse -- 5       # top 5
 *
 * Reports real token usage and estimated cost, so the cost-control claims in
 * the README are measured rather than asserted.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collect } from '../src/lib/jobs/registry.ts';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { AiClient, STAGE_MODELS } from '../src/lib/ai/client.ts';
import { shouldAnalyse } from '../src/lib/ai/services.ts';
import { aiRuntime } from '../src/lib/ai/runtime.ts';
import { BudgetExceededError, DEFAULT_LIMITS } from '../src/lib/ai/budget.ts';
import { ensureUser } from '../src/lib/db/repo.ts';
import { getPool } from '../src/lib/db/pool.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TARGET_COUNTRIES = ['DE', 'NL', 'SE', 'FI', 'DK', 'NO', 'IE', 'BE', 'AT', 'FR', 'CH', 'LU', 'PL'];
const TARGET_TITLES = [
  'Oracle Developer', 'PL/SQL Developer', 'Database Developer', 'Database Engineer',
  'Database Administrator', 'SQL Developer', 'ERP Developer', 'ERP Consultant',
  'Application Developer', 'Backend Developer', 'Software Developer', 'Software Engineer',
  'Data Engineer', 'Technical Consultant',
];

async function main() {
  const args = process.argv.slice(2);
  const wanted = Number(args.find((a) => /^\d+$/.test(a)) ?? 3);
  /**
   * Documents are opt-in.
   *
   * Measured per job: explanation $0.009, cover letter $0.053, tailored resume
   * $0.157. Generating all three for everything that clears the score threshold
   * spends 24x the triage cost on jobs the explanation may well tell you to
   * skip -- and on a real run one of the top three came back SKIP. So the
   * default is explanations only, and documents are produced for the jobs you
   * have actually decided to apply to.
   */
  const withDocuments = args.includes('--full');

  if (!AiClient.isConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set. Scoring works without it; the AI stages do not.');
    process.exit(1);
  }

  const profile = CandidateProfile.parse(
    JSON.parse(readFileSync(join(here, '..', 'data', 'profile.v3.json'), 'utf8'))
  );
  console.log(`profile v${profile.version}: ${profile.totalYears}y, ${profile.skills.length} evidenced skills\n`);

  const { jobs, perSource, duplicatesCollapsed } = await collect({
    countries: TARGET_COUNTRIES,
    titles: TARGET_TITLES,
    keywords: ['oracle', 'plsql', 'postgresql', 'sql', 'database', 'erp'],
    postedWithinDays: 30,
    limit: 400,
  });
  for (const s of perSource) {
    console.log(`  ${s.slug.padEnd(10)} ${s.configured ? `${s.fetched} jobs` : 'not configured'}`);
  }
  console.log(`  ${jobs.length} unique (${duplicatesCollapsed} duplicates collapsed)\n`);

  const scored = jobs
    .map((job) => ({ job, match: scoreJob(profile, job, { preferredCountries: TARGET_COUNTRIES }) }))
    .sort((a, b) => b.match.overall - a.match.overall);

  const eligible = scored.filter(({ match }) => shouldAnalyse(match));
  console.log(`${eligible.length} of ${scored.length} jobs are above the AI threshold (AI_MIN_SCORE=${process.env.AI_MIN_SCORE ?? 70})`);
  console.log(`analysing the top ${Math.min(wanted, eligible.length)}\n`);

  // Spend goes through the same per-user ledger the web app uses, charged to
  // APP_USER_EMAIL. A second, separate accounting path for the CLI would be a
  // way to spend past the cap without noticing.
  const userId = await ensureUser(process.env.APP_USER_EMAIL || 'local@eurojob');
  const { client: ai, services, guard, cache } = await aiRuntime(userId, profile);

  console.log(
    `limits: $${DEFAULT_LIMITS.perRunUsd.toFixed(2)}/run, $${DEFAULT_LIMITS.dailyUsd.toFixed(2)}/day ` +
      `(this user has spent $${guard.spentLast24h().toFixed(4)} in the last 24h)`
  );
  console.log(`models: summary=${STAGE_MODELS['match-summary']} letter=${STAGE_MODELS['cover-letter']} resume=${STAGE_MODELS['resume-tailor']}`);
  console.log(
    withDocuments
      ? 'mode: --full (explanation + cover letter + tailored resume, about $0.22 per job)\n'
      : 'mode: triage only (explanations, about $0.009 per job). Pass --full for documents.\n'
  );

  const results: unknown[] = [];

  for (const { job, match } of eligible.slice(0, wanted)) {
    try {
    console.log('='.repeat(78));
    console.log(`${match.overall}%  ${job.title}`);
    console.log(`       ${job.company} — ${[job.city, job.country].filter(Boolean).join(', ')} (${job.remote})`);
    console.log(`       confidence: ${match.confidence.level}   source: ${job.sourceSlug}`);
    console.log(`       ${job.url}\n`);

    const summary = await services.explainMatch(job, match);
    console.log(`VERDICT (${summary.output.applyPriority.toUpperCase()}): ${summary.output.verdict}\n`);
    console.log('Strengths:');
    for (const s of summary.output.strengths) console.log(`  + ${s}`);
    if (summary.output.concerns.length) {
      console.log('Concerns:');
      for (const c of summary.output.concerns) console.log(`  - ${c}`);
    }
    if (summary.output.preparation.length) {
      console.log('Before applying:');
      for (const p of summary.output.preparation) console.log(`  > ${p}`);
    }
    console.log(`\nverification: ${summary.safe ? 'clean' : `${summary.violations.length} violation(s)`}`);
    for (const v of summary.violations) console.log(`  [${v.severity}] ${v.detail}`);

    if (!withDocuments) {
      console.log('\n(cover letter and tailored resume skipped: pass --full to generate them)');
      results.push({ job, match, summary });
      continue;
    }

    const letter = await services.writeCoverLetter(job, match, 'technical');
    console.log(`\nCOVER LETTER (technical tone) — subject: ${letter.output.subjectLine}`);
    console.log(`  ${letter.output.greeting}`);
    console.log(`  ${letter.output.paragraphs[0]?.slice(0, 220)}...`);
    console.log(`  verification: ${letter.safe ? 'clean' : `${letter.violations.length} violation(s)`}`);
    for (const v of letter.violations) console.log(`    [${v.severity}] ${v.detail}`);

    const resume = await services.tailorResume(job, match);
    console.log(`\nTAILORED RESUME`);
    console.log(`  summary: ${resume.output.summary.slice(0, 200)}...`);
    console.log(`  skills reordered to lead with: ${resume.output.skillOrder.slice(0, 6).join(', ')}`);
    console.log(`  provenance entries: ${resume.output.provenance.length}`);
    console.log(`  verification: ${resume.safe ? 'clean' : `${resume.violations.length} violation(s)`}`);
    for (const v of resume.violations) console.log(`    [${v.severity}] ${v.detail}`);
    console.log();

    results.push({ job, match, summary, letter, resume });
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.log(`
STOPPED: ${err.message}`);
        console.log('Jobs already analysed are kept and cached; re-running resumes from here for free.');
        break;
      }
      throw err;
    }
  }

  console.log('='.repeat(78));
  const { calls, cacheHits, schemaRetries, usage, estimatedCostUsd } = ai.stats;
  console.log(`AI usage: ${calls} calls, ${cacheHits} cache hits, ${schemaRetries} schema retries`);
  console.log(`  input ${usage.inputTokens} | output ${usage.outputTokens}`);
  console.log(`  prompt cache: ${usage.cacheReadTokens} read, ${usage.cacheCreationTokens} written`);
  console.log(`  estimated cost this run: $${estimatedCostUsd.toFixed(4)}`);
  console.log(`  cache: ${cache.stats.hits} hits, ${cache.stats.misses} misses`);
  // Written durably before the process can exit.
  await guard.flush();
  console.log(`
spend this run, by stage:`);
  for (const row of guard.breakdown()) {
    console.log(`  ${row.kind.padEnd(16)} ${String(row.calls).padStart(3)} calls  $${row.usd.toFixed(4)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(16)}     $${guard.spentLast24h().toFixed(4)} of $${DEFAULT_LIMITS.dailyUsd.toFixed(2)} daily cap for this user`);

  mkdirSync(join(here, '..', 'data', 'generated'), { recursive: true });
  const out = join(here, '..', 'data', 'generated', 'analysis.json');
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nfull output written to ${out}`);
}

main().catch((err) => {
  console.error('\nfailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
