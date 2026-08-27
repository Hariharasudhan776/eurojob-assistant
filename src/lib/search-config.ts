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
export const DEFAULT_SEARCH: JobQuery = {
  countries: [],
  titles: [
    'Oracle Developer', 'PL/SQL Developer', 'Database Developer', 'Database Engineer',
    'Database Administrator', 'SQL Developer', 'ERP Developer', 'ERP Consultant',
    'Application Developer', 'Backend Developer', 'Software Developer', 'Software Engineer',
    'Data Engineer', 'Technical Consultant',
  ],
  keywords: ['oracle', 'plsql', 'postgresql', 'sql', 'database', 'erp'],
  postedWithinDays: 30,
  limit: Number(process.env.JOB_COLLECTION_LIMIT || 600),
};

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
];
