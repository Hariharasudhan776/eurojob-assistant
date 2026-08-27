'use client';

import Link from 'next/link';
import { readJson } from '@/lib/http-json';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Sign-in and sign-up.
 *
 * Both report the server's own message rather than a generic failure: "that
 * account has no password yet" and "your profile is missing evidence on skill 3"
 * are actionable, and "something went wrong" is not.
 */

const inputClass =
  'w-full rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2.5 py-2 text-sm text-[var(--color-fg)]';

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error ?? 'Sign-in failed.');
      router.push(next && next.startsWith('/') ? next : '/');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">Email</span>
        {/* type="text", not "email": an account created by the CLI can be called
            something the browser does not consider a valid address, and the
            browser must not block signing in to an account that exists. */}
        <input name="email" type="text" inputMode="email" required autoComplete="email" className={`mt-1 ${inputClass}`} />
      </label>
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">Password</span>
        <input name="password" type="password" required autoComplete="current-password" className={`mt-1 ${inputClass}`} />
      </label>
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-ink)] disabled:opacity-40"
      >
        {busy ? 'signing in...' : 'Sign in'}
      </button>
      <p className="text-xs text-[var(--color-muted)]">
        No account? <Link href="/signup" className="text-[var(--color-accent)]">Create one</Link> — you will need your
        profile JSON.
      </p>
    </form>
  );
}

export function SignupForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    setBusy(true);
    setError(null);
    setDetails([]);
    try {
      const res = await fetch('/api/auth/signup', { method: 'POST', body: form });
      const body = await readJson(res);
      if (!res.ok) {
        setDetails(Array.isArray(body.details) ? body.details : []);
        throw new Error(body.error ?? 'Sign-up failed.');
      }
      // Not signed in: the account is pending review. Show the acknowledgement.
      setSubmitted(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-up failed.');
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return (
      <div className="glass animate-rise rounded-2xl p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full text-3xl" style={{ backgroundImage: 'var(--grad-brand)' }}>
          ✓
        </div>
        <h2 className="font-display mt-4 text-xl font-extrabold">Request received</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Thanks — your request to join has been sent. <strong className="text-[var(--color-fg)]">Hari</strong> will
          review it and you&apos;ll be informed once your account is approved.
        </p>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          We&apos;ll use <strong className="text-[var(--color-fg)]">{submitted}</strong> to reach you.
        </p>
        <Link href="/login" className="mt-5 inline-block text-sm font-semibold text-[var(--color-accent)]">
          ← back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">Name (optional)</span>
        <input name="displayName" type="text" autoComplete="name" className={`mt-1 ${inputClass}`} />
      </label>
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">Email</span>
        <input name="email" type="email" required autoComplete="email" className={`mt-1 ${inputClass}`} />
      </label>
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">Password — at least 10 characters</span>
        <input name="password" type="password" required minLength={10} autoComplete="new-password" className={`mt-1 ${inputClass}`} />
      </label>
      <label className="block">
        <span className="text-xs text-[var(--color-muted)]">Your profile, as JSON</span>
        <input name="profile" type="file" accept="application/json,.json" required className={`mt-1 ${inputClass}`} />
      </label>

      <p className="text-xs text-[var(--color-muted)]">
        Start from the{' '}
        <a href="/api/profile/template" className="text-[var(--color-accent)]">
          template
        </a>
        . Every skill needs an <code className="text-[var(--color-fg)]">evidence</code> line saying where it came from —
        that is what stops a generated resume claiming something you cannot back up, so the upload is rejected without it.
      </p>

      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      {details.length > 0 && (
        <ul className="space-y-1 rounded border border-[var(--color-line)] p-2">
          {details.map((detail, i) => (
            <li key={i} className="text-xs text-[var(--color-warn)]">
              {detail}
            </li>
          ))}
        </ul>
      )}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-ink)] disabled:opacity-40"
      >
        {busy ? 'sending your request...' : 'Request an account'}
      </button>
      <p className="text-xs text-[var(--color-muted)]">
        Already have one? <Link href="/login" className="text-[var(--color-accent)]">Sign in</Link>
      </p>
    </form>
  );
}

/** In the header, so signing out is never a hunt through a menu. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      onClick={async () => {
        setBusy(true);
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/login');
        router.refresh();
      }}
      disabled={busy}
      className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-40"
    >
      {busy ? '...' : 'Sign out'}
    </button>
  );
}
