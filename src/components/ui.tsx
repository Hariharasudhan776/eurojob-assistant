import Link from 'next/link';

const GRADS: Record<string, string> = {
  violet: 'var(--grad-violet)',
  blue: 'var(--grad-blue)',
  pink: 'var(--grad-pink)',
  green: 'var(--grad-green)',
  brand: 'var(--grad-brand)',
};

export function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) {
    return <span className="text-xs text-[var(--color-muted)]">unscored</span>;
  }
  const grad = score >= 80 ? GRADS.green : score >= 60 ? GRADS.blue : GRADS.violet;
  return (
    <span
      className="tnum inline-flex min-w-12 items-center justify-center rounded-full px-2.5 py-1 text-sm font-bold text-white shadow-lg"
      style={{ backgroundImage: score >= 45 ? grad : undefined, background: score < 45 ? 'rgba(255,255,255,0.08)' : undefined }}
    >
      {score}%
    </span>
  );
}

/** Circular score ring — the hero number on job cards. */
export function ScoreRing({ score, size = 56 }: { score: number | null | undefined; size?: number }) {
  const value = score ?? 0;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const hue = value >= 80 ? '#34d399' : value >= 60 ? '#22d3ee' : value >= 45 ? '#a06bff' : '#6b6484';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={hue} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (value / 100) * c}
          style={{ transition: 'stroke-dashoffset .6s ease' }}
        />
      </svg>
      <span className="tnum absolute inset-0 flex items-center justify-center text-sm font-bold">
        {score === null || score === undefined ? '—' : `${value}`}
      </span>
    </div>
  );
}

export function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const colour = {
    muted: 'var(--color-muted)', good: 'var(--color-good)',
    warn: 'var(--color-warn)', bad: 'var(--color-bad)', accent: 'var(--color-accent)',
  }[tone];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ color: colour, background: `color-mix(in srgb, ${colour} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${colour} 35%, transparent)` }}
    >
      {children}
    </span>
  );
}

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
    <section className="glass rounded-2xl p-5">
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="font-display text-sm font-bold tracking-tight text-[var(--color-fg)]">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Bold gradient KPI tile. `gradient` and `icon` are optional so the older
 * plain-number call sites keep working unchanged.
 */
export function Stat({
  label, value, href, gradient, icon, sub,
}: {
  label: string; value: number | string; href?: string;
  gradient?: 'violet' | 'blue' | 'pink' | 'green' | 'brand'; icon?: string; sub?: string;
}) {
  const body = (
    <div
      className="glass glass-hover relative overflow-hidden rounded-2xl p-4"
      style={gradient ? { backgroundImage: GRADS[gradient], border: '1px solid rgba(255,255,255,0.14)' } : undefined}
    >
      {gradient && <div className="pointer-events-none absolute -right-6 -top-8 text-6xl opacity-25">{icon}</div>}
      <div className="flex items-center gap-2">
        {!gradient && icon && <span className="text-lg">{icon}</span>}
        <div className={`text-xs font-semibold uppercase tracking-wide ${gradient ? 'text-white/80' : 'text-[var(--color-muted)]'}`}>{label}</div>
      </div>
      <div className={`tnum font-display mt-1 text-3xl font-extrabold ${gradient ? 'text-white' : 'text-[var(--color-fg)]'}`}>{value}</div>
      {sub && <div className={`mt-0.5 text-[11px] ${gradient ? 'text-white/70' : 'text-[var(--color-muted)]'}`}>{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className="animate-rise block">{body}</Link> : <div className="animate-rise">{body}</div>;
}

export function Bar({ label, score }: { label: string; score: number }) {
  const grad = score >= 80 ? 'var(--grad-green)' : score >= 55 ? 'var(--grad-blue)' : 'var(--grad-pink)';
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-xs text-[var(--color-muted)]">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/8">
        <span className="block h-full rounded-full" style={{ width: `${score}%`, backgroundImage: grad }} />
      </span>
      <span className="tnum w-10 shrink-0 text-right text-xs font-semibold">{score}</span>
    </div>
  );
}

/** Gradient primary button / link. */
export function GradientButton({ children, href, type = 'submit' }: { children: React.ReactNode; href?: string; type?: 'submit' | 'button' }) {
  const cls = 'inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-bold text-white shadow-lg transition-transform hover:scale-[1.03]';
  const style = { backgroundImage: 'var(--grad-brand)' };
  return href ? <Link href={href} className={cls} style={style}>{children}</Link> : <button type={type} className={cls} style={style}>{children}</button>;
}
