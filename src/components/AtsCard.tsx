import type { AtsReport, AtsCheck } from '@/lib/match/ats';
import { ScoreRing } from '@/components/ui';

/**
 * ATS clearance card, shown above the generate buttons so the applicant sees how
 * their resume will fare before spending a call on tailoring. Server-rendered and
 * free — it reflects the match that already exists.
 */
export function AtsCard({ report }: { report: AtsReport }) {
  const clear = report.verdict === 'clear';
  return (
    <section className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-4">
        <ScoreRing score={report.score} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-sm font-bold">ATS clearance check</h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            Runs before you tailor — how machine-readable your resume is, and how well it matches this posting&apos;s keywords.
          </p>
        </div>
        <span
          className="rounded-full px-3 py-1 text-xs font-bold text-white shadow"
          style={{ backgroundImage: clear ? 'var(--grad-green)' : 'linear-gradient(135deg,#f59e0b,#f97316)' }}
        >
          {clear ? '✓ ATS-ready' : '⚠ Worth a look'}
        </span>
      </div>

      {/* Keyword coverage */}
      <div className="mt-4">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-[var(--color-muted)]">Keyword coverage for this job</span>
          <span className="tnum font-bold">{report.coverage.percent}%</span>
        </div>
        <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/8">
          <div
            className="h-full rounded-full"
            style={{
              width: `${report.coverage.percent}%`,
              backgroundImage: report.coverage.percent >= 55 ? 'var(--grad-green)' : 'var(--grad-pink)',
            }}
          />
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ChipList label="Covered" tone="var(--color-good)" items={report.coverage.covered} empty="—" />
          <ChipList label="Missing (add if you have it)" tone="var(--color-bad)" items={report.coverage.missing} empty="none — full coverage" />
        </div>
        {report.coverage.transferable.length > 0 && (
          <div className="mt-3">
            <ChipList label="Transferable" tone="var(--color-warn)" items={report.coverage.transferable} empty="" />
          </div>
        )}
      </div>

      {/* Checklists */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ChecklistBlock title="Format" checks={report.format} />
        <ChecklistBlock title="Contact details" checks={report.contact} />
      </div>
    </section>
  );
}

function ChipList({ label, tone, items, empty }: { label: string; tone: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: tone }}>{label}</p>
      {items.length === 0 ? (
        empty ? <p className="mt-1 text-xs text-[var(--color-muted)]">{empty}</p> : null
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {items.slice(0, 12).map((item) => (
            <span
              key={item}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ color: tone, background: `color-mix(in srgb, ${tone} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)` }}
            >
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ChecklistBlock({ title, checks }: { title: string; checks: AtsCheck[] }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</p>
      <ul className="mt-1.5 space-y-1">
        {checks.map((c) => (
          <li key={c.label} className="flex items-start gap-2 text-xs">
            <span style={{ color: c.pass ? 'var(--color-good)' : 'var(--color-bad)' }}>{c.pass ? '✓' : '✗'}</span>
            <span className="text-[var(--color-fg)]/85">
              {c.label}
              {!c.pass && <span className="text-[var(--color-muted)]"> — {c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
