'use client';

import { useRouter } from 'next/navigation';
import { readJson } from '@/lib/http-json';
import { useState } from 'react';

export interface AdminUser {
  id: number;
  email: string;
  display_name: string | null;
  status: string;
  is_admin: boolean;
  created_at: string;
  last_login_at: string | null;
  has_password: boolean;
}

const field =
  'rounded-xl border border-white/10 bg-[#1b1430] px-3 py-2 text-sm text-[var(--color-fg)] outline-none';

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active' ? 'var(--color-good)' : status === 'pending' ? 'var(--color-warn)' : 'var(--color-bad)';
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }}
    >
      {status}
    </span>
  );
}

export function AdminPanel({
  users,
  provider,
  adminId,
}: {
  users: AdminUser[];
  provider: string;
  adminId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [current, setCurrent] = useState(provider);
  const [resetShown, setResetShown] = useState<Record<number, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  async function act(action: string, userId?: number, extra?: Record<string, unknown>) {
    const tag = `${action}:${userId ?? 'self'}`;
    setBusy(tag);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, userId, ...extra }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error ?? 'failed');
      if (action === 'set_provider') setCurrent(body.provider);
      if (action === 'reset_password' && userId) {
        setResetShown((prev) => ({ ...prev, [userId]: body.password }));
      } else {
        router.refresh();
      }
      if (action !== 'reset_password') setMessage('Done.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  const pending = users.filter((u) => u.status === 'pending');

  return (
    <div className="space-y-6">
      {/* Provider toggle */}
      <div className="glass rounded-2xl p-5">
        <h2 className="font-display text-sm font-bold">AI provider</h2>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Which model your generations (explanations, cover letters, tailored resumes) use. Applies to your account.
        </p>
        <div className="mt-3 flex gap-2">
          {(['claude', 'gemini'] as const).map((p) => (
            <button
              key={p}
              onClick={() => act('set_provider', undefined, { provider: p })}
              disabled={busy !== null}
              className={`rounded-full px-4 py-2 text-sm font-bold capitalize transition-all disabled:opacity-40 ${
                current === p ? 'text-white shadow-lg' : 'border border-white/10 text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
              style={current === p ? { backgroundImage: p === 'gemini' ? 'var(--grad-blue)' : 'var(--grad-brand)' } : undefined}
            >
              {p === 'claude' ? '◆ Claude' : '✦ Gemini'}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[var(--color-muted)]">
          Currently using <strong className="text-[var(--color-fg)]">{current}</strong>. The matching API key must be set
          in the environment (<code>ANTHROPIC_API_KEY</code> / <code>GEMINI_API_KEY</code>).
        </p>
      </div>

      {/* Pending requests */}
      <div className="glass rounded-2xl p-5">
        <h2 className="font-display text-sm font-bold">
          Account requests{pending.length ? ` — ${pending.length} waiting` : ''}
        </h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted)]">No pending requests right now.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {pending.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{u.display_name || u.email}</p>
                  <p className="truncate text-xs text-[var(--color-muted)]">{u.email} · requested {fmt(u.created_at)}</p>
                </div>
                <button
                  onClick={() => act('approve', u.id)}
                  disabled={busy !== null}
                  className="rounded-full px-3 py-1.5 text-sm font-bold text-white disabled:opacity-40"
                  style={{ backgroundImage: 'var(--grad-green)' }}
                >
                  {busy === `approve:${u.id}` ? '…' : 'Approve'}
                </button>
                <button
                  onClick={() => act('reject', u.id)}
                  disabled={busy !== null}
                  className="rounded-full border border-[var(--color-bad)]/50 px-3 py-1.5 text-sm font-semibold text-[var(--color-bad)] disabled:opacity-40"
                >
                  {busy === `reject:${u.id}` ? '…' : 'Reject'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* All users */}
      <div className="glass rounded-2xl p-5">
        <h2 className="font-display text-sm font-bold">All accounts — {users.length}</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
                <th className="pb-2 pr-3">User</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Last login</th>
                <th className="pb-2 pr-3">Password</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-white/8 align-top">
                  <td className="py-2 pr-3">
                    <span className="font-semibold">{u.display_name || u.email}</span>
                    {u.is_admin && <span className="ml-1.5 text-[10px] font-bold text-[var(--color-accent)]">ADMIN</span>}
                    <span className="block text-xs text-[var(--color-muted)]">{u.email}</span>
                  </td>
                  <td className="py-2 pr-3"><StatusBadge status={u.status} /></td>
                  <td className="py-2 pr-3 text-xs text-[var(--color-muted)]">{u.last_login_at ? fmt(u.last_login_at) : 'never'}</td>
                  <td className="py-2 pr-3 text-xs">
                    {resetShown[u.id] ? (
                      <code className="rounded bg-[var(--color-good)]/15 px-1.5 py-0.5 text-[var(--color-good)]">{resetShown[u.id]}</code>
                    ) : u.has_password ? (
                      <span className="text-[var(--color-muted)]">set</span>
                    ) : (
                      <span className="text-[var(--color-warn)]">none</span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {u.status === 'pending' && (
                        <button onClick={() => act('approve', u.id)} disabled={busy !== null}
                          className="rounded-full px-2.5 py-1 text-xs font-bold text-white disabled:opacity-40" style={{ backgroundImage: 'var(--grad-green)' }}>
                          Approve
                        </button>
                      )}
                      {!u.is_admin && u.status === 'active' && (
                        <button onClick={() => act('reject', u.id)} disabled={busy !== null}
                          className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40">
                          Suspend
                        </button>
                      )}
                      {u.id !== adminId && (
                        <button onClick={() => act('reset_password', u.id)} disabled={busy !== null}
                          className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-40">
                          {busy === `reset_password:${u.id}` ? '…' : 'Reset password'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {Object.keys(resetShown).length > 0 && (
          <p className="mt-3 text-xs text-[var(--color-warn)]">
            Copy the new password(s) now and send them to the user — they are shown once and cannot be retrieved later.
          </p>
        )}
      </div>

      {message && <p className="text-sm text-[var(--color-accent)]">{message}</p>}
    </div>
  );
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
