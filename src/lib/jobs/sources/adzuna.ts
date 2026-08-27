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
 * Request budget matters: the free tier is limited per day, so this issues ONE
 * request per country per page using `what_or` rather than one per job title.
 * Twenty-one countries at two pages each is ~42 calls per run.
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
 * Request budget. Twenty-one countries at two pages each is ~42 calls per run,
 * which the free tier absorbs; ADZUNA_MAX_PAGES exists for anyone whose quota is
 * tighter or who wants to sweep deeper.
 */
const MAX_PAGES_PER_COUNTRY = Math.max(1, Number(process.env.ADZUNA_MAX_PAGES || 2));
const RESULTS_PER_PAGE = 50;

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

    const perCountryCap = Math.max(1, Math.ceil(query.limit / Math.max(1, countries.length)));

    for (const country of countries) {
      const endpoint = COUNTRY_ENDPOINTS[country]!;
      let countryCount = 0;

      for (let page = 1; page <= MAX_PAGES_PER_COUNTRY && countryCount < perCountryCap; page++) {
        const params = new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          results_per_page: String(RESULTS_PER_PAGE),
          what_or: terms,
          category: 'it-jobs',
          'content-type': 'application/json',
        });
        if (query.postedWithinDays) params.set('max_days_old', String(query.postedWithinDays));

        const url = `https://api.adzuna.com/v1/api/jobs/${endpoint}/search/${page}?${params}`;

        let payload: AdzunaResponse | null = null;
        for (let attempt = 1; attempt <= 3 && payload === null; attempt++) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
            if (response.status === 429 || response.status >= 500) {
              const retryAfter = Number(response.headers.get('retry-after'));
              const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * 2 ** (attempt - 1);
              if (attempt === 3) {
                warnings.push(`${country} page ${page}: HTTP ${response.status} after 3 attempts`);
                break;
              }
              await sleep(backoff);
              continue;
            }
            if (response.status === 401 || response.status === 403) {
              // Credentials are wrong or the daily quota is spent. Retrying
              // every remaining country would just burn time.
              return { jobs: collected, warnings: [...warnings, `HTTP ${response.status}: Adzuna rejected the credentials or the quota is exhausted`] };
            }
            if (!response.ok) {
              warnings.push(`${country} page ${page}: HTTP ${response.status}`);
              break;
            }
            payload = (await response.json()) as AdzunaResponse;
          } catch (err) {
            warnings.push(`${country} page ${page}: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }

        if (!payload?.results?.length) break;

        for (const raw of payload.results) {
          if (countryCount >= perCountryCap) break;
          const normalised = this.normalise(raw, country, endpoint);
          if (!normalised) continue;
          collected.push(normalised);
          countryCount += 1;
        }

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
