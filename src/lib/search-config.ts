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
export const DEFAULT_SEARCH: JobQuery = {
  countries: ['DE', 'NL', 'SE', 'FI', 'DK', 'NO', 'IE', 'BE', 'AT', 'FR', 'CH', 'LU', 'PL'],
  titles: [
    'Oracle Developer', 'PL/SQL Developer', 'Database Developer', 'Database Engineer',
    'Database Administrator', 'SQL Developer', 'ERP Developer', 'ERP Consultant',
    'Application Developer', 'Backend Developer', 'Software Developer', 'Software Engineer',
    'Data Engineer', 'Technical Consultant',
  ],
  keywords: ['oracle', 'plsql', 'postgresql', 'sql', 'database', 'erp'],
  postedWithinDays: 30,
  limit: 400,
};
