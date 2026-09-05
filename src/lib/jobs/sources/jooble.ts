import type { FetchResult, JobQuery, JobSource, NormalisedJob } from '../types.ts';
import { COUNTRY_NAMES } from '../types.ts';
import {
  detectRelocationSupport,
  detectRequiredLanguages,
  detectVisaSponsorship,
  htmlToText,
  parseLocation,
} from '../parse.ts';

/**
 * Jooble -- https://jooble.org/api/about (free key, 70+ countries)
 *
 * Added for COUNTRY REACH and nothing else. Measured on the live feed before
 * this source existed: Czechia 0 postings, Portugal 0, Saudi Arabia 0, Qatar 0,
 * Oman 0, Kuwait 0, Bahrain 0, Norway 2, Denmark 2, Finland 1, Sweden 25 --
 * eleven of the twenty countries in DEFAULT_TARGET_COUNTRIES were effectively
 * empty, and no key-free source reaches them. Adzuna operates no endpoint for
 * any of them, Arbeitnow is a German board, and Jobicy only covers the remote
 * slice.
 *
 * **What this source is NOT good for.** Jooble returns a `snippet`, not a
 * description -- measured around 200-300 characters, shorter than Adzuna's 500.
 * So every row here is `descriptionComplete: false`, the matcher shrinks its
 * confidence accordingly (decision §10) and these postings will rank BELOW an
 * ATS row describing the same job in full. That is correct and deliberate: the
 * point of this source is to surface a Prague or Riyadh posting that otherwise
 * does not exist in the app at all, not to rank it above better-described work.
 *
 * **Country is requested through `location`, which is free text.** The API has
 * no country parameter -- one request per country name is the only way to steer
 * it, which is why the request budget below is shaped by countries rather than
 * by pages. The country on the stored row still comes from `parseLocation`
 * reading what the posting actually says, never from the country that was
 * asked for: asking for "Czechia" and getting a Bratislava job would otherwise
 * file a Slovak posting under CZ.
 */

interface JoobleJob {
  id?: number | string;
  title?: string;
  location?: string;
  snippet?: string;
  salary?: string;
  source?: string;
  type?: string;
  link?: string;
  company?: string;
  updated?: string;
}

interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

const ENDPOINT = 'https://jooble.org/api';

/**
 * Request budget -- and read the number before changing it.
 *
 * **Jooble issues 500 requests by default, and that is a TOTAL, not a daily
 * rate.** It is stated on the page that hands over the key, not in any API
 * response, so nothing here can detect the budget running out: the source will
 * simply start returning nothing, which looks exactly like "no jobs in Czechia
 * today". That is the failure mode `ats.ts` was written to avoid, and it
 * applies with more force here because the ceiling is finite.
 *
 * So the shape of the cost matters. Countries x keywords x pages multiplies
 * fast -- fourteen countries against three keywords at two pages is 84 requests,
 * which would exhaust the entire allowance in SIX runs, and the daily agent runs
 * unattended.
 *
 * 20 per run is roughly 25 runs, or three weeks of daily collection, which is
 * enough to prove the source is worth keeping before asking Jooble to raise the
 * limit (their message invites the request). Raise it for a one-off backfill of
 * the empty countries and put it back -- but unlike ADZUNA_MAX_PAGES, spending
 * here is not refilled tomorrow.
 */
const MAX_REQUESTS = Math.max(1, Number(process.env.JOOBLE_MAX_REQUESTS || 20));
const MAX_PAGES = Math.max(1, Number(process.env.JOOBLE_MAX_PAGES || 1));
const RESULTS_PER_PAGE = 50;

/**
 * The keywords this source spends its budget on.
 *
 * Deliberately NOT the full DEFAULT_SEARCH.titles list. Every extra term is
 * another request in every country, and the titles overlap heavily once a
 * free-text engine sees them -- "Database Developer" and "Database Engineer"
 * return substantially the same rows. These three cover the profile's centre
 * and keep the budget inside one run.
 */
const DEFAULT_KEYWORDS = ['sql database', 'oracle plsql', 'erp'];

/**
 * Countries to ask for, when the caller has not named any.
 *
 * `query.countries` is empty by design (collection is global), but this source
 * cannot express "everywhere" -- there is no country parameter, only a location
 * string. So it falls back to the caller's priority list, which is the set of
 * markets the reader actually cares about, and that is the honest use of a
 * budget that cannot cover the world.
 */
