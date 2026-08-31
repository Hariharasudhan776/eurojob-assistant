import type { FetchResult, JobQuery, JobSource, NormalisedJob } from '../types.ts';
import {
  detectRelocationSupport,
  detectRequiredLanguages,
  detectVisaSponsorship,
  htmlToText,
  parseLocation,
} from '../parse.ts';

/**
 * Jobicy — https://jobicy.com/jobs-rss-feed (JSON API v2, no key)
 *
 * Added because the feed had a shape of hole that more European coverage could
 * not fill. Adzuna operates twenty-one country endpoints and none of them is in
 * the Gulf, the Nordics, Ireland, Luxembourg or Portugal; Arbeitnow is a German
 * board; The Muse reaches those markets only thinly. A candidate whose target
 * list includes IE, SE, DK, NO, FI, AE, SA, QA, OM, KW and BH was therefore
 * being shown almost nothing from eleven of the countries he asked for.
 *
 * This source does not fix that by country. It fixes it by category: every
 * posting here is REMOTE, and a remote role is the one kind of job for which the
 * employer's country is not a visa problem. For someone who needs sponsorship,
 * that is not a consolation prize -- it is the highest-value slice of a global
 * feed, and the app had no source that covered it.
 *
 * Two properties shape the implementation:
 *
 *  1. **`tag` is a real server-side filter** and the only one. There is no free-
 *     text search, so this issues one request per search keyword rather than
 *     pulling the whole board and discarding most of it. Seven keywords is seven
 *     calls.
 *  2. **`jobGeo` is a list of eligibility regions, not a location** -- "EMEA",
 *     "Anywhere", or "Europe, Ireland, Poland, Spain, UK". See `geoCountry`.
 *
 * Descriptions come through complete (measured: 4.5k-12.5k characters), which
 * also makes this the only source besides Arbeitnow whose postings the matcher
 * can read in full.
 */

interface JobicyJob {
  id: number | string;
  url: string;
  jobTitle: string;
  companyName: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
  jobCount?: number;
}

const ENDPOINT = 'https://jobicy.com/api/v2/remote-jobs';

/** The API's maximum. Asking for more is silently capped. */
const RESULTS_PER_TAG = 50;

/**
 * Region words that appear in `jobGeo` alongside real country names.
 *
 * They are listed so they can be SKIPPED, not mapped. "EMEA" is not a country
 * and neither is "Anywhere"; treating either as one would put a job in a
 * country filter it does not belong to. Without this list, `parseLocation`
 * would read "Europe, Ireland, Poland" left to right and find nothing at all.
 */
const REGION_WORDS = new Set(['anywhere', 'worldwide', 'emea', 'apac', 'latam', 'europe', 'eu', 'americas', 'global', 'remote']);

/**
 * The first real country a posting is open in, or null.
 *
 * `jobGeo` states ELIGIBILITY, not a workplace: "Europe, Ireland, Poland,
 * Spain, UK" means a person in any of those five may take the job. There is no
 * single correct country for such a row, and the honest options are null or the
 * first named one. This takes the first named one, because it is a true
 * statement about the posting -- the job really is open in Ireland -- and
 * because null would drop the row out of every country filter in the app, which
 * is the outcome this source was added to prevent. A row whose geo names no
 * country at all ("Anywhere", "EMEA") gets null rather than a guess.
 */
export function geoCountry(geo: string | undefined): string | null {
  if (!geo) return null;
  for (const part of geo.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (REGION_WORDS.has(part.toLowerCase())) continue;
    const { country } = parseLocation(part);
    if (country) return country;
  }
  return null;
}

export class JobicySource implements JobSource {
  readonly slug = 'jobicy';
  readonly displayName = 'Jobicy';
  readonly homepage = 'https://jobicy.com/jobs-rss-feed';
  readonly requiresKey = false;
  readonly requiredEnv: string[] = [];
  /** Remote postings, so eligibility rather than an office. 'any' is the truth. */
  readonly coverage = 'any' as const;
  readonly rateLimit = { requestsPerMinute: 20 };

  isConfigured(): boolean {
    return true;
  }

  async fetch(query: JobQuery): Promise<FetchResult> {
    const warnings: string[] = [];
    const collected: NormalisedJob[] = [];
    // One posting matches several of our keywords, so the same id comes back
    // from several requests. Dedup here rather than leaving it to the
    // cross-source hash, which would count them as collapsed duplicates and
    // make the run report misleading.
    const seen = new Set<string>();

    const cutoff = query.postedWithinDays ? Date.now() - query.postedWithinDays * 86_400_000 : null;
    const tags = query.keywords?.length ? query.keywords : ['sql', 'database', 'erp'];

    for (const tag of tags) {
      if (collected.length >= query.limit) break;

      const params = new URLSearchParams({ count: String(RESULTS_PER_TAG), tag });
      let payload: JobicyResponse | null = null;

      for (let attempt = 1; attempt <= 3 && payload === null; attempt++) {
        try {
          const response = await fetch(`${ENDPOINT}?${params}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'eurojob-assistant (personal job search)' },
            signal: AbortSignal.timeout(20_000),
          });
          if (response.status === 429 || response.status >= 500) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const backoff =
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * 2 ** (attempt - 1);
            if (attempt === 3) {
              warnings.push(`tag "${tag}": HTTP ${response.status} after 3 attempts`);
              break;
            }
            await sleep(backoff);
            continue;
          }
          if (!response.ok) {
            warnings.push(`tag "${tag}": HTTP ${response.status}`);
            break;
          }
          payload = (await response.json()) as JobicyResponse;
        } catch (err) {
          warnings.push(`tag "${tag}": ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }

      for (const raw of payload?.jobs ?? []) {
        if (collected.length >= query.limit) break;
        const id = String(raw.id ?? '');
        if (!id || seen.has(id)) continue;

        const posted = raw.pubDate ? new Date(raw.pubDate) : null;
        const postedValid = posted && !Number.isNaN(posted.getTime()) ? posted : null;
        if (cutoff && postedValid && postedValid.getTime() < cutoff) continue;

        const normalised = this.normalise(raw, id, postedValid);
        if (!normalised) continue;

        seen.add(id);
        collected.push(normalised);
      }

      await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
    }

    return { jobs: collected, warnings };
  }

  private normalise(raw: JobicyJob, id: string, postedAt: Date | null): NormalisedJob | null {
    // The excerpt is a truncated copy of the description with an HTML ellipsis
    // entity on the end, so it is a fallback and never a supplement.
    const description = htmlToText(raw.jobDescription || raw.jobExcerpt || '');
    const title = raw.jobTitle?.trim();
    const company = raw.companyName?.trim();
    if (!description || !title || !company) return null;

    return {
      sourceSlug: this.slug,
      sourceJobId: id,
      url: raw.url,
      title,
      company,
      country: geoCountry(raw.jobGeo),
      // There is no city. Every posting on this board is remote, and inventing
      // one from the eligibility region would be a location the job does not
      // have.
      city: null,
      remote: 'remote',
      employmentType: raw.jobType?.[0] ?? null,
      // The API carries no salary fields; compensation.ts reads the description
      // at render time, so a posting that states pay in prose is still read.
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      description,
      descriptionComplete: Boolean(raw.jobDescription),
      languages: detectRequiredLanguages(description),
      visaSponsorship: detectVisaSponsorship(description),
      relocationSupport: detectRelocationSupport(description),
      postedAt,
      raw,
    };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
