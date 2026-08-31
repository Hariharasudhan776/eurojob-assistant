import type { FetchResult, JobQuery, JobSource, NormalisedJob } from '../types.ts';
import {
  detectRelocationSupport,
  detectRemote,
  detectRequiredLanguages,
  detectVisaSponsorship,
  htmlToText,
  parseLocation,
} from '../parse.ts';

/**
 * The Muse — https://www.themuse.com/developers/api/v2
 *
 * Added to fill the **Ireland** gap. Adzuna, the app's broadest source, operates
 * no Irish endpoint, and Ireland is the single most valuable market for a
 * non-EU, English-speaking candidate: the Critical Skills Employment Permit is a
 * real sponsorship route and the language requirement is one this profile
 * already meets. A search that silently omitted it was omitting the best odds in
 * the feed.
 *
 * Why this API rather than an Irish job board:
 *
 *  * It is **public and documented**, and needs no key. The rule for every
 *    source holds -- public APIs and feeds only, no CAPTCHA solving, no login
 *    bypass, no scraping a site whose terms forbid it. An optional
 *    `MUSE_API_KEY` raises the rate limit; without it the source still works.
 *  * It returns the **full posting body**, not a snippet, so these jobs get
 *    `descriptionComplete: true` and the matcher can report missing skills
 *    honestly -- unlike Adzuna's 500-character extracts.
 *  * Its Dublin listings are dominated by the multinational engineering offices
 *    that actually sponsor. Verified against the live API: a single Software
 *    Engineering page returns Dublin alongside Rome, Mexico City, Bangalore and
 *    Chennai, which is exactly the global reach the rest of this change is for.
 *
 * Locations are queried explicitly, because the API has no "anywhere" parameter
 * -- `location=Dublin, Ireland` is how you ask for Ireland. The default list
 * leads with the Irish cities and then covers the English-speaking hubs Adzuna
 * misses; MUSE_LOCATIONS overrides it.
 */

interface MuseJob {
  id: number | string;
  name?: string;
  contents?: string;
  publication_date?: string;
  locations?: { name?: string }[];
  categories?: { name?: string }[];
  levels?: { name?: string; short_name?: string }[];
  company?: { name?: string };
  refs?: { landing_page?: string };
  short_name?: string;
}

interface MuseResponse {
  page?: number;
  page_count?: number;
  total?: number;
  results?: MuseJob[];
  /** Older documentation calls this `items`; tolerated rather than assumed. */
  items?: MuseJob[];
}

const ENDPOINT = 'https://www.themuse.com/api/public/jobs';

/**
 * Ireland first -- that is why this source exists -- then the English-speaking
 * markets with no Adzuna endpoint or a sponsorship route worth surfacing.
 */
const DEFAULT_LOCATIONS = [
  'Dublin, Ireland',
  'Cork, Ireland',
  'Galway, Ireland',
  'Limerick, Ireland',
  'Stockholm, Sweden',
  'Copenhagen, Denmark',
  'Oslo, Norway',
  'Helsinki, Finland',
  'Luxembourg, Luxembourg',
  // The Gulf. Adzuna has no endpoint for any of these, so without them the
  // region is a silent hole in the feed rather than a thin part of it -- and it
  // is where this candidate's ERP experience trades best and where he already
  // holds a work visa.
  'Dubai, United Arab Emirates',
  'Abu Dhabi, United Arab Emirates',
  'Doha, Qatar',
  'Riyadh, Saudi Arabia',
  'Muscat, Oman',
];

/** The API's own taxonomy. Filtering at the source beats discarding here. */
const CATEGORIES = ['Software Engineering', 'Data Science', 'IT'];

/**
 * Raised from 2. The location parameter is a weak filter -- of 80 results for
 * "Dublin, Ireland", 3 were actually Irish -- so the local postings this source
 * exists to find are thinly spread through the pages rather than concentrated on
 * the first two. Reading twice as deep is the only way to reach them, and at
 * 20 results a page it is still four requests per location.
 */
const MAX_PAGES_PER_LOCATION = Math.max(1, Number(process.env.MUSE_MAX_PAGES || 4));

/**
 * How old a Muse posting may be, in days.
 *
 * Measured against the live API, asking for `location=Dublin, Ireland`: of 80
 * results across four pages, 3 carried an actual Irish location -- the location
 * parameter is a weak filter, not a restriction -- and of those 3, one was
 * posted that day and the others 33 and 44 days earlier. Applying the collector's
 * usual 30-day window to this source therefore discarded two thirds of the
 * Ireland coverage it exists to provide.
 *
 * So this source uses its own, wider window, and it is a declared number rather
 * than a silent exception: set MUSE_MAX_AGE_DAYS=30 to make it behave like the
 * others. Results the window keeps are still stamped with their real
 * `postedAt`, so nothing about their age is hidden downstream.
 */
const MAX_AGE_DAYS = Math.max(1, Number(process.env.MUSE_MAX_AGE_DAYS || 90));

