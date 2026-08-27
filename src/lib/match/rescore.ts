import { allJobs, getTargetCountries, latestProfile, saveMatches, unscoredJobs, type JobRow } from '../db/repo.ts';
import { DEFAULT_TARGET_COUNTRIES } from '../search-config.ts';
import type { NormalisedJob } from '../jobs/types.ts';
import { scoreJob } from './score.ts';

/**
 * Score the shared feed against one user's profile.
 *
 * Jobs are collected once for everyone; scores are per person. So a new account,
 * or an updated profile, has to be caught up with whatever has already been
 * collected -- otherwise a user who signs up between two syncs sees a few
 * hundred jobs with no score at all.
 *
 * Done in **batches with a reported remainder**, not in one pass. A deployed
 * request has a hard timeout, and a function that quietly scores the first 200 of
 * 5,000 jobs and returns "done" is worse than one that says how many are left.
 * The caller (the Profile page, or the CLI) keeps calling until `remaining` is 0.
 *
 * Scoring stays deterministic code here as everywhere else: no model is asked
 * for an opinion, so catching up 5,000 jobs costs nothing but CPU.
 */

export const DEFAULT_BATCH = Number(process.env.RESCORE_BATCH || 400);

export interface RescoreResult {
  scored: number;
  remaining: number;
  profileVersion: number | null;
}

/** The normalised shape the scorer expects, rebuilt from a stored row. */
export function rowToJob(row: JobRow): NormalisedJob {
  return {
    sourceSlug: row.source_slug,
    sourceJobId: String(row.id),
    url: row.url,
    title: row.title,
    company: row.company,
    country: row.country,
    city: row.city,
    remote: row.remote as NormalisedJob['remote'],
    employmentType: row.employment_type,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    description: row.description,
    descriptionComplete: row.description_complete,
    languages: row.languages ?? [],
    visaSponsorship: row.visa_sponsorship as NormalisedJob['visaSponsorship'],
    relocationSupport: row.relocation_support as NormalisedJob['relocationSupport'],
    postedAt: row.posted_at ? new Date(row.posted_at) : null,
    raw: {},
  };
}

/**
 * The countries this user's location score treats as "target".
 *
 * Their own preference if they have set one, otherwise the app's default market.
 * Never the collection list: that is now global, and scoring every country as a
 * target country would flatten the component to a constant.
 */
export async function targetCountriesFor(userId: number): Promise<string[]> {
  const chosen = await getTargetCountries(userId);
  return chosen.length ? chosen : DEFAULT_TARGET_COUNTRIES;
}

export async function rescoreForUser(userId: number, batch = DEFAULT_BATCH): Promise<RescoreResult> {
  const profile = await latestProfile(userId);
  if (!profile) return { scored: 0, remaining: 0, profileVersion: null };

  const preferredCountries = await targetCountriesFor(userId);
  const { rows, remaining } = await unscoredJobs(profile.id, batch);

  const entries = rows.map((row) => ({
    jobId: row.id,
    match: scoreJob(profile.data, rowToJob(row), { preferredCountries }),
  }));

  const scored = await saveMatches(profile.id, entries);
  return {
    scored,
    // `remaining` was measured before this batch was written.
    remaining: Math.max(0, remaining - scored),
    profileVersion: profile.data.version,
  };
}

/**
 * Re-score jobs that ALREADY have a match for this profile.
 *
 * Needed when an input to the score changes without the job changing -- the user
 * edits their target countries, or the scorer itself is improved. Walks by
 * ascending job id so the caller can resume from `lastId` after a timeout, and
 * reports `done` instead of guessing.
 */
export async function rescoreAllForUser(
  userId: number,
  afterId = 0,
  batch = DEFAULT_BATCH
): Promise<{ scored: number; lastId: number; done: boolean }> {
  const profile = await latestProfile(userId);
  if (!profile) return { scored: 0, lastId: afterId, done: true };

  const preferredCountries = await targetCountriesFor(userId);
  const rows = await allJobs(batch, afterId);
  if (rows.length === 0) return { scored: 0, lastId: afterId, done: true };

  const entries = rows.map((row) => ({
    jobId: row.id,
    match: scoreJob(profile.data, rowToJob(row), { preferredCountries }),
  }));
  const scored = await saveMatches(profile.id, entries);

  return {
    scored,
    lastId: rows[rows.length - 1]!.id,
    done: rows.length < batch,
  };
}
