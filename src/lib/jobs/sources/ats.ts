import type { FetchResult, JobQuery, JobSource, NormalisedJob } from '../types.ts';
import {
  detectRelocationSupport,
  detectRemote,
  detectRequiredLanguages,
  detectVisaSponsorship,
  htmlToText,
  parseLocation,
} from '../parse.ts';
import { matchesQuery } from './arbeitnow.ts';
import { ATS_BOARDS, type AtsBoard } from './ats-boards.ts';

/**
 * Company applicant-tracking boards — Greenhouse, Lever, Ashby, SmartRecruiters.
 *
 * This is the employer publishing its own vacancies. Every one of these
 * endpoints is the documented, public feed that powers the company's own
 * careers page: no key, no login, no terms to breach. It is the opposite of the
 * thing decision §9 forbids — not a way around a source's limits, but the
 * primary source itself, upstream of every aggregator that republishes it.
 *
 * It was added because Naukri, LinkedIn, Indeed and Glassdoor are all closed:
 * Naukri publishes no API and no RSS (its /rss/ paths return an HTML page),
 * LinkedIn's Jobs API is partner-only, Indeed retired its Publisher API and
 * Glassdoor's is discontinued. Reaching any of them would mean scraping, which
 * this app does not do. Going to the employers directly turned out to be better
 * than the boards would have been, for three reasons that matter here:
 *
 *  1. **Descriptions arrive complete.** 42% of the feed is Adzuna, truncated to
 *     500 characters, and the matcher has to shrink its confidence to
 *     compensate. Everything from this source is the whole posting.
 *  2. **A closed vacancy disappears the same day.** The board IS the source of
 *     truth, so unlike every aggregator, absence here is real evidence. That is
 *     the honest fix for stale postings that db/006 could only approximate with
 *     a date rule.
 *  3. **It is global by employer rather than by endpoint.** Databricks alone
 *     posts in Bengaluru, Singapore, Tokyo, Stockholm, Amsterdam and London;
 *     Bosch carries 4,773 vacancies across Europe and India. Adzuna has no
 *     endpoint for the Nordics, Ireland or the Gulf, and this reaches all three
 *     without one.
 *
 * The cost is that it is per-company: it can only find jobs at employers named
 * in `ats-boards.ts`. That is a real limit and also the point — a curated list
 * of employers that sponsor is a better filter than "every job in Germany".
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SmartRecruiters detail requests, capped per company.
 *
 * Unlike the other three, its listing endpoint carries no description at all,
 * so a full posting needs a second request per job. Bosch matches 278 postings
 * across the search keywords; fetching every one would cost more requests than
 * the rest of the entire run put together. Titles are filtered first and only
 * the survivors are fetched, up to this cap.
 */
const SR_DETAIL_CAP = Math.max(1, Number(process.env.ATS_SR_DETAIL_CAP || 40));

// --- per-platform adapters ---------------------------------------------------

interface GreenhouseJob {
  id: number | string;
  title: string;
  absolute_url: string;
  content?: string;
  location?: { name?: string };
  offices?: { name?: string }[];
  company_name?: string;
  first_published?: string;
  updated_at?: string;
}

