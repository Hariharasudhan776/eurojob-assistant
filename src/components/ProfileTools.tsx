'use client';

import { useRouter } from 'next/navigation';
import { readJson } from '@/lib/http-json';
import { useState } from 'react';

/**
 * Uploading a new profile version, and catching the feed up with it.
 *
 * Re-scoring runs as a **loop of bounded requests**, not one long one. Scoring
 * thousands of postings takes longer than a serverless function is allowed to
 * live, and a single request would be killed halfway with no way to say so. Each
 * call scores a batch and reports what is left; this keeps calling and shows the
 * number going down, which is also just more honest than a spinner.
 */

const MAX_ROUNDS = 60;

export function ProfileTools({ version, unscored }: { version: number; unscored: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('upload');
    setMessage(null);
    setErrors([]);
    try {
      const res = await fetch('/api/profile', { method: 'POST', body: form });
      const body = await readJson(res);
      if (!res.ok) {
        setErrors(Array.isArray(body.details) ? body.details : []);
        throw new Error(body.error ?? 'Upload failed.');
      }
      const filled: string[] = Array.isArray(body.filledIn) ? body.filledIn : [];
      setMessage(
        `Saved as version ${body.version}. ${body.scored} jobs scored against it` +
          (body.remaining ? `, ${body.remaining} to go.` : '.') +
          (filled.length ? ` Derived for you: ${filled.join('; ')}.` : '')
      );
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(null);
    }
  }

  async function score(mode: 'missing' | 'all') {
    setBusy(mode);
    setMessage(null);
    setErrors([]);
    let total = 0;
    let afterId = 0;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await fetch('/api/rescore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(mode === 'all' ? { mode: 'all', afterId } : {}),
        });
        const body = await readJson(res);
        if (!res.ok) throw new Error(body.error ?? 'Scoring failed.');

        total += body.scored ?? 0;
        setProgress(
          mode === 'all'
            ? `${total} scored so far...`
            : `${total} scored, ${body.remaining ?? 0} left...`
        );

        if (mode === 'all') {
          afterId = body.lastId ?? afterId;
          if (body.done) break;
        } else if ((body.remaining ?? 0) === 0 || (body.scored ?? 0) === 0) {
          break;
        }
      }
      setMessage(`${total} jobs scored. Free — scoring never calls a model.`);
      setProgress(null);
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Scoring failed.');
      setProgress(null);
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <div className="space-y-4">
      <form onSubmit={upload} className="space-y-2">
        <label className="block">
          <span className="text-xs text-[var(--color-muted)]">
            Upload an updated profile — it is saved as version {version + 1}, and version {version} is kept
          </span>
          <input
            name="profile"
            type="file"
            accept="application/json,.json"
            required
            className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2.5 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={disabled}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] disabled:opacity-40"
        >
          {busy === 'upload' ? 'validating...' : 'Save as a new version'}
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => score('missing')}
          disabled={disabled || unscored === 0}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-good)] disabled:opacity-40"
        >
          {busy === 'missing' ? 'scoring...' : `Score ${unscored} unscored job${unscored === 1 ? '' : 's'} (free)`}
        </button>
        <button
          onClick={() => score('all')}
          disabled={disabled}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-good)] disabled:opacity-40"
        >
          {busy === 'all' ? 'scoring...' : 'Re-score everything (free)'}
        </button>
      </div>

      {progress && <p className="text-xs text-[var(--color-accent)]">{progress}</p>}
      {message && <p className="text-sm text-[var(--color-accent)]">{message}</p>}
      {errors.length > 0 && (
        <ul className="space-y-1 rounded border border-[var(--color-line)] p-2">
          {errors.map((detail, i) => (
            <li key={i} className="text-xs text-[var(--color-warn)]">
              {detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