const FALLBACK_COUNTRIES = ['CZ', 'PT', 'IE', 'SE', 'NO', 'DK', 'FI', 'LU', 'AE', 'SA', 'QA', 'OM', 'KW', 'BH'];

/**
 * Country names Jooble does not recognise, and what to send instead.
 *
 * `COUNTRY_NAMES` is this app's vocabulary and uses the current short forms.
 * Jooble's location index does not: measured on the live API, "Czechia" returns
 * **totalCount 0** and "Czech Republic" returns results for the identical query.
 * A wrong name here is indistinguishable from an empty market -- HTTP 200, zero
 * jobs, no error -- which is precisely how Czechia came to look like a source
 * gap when the request had simply named a place the index does not hold.
 *
 * Add an entry when a country reads as empty and you have checked the name
 * against the API rather than assuming it.
 */
const LOCATION_OVERRIDES: Record<string, string> = {
  CZ: 'Czech Republic',
};

export class JoobleSource implements JobSource {
  readonly slug = 'jooble';
  readonly displayName = 'Jooble';
  readonly homepage = 'https://jooble.org/api/about';
  readonly requiresKey = true;
  readonly requiredEnv = ['JOOBLE_API_KEY'];
  readonly coverage = 'any' as const;
  readonly rateLimit = { requestsPerMinute: 20 };

  isConfigured(): boolean {
    return Boolean(process.env.JOOBLE_API_KEY);
  }

  async fetch(query: JobQuery): Promise<FetchResult> {
    const warnings: string[] = [];
    const collected: NormalisedJob[] = [];
    const seen = new Set<string>();

    const key = process.env.JOOBLE_API_KEY;
    if (!key) return { jobs: [], warnings: ['JOOBLE_API_KEY is not set'] };

    const codes = query.countries.length
      ? query.countries
      : query.priorityCountries?.length
        ? query.priorityCountries
        : FALLBACK_COUNTRIES;

    // DEFAULT_KEYWORDS regardless of query.keywords: see the constant. Honouring
    // the caller's seven keywords would multiply every country by seven.
    const keywords = DEFAULT_KEYWORDS;
    const cutoff = query.postedWithinDays ? Date.now() - query.postedWithinDays * 86_400_000 : null;
    const since = query.postedWithinDays
      ? new Date(Date.now() - query.postedWithinDays * 86_400_000).toISOString().slice(0, 10)
      : undefined;

    let requests = 0;
    const hitsByCountry = new Map<string, number>();
    /** Countries a request was actually issued for. See the warning block below. */
    const asked = new Set<string>();

    /**
     * BREADTH FIRST: every country against keyword one, before any country sees
     * keyword two.
     *
     * The obvious loop -- country outer, keyword inner -- spends three requests
     * on Germany before Czechia is asked once, and measured against the live API
     * that is exactly what happened: a 20-request budget reached 7 of 20
     * countries and stopped, so the thirteen it never got to looked empty. They
     * were not empty; they were unasked.
     *
     * Coverage is the entire reason this source exists, so the budget buys
     * countries first and depth only with what is left over.
     */
    outer: for (const keyword of keywords) {
      for (const code of codes) {
        // The API wants a place a human would type, not an ISO code: "CZ" is not
        // a location and returns nothing. LOCATION_OVERRIDES handles the names
        // where our vocabulary and Jooble's index disagree.
        const location = LOCATION_OVERRIDES[code] ?? COUNTRY_NAMES[code] ?? code;

        for (let page = 1; page <= MAX_PAGES; page++) {
          if (collected.length >= query.limit || requests >= MAX_REQUESTS) break outer;

          const payload = await this.post(key, warnings, `${location}/${keyword}`, {
            keywords: keyword,
            location,
            page: String(page),
            ResultOnPage: String(RESULTS_PER_PAGE),
            ...(since ? { datecreatedfrom: since } : {}),
          });
          requests++;
          asked.add(code);
          if (!payload) break;

          const batch = payload.jobs ?? [];
          if (batch.length === 0) break;

          for (const raw of batch) {
            if (collected.length >= query.limit) break outer;
            const id = String(raw.id ?? raw.link ?? '');
            if (!id || seen.has(id)) continue;

            const posted = raw.updated ? new Date(raw.updated) : null;
            const postedValid = posted && !Number.isNaN(posted.getTime()) ? posted : null;
            if (cutoff && postedValid && postedValid.getTime() < cutoff) continue;

            const normalised = this.normalise(raw, id);
            if (!normalised) continue;

            seen.add(id);
            collected.push(normalised);
            hitsByCountry.set(code, (hitsByCountry.get(code) ?? 0) + 1);
          }

          // A short page is the last page.
          if (batch.length < RESULTS_PER_PAGE) break;
          await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
        }
      }
    }

    /**
     * Report empty countries, and separate the two reasons a country can be
     * empty -- they mean opposite things.
     *
     * A country that WAS asked and answered nothing is a fact about that market.
     * A country the budget never reached is a fact about this run. Both show as
     * zero on the Settings page, and only one of them is worth acting on, so
     * they are named separately rather than summed into a single silence.
     */
    const emptyButAsked = codes.filter((c) => asked.has(c) && !hitsByCountry.has(c));
    const neverAsked = codes.filter((c) => !asked.has(c));

    if (emptyButAsked.length) {
      warnings.push(`no postings returned for: ${emptyButAsked.join(', ')}`);
    }
    if (neverAsked.length) {
      warnings.push(
        `${neverAsked.length} of ${codes.length} countries were never asked — ` +
        `the ${MAX_REQUESTS}-request budget ran out (JOOBLE_MAX_REQUESTS): ${neverAsked.join(', ')}`
      );
    }
    if (hitsByCountry.size === 0) {
      warnings.push('no country returned anything — check JOOBLE_API_KEY and the 500-request allowance');
    }

    return { jobs: collected, warnings };
  }

