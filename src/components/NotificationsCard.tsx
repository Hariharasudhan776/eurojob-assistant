'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { NotificationRow } from '@/lib/db/repo';

/**
 * What the agent found while you were away. Fed by `npm run agent` (scheduled),
 * which writes one notification per newly-top-matched job. Clicking through
 * lands on the job page, where generating a resume is the user's own one-click,
 * one-account, capped decision -- the agent surfaces, the human spends.
 */
export function NotificationsCard({ notifications }: { notifications: NotificationRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!notifications.length) return null;

  async function markRead() {
    setBusy(true);
    await fetch('/api/notifications/read', { method: 'POST' });
    setBusy(false);
    router.refresh();
  }

  return (
    <section className="glass animate-rise rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-sm font-bold">
          🔔 While you were away — {notifications.length} new top match{notifications.length === 1 ? '' : 'es'}
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={markRead}
          className="rounded-lg border border-white/12 px-3 py-1.5 text-xs font-semibold hover:bg-white/5 disabled:opacity-40"
        >
          {busy ? '…' : 'Mark all read'}
        </button>
      </div>
      <ul className="mt-3 space-y-2">
        {notifications.map((n) => (
          <li key={n.id}>
            {n.job_id ? (
              <Link href={`/jobs/${n.job_id}`} className="block rounded-xl border border-white/10 p-3 hover:bg-white/5">
                <p className="text-sm font-semibold">{n.title}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">{n.body}</p>
              </Link>
            ) : (
              <div className="rounded-xl border border-white/10 p-3">
                <p className="text-sm font-semibold">{n.title}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">{n.body}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
