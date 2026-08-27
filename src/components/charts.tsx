'use client';

import { useEffect, useState } from 'react';

const PALETTE = ['#a06bff', '#ec4899', '#22d3ee', '#f97316', '#34d399', '#fbbf24', '#2563eb', '#f472b6', '#818cf8', '#facc15'];

function useMounted() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(t);
  }, []);
  return on;
}

/** Donut chart with a centred total. */
export function Donut({ data, unit = '' }: { data: { label: string; value: number }[]; unit?: string }) {
  const mounted = useMounted();
  const items = data.filter((d) => d.value > 0).slice(0, 8);
  const total = items.reduce((s, d) => s + d.value, 0) || 1;
  const size = 180, stroke = 26, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          {items.map((d, i) => {
            const frac = d.value / total;
            const dash = mounted ? frac * c : 0;
            const seg = (
              <circle
                key={d.label} cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={PALETTE[i % PALETTE.length]} strokeWidth={stroke}
                strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
                style={{ transition: 'stroke-dasharray .7s ease, stroke-dashoffset .7s ease' }}
              />
            );
            offset += mounted ? frac * c : 0;
            return seg;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum font-display text-2xl font-extrabold">{total}</span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{unit || 'total'}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-1.5 text-sm">
        {items.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">{d.label}</span>
            <span className="tnum text-[var(--color-muted)]">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal gradient bar list. */
export function BarList({ data, gradient = 'var(--grad-violet)' }: { data: { label: string; value: number }[]; gradient?: string }) {
  const mounted = useMounted();
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2.5">
      {data.slice(0, 8).map((d) => (
        <li key={d.label} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-[var(--color-muted)]" title={d.label}>{d.label}</span>
          <span className="relative h-6 flex-1 overflow-hidden rounded-lg bg-white/5">
            <span
              className="absolute inset-y-0 left-0 rounded-lg"
              style={{ width: mounted ? `${(d.value / max) * 100}%` : '0%', backgroundImage: gradient, transition: 'width .7s cubic-bezier(.2,.7,.2,1)' }}
            />
          </span>
          <span className="tnum w-10 shrink-0 text-right text-xs font-semibold">{d.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Application funnel — applied → interview → offer. */
export function Funnel({ stages }: { stages: { label: string; value: number }[] }) {
  const mounted = useMounted();
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-3">
      {stages.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="w-24 shrink-0 text-xs capitalize text-[var(--color-muted)]">{s.label}</span>
          <div className="flex-1">
            <div
              className="flex h-9 items-center rounded-xl px-3 text-sm font-bold text-white"
              style={{
                width: mounted ? `${Math.max(12, (s.value / max) * 100)}%` : '0%',
                backgroundImage: PALETTE_GRAD[i % PALETTE_GRAD.length],
                transition: 'width .6s ease',
              }}
            >
              {s.value}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const PALETTE_GRAD = ['var(--grad-blue)', 'var(--grad-violet)', 'var(--grad-pink)', 'var(--grad-green)', 'linear-gradient(135deg,#f43f5e,#f97316)'];

/** Vertical bar histogram for the score distribution. */
export function Histogram({ buckets }: { buckets: { label: string; value: number; color?: string }[] }) {
  const mounted = useMounted();
  const max = Math.max(1, ...buckets.map((b) => b.value));
  return (
    <div className="flex h-40 items-end gap-3">
      {buckets.map((b, i) => (
        <div key={b.label} className="flex flex-1 flex-col items-center gap-2">
          <span className="tnum text-xs font-semibold text-[var(--color-fg)]">{b.value}</span>
          <div className="flex w-full flex-1 items-end">
            <div
              className="w-full rounded-t-lg"
              style={{
                height: mounted ? `${(b.value / max) * 100}%` : '0%',
                backgroundImage: b.color ?? PALETTE_GRAD[i % PALETTE_GRAD.length],
                transition: 'height .7s cubic-bezier(.2,.7,.2,1)',
                minHeight: b.value > 0 ? 6 : 0,
              }}
            />
          </div>
          <span className="text-[10px] text-[var(--color-muted)]">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
