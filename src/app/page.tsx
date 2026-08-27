import Link from 'next/link';
import { NoProfileNotice } from '@/components/NoProfileNotice';
import { isReady } from '@/lib/db/pool';
import { dashboardStats, facetCounts, listJobs, scoreBuckets, cvTextFor, latestProfile } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { countryName } from '@/lib/jobs/types';
import { roleLabel } from '@/lib/match/roles';
import { Card, RecommendationPill, ScoreRing, SponsorshipPill, Stat } from '@/components/ui';
import { BarList, Donut, Funnel, Histogram } from '@/components/charts';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const ready = await isReady();
  if (!ready.ready) return <SetupNeeded reason={ready.reason ?? 'unknown'} />;

  const userId = await currentUserId();
  // Same reason as the Jobs page: no profile means no scores anywhere.
  const [dashProfile, dashCv] = await Promise.all([latestProfile(userId), cvTextFor(userId)]);
  const [stats, top, facets, buckets] = await Promise.all([
    dashboardStats(userId),
    listJobs(userId, { minScore: 70, limit: 6 }),
    facetCounts(),
    scoreBuckets(userId),
  ]);

  const countries = facets.countries
    .filter((c) => c.value)
    .map((c) => ({ label: countryName(c.value), value: c.count }));
  const roles = facets.roles
    .filter((r) => r.value)
    .map((r) => ({ label: roleLabel(r.value), value: r.count }));

  return (
    <div className="space-y-8">
      {!dashProfile && <NoProfileNotice hasCv={Boolean(dashCv)} />}
      {/* Hero */}
      <div className="animate-rise">
        <p className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">Your job search</p>
        <h1 className="font-display mt-1 text-4xl font-extrabold leading-tight sm:text-5xl">
          <span className="text-gradient">{stats.total_jobs.toLocaleString()}</span> jobs, ranked for you
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--color-muted)]">
          {stats.highly_matched} highly-recommended roles · {stats.new_jobs} arrived in the last 24 hours ·
          refreshed automatically every morning.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Jobs found" value={stats.total_jobs} href="/jobs" gradient="violet" icon="🌍" />
        <Stat label="New (24h)" value={stats.new_jobs} href="/jobs" gradient="blue" icon="✨" />
        <Stat label="Top matches" value={stats.highly_matched} href="/jobs?recommendation=highly_recommended" gradient="green" icon="🎯" />
        <Stat label="Sponsorship" value={stats.sponsoring} href="/jobs?sponsorship=1" gradient="pink" icon="🛂" />
        <Stat label="Applied" value={stats.applied} href="/applications" icon="📮" />
        <Stat label="Interviews" value={stats.interview} href="/applications" icon="💬" />
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Match quality — how your scores are spread">
          <Histogram buckets={buckets} />
        </Card>
        <Card title="Roles on offer">
          {roles.length ? <Donut data={roles} unit="jobs" /> : <Empty />}
        </Card>
        <Card title="Where the jobs are">
          {countries.length ? <BarList data={countries} gradient="var(--grad-blue)" /> : <Empty />}
        </Card>
        <Card title="Your application pipeline">
          <Funnel
            stages={[
              { label: 'applied', value: stats.applied },
              { label: 'interview', value: stats.interview },
              { label: 'offer', value: stats.offer },
            ]}
          />
          <Link href="/applications" className="mt-4 inline-block text-xs font-semibold text-[var(--color-accent)]">
            open the tracker →
          </Link>
        </Card>
      </div>

      {/* Best matches */}
      <Card
        title="Best matches for you"
        actions={<Link href="/jobs" className="text-xs font-semibold text-[var(--color-accent)]">see all →</Link>}
      >
        {top.rows.length === 0 ? (
          <Empty />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {top.rows.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="glass glass-hover flex items-start gap-4 rounded-2xl p-4"
                >
                  <ScoreRing score={job.overall} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-[var(--color-fg)]">{job.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-[var(--color-muted)]">
                      {job.company}
                      {job.city ? ` — ${job.city}` : ''}
                      {job.country ? `, ${countryName(job.country)}` : ''} · {job.remote}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      <RecommendationPill value={job.recommendation} />
                      <SponsorshipPill value={job.visa_sponsorship} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Empty() {
  return (
    <p className="text-sm text-[var(--color-muted)]">
      Nothing here yet — jobs refresh automatically each morning, or run <code className="text-[var(--color-fg)]">npm run sync</code>.
    </p>
  );
}

function SetupNeeded({ reason }: { reason: string }) {
  return (
    <Card title="Setup needed">
      <p className="text-sm text-[var(--color-bad)]">{reason}</p>
      <ol className="mt-3 list-inside list-decimal space-y-1 text-sm text-[var(--color-muted)]">
        <li>Make sure the database is reachable.</li>
        <li>Run <code className="text-[var(--color-fg)]">npm run db:migrate</code></li>
        <li>Run <code className="text-[var(--color-fg)]">npm run sync</code></li>
      </ol>
    </Card>
  );
}