/**
 * Greenhouse escapes its HTML: `content` arrives as `&lt;p&gt;…`, so stripping
 * tags before decoding entities would strip nothing and leave the markup
 * visible to the reader and the matcher alike. Decode, then strip.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" does not become a tag
}

async function fetchGreenhouse(board: AtsBoard): Promise<NormalisedJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`;
  const payload = (await getJson(url)) as { jobs?: GreenhouseJob[] } | null;

  return (payload?.jobs ?? []).flatMap((raw) => {
    const description = htmlToText(decodeEntities(raw.content ?? ''));
    if (!description || !raw.title) return [];

    // `location.name` is free text and often lists several offices separated by
    // semicolons ("Atlanta, Georgia; Boston, Massachusetts"). The first is taken
    // rather than all of them: a job row holds one country, and the alternative
    // is discarding a location that is perfectly usable.
    const primary = (raw.location?.name ?? raw.offices?.[0]?.name ?? '').split(';')[0]!.trim();
    const { country, city } = parseLocation(primary);
    const posted = raw.first_published ?? raw.updated_at;

    return [
      normalise({
        slug: `greenhouse:${board.slug}:${raw.id}`,
        url: raw.absolute_url,
        title: raw.title.trim(),
        company: raw.company_name?.trim() || board.name,
        country,
        city,
        locationText: primary,
        description,
        postedAt: toDate(posted),
        raw,
      }),
    ];
  });
}

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  descriptionPlain?: string;
  description?: string;
  lists?: { text?: string; content?: string }[];
  categories?: { location?: string; team?: string; commitment?: string };
  createdAt?: number;
  workplaceType?: string;
}

async function fetchLever(board: AtsBoard): Promise<NormalisedJob[]> {
  const url = `https://api.lever.co/v0/postings/${board.slug}?mode=json`;
  const payload = (await getJson(url)) as LeverJob[] | null;

  return (payload ?? []).flatMap((raw) => {
    // `descriptionPlain` is the intro only; the requirements live in `lists`,
    // which is exactly the part the matcher needs. Joining them is not
    // embellishment, it is reassembling the posting the employer published.
    const lists = (raw.lists ?? [])
      .map((l) => `${l.text ?? ''}\n${htmlToText(l.content ?? '')}`)
      .join('\n');
    const description = `${raw.descriptionPlain ?? htmlToText(raw.description ?? '')}\n${lists}`.trim();
    if (!description || !raw.text) return [];

    const locationText = raw.categories?.location ?? '';
    const { country, city } = parseLocation(locationText);

    return [
      normalise({
        slug: `lever:${board.slug}:${raw.id}`,
        url: raw.hostedUrl,
        title: raw.text.trim(),
        company: board.name,
        country,
        city,
        locationText: `${locationText} ${raw.workplaceType ?? ''}`,
        description,
        postedAt: raw.createdAt ? new Date(raw.createdAt) : null,
        employmentType: raw.categories?.commitment ?? null,
        raw,
      }),
    ];
  });
}

interface AshbyJob {
  id: string;
  title: string;
  jobUrl?: string;
  applyUrl?: string;
  location?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  employmentType?: string;
  publishedAt?: string;
  isRemote?: boolean;
  isListed?: boolean;
}

async function fetchAshby(board: AtsBoard): Promise<NormalisedJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`;
  const payload = (await getJson(url)) as { jobs?: AshbyJob[] } | null;

  return (payload?.jobs ?? []).flatMap((raw) => {
    // `isListed: false` is a posting the company has taken off its own board.
    // Publishing it anyway would put a job in the feed that the employer has
    // deliberately unpublished.
    if (raw.isListed === false) return [];

    const description = raw.descriptionPlain?.trim() || htmlToText(raw.descriptionHtml ?? '');
    if (!description || !raw.title) return [];

    const { country, city } = parseLocation(raw.location ?? '');

    return [
      normalise({
        slug: `ashby:${board.slug}:${raw.id}`,
        url: raw.jobUrl ?? raw.applyUrl ?? '',
        title: raw.title.trim(),
        company: board.name,
        country,
        city,
        locationText: `${raw.location ?? ''} ${raw.isRemote ? 'remote' : ''}`,
        description,
        postedAt: toDate(raw.publishedAt),
        employmentType: raw.employmentType ?? null,
        raw,
      }),
    ];
  });
}

interface SrPosting {
  id: string;
  name: string;
  ref?: string;
  releasedDate?: string;
  typeOfEmployment?: { label?: string };
  location?: { city?: string; country?: string; remote?: boolean; hybrid?: boolean };
}

async function fetchSmartRecruiters(board: AtsBoard, query: JobQuery): Promise<NormalisedJob[]> {
  const terms = query.keywords?.length ? query.keywords : ['sql', 'database', 'erp'];
  const byId = new Map<string, SrPosting>();

  // `q` is a real server-side filter -- measured on Bosch, it cuts 4,773
  // postings to 73 for "sql" and 18 for "oracle". Without it this company alone
  // would dominate the whole run.
  for (const term of terms) {
    const url = `https://api.smartrecruiters.com/v1/companies/${board.slug}/postings?limit=100&q=${encodeURIComponent(term)}`;
    const payload = (await getJson(url)) as { content?: SrPosting[] } | null;
    for (const posting of payload?.content ?? []) {
      if (posting?.id) byId.set(posting.id, posting);
    }
    await sleep(400);
  }

  // Filter on the TITLE before paying for a detail request. The listing carries
  // no description at all, so this is the only signal available for free.
  const candidates = [...byId.values()].filter((posting) =>
    matchesQuery(
      {
        title: posting.name ?? '',
        // Empty on purpose: matchesQuery falls back to a keyword scan of the
        // description, and there is no description yet -- that is the request
        // this filter exists to avoid paying for. Titles only, here.
        description: '',
        country: (posting.location?.country ?? '').toUpperCase() || null,
        remote: posting.location?.remote ? 'remote' : 'unknown',
      } as NormalisedJob,
      { ...query, countries: [] }
    )
  );

  const jobs: NormalisedJob[] = [];
  for (const posting of candidates.slice(0, SR_DETAIL_CAP)) {
    const detail = (await getJson(
      `https://api.smartrecruiters.com/v1/companies/${board.slug}/postings/${posting.id}`
    )) as { jobAd?: { sections?: Record<string, { text?: string; title?: string }> }; postingUrl?: string; applyUrl?: string } | null;

    const sections = detail?.jobAd?.sections ?? {};
    const description = htmlToText(
      Object.values(sections)
        .map((section) => `${section?.title ?? ''}\n${section?.text ?? ''}`)
        .join('\n')
    );
    await sleep(400);
    if (!description) continue;

    // The country arrives as a two-letter code already, which is better than
    // any string this app could parse.
    const country = (posting.location?.country ?? '').toUpperCase() || null;

    jobs.push(
      normalise({
        slug: `smartrecruiters:${board.slug}:${posting.id}`,
        url: detail?.postingUrl ?? detail?.applyUrl ?? posting.ref ?? '',
        title: posting.name.trim(),
        company: board.name,
        country,
        city: posting.location?.city ?? null,
        locationText: `${posting.location?.city ?? ''} ${posting.location?.remote ? 'remote' : posting.location?.hybrid ? 'hybrid' : ''}`,
        description,
        postedAt: toDate(posting.releasedDate),
        employmentType: posting.typeOfEmployment?.label ?? null,
        raw: posting,
      })
    );
  }

  return jobs;
}

// --- shared helpers ----------------------------------------------------------

async function getJson(url: string): Promise<unknown | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'eurojob-assistant (personal job search)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 2) return null;
        await sleep(3_000);
        continue;
      }
      if (!response.ok) return null;
      return await response.json();
    } catch {
      if (attempt === 2) return null;
      await sleep(1_500);
    }
  }
  return null;
}

const toDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

function normalise(input: {
  slug: string;
  url: string;
  title: string;
  company: string;
  country: string | null;
  city: string | null;
  locationText: string;
  description: string;
  postedAt: Date | null;
  employmentType?: string | null;
  raw: unknown;
}): NormalisedJob {
  return {
    sourceSlug: 'ats',
    sourceJobId: input.slug,
    url: input.url,
    title: input.title,
    company: input.company,
    country: input.country,
    city: input.city,
    remote: detectRemote(`${input.locationText} ${input.description}`),
    employmentType: input.employmentType ?? null,
    // None of the four exposes a structured salary field. compensation.ts reads
    // the description at render time, so a posting stating pay in prose is still
    // read -- and these descriptions are complete, so it has the whole text.
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    description: input.description,
    // The employer's own published text, in full. This is the only source other
    // than Arbeitnow for which that is true.
    descriptionComplete: true,
    languages: detectRequiredLanguages(input.description),
    visaSponsorship: detectVisaSponsorship(input.description),
    relocationSupport: detectRelocationSupport(input.description),
    postedAt: input.postedAt,
    raw: input.raw,
  };
}

// --- the source --------------------------------------------------------------

export class AtsSource implements JobSource {
  readonly slug = 'ats';
  readonly displayName = 'Company job boards';
  readonly homepage = 'https://boards-api.greenhouse.io';
  readonly requiresKey = false;
  readonly requiredEnv: string[] = [];
  /** Wherever the listed employers hire, which is not expressible as a list. */
  readonly coverage = 'any' as const;
  readonly rateLimit = { requestsPerMinute: 60 };

  isConfigured(): boolean {
    return ATS_BOARDS.length > 0;
  }

  async fetch(query: JobQuery): Promise<FetchResult> {
    const warnings: string[] = [];
    const collected: NormalisedJob[] = [];
    const cutoff = query.postedWithinDays ? Date.now() - query.postedWithinDays * 86_400_000 : null;

    let emptyBoards = 0;

    for (const board of ATS_BOARDS) {
      if (collected.length >= query.limit) break;

      let jobs: NormalisedJob[] = [];
      try {
        jobs =
          board.platform === 'greenhouse' ? await fetchGreenhouse(board)
          : board.platform === 'lever' ? await fetchLever(board)
          : board.platform === 'ashby' ? await fetchAshby(board)
          : await fetchSmartRecruiters(board, query);
      } catch (err) {
        // One dead board must never abort the sweep -- the whole point of a
        // curated list is that it degrades one company at a time.
        warnings.push(`${board.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (jobs.length === 0) {
        // Named, not silent. A board that stops answering looks exactly like a
        // company with no vacancies, and the two need telling apart.
        emptyBoards += 1;
        warnings.push(`${board.name} (${board.platform}): no postings returned`);
      }

      for (const job of jobs) {
        if (collected.length >= query.limit) break;
        if (!job.url) continue;
        // Boards carry every vacancy the company has, in every discipline, so
        // the same title/keyword filter Arbeitnow uses applies here. Countries
        // are cleared from the query first: collection is global, and a board
        // is not restricted to one country.
        if (!matchesQuery(job, { ...query, countries: [] })) continue;
        if (cutoff && job.postedAt && job.postedAt.getTime() < cutoff) continue;
        collected.push(job);
      }

      await sleep(Math.ceil(60_000 / this.rateLimit.requestsPerMinute));
    }

    if (emptyBoards > ATS_BOARDS.length / 2) {
      warnings.push(`${emptyBoards} of ${ATS_BOARDS.length} boards returned nothing — check ats-boards.ts`);
    }

    return { jobs: collected, warnings };
  }
}
