import type { FetchResult, JobQuery, JobSource, NormalisedJob } from '../types.ts';
import {
  contentHash,
  detectMinYears,
  detectRelocationSupport,
  detectRemote,
  detectRequiredLanguages,
  detectVisaSponsorship,
  htmlToText,
  parseLocation,
} from '../parse.ts';

/**
 * Arbeitnow — https://www.arbeitnow.com/api/job-board-api
 *
 * A public, documented, key-free job board API with strong German and wider
 * European coverage. It is the default source precisely because it needs no
 * credentials: the whole pipeline can be run and verified before any paid
 * account exists.
 *
 * The API paginates but exposes no server-side query parameters, so filtering
 * happens client-side after fetching. Pages are walked politely, with a hard
 * page cap so a run cannot turn into an unbounded crawl.
 */

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

interface ArbeitnowResponse {
  data: ArbeitnowJob[];
  links?: { next?: string | null };
}

const ENDPOINT = 'https://www.arbeitnow.com/api/job-board-api';
const MAX_PAGES = 10;

export class ArbeitnowSource implements JobSource {
  readonly slug = 'arbeitnow';
  readonly displayName = 'Arbeitnow';
  readonly homepage = 'https://www.arbeitnow.com';
  readonly requiresKey = false;
  readonly requiredEnv: string[] = [];
  readonly coverage = ['DE', 'NL', 'AT', 'CH', 'PL', 'SE', 'DK', 'FI', 'NO', 'BE', 'FR', 'IE', 'ES', 'IT', 'PT', 'CZ', 'EE', 'LU'];
  // Measured, not guessed: at 30 rpm a real run took an HTTP 429 on page 7.
  readonly rateLimit = { requestsPerMinute: 12 };

  isConfigured(): boolean {
    return true;
  }

  async fetch(query: JobQuery): Promise<FetchResult> {
    const warnings: string[] = [];
    const collected: NormalisedJob[] = [];
    const seen = new Set<string>();

    const cutoff = query.postedWithinDays
      ? Date.now() - query.postedWithinDays * 86_400_000
      : null;

    let url: string | null = ENDPOINT;
    let page = 0;

    while (url && page < MAX_PAGES && collected.length < query.limit) {
      page += 1;

      let payload: ArbeitnowResponse | null = null;
      let attempt = 0;

      // Retry only on 429 and 5xx, honouring Retry-After when the server sends
      // it. A 404 or 400 will not fix itself, so those fail immediately rather
      // than hammering the endpoint.
      while (attempt < 3 && payload === null) {
        attempt += 1;
        try {
          const response = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'eurojob-assistant (personal job search)' },
            signal: AbortSignal.timeout(20_000),
          });

          if (response.status === 429 || response.status >= 500) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const backoff = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 2_000 * 2 ** (attempt - 1);
            if (attempt >= 3) {
              warnings.push(`page ${page}: HTTP ${response.status} after ${attempt} attempts, stopping`);
              break;
            }
            warnings.push(`page ${page}: HTTP ${response.status}, backing off ${Math.round(backoff / 1000)}s`);
            await sleep(backoff);
            continue;
          }

          if (!response.ok) {
            warnings.push(`page ${page}: HTTP ${response.status}`);
            break;
          }
          payload = (await response.json()) as ArbeitnowResponse;
        } catch (err) {
          warnings.push(`page ${page}: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
      if (payload === null) break;

      if (!Array.isArray(payload.data) || payload.data.length === 0) break;

      for (const raw of payload.data) {
        if (collected.length >= query.limit) break;
        if (!raw?.slug || seen.has(raw.slug)) continue;
        seen.add(raw.slug);

        const postedAt = Number.isFinite(raw.created_at) ? new Date(raw.created_at * 1000) : null;
        if (cutoff && postedAt && postedAt.getTime() < cutoff) continue;

        const normalised = this.normalise(raw, postedAt);
        if (!normalised) continue;
        if (!matchesQuery(normalised, query)) continue;
        collected.push(normalised);
      }

      url = payload.links?.next ?? null;
      // Pace requests to stay well inside the declared rate limit.
      if (url) await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
    }

    if (page >= MAX_PAGES && collected.length < query.limit) {
      warnings.push(`stopped at the ${MAX_PAGES}-page cap; increase it to widen the sweep`);
    }
    return { jobs: collected, warnings };
  }

  private normalise(raw: ArbeitnowJob, postedAt: Date | null): NormalisedJob | null {
    const description = htmlToText(raw.description ?? '');
    if (!description || !raw.title || !raw.company_name) return null;

    const { country, city } = parseLocation(raw.location);
    // The API's boolean `remote` only ever asserts remote; it never distinguishes
    // hybrid from on-site, so the text is the better signal when it is false.
    const remote = raw.remote ? 'remote' : detectRemote(`${raw.location} ${description}`, raw.tags ?? []);

    return {
      sourceSlug: this.slug,
      sourceJobId: raw.slug,
      url: raw.url,
      title: raw.title.trim(),
      company: raw.company_name.trim(),
      country,
      city,
      remote,
      employmentType: raw.job_types?.[0] ?? null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      description,
      // Arbeitnow returns the employer's full posting body.
      descriptionComplete: true,
      languages: detectRequiredLanguages(description),
      visaSponsorship: detectVisaSponsorship(description),
      relocationSupport: detectRelocationSupport(description),
      postedAt,
      raw,
    };
  }
}

/**
 * Client-side filtering, applied because this API takes no query parameters.
 *
 * Title matching is token-based rather than exact (spec §13): a profile aimed at
 * "Database Developer" should also surface "PL/SQL Developer" and "Oracle
 * Engineer", so any query title whose significant words all appear in the
 * posting title counts as a hit.
 */
export function matchesQuery(job: NormalisedJob, query: JobQuery): boolean {
  if (query.countries.length > 0) {
    // An unknown country is kept only for remote roles, where location matters
    // less; otherwise it is noise.
    if (job.country === null) {
      if (job.remote !== 'remote') return false;
    } else if (!query.countries.includes(job.country)) {
      return false;
    }
  }

  if (query.remote && query.remote !== 'unknown' && job.remote !== query.remote) return false;

  if (query.titles.length > 0) {
    const title = job.title.toLowerCase();
    const titleHit = query.titles.some((wanted) => {
      const words = wanted.toLowerCase().split(/[^a-z0-9+#/]+/).filter((w) => w.length > 2);
      return words.length > 0 && words.every((w) => title.includes(w));
    });
    const keywordHit = (query.keywords ?? []).some((k) =>
      job.description.toLowerCase().includes(k.toLowerCase())
    );
    if (!titleHit && !keywordHit) return false;
  }

  return true;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
