import Link from 'next/link';

export function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) {
    return <span className="text-xs text-[var(--color-muted)]">unscored</span>;
  }
  const colour =
    score >= 80 ? 'var(--color-good)' : score >= 60 ? 'var(--color-warn)' : 'var(--color-muted)';
  return (
    <span className="tnum inline-flex min-w-12 items-center justify-center rounded px-2 py-0.5 text-sm font-semibold"
          style={{ color: colour, border: `1px solid ${colour}33`, background: `${colour}14` }}>
      {score}%
    </span>
  );
}

export function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const colour = {
    muted: 'var(--color-muted)', good: 'var(--color-good)',
    warn: 'var(--color-warn)', bad: 'var(--color-bad)', accent: 'var(--color-accent)',
  }[tone];
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wide"
          style={{ color: colour, border: `1px solid ${colour}33` }}>
      {children}
    </span>
  );
}

/**
 * Sponsorship is three-valued and rendered as three visibly different things.
 * "Not specified" must never look like "no" -- it is the most common answer and
 * it means "ask", not "rejected".
 */
export function SponsorshipPill({ value }: { value: string }) {
  if (value === 'yes') return <Pill tone="good">visa sponsored</Pill>;
  if (value === 'no') return <Pill tone="bad">no sponsorship</Pill>;
  return <Pill tone="muted">sponsorship not stated</Pill>;
}

export function RecommendationPill({ value }: { value: string | null | undefined }) {
  if (value === 'highly_recommended') return <Pill tone="good">highly recommended</Pill>;
  if (value === 'possible') return <Pill tone="warn">possible</Pill>;
  if (value === 'low') return <Pill tone="muted">low</Pill>;
  return null;
}

export function Card({ title, children, actions }: { title?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, href }: { label: string; value: number | string; href?: string }) {
  const body = (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3 transition-colors hover:border-[var(--color-accent)]">
      <div className="tnum text-2xl font-semibold">{value}</div>
      <div className="mt-0.5 text-xs text-[var(--color-muted)]">{label}</div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function Bar({ label, score }: { label: string; score: number }) {
  const colour = score >= 80 ? 'var(--color-good)' : score >= 55 ? 'var(--color-warn)' : 'var(--color-bad)';
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-xs text-[var(--color-muted)]">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded bg-[var(--color-line)]">
        <span className="block h-full rounded" style={{ width: `${score}%`, background: colour }} />
      </span>
      <span className="tnum w-10 shrink-0 text-right text-xs">{score}</span>
    </div>
  );
}