  private async post(
    key: string,
    warnings: string[],
    label: string,
    body: Record<string, string>
  ): Promise<JoobleResponse | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(`${ENDPOINT}/${key}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'eurojob-assistant (personal job search)',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });

        if (response.status === 429 || response.status >= 500) {
          if (attempt === 3) {
            warnings.push(`${label}: HTTP ${response.status} after 3 attempts`);
            return null;
          }
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000 * 2 ** (attempt - 1));
          continue;
        }
        if (!response.ok) {
          // The key is in the URL, so a bad key is a 401/403 on every call. Say
          // so once per call site rather than letting it read as empty coverage.
          warnings.push(`${label}: HTTP ${response.status}${response.status === 401 ? ' (check JOOBLE_API_KEY)' : ''}`);
          return null;
        }
        return (await response.json()) as JoobleResponse;
      } catch (err) {
        warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
    return null;
  }

  private normalise(raw: JoobleJob, id: string): NormalisedJob | null {
    const description = htmlToText(raw.snippet || '');
    const title = raw.title?.trim();
    const company = raw.company?.trim();
    const url = raw.link?.trim();
    if (!description || !title || !company || !url) return null;

    // What the posting says, not what was asked for. See the header note.
    const { country, city } = parseLocation(raw.location ?? '');

    return {
      sourceSlug: this.slug,
      sourceJobId: id,
      url,
      title,
      company,
      country,
      city,
      remote: /\bremote\b|\bhome ?office\b/i.test(`${title} ${raw.location ?? ''} ${description}`) ? 'remote' : 'unknown',
      employmentType: raw.type?.trim() || null,
      // `salary` is free text in whatever the posting wrote ("€55,000 - €70,000",
      // "25 000 Kč/měsíc"), with no currency or period field to read it against.
      // compensation.ts already parses prose at render time and knows about
      // monthly figures and ceilings, so the honest thing is to leave the
      // structured fields null and let it read the text.
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      description: raw.salary ? `${description}\n\nSalary: ${raw.salary}` : description,
      // A snippet, always. Never claim otherwise -- see the header.
      descriptionComplete: false,
      languages: detectRequiredLanguages(description),
      visaSponsorship: detectVisaSponsorship(description),
      relocationSupport: detectRelocationSupport(description),
      postedAt: raw.updated && !Number.isNaN(new Date(raw.updated).getTime()) ? new Date(raw.updated) : null,
      raw,
    };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
