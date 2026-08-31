import type { FetchResult, JobQuery, JobSource, NormalisedJob } from '../types.ts';
import {
  detectMinYears,
  detectRelocationSupport,
  detectRemote,
  detectRequiredLanguages,
  detectVisaSponsorship,
  htmlToText,
} from '../parse.ts';

/**
 * Adzuna — https://developer.adzuna.com
 *
 * Twenty-one country endpoints behind a free API key -- Europe plus the US,
 * Canada, Australia, New Zealand, South Africa, Singapore, India, Brazil,
 * Mexico, Russia and Argentina. Two properties of this API shape the
 * implementation:
 *
 *  1. **Descriptions are truncated to 500 characters.** Verified against the
 *     live API: every result comes back capped. So jobs from this source are
 *     flagged `descriptionComplete: false`, and the matcher lowers its
 *     confidence rather than reporting requirements as "missing" when they may
 *     simply be past the cut-off. Following `redirect_url` to scrape the full
 *     posting is deliberately NOT done -- that is exactly the kind of
 *     terms-violating collection the brief rules out (§5).
 *
 *  2. **It has a real category taxonomy.** `category=it-jobs` filters at the
 *     source, which is far cheaper and more reliable than pulling everything
 *     and discarding non-technical roles client-side.
 *
 *  3. **It sorts by relevance unless told otherwise**, and relevance is not
 *     recency -- see SORT_ORDER below. This source asks for date order, because
 *     a daily run whose job is to catch what is new must read the new end.
 *
 * Request budget matters: the free tier is limited per day, so this issues ONE
 * request per country per page using `what_or` rather than one per job title.
 * Twenty-one countries at three pages, plus a one-page sweep of two extra
 * categories in the priority markets, is ~80 calls per run.
 */

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  created: string;
  redirect_url: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  category?: { tag?: string; label?: string };
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  contract_time?: string;
  contract_type?: string;
}

interface AdzunaResponse {
  count?: number;
  results?: AdzunaJob[];
}

/**
 * Every country endpoint Adzuna operates, not just the European ones.
 *
 * The app used to ask for ten European countries because the search itself was
 * European. The search is global now, so the source offers everything it can
 * reach and the *user* decides what to look at with the country filter. Adding
 * the rest cost nothing but a longer list -- the request budget is controlled by
 * MAX_PAGES_PER_COUNTRY and the per-country cap, not by the number of endpoints.
 */
const COUNTRY_ENDPOINTS: Record<string, string> = {
  // Europe
  GB: 'gb', DE: 'de', NL: 'nl', FR: 'fr', PL: 'pl', AT: 'at', BE: 'be', CH: 'ch',
  IT: 'it', ES: 'es',
  // Americas, Asia-Pacific, Africa
  US: 'us', CA: 'ca', AU: 'au', NZ: 'nz', ZA: 'za', SG: 'sg', IN: 'in',
  BR: 'br', MX: 'mx',
  // Observed on a live run: these two answer HTTP 404 today, although Adzuna
  // documents them. They are kept rather than quietly dropped -- if the
  // endpoints come back, the coverage returns with them -- and the 404 shows up
  // as a source warning on the Settings page rather than as a silent gap.
  RU: 'ru', AR: 'ar',
};

/** Local currency per endpoint. Adzuna reports annual figures with no currency field. */
const CURRENCY: Record<string, string> = {
  de: 'EUR', nl: 'EUR', at: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', be: 'EUR',
  ch: 'CHF', pl: 'PLN', gb: 'GBP',
  us: 'USD', ca: 'CAD', au: 'AUD', nz: 'NZD', za: 'ZAR', sg: 'SGD', in: 'INR',
  br: 'BRL', mx: 'MXN', ru: 'RUB', ar: 'ARS',
};

/**
 * Request budget. Twenty-one countries at three pages each is ~63 calls per run
 * plus the priority-category sweep below, which the free tier (250/day) absorbs
 * comfortably. ADZUNA_MAX_PAGES exists for anyone whose quota is tighter -- and
 * for the opposite case: set it to 10 for a one-off deep backfill, then put it
 * back. A daily run only has to keep up with a day of new postings.
 */
const MAX_PAGES_PER_COUNTRY = Math.max(1, Number(process.env.ADZUNA_MAX_PAGES || 3));
const RESULTS_PER_PAGE = 50;

