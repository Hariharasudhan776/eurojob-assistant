import 'dotenv/config';
import type { JobQuery, JobSource, NormalisedJob } from './types.ts';
import { contentHash } from './parse.ts';
import { ArbeitnowSource } from './sources/arbeitnow.ts';
import { AdzunaSource } from './sources/adzuna.ts';
import { TheMuseSource } from './sources/themuse.ts';
import { JobicySource } from './sources/jobicy.ts';
import { AtsSource } from './sources/ats.ts';
import { JoobleSource } from './sources/jooble.ts';

/**
 * Source registry. Adding a source means adding one line here (spec §5) --
 * nothing downstream knows how many there are.
 *
 * Arbeitnow: no key, strong German and EU coverage.
 * Adzuna: free key, 21 country endpoints, but 500-character descriptions.
 * The Muse: no key, full descriptions, and the only source covering IRELAND --
 * which Adzuna does not serve at all and which matters most for a non-EU
 * candidate needing sponsorship.
 * Jobicy: no key, full descriptions, worldwide REMOTE roles -- the one category
 * for which the employer's country is not a visa problem, and the only coverage
 * the other three give of the Gulf and the Nordics.
 * ATS: no key, full descriptions, the EMPLOYERS' OWN boards (Greenhouse, Lever,
 * Ashby, SmartRecruiters). Upstream of every aggregator here, and the only
 * source where a vacancy disappearing is real evidence that it closed.
 * Jooble: free key, 70+ countries, SNIPPETS only. Here purely for reach --
 * Czechia, Portugal, the Nordics and the Gulf were measured at or near zero
 * across every other source, and no key-free source covers them. Its rows rank
 * below better-described ones by design; the point is that they exist at all.
 */
export const SOURCES: JobSource[] = [
  new ArbeitnowSource(),
  new AdzunaSource(),
  new TheMuseSource(),
  new JobicySource(),
  new AtsSource(),
  new JoobleSource(),
];

export interface CollectionReport {
  jobs: NormalisedJob[];
  perSource: { slug: string; configured: boolean; fetched: number; warnings: string[]; ms: number }[];
  duplicatesCollapsed: number;
}

/**
 * Collect from every configured source and consolidate duplicates.
 *
 * When the same posting arrives from two sources, the one with the fuller
 * description wins. That matters: Adzuna truncates to 500 characters, so
 * preferring the complete copy turns a low-confidence match into a
 * high-confidence one for free.
 */
export async function collect(query: JobQuery): Promise<CollectionReport> {
  const perSource: CollectionReport['perSource'] = [];
  const byHash = new Map<string, NormalisedJob>();
  let duplicatesCollapsed = 0;

  for (const source of SOURCES) {
    const configured = source.isConfigured();
    if (!configured) {
      perSource.push({
        slug: source.slug,
        configured: false,
        fetched: 0,
        warnings: [`skipped: set ${source.requiredEnv.join(' and ')} to enable`],
        ms: 0,
      });
      continue;
    }

    const started = Date.now();
    let fetched = 0;
    let warnings: string[] = [];
    try {
      const result = await source.fetch(query);
      warnings = result.warnings;
      fetched = result.jobs.length;

      for (const job of result.jobs) {
        const hash = contentHash(job);
        const existing = byHash.get(hash);
        if (!existing) {
          byHash.set(hash, job);
          continue;
        }
        duplicatesCollapsed += 1;
        // Keep whichever copy carries the fuller text.
        const better =
          (job.descriptionComplete ? 1 : 0) - (existing.descriptionComplete ? 1 : 0) ||
          job.description.length - existing.description.length;
        if (better > 0) byHash.set(hash, job);
      }
    } catch (err) {
      // One broken source must never abort the whole run.
      warnings.push(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    }
    perSource.push({ slug: source.slug, configured: true, fetched, warnings, ms: Date.now() - started });
  }

  return { jobs: [...byHash.values()], perSource, duplicatesCollapsed };
}
