import Link from 'next/link';
import { facetCounts, listJobs, type JobFilters } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { countryName } from '@/lib/jobs/types';
import { roleLabel } from '@/lib/match/roles';
import { Card, GradientButton, Pill, RecommendationPill, ScoreRing, SponsorshipPill } from '@/components/ui';
import { extractSalary, formatSalary } from '@/lib/jobs/compensation';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;
// Solid (not glassy) background: native <select> popups inherit the control's
// background, and a transparent one renders an unreadable option list.
const field =
  'rounded-xl border border-white/10 bg-[#1b1430] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]';

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const page = Math.max(1, Number(one('page') ?? 1));
  const filters: JobFilters = {
    minScore: one('minScore') ? Number(one('minScore')) : undefined,
    countries: one('country') ? [one('country')!] : undefined,
    remote: one('remote') || undefined,
    recommendation: one('recommendation') || undefined,
    sponsorshipOnly: one('sponsorship') === '1',
    role: one('role') || undefined,
    search: one('q') || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const userId = await currentUserId();
  const [{ rows, total }, facets] = await Promise.all([listJobs(userId, filters), facetCounts()]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const linkWith = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const v = Array.isArray(value) ? value[0] : value;
      if (v) next.set(key, v);
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
    }
    next.delete('page');
    return `/jobs?${next.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="animate-rise">
        <h1 className="font-display text-3xl font-extrabold">
          <span className="text-gradient">{total.toLocaleString()}</span> jobs
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">Filtered from a global feed, ranked against your profile.</p>
      </div>

      <Card>
        <form className="flex flex-wrap items-end gap-3" action="/jobs">
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--color-muted)]">
            Search
            <input name="q" defaultValue={one('q') ?? ''} placeholder="title or company" className={`${field} w-52`} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--color-muted)]">
            Min score
            <select name="minScore" defaultValue={one('minScore') ?? ''} className={field}>
              <option value="">any</option>
              {[50, 60, 70, 75, 80].map((n) => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--color-muted)]">
            Country
            <select name="country" defaultValue={one('country') ?? ''} className={field}>
              <option value="">anywhere</option>
              {facets.countries.filter((c) => c.value).map((c) => (
                <option key={c.value} value={c.value!}>{countryName(c.value)} ({c.count})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--color-muted)]">
            Role
            <select name="role" defaultValue={one('role') ?? ''} className={field}>
              <option value="">any role</option>
              {facets.roles.filter((r) => r.value).map((r) => (
                <option key={r.value} value={r.value!}>{roleLabel(r.value)} ({r.count})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--color-muted)]">
            Working mode
            <select name="remote" defaultValue={one('remote') ?? ''} className={field}>
              <option value="">any</option>
              {['remote', 'hybrid', 'onsite', 'unknown'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--color-muted)]">
            Verdict
            <select name="recommendation" defaultValue={one('recommendation') ?? ''} className={field}>
              <option value="">any</option>
              <option value="highly_recommended">highly recommended</option>
              <option value="possible">possible</option>
              <option value="low">low</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-xs font-semibold text-[var(--color-muted)]">
            <input type="checkbox" name="sponsorship" value="1" defaultChecked={one('sponsorship') === '1'} className="accent-[var(--color-accent)]" />
            Sponsorship stated
          </label>
          <GradientButton>Apply filters</GradientButton>
          <Link href="/jobs" className="pb-2 text-xs font-semibold text-[var(--color-muted)] hover:text-[var(--color-fg)]">clear</Link>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--color-muted)]">
            No jobs match. {total === 0 ? 'They refresh automatically each morning.' : 'Try relaxing the filters.'}
          </p>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((job) => (
            <li key={job.id}>
              <Link href={`/jobs/${job.id}`} className="glass glass-hover flex h-full items-start gap-4 rounded-2xl p-4">
                <ScoreRing score={job.overall} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-[var(--color-fg)]">{job.title}</span>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                    {job.company}
                    {job.city ? ` — ${job.city}` : ''}
                    {job.country ? `, ${countryName(job.country)}` : ''} · {job.remote} · {job.source_slug}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <RecommendationPill value={job.recommendation} />
                    <SponsorshipPill value={job.visa_sponsorship} />
                    {salaryPill(job)}
                    {job.role_category && <Pill>{roleLabel(job.role_category)}</Pill>}
                    {!job.description_complete && <Pill tone="warn">extract only</Pill>}
                    {job.stage && <Pill tone="accent">{job.stage}</Pill>}
                  </div>
                  {job.strong_matches?.length ? (
                    <p className="mt-1.5 truncate text-[11px] text-[var(--color-muted)]">
                      ✓ {job.strong_matches.slice(0, 5).join(' · ')}
                    </p>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-xs text-[var(--color-muted)]">page {page} of {pages}</span>
          <div className="flex gap-3">
            {page > 1 && <Link className="font-semibold text-[var(--color-accent)]" href={`${linkWith({})}&page=${page - 1}`}>← previous</Link>}
            {page < pages && <Link className="font-semibold text-[var(--color-accent)]" href={`${linkWith({})}&page=${page + 1}`}>next →</Link>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Pay on the list card, from the structured field when the source gave one and
 * from the posting text otherwise.
 *
 * Text is the common case by a wide margin -- of 2,563 live jobs, 263 carried a
 * salary in an API field and another 331 stated one only in prose. Reading it
 * here is what turns "salary: not stated" into a number on ten times as many
 * cards, without a migration or a re-sync.
 */
function salaryPill(job: { salary_min: number | null; salary_max: number | null; salary_currency: string | null; description: string | null }) {
  if (job.salary_min || job.salary_max) {
    const money = (v: number) => `${job.salary_currency ? `${job.salary_currency} ` : ''}${v.toLocaleString('en-GB')}`;
    const text = job.salary_min && job.salary_max ? `${money(job.salary_min)} – ${money(job.salary_max)}` : money(job.salary_min ?? job.salary_max ?? 0);
    return <Pill tone="good">{text}</Pill>;
  }
  const found = extractSalary(job.description ?? '');
  return found ? <Pill tone="good">{formatSalary(found)}</Pill> : null;
}
