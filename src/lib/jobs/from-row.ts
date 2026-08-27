import type { NormalisedJob } from './types.ts';

/**
 * Rebuild the normalised shape from a stored job row, so scoring has one code
 * path whether it runs during collection, in an API route, or on a page.
 *
 * This used to live privately inside the analyse route. It moved here when the
 * job page needed to score a posting itself: the page previously read the
 * `breakdown` column that a past sync had written, which is fine for a number
 * and wrong for anything derived from the matcher's vocabulary. A stored
 * breakdown predates the current taxonomy, so it carries neither the employer's
 * own spellings nor any requirement the matcher has since learned to see. Two
 * ways of turning a row into a job would have made that discrepancy permanent.
 */
export interface JobRow {
  id: number;
  source_slug: string;
  url: string;
  title: string;
  company: string;
  country: string | null;
  city: string | null;
  remote: string;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  description: string;
  description_complete: boolean;
  languages: string[] | null;
  visa_sponsorship: string;
  relocation_support: string;
  posted_at: string | Date | null;
}

export function jobRowToNormalised(job: JobRow): NormalisedJob {
  return {
    sourceSlug: job.source_slug,
    sourceJobId: String(job.id),
    url: job.url,
    title: job.title,
    company: job.company,
    country: job.country,
    city: job.city,
    remote: job.remote as NormalisedJob['remote'],
    employmentType: job.employment_type,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    salaryCurrency: job.salary_currency,
    description: job.description,
    descriptionComplete: job.description_complete,
    languages: job.languages ?? [],
    visaSponsorship: job.visa_sponsorship as NormalisedJob['visaSponsorship'],
    relocationSupport: job.relocation_support as NormalisedJob['relocationSupport'],
    postedAt: job.posted_at ? new Date(job.posted_at) : null,
    raw: {},
  };
}
