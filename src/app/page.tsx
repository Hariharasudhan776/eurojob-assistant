import Link from 'next/link';
import { isReady } from '@/lib/db/pool';
import { dashboardStats, listJobs } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { Card, RecommendationPill, ScoreBadge, SponsorshipPill, Stat } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const ready = await isReady();
  if (!ready.ready) return <SetupNeeded reason={ready.reason ?? 'unknown'} />;

  const userId = await currentUserId();
  const [stats, top] = await Promise.all([
    dashboardStats(userId),
    listJobs(userId, { minScore: 70, limit: 8 }),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Jobs found" value={stats.total_jobs} href="/jobs" />
        <Stat label="New (24h)" value={stats.new_jobs} href="/jobs" />
        <Stat label="Highly matched" value={stats.highly_matched} href="/jobs?recommendation=highly_recommended" />
        <Stat label="Mention sponsorship" value={stats.sponsoring} href="/jobs?sponsorship=1" />
        <Stat label="Applied" value={stats.applied} href="/applications" />
        <Stat label="Interview" value={stats.interview} href="/applications" />
      </div>

      <Card
        title="Best matches"
        actions={<Link href="/jobs" className="text-xs text-[var(--color-accent)]">see all</Link>}
      >
        {top.rows.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            Nothing scored yet. Run <code className="text-[var(--color-fg)]">npm run sync</code> to collect jobs.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {top.rows.map((job) => (
              <li key={job.id} className="py-3">
                <Link href={`/jobs/${job.id}`} className="group flex flex-wrap items-start gap-3">
                  <ScoreBadge score={job.overall} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium group-hover:text-[var(--color-accent)]">
                      {job.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                      {job.company}
                      {job.city ? ` — ${job.city}` : ''}
                      {job.country ? `, ${job.country}` : ''} · {job.remote}
                    </span>
                    <span className="mt-1.5 flex flex-wrap gap-1.5">
                      <RecommendationPill value={job.recommendation} />
                      <SponsorshipPill value={job.visa_sponsorship} />
                      {job.stage && <span className="text-[11px] text-[var(--color-accent)]">{job.stage}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Keeping it fed">
        <div className="space-y-2 text-sm text-[var(--color-muted)]">
          <p>
            <code className="text-[var(--color-fg)]">npm run sync</code> — collect and score. Costs nothing; no AI is used.
          </p>
          <p>
            <code className="text-[var(--color-fg)]">npm run sync -- --explain 5</code> — also write plain-English
            verdicts for the top 5. About $0.01 each.
          </p>
          <p>Scheduling that once a day means this page is always current without you doing anything.</p>
        </div>
      </Card>
    </div>
  );
}

function SetupNeeded({ reason }: { reason: string }) {
  return (
    <Card title="Setup needed">
      <p className="text-sm text-[var(--color-bad)]">{reason}</p>
      <ol className="mt-3 list-inside list-decimal space-y-1 text-sm text-[var(--color-muted)]">
        <li>Make sure PostgreSQL is running.</li>
        <li>Copy <code className="text-[var(--color-fg)]">.env.example</code> to <code className="text-[var(--color-fg)]">.env</code> and fill it in.</li>
        <li>Run <code className="text-[var(--color-fg)]">npm run db:migrate</code></li>
        <li>Run <code className="text-[var(--color-fg)]">npm run sync</code></li>
      </ol>
    </Card>
  );
}