export class TheMuseSource implements JobSource {
  readonly slug = 'themuse';
  readonly displayName = 'The Muse';
  readonly homepage = 'https://www.themuse.com/developers/api/v2';
  /** Works with no credentials; a key only raises the rate limit. */
  readonly requiresKey = false;
  readonly requiredEnv: string[] = [];
  readonly coverage = ['IE', 'GB', 'SE', 'DK', 'NO', 'FI', 'LU', 'US', 'CA', 'DE', 'NL', 'IN', 'BR', 'MX'];
  // Unauthenticated use is documented as limited; 10/minute stays well inside it.
  readonly rateLimit = { requestsPerMinute: 10 };

  isConfigured(): boolean {
    return true;
  }

  async fetch(query: JobQuery): Promise<FetchResult> {
    const warnings: string[] = [];
    const collected: NormalisedJob[] = [];
    const seen = new Set<string>();

    const locations = (process.env.MUSE_LOCATIONS?.split(';').map((l) => l.trim()).filter(Boolean) ?? DEFAULT_LOCATIONS);
    // The wider of the collector's window and this source's own, for the reason
    // documented at MAX_AGE_DAYS.
    const windowDays = Math.max(query.postedWithinDays ?? 0, MAX_AGE_DAYS);
    const cutoff = Date.now() - windowDays * 86_400_000;
    const perLocationCap = Math.max(5, Math.ceil(query.limit / Math.max(1, locations.length)));

    for (const location of locations) {
      let locationCount = 0;

      for (let page = 1; page <= MAX_PAGES_PER_LOCATION && locationCount < perLocationCap; page++) {
        const params = new URLSearchParams({ page: String(page), location });
        for (const category of CATEGORIES) params.append('category', category);
        if (process.env.MUSE_API_KEY) params.set('api_key', process.env.MUSE_API_KEY);

        const payload = await this.request(`${ENDPOINT}?${params}`, warnings, `${location} page ${page}`);
        if (!payload) break;

        const results = payload.results ?? payload.items ?? [];
        if (results.length === 0) break;

        for (const raw of results) {
          if (locationCount >= perLocationCap) break;

          const id = String(raw.id ?? raw.short_name ?? '');
          if (!id || seen.has(id)) continue;

          const posted = raw.publication_date ? new Date(raw.publication_date) : null;
          const postedValid = posted && !Number.isNaN(posted.getTime()) ? posted : null;
          if (cutoff && postedValid && postedValid.getTime() < cutoff) continue;

          const normalised = this.normalise(raw, id, postedValid);
          if (!normalised) continue;

          seen.add(id);
          collected.push(normalised);
          locationCount += 1;
        }

        // Stop at the last page the API says exists, rather than requesting
        // pages that are known to be empty.
        if (payload.page_count !== undefined && page >= payload.page_count) break;
        await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
      }

      if (collected.length >= query.limit) break;
    }

    if (collected.length === 0 && warnings.length === 0) {
      warnings.push('no postings matched; check MUSE_LOCATIONS spelling ("City, Country")');
    }
    return { jobs: collected, warnings };
  }

  /** Retries 429 and 5xx only; a 400 or 404 will not fix itself. */
  private async request(url: string, warnings: string[], label: string): Promise<MuseResponse | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'job-assistant (personal job search)' },
          signal: AbortSignal.timeout(20_000),
        });

        if (response.status === 429 || response.status >= 500) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * 2 ** (attempt - 1);
          if (attempt === 3) {
            warnings.push(`${label}: HTTP ${response.status} after 3 attempts`);
            return null;
          }
          await sleep(backoff);
          continue;
        }
        if (!response.ok) {
          warnings.push(`${label}: HTTP ${response.status}`);
          return null;
        }
        return (await response.json()) as MuseResponse;
      } catch (err) {
        warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
    return null;
  }

  private normalise(raw: MuseJob, id: string, postedAt: Date | null): NormalisedJob | null {
    const description = htmlToText(raw.contents ?? '');
    const title = raw.name?.trim();
    const company = raw.company?.name?.trim();
    const url = raw.refs?.landing_page;
    if (!description || !title || !company || !url) return null;

    // The first named location is the posting's primary one. "Flexible / Remote"
    // is a working mode, not a place, so it is skipped when looking for a
    // country -- otherwise every remote job would land in the same non-existent
    // country.
    const named = (raw.locations ?? []).map((l) => l.name?.trim()).filter((n): n is string => Boolean(n));
    const physical = named.find((n) => !/flexible|remote|anywhere/i.test(n)) ?? null;
    const { country, city } = parseLocation(physical);

    const remoteFlag = named.some((n) => /flexible|remote|anywhere/i.test(n));

    return {
      sourceSlug: this.slug,
      sourceJobId: id,
      url,
      title,
      company,
      country,
      city,
      remote: remoteFlag ? 'remote' : detectRemote(`${physical ?? ''} ${description}`),
      // The API exposes seniority (`levels`), not contract type.
      employmentType: raw.levels?.[0]?.name ?? null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      description,
      // Full employer body, verified against the live API.
      descriptionComplete: true,
      languages: detectRequiredLanguages(description),
      visaSponsorship: detectVisaSponsorship(description),
      relocationSupport: detectRelocationSupport(description),
      postedAt,
      raw,
    };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
