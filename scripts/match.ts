/**
 * End-to-end pipeline check with no API keys and no database:
 * collect real jobs -> parse -> dedupe -> score -> rank.
 *
 *   npm run jobs:match
 *
 * This is the honesty check on the whole design. If the deterministic core
 * cannot rank real postings sensibly on its own, no amount of AI narration on
 * top will fix it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collect } from '../src/lib/jobs/registry.ts';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import { scoreJob } from '../src/lib/match/score.ts';

const here = dirname(fileURLToPath(import.meta.url));

const TARGET_COUNTRIES = ['DE', 'NL', 'SE', 'FI', 'DK', 'NO', 'IE', 'BE', 'AT', 'FR', 'CH', 'LU'];

// Deliberately broad (spec §13): searching only the exact current job title
// would miss most of the roles this profile actually fits.
const TARGET_TITLES = [
  'Oracle Developer',
  'PL/SQL Developer',
  'Database Developer',
  'Database Engineer',
  'SQL Developer',
  'ERP Developer',
  'ERP Consultant',
  'Application Developer',
  'Backend Developer',
  'Software Developer',
  'Software Engineer',
  'Data Engineer',
  'Technical Consultant',
];

async function main() {
  const profile = CandidateProfile.parse(
    JSON.parse(readFileSync(join(here, '..', 'data', 'profile.sample.v3.json'), 'utf8'))
  );
  console.log(`profile v${profile.version}: ${profile.name}, ${profile.totalYears}y, ${profile.skills.length} evidenced skills\n`);

  const { jobs, perSource, duplicatesCollapsed } = await collect({
    countries: TARGET_COUNTRIES,
    titles: TARGET_TITLES,
    keywords: ['oracle', 'plsql', 'postgresql', 'sql', 'database', 'erp'],
    postedWithinDays: 30,
    limit: 400,
  });

  for (const s of perSource) {
    const status = s.configured ? `${s.fetched} jobs in ${(s.ms / 1000).toFixed(1)}s` : 'not configured';
    console.log(`  ${s.slug.padEnd(10)} ${status}`);
    for (const w of s.warnings) console.log(`             ${w}`);
  }
  const unique = jobs;
  console.log(`
  ${unique.length} unique jobs (${duplicatesCollapsed} duplicates collapsed)
`);

  const scored = unique
    .map((job) => ({ job, match: scoreJob(profile, job, { preferredCountries: TARGET_COUNTRIES }) }))
    .sort((a, b) => b.match.overall - a.match.overall);

  const counts = { highly_recommended: 0, possible: 0, low: 0 };
  for (const { match } of scored) counts[match.recommendation] += 1;
  const outOfScope = scored.filter((s) => s.match.relevance.outOfScope).length;
  console.log(`  ${outOfScope} filtered out as not-a-software-role`);
  console.log(`scored ${scored.length}: ${counts.highly_recommended} highly recommended, ${counts.possible} possible, ${counts.low} low\n`);

  console.log('='.repeat(78));
  for (const { job, match } of scored.slice(0, 8)) {
    const c = match.components;
    console.log(`${match.overall}%  ${match.recommendation.toUpperCase().replace(/_/g, ' ')}`);
    console.log(`  ${job.title}`);
    console.log(`  ${job.company} — ${job.city ?? '?'}, ${job.country ?? 'country unknown'} (${job.remote})`);
    console.log(
      `  tech ${c.technical.score}  exp ${c.experience.score}  edu ${c.education.score}  ` +
        `loc ${c.location.score}  lang ${c.language.score}  ai ${c.aiTools.score}`
    );
    if (match.strongMatches.length) console.log(`  strong:  ${match.strongMatches.join(', ')}`);
    if (match.partialMatches.length) console.log(`  partial: ${match.partialMatches.join(', ')}`);
    if (match.missingSkills.length) console.log(`  missing: ${match.missingSkills.join(', ')}`);
    console.log(`  visa: ${job.visaSponsorship}   relocation: ${job.relocationSupport}   languages: ${job.languages.join(', ') || 'none stated'}`);
    for (const b of match.blockers) console.log(`  BLOCKER: ${b}`);
    console.log(`  role: ${match.relevance.discipline}`);
    console.log(`  why: ${c.technical.reasons[0]}`);
    console.log('-'.repeat(78));
  }

  const sponsoring = scored.filter((s) => s.job.visaSponsorship === 'yes');
  console.log(`\npostings that explicitly mention visa sponsorship: ${sponsoring.length}`);
  for (const { job, match } of sponsoring.slice(0, 5)) {
    console.log(`  ${match.overall}%  ${job.title} — ${job.company} (${job.country ?? '?'})`);
  }
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
