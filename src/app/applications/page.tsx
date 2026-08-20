import Link from 'next/link';
import { listApplications } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { Card, ScoreBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** The pipeline order the tracker shows. Terminal states sit apart. */
const PIPELINE = ['new', 'shortlisted', 'resume_ready', 'applied', 'interview', 'offer'] as const;
const CLOSED = ['rejected', 'withdrawn'] as const;

const LABELS: Record<string, string> = {
  new: 'New', shortlisted: 'Shortlisted', resume_ready: 'Resume ready',
  applied: 'Applied', interview: 'Interview', offer: 'Offer',
  rejected: 'Rejected', withdrawn: 'Withdrawn',
};

export default async function ApplicationsPage() {
  const userId = await currentUserId();
  const applications = await listApplications(userId);

  const byStage = new Map<string, typeof applications>();
  for (const application of applications) {
    const list = byStage.get(application.stage) ?? [];
    list.push(application);
    byStage.set(application.stage, list);
  }

  return (
    <div className="space-y-4">
      <Card title={`${applications.length} tracked`}>
        <p className="text-sm text-[var(--color-muted)]">
          Move a job through the stages from its detail page. Every transition is recorded with a timestamp,
          so &ldquo;when did this reach interview&rdquo; is always answerable.
        </p>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {PIPELINE.map((stage) => (
          <Column key={stage} stage={stage} label={LABELS[stage]!} items={byStage.get(stage) ?? []} />
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {CLOSED.map((stage) => (
          <Column key={stage} stage={stage} label={LABELS[stage]!} items={byStage.get(stage) ?? []} />
        ))}
      </div>
    </div>
  );
}

function Column({ label, items }: { stage: string; label: string; items: Record<string, unknown>[] }) {
  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-3">
      <h2 className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
        {label}
        <span className="tnum">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">—</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={String(item.id)} className="rounded border border-[var(--color-line)] p-2">
              <Link href={`/jobs/${item.job_id}`} className="block text-sm hover:text-[var(--color-accent)]">
                {String(item.title)}
              </Link>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {String(item.company)}
                {item.country ? `, ${String(item.country)}` : ''}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <ScoreBadge score={item.overall as number | null} />
                {item.applied_at ? (
                  <span className="text-[11px] text-[var(--color-muted)]">
                    applied {new Date(String(item.applied_at)).toISOString().slice(0, 10)}
                  </span>
                ) : null}
              </div>
              {item.notes ? <p className="mt-1.5 text-xs text-[var(--color-fg)]/70">{String(item.notes)}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
