import 'dotenv/config';
import type { JobQuery, JobSource, NormalisedJob } from './types.ts';
import { contentHash } from './parse.ts';
import { ArbeitnowSource } from './sources/arbeitnow.ts';
import { AdzunaSource } from './sources/adzuna.ts';

/**
 * Source registry. Adding a source means adding one line here (spec §5) --
 * nothing downstream knows how many there are.
 */
export const SOURCES: JobSource[] = [new ArbeitnowSource(), new AdzunaSource()];

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