/**
 * Newest first, NOT most relevant first -- and this is the fix for the whole
 * class of "Adzuna emailed me about a job the app never showed".
 *
 * Adzuna sorts by relevance when `sort_by` is omitted, and relevance has no
 * relationship to recency: measured on the live API, the first relevance-ranked
 * result for this search was 12 days old in DE, 30 days old in GB and 19 days
 * old in US. Reading only the first pages of a relevance ranking therefore reads
 * the same settled postings every day and never sees today's. Adzuna's own alert
 * emails are date-ordered, which is exactly why they carried jobs this app did
 * not. Date order plus `max_days_old` makes a daily run complete by
 * construction: whatever appeared since yesterday is at the top.
 */
const SORT_ORDER = 'date';

/**
 * The categories swept beyond `it-jobs`.
 *
 * `category=it-jobs` filters at the source, which is cheap and precise -- but it
 * is Adzuna's judgement of the posting, not ours, and it is wrong often enough
 * to matter for this profile. Measured on the live API: `consultancy-jobs`
 * carries "ERP-Consultant Variantenmanagement" and `engineering-jobs` carries
 * "Application Engineer ETL & DWH" in Germany. Both are squarely in scope, and
 * both were invisible while it-jobs was the only category asked for.
 *
 * The other twenty-six categories were measured too and are deliberately NOT
 * here: admin, accounting-finance and scientific-qa returned procurement clerks,
 * tax associates and animal technicians whose only tie to the query was the word
 * "database" somewhere in the body. The role classifier would drop them anyway,
 * but not before spending the requests to fetch them.
 *
 * This sweep runs only in `priorityCountries`, one page each, so it costs a
 * handful of calls rather than a multiplier across every endpoint.
 */
const EXTRA_CATEGORIES = ['consultancy-jobs', 'engineering-jobs'];

export class AdzunaSource implements JobSource {
  readonly slug = 'adzuna';
  readonly displayName = 'Adzuna';
  readonly homepage = 'https://developer.adzuna.com';
  readonly requiresKey = true;
  readonly requiredEnv = ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'];
  readonly coverage = Object.keys(COUNTRY_ENDPOINTS);
  readonly rateLimit = { requestsPerMinute: 20 };

