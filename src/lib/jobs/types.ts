import { z } from 'zod';

/**
 * The normalised job shape every source must produce.
 *
 * `visaSponsorship` and `relocationSupport` are three-valued on purpose.
 * "not_specified" is a real, distinct answer: a posting that says nothing about
 * sponsorship has not refused it and has not offered it, and collapsing that
 * into a boolean would either hide opportunities or invent promises. The spec
 * calls this out (§14) and the type enforces it.
 */

export const RemoteMode = z.enum(['remote', 'hybrid', 'onsite', 'unknown']);
export type RemoteMode = z.infer<typeof RemoteMode>;

export const Tristate = z.enum(['yes', 'no', 'not_specified']);
export type Tristate = z.infer<typeof Tristate>;

export const NormalisedJob = z.object({
  sourceSlug: z.string().min(1),
  /** Stable id within the source, for upserts. */
  sourceJobId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().min(1),
  country: z.string().nullable(),
  city: z.string().nullable(),
  remote: RemoteMode,
  employmentType: z.string().nullable(),
  salaryMin: z.number().int().nullable(),
  salaryMax: z.number().int().nullable(),
  salaryCurrency: z.string().nullable(),
  description: z.string().min(1),
  /**
   * False when the source only returns a snippet.
   *
   * Adzuna's search API truncates every description to 500 characters. A
   * requirement absent from 500 characters is not an absent requirement, so the
   * matcher must not report confident "missing skills" against a snippet -- it
   * lowers its confidence instead. Conflating "not mentioned" with "not
   * required" would produce false rejections of good jobs.
   */
  descriptionComplete: z.boolean(),
  languages: z.array(z.string()),
  visaSponsorship: Tristate,
  relocationSupport: Tristate,
  postedAt: z.date().nullable(),
  /** Untouched source payload, so a parser bug is fixable without re-crawling. */
  raw: z.unknown(),
});
export type NormalisedJob = z.infer<typeof NormalisedJob>;

export interface JobQuery {
  /** ISO 3166-1 alpha-2 codes. */
  countries: string[];
  titles: string[];
  keywords?: string[];
  remote?: RemoteMode;
  postedWithinDays?: number;
  /** Per-source cap, so one noisy source cannot dominate a run. */
  limit: number;
}

export interface FetchResult {
  jobs: NormalisedJob[];
  /** Non-fatal problems worth surfacing in the source's status. */
  warnings: string[];
}

/**
 * A job source.
 *
 * Adding a source means implementing this and registering it -- no changes to
 * the collector, the matcher, or the UI (spec §5).
 *
 * Every implementation must respect the source's terms: public APIs and feeds
 * only, no CAPTCHA solving, no authentication bypass, no paywall circumvention.
 * `rateLimit` is declared here so the collector can pace itself rather than
 * leaving politeness to each adapter.
 */
export interface JobSource {
  readonly slug: string;
  readonly displayName: string;
  readonly homepage: string;
  /** False means it works with no credentials at all. */
  readonly requiresKey: boolean;
  /** Env var names this source needs. Empty when none. */
  readonly requiredEnv: string[];
  /** Countries the source actually covers, or 'any'. */
  readonly coverage: string[] | 'any';
  readonly rateLimit: { requestsPerMinute: number };

  /** True when its credentials are present, so the collector can skip it cleanly. */
  isConfigured(): boolean;
  fetch(query: JobQuery): Promise<FetchResult>;
}

/**
 * The European countries the app was originally built around. Kept as its own
 * export because it is still the default *target* list for scoring -- the
 * countries a location score treats as "where I want to work" until the user
 * says otherwise -- even though collection is no longer restricted to them.
 */
export const EUROPEAN_COUNTRIES: Record<string, string> = {
  DE: 'Germany',
  NL: 'Netherlands',
  SE: 'Sweden',
  FI: 'Finland',
  DK: 'Denmark',
  NO: 'Norway',
  IE: 'Ireland',
  BE: 'Belgium',
  AT: 'Austria',
  FR: 'France',
  CH: 'Switzerland',
  LU: 'Luxembourg',
  PL: 'Poland',
  ES: 'Spain',
  IT: 'Italy',
  PT: 'Portugal',
  CZ: 'Czechia',
  EE: 'Estonia',
  GB: 'United Kingdom',
};

/**
 * Every country a collected posting can be attributed to.
 *
 * This exists because the feed is global now: a job in Toronto or Bengaluru has
 * to be storable and filterable, and a code with no name here would show up in
 * the UI as a bare two-letter string. The Jobs page builds its country filter
 * from the countries actually present in the database and looks their names up
 * here, so an unrecognised code degrades to the code rather than disappearing.
 */
export const COUNTRY_NAMES: Record<string, string> = {
  ...EUROPEAN_COUNTRIES,
  // rest of Europe that sources reach without a dedicated endpoint
  BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', GR: 'Greece', HU: 'Hungary',
  IS: 'Iceland', LT: 'Lithuania', LV: 'Latvia', MT: 'Malta', RO: 'Romania',
  RS: 'Serbia', SI: 'Slovenia', SK: 'Slovakia', UA: 'Ukraine', TR: 'Türkiye',
  // Americas
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina',
  CL: 'Chile', CO: 'Colombia',
  // Asia-Pacific, Middle East, Africa
  AU: 'Australia', NZ: 'New Zealand', SG: 'Singapore', IN: 'India', JP: 'Japan',
  CN: 'China', HK: 'Hong Kong', KR: 'South Korea', MY: 'Malaysia', PH: 'Philippines',
  ID: 'Indonesia', VN: 'Vietnam', IL: 'Israel', AE: 'United Arab Emirates',
  SA: 'Saudi Arabia', QA: 'Qatar', OM: 'Oman', KW: 'Kuwait', BH: 'Bahrain',
  ZA: 'South Africa', EG: 'Egypt', KE: 'Kenya', NG: 'Nigeria', MA: 'Morocco',
  RU: 'Russia',
};

export const countryName = (code: string | null | undefined): string =>
  code ? (COUNTRY_NAMES[code] ?? code) : 'location not stated';
