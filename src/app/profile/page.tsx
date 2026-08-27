import { latestProfile, unscoredJobs } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { Card, Pill } from '@/components/ui';
import { ProfileTools } from '@/components/ProfileTools';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
  language: 'Languages',
  database: 'Databases',
  database_admin: 'Database administration',
  framework: 'Frameworks & platforms',
  erp: 'Enterprise systems',
  ai: 'AI & automation',
  tool: 'Tools',
  domain: 'Domain knowledge',
  os: 'Operating systems',
  soft: 'Ways of working',
};

export default async function ProfilePage() {
  const userId = await currentUserId();
  const profile = await latestProfile(userId);

  if (!profile) {
    return (
      <Card title="No profile yet">
        <p className="text-sm text-[var(--color-muted)]">
          Nothing can be scored or written without one. Upload yours as JSON —{' '}
          <a href="/api/profile/template" className="text-[var(--color-accent)]">
            start from the template
          </a>
          . Locally you can also drop a file in <code className="text-[var(--color-fg)]">data/</code> and run{' '}
          <code className="text-[var(--color-fg)]">npm run db:migrate</code>.
        </p>
        <div className="mt-4">
          <ProfileTools version={0} unscored={0} />
        </div>
      </Card>
    );
  }

  // How much of the shared feed has not been scored against this profile yet.
  // Jobs are collected once for everyone; scores are per person, so a profile
  // uploaded between two syncs starts behind.
  const { remaining: unscored } = await unscoredJobs(profile.id, 1);

  const p = profile.data;
  const byCategory = new Map<string, typeof p.skills>();
  for (const skill of p.skills) {
    const list = byCategory.get(skill.category) ?? [];
    list.push(skill);
    byCategory.set(skill.category, list);
  }

  return (
    <div className="space-y-4">
      <Card title={`Profile v${p.version}`}>
        <h1 className="text-lg font-semibold">{p.name}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{p.headline}</p>
        <p className="mt-2 text-sm">{p.summary}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Pill tone="accent">{p.totalYears} years experience</Pill>
          <Pill>{p.skills.length} evidenced skills</Pill>
          {p.workAuthorisation.needsSponsorship && <Pill tone="warn">needs visa sponsorship</Pill>}
        </div>
      </Card>

      <Card title="Every skill, with its evidence">
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          A skill cannot exist here without a note saying where it came from. That is the mechanism that stops
          generated documents claiming anything you could not back up in an interview.
        </p>
        <div className="space-y-4">
          {[...byCategory.entries()].map(([category, skills]) => (
            <div key={category}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                {LABELS[category] ?? category}
              </p>
              <ul className="mt-1 space-y-1.5">
                {skills.map((skill) => (
                  <li key={skill.canonical} className="text-sm">
                    <span className="font-medium">{skill.name}</span>
                    <span className="text-[var(--color-muted)]">
                      {' '}
                      — {skill.level}
                      {skill.years ? `, ~${skill.years}y` : ''}
                    </span>
                    <span className="block text-xs text-[var(--color-fg)]/60">{skill.evidence}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      {p.employmentGaps.length > 0 && (
        <Card title="Employment gaps">
          {p.employmentGaps.map((gap, i) => (
            <div key={i} className="mb-3 last:mb-0">
              <p className="text-sm font-medium">
                {gap.from} to {gap.to} ({gap.months} months)
                {!gap.verified && <span className="ml-2 text-xs text-[var(--color-warn)]">not documented</span>}
              </p>
              <p className="mt-1 text-sm text-[var(--color-fg)]/80">{gap.explanation}</p>
              {gap.guidance && <p className="mt-1 text-xs text-[var(--color-accent)]">{gap.guidance}</p>}
            </div>
          ))}
        </Card>
      )}

      <Card title="Editing this">
        <p className="text-sm text-[var(--color-muted)]">
          Upload a new version below, or edit{' '}
          <code className="text-[var(--color-fg)]">data/profile.v{p.version}.json</code> and run{' '}
          <code className="text-[var(--color-fg)]">npm run db:migrate</code> if you are working locally. Either way a
          new version is created and the old one is kept: every match records the profile version that scored it, so
          an old result stays explainable against the facts that were true at the time.
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Start from the{' '}
          <a href="/api/profile/template" className="text-[var(--color-accent)]">
            template
          </a>{' '}
          if you want the exact shape. Every skill needs its <code className="text-[var(--color-fg)]">evidence</code>{' '}
          line or the upload is rejected.
        </p>
        <div className="mt-4">
          <ProfileTools version={p.version} unscored={unscored} />
        </div>
      </Card>
    </div>
  );
}
