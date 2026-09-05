import type { JobQuery } from './jobs/types.ts';

/**
 * What to search for.
 *
 * Titles are deliberately broad (spec §13): searching only the current job
 * title would miss most of the roles this profile actually fits, and an Oracle
 * developer is a plausible candidate for half a dozen differently-named posts.
 *
 * Edit this file to change the search. Everything downstream reads from here, so
 * there is one place to look.
 */

/**
 * Collection is GLOBAL: `countries: []` means "do not restrict".
 *
 * It used to be a fixed list of thirteen European countries, which decided for
 * the user that nothing outside Europe was worth seeing. That belongs to the
 * person reading the results, not to the collector. Every source now returns
 * everything it covers, and the Jobs page has a country filter built from what
 * the database actually holds.
 *
 * Two things did NOT change with it:
 *
 *  * **Per-source request budgets.** A global sweep is more requests, not
 *    unlimited requests: each source still paces itself and caps its pages.
 *  * **The location component of the score.** Scoring against "everywhere"
 *    would make it meaningless, so target countries are a per-user preference
 *    (`search_preferences.countries`), defaulting to DEFAULT_TARGET_COUNTRIES.
 */
/**
 * The scoring default for someone who has not said where they want to work.
 *
 * This is the European market the app was built for -- English-speaking or
 * sponsorship-friendly countries with a route for a non-EU candidate. A user can
 * replace it from the Settings page, and their choice is what the location
 * component uses from then on.
 */
export const DEFAULT_TARGET_COUNTRIES = [
  'DE', 'NL', 'SE', 'FI', 'DK', 'NO', 'IE', 'BE', 'AT', 'FR', 'CH', 'LU', 'PL',
  // Czechia and Portugal, added 2026-09-05 because he asked for Czech postings
  // and the feed held ZERO -- which read as a source problem and was not one.
  // No source had ever been asked for them: this list is what steers a source's
  // country budget, and neither code was in it. Prague and Lisbon are also the
  // two European tech markets with the lowest cost of entry for a non-EU
  // candidate, which is why they belong here rather than only in a filter.
  'CZ', 'PT',
  // India and the Gulf. Europe remains the priority and is unaffected -- the
  // location component checks membership of this list, so adding markets lifts
  // those postings without lowering any European one. They are here because
  // this candidate's ERP experience is worth more in the markets where Axpert
  // is actually sold, and because he already lives and works in Oman, so no
  // sponsorship question arises for the Gulf at all.
  'IN', 'AE', 'SA', 'QA', 'OM', 'KW', 'BH',
];

export const DEFAULT_SEARCH: JobQuery = {
  countries: [],
  titles: [
    'Oracle Developer', 'PL/SQL Developer', 'Database Developer', 'Database Engineer',
    'Database Administrator', 'SQL Developer', 'ERP Developer', 'ERP Consultant',
    'Application Developer', 'Backend Developer', 'Software Developer', 'Software Engineer',
    'Data Engineer', 'Technical Consultant',
    // ERP is 2.5 years of this profile's strongest domain work -- Axpert module
    // development, finance, inventory and logistics at Northwind and Meridian --
    // and it was reachable only through the two generic 'ERP Developer' and
    // 'ERP Consultant' titles. These are the titles those roles are actually
    // advertised under, and 'Axpert' is searched by name: it is a smaller
    // vendor, well known in India and the Gulf, so a keyword search finds
    // postings that no generic title query returns.
    'Axpert Developer', 'Axpert ERP', 'ERP Functional Consultant', 'ERP Support Engineer',
    'ERP Analyst', 'ERP Implementation Consultant', 'ERP Technical Consultant',
    'Business Applications Developer', 'Data Analyst',
  ],
  keywords: ['oracle', 'plsql', 'postgresql', 'sql', 'database', 'erp', 'axpert'],
  postedWithinDays: 30,
  /**
   * Where a source should spend EXTRA request budget when it has some. It does
   * not restrict collection -- `countries: []` above still means everywhere.
   * Adzuna uses it to sweep its consultancy and engineering categories in the
   * markets that matter rather than across all twenty-one endpoints.
   */
  priorityCountries: DEFAULT_TARGET_COUNTRIES,
  /**
   * The per-source ceiling, raised from 600.
   *
   * 600 was not a politeness limit -- each source paces its own requests and
   * caps its own pages, and that is what actually protects the API. It was a cap
   * on ROWS, and it silently decided that a global sweep of twenty-one Adzuna
   * countries plus Arbeitnow plus The Muse should return fewer jobs than Adzuna
   * alone offers for Germany. Requests are the scarce resource; rows are free
   * once fetched.
   */
  limit: Number(process.env.JOB_COLLECTION_LIMIT || 5000),
};