  isConfigured(): boolean {
    return Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY);
  }

  async fetch(query: JobQuery): Promise<FetchResult> {
    const warnings: string[] = [];
    const collected: NormalisedJob[] = [];

    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      return { jobs: [], warnings: ['ADZUNA_APP_ID / ADZUNA_APP_KEY not set; source skipped'] };
    }

    // Only ask for countries this source actually serves.
    const countries = (query.countries.length ? query.countries : Object.keys(COUNTRY_ENDPOINTS)).filter(
      (c) => COUNTRY_ENDPOINTS[c]
    );
    const skipped = query.countries.filter((c) => !COUNTRY_ENDPOINTS[c]);
    if (skipped.length) warnings.push(`not covered by Adzuna, skipped: ${skipped.join(', ')}`);

    // `what_or` matches any term, which is the right shape for one broad
    // request per country instead of one per job title.
    const terms = (query.keywords?.length ? query.keywords : ['oracle', 'plsql', 'postgresql', 'sql', 'database', 'erp'])
      .join(' ');

    /**
     * The per-country budget is now a PAGE budget, not a slice of the results.
     *
     * It used to be `ceil(limit / countries)` -- with the shipped defaults, 29 --
     * and the loop broke out of the page the moment it hit that. So every run
     * fetched fifty results per country and threw twenty-one of them away
     * unread, then stopped. Adzuna had 1,413 matching IT postings in Germany
     * alone over the same thirty days; the whole feed held 1,376 from all
     * twenty-one countries put together. Nothing was wrong with the API or the
     * search -- the collector was discarding what it had already paid to fetch.
     *
     * Pages are the honest control: they bound the REQUESTS, which are the
     * scarce resource, instead of bounding the rows, which are free once
     * fetched.
     */
    const perCountryCap = MAX_PAGES_PER_COUNTRY * RESULTS_PER_PAGE;
    const priority = new Set((query.priorityCountries ?? []).filter((c) => COUNTRY_ENDPOINTS[c]));

    /**
     * One search request. `null` means "this page failed, stop this sweep";
     * `'abort'` means the credentials or the quota are gone and every remaining
     * country would fail the same way.
     */
    const requestPage = async (
      country: string,
      endpoint: string,
      pageNo: number,
      category: string
    ): Promise<AdzunaResponse | null | 'abort'> => {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: String(RESULTS_PER_PAGE),
        what_or: terms,
        category,
        sort_by: SORT_ORDER,
        'content-type': 'application/json',
      });
      if (query.postedWithinDays) params.set('max_days_old', String(query.postedWithinDays));

      const url = `https://api.adzuna.com/v1/api/jobs/${endpoint}/search/${pageNo}?${params}`;
      const where = `${country} ${category} page ${pageNo}`;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
          if (response.status === 429 || response.status >= 500) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const backoff =
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * 2 ** (attempt - 1);
            if (attempt === 3) {
              warnings.push(`${where}: HTTP ${response.status} after 3 attempts`);
              return null;
            }
            await sleep(backoff);
            continue;
          }
          if (response.status === 401 || response.status === 403) {
            warnings.push(`HTTP ${response.status}: Adzuna rejected the credentials or the quota is exhausted`);
            return 'abort';
          }
          if (!response.ok) {
            warnings.push(`${where}: HTTP ${response.status}`);
            return null;
          }
          return (await response.json()) as AdzunaResponse;
        } catch (err) {
          warnings.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      }
      return null;
    };

    const take = (payload: AdzunaResponse, country: string, endpoint: string): number => {
      let added = 0;
      for (const raw of payload.results ?? []) {
        const normalised = this.normalise(raw, country, endpoint);
        if (!normalised) continue;
        collected.push(normalised);
        added += 1;
      }
      return added;
    };

    // --- pass 1: it-jobs, every country the source serves --------------------
    for (const country of countries) {
      // The source-level ceiling still binds. Pages control the REQUESTS, which
      // is the scarce resource; this is the row ceiling, and it matters again
      // the moment someone sets ADZUNA_MAX_PAGES high for a deep backfill.
      if (collected.length >= query.limit) break;
      const endpoint = COUNTRY_ENDPOINTS[country]!;
      let countryCount = 0;

      for (let pageNo = 1; pageNo <= MAX_PAGES_PER_COUNTRY && countryCount < perCountryCap; pageNo++) {
        const payload = await requestPage(country, endpoint, pageNo, 'it-jobs');
        if (payload === 'abort') return { jobs: collected, warnings };
        if (!payload?.results?.length) break;
        countryCount += take(payload, country, endpoint);
        // A short page is the last page; asking for the next one wastes a call.
        if (payload.results.length < RESULTS_PER_PAGE) break;
        await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
      }
    }

    // --- pass 2: the categories Adzuna files ERP and data work under ---------
    for (const country of countries) {
      if (collected.length >= query.limit) break;
      if (!priority.has(country)) continue;
      const endpoint = COUNTRY_ENDPOINTS[country]!;
      for (const category of EXTRA_CATEGORIES) {
        const payload = await requestPage(country, endpoint, 1, category);
        if (payload === 'abort') return { jobs: collected, warnings };
        if (payload?.results?.length) take(payload, country, endpoint);
        await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
      }
    }

    return { jobs: collected, warnings };
  }

  private normalise(raw: AdzunaJob, country: string, endpoint: string): NormalisedJob | null {
    const description = htmlToText(raw.description ?? '');
    const title = raw.title?.trim();
    const company = raw.company?.display_name?.trim();
    if (!description || !title || !company) return null;

    // `area` is ordered country -> region -> ... -> locality, so the last entry
    // is the most specific place name. More reliable than splitting display_name.
    const area = raw.location?.area ?? [];
    const city = area.length > 1 ? area[area.length - 1]! : null;

    const posted = raw.created ? new Date(raw.created) : null;

    // salary_is_predicted === '1' means Adzuna estimated it rather than the
    // employer stating it, so it is not treated as a real salary figure.
    const predicted = String(raw.salary_is_predicted ?? '0') === '1';
    const salaryMin = !predicted && raw.salary_min ? Math.round(raw.salary_min) : null;
    const salaryMax = !predicted && raw.salary_max ? Math.round(raw.salary_max) : null;

    return {
      sourceSlug: this.slug,
      sourceJobId: String(raw.id),
      url: raw.redirect_url,
      title,
      company,
      country,
      city,
      remote: detectRemote(`${title} ${raw.location?.display_name ?? ''} ${description}`),
      employmentType: raw.contract_time ?? raw.contract_type ?? null,
      salaryMin,
      salaryMax,
      salaryCurrency: salaryMin || salaryMax ? (CURRENCY[endpoint] ?? null) : null,
      description,
      // The single most important flag from this source: 500 characters is a
      // snippet, and absence of a requirement in a snippet proves nothing.
      descriptionComplete: false,
      languages: detectRequiredLanguages(description),
      visaSponsorship: detectVisaSponsorship(description),
      relocationSupport: detectRelocationSupport(description),
      postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : null,
      raw,
    };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export { detectMinYears };
