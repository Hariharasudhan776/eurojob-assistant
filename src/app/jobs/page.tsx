import Link from 'next/link';
import { listJobs, type JobFilters } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { EUROPEAN_COUNTRIES } from '@/lib/jobs/types';
import { Card, Pill, RecommendationPill, ScoreBadge, SponsorshipPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;

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
    search: one('q') || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  const userId = await currentUserId();
  const { rows, total } = await listJobs(userId, filters);
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
    <div className="space-y-4">
      <Card title={`${total} jobs`}>
        <form className="flex flex-wrap items-end gap-3" action="/jobs">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Search
            <input name="q" defaultValue={one('q') ?? ''} placeholder="title or company"
              className="w-52 rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2 py-1.5 text-sm text-[var(--color-fg)]" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Min score
            <select name="minScore" defaultValue={one('minScore') ?? ''}
              className="rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2 py-1.5 text-sm text-[var(--color-fg)]">
              <option value="">any</option>
              {[50, 60, 70, 75, 80].map((n) => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Country
            <select name="country" defaultValue={one('country') ?? ''}
              className="rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2 py-1.5 text-sm text-[var(--color-fg)]">
              <option value="">all</option>
              {Object.entries(EUROPEAN_COUNTRIES).map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Working mode
            <select name="remote" defaultValue={one('remote') ?? ''}
              className="rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2 py-1.5 text-sm text-[var(--color-fg)]">
              <option value="">any</option>
              {['remote', 'hybrid', 'onsite', 'unknown'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Verdict
            <select name="recommendation" defaultValue={one('recommendation') ?? ''}
              className="rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2 py-1.5 text-sm text-[var(--color-fg)]">
              <option value="">any</option>
              <option value="highly_recommended">highly recommended</option>
              <option value="possible">possible</option>
              <option value="low">low</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-xs text-[var(--color-muted)]">
            <input type="checkbox" name="sponsorship" value="1" defaultChecked={one('sponsorship') === '1'} />
            Sponsorship stated
          </label>
          <button type="submit" className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink)]">
            Apply
          </button>
          <Link href="/jobs" className="pb-1.5 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]">clear</Link>
        </form>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            No jobs match. {total === 0 ? 'Run npm run sync to collect some.' : 'Try relaxing the filters.'}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {rows.map((job) => (
              <li key={job.id} className="py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <ScoreBadge score={job.overall} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/jobs/${job.id}`} className="block truncate text-sm font-medium hover:text-[var(--color-accent)]">
                      {job.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {job.company}
                      {job.city ? ` — ${job.city}` : ''}
                      {job.country ? `, ${job.country}` : ''} · {job.remote} · {job.source_slug}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <RecommendationPill value={job.recommendation} />
                      <SponsorshipPill value={job.visa_sponsorship} />
                      {!job.description_complete && <Pill tone="warn">extract only</Pill>}
                      {job.stage && <Pill tone="accent">{job.stage}</Pill>}
                      {job.strong_matches?.length ? (
                        <span className="truncate text-[11px] text-[var(--color-muted)]">
                          {job.strong_matches.slice(0, 4).join(' · ')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {pages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-xs text-[var(--color-muted)]">page {page} of {pages}</span>
          <div className="flex gap-2">
            {page > 1 && <Link className="text-[var(--color-accent)]" href={`${linkWith({})}&page=${page - 1}`}>previous</Link>}
            {page < pages && <Link className="text-[var(--color-accent)]" href={`${linkWith({})}&page=${page + 1}`}>next</Link>}
          </div>
        </div>
      )}
    </div>
  );
}
