/**
 * When a posting stops being a posting.
 *
 * The whole rule lives here, in one place, because it is a judgement rather than
 * a fact and it should be arguable in one file rather than scattered across the
 * SQL. See `db/006_job_lifecycle.sql` for why the more certain-looking checks
 * (fetching the URL, reading the page for a "no longer available" marker,
 * treating absence from the next sweep as removal) were measured against the
 * live feed and rejected: none of the three sources supports any of them.
 */

/**
 * How long a posting is presumed open after the last evidence that it was.
 *
 * 45 days, and the number is derived rather than picked. Collection asks every
 * source for the last 30 days (`DEFAULT_SEARCH.postedWithinDays`), so 30 is the
 * longest a live posting can go without being seen by a sweep purely because it
 * aged out of the search -- expiring at 30 would therefore close jobs that are
 * demonstrably still open. The extra fifteen days is the margin for a run that
 * did not happen: a week of a broken schedule must not empty the feed.
 *
 * Raise it and dead jobs linger; lower it and live ones vanish. `JOB_STALE_AFTER_DAYS`
 * makes that the reader's call.
 */
export const STALE_AFTER_DAYS = Math.max(1, Number(process.env.JOB_STALE_AFTER_DAYS || 45));

export const CLOSED_REASONS = ['expired', 'reported'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

/**
 * The date rule, as SQL, against the `jobs` alias given.
 *
 * `GREATEST(last_seen_at, posted_at)` and not either one alone. A posting dated
 * three months ago that a source returned this morning is open -- the source
 * saying so outranks the date on it. A posting dated this morning that no sweep
 * has ever returned (it was collected once, at signup, from a source that has
 * since gone quiet) is judged on its date. Taking the later of the two means
 * either kind of evidence keeps a job alive, and only the absence of both
 * closes it.
 *
 * NULLs: a row with neither date is left OPEN. Silence is not evidence, and the
 * failure mode of hiding a live job the reader wanted is worse than the failure
 * mode of showing one extra stale row.
 */
export const staleClause = (alias = 'j') =>
  `GREATEST(${alias}.last_seen_at, ${alias}.posted_at) < now() - interval '${STALE_AFTER_DAYS} days'`;

/** Human wording for the badge on a closed job. */
export function closedLabel(reason: string | null, at: Date | string | null): string {
  const when = at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
  if (reason === 'reported') return when ? `Reported gone on ${when}` : 'Reported no longer available';
  if (reason === 'expired') return `No source has listed this for over ${STALE_AFTER_DAYS} days`;
  return 'Closed';
}
