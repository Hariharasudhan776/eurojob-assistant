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
import { AiClient } from '../src/lib/ai/client.ts';
import { AiServices, shouldAnalyse } from '../src/lib/ai/services.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TARGET_COUNTRIES = ['DE', 'NL', 'SE', 'FI', 'DK', 'NO', 'IE', 'BE', 'AT', 'FR', 'CH', 'LU', 'PL'];
const TARGET_TITLES = [
  'Oracle Developer', 'PL/SQL Developer', 'Database Developer', 'Database Engineer',
  'Database Administrator', 'SQL Developer', 'ERP Developer', 'ERP Consultant',
  'Application Developer', 'Backend Developer', 'Software Developer', 'Software Engineer',
  'Data Engineer', 'Technical Consultant',
];

async function main() {
  const wanted = Number(process.argv[2] ?? 3);

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

  const ai = new AiClient();
  const services = new AiServices(ai, profile);
  const results: unknown[] = [];

  for (const { job, match } of eligible.slice(0, wanted)) {
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
  }

  console.log('='.repeat(78));
  const { calls, cacheHits, schemaRetries, usage, estimatedCostUsd } = ai.stats;
  console.log(`AI usage: ${calls} calls, ${cacheHits} cache hits, ${schemaRetries} schema retries`);
  console.log(`  input ${usage.inputTokens} | output ${usage.outputTokens}`);
  console.log(`  prompt cache: ${usage.cacheReadTokens} read, ${usage.cacheCreationTokens} written`);
  console.log(`  estimated cost: $${estimatedCostUsd.toFixed(4)} on ${ai.model}`);

  mkdirSync(join(here, '..', 'data', 'generated'), { recursive: true });
  const out = join(here, '..', 'data', 'generated', 'analysis.json');
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nfull output written to ${out}`);
}

main().catch((err) => {
  console.error('\nfailed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
