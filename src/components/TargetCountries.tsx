'use client';

import { useRouter } from 'next/navigation';
import { readJson } from '@/lib/http-json';
import { useState } from 'react';

/**
 * Which countries the location component of the score treats as targets.
 *
 * Collection is global, but scoring cannot be: if every country counted as a
 * target country, the location component would be the same number for every job
 * and would stop carrying information. So the target list is a per-user
 * preference, and this is where it is set.
 *
 * Saving deliberately does NOT silently re-score. Changing an input to a score
 * makes existing numbers stale, and the honest thing is to say so and let the
 * user press the button, rather than kicking off minutes of work they did not
 * ask for.
 */
export function TargetCountries({
  options,
  selected,
  isDefault,
}: {
  options: { code: string; name: string }[];
  selected: string[];
  isDefault: boolean;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(selected);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(code: string) {
    setChosen((current) => (current.includes(code) ? current.filter((c) => c !== code) : [...current, code]));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ countries: chosen }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error ?? 'Could not save.');
      setMessage(body.note ?? 'Saved.');
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--color-muted)]">
        {isDefault
          ? 'Using the default list. Jobs in these countries score higher on location; everything else is still collected and still listed.'
          : 'Your own list. Jobs in these countries score higher on location; everything else is still collected and still listed.'}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((option) => (
          <label key={option.code} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={chosen.includes(option.code)} onChange={() => toggle(option.code)} />
            <span className={chosen.includes(option.code) ? '' : 'text-[var(--color-muted)]'}>{option.name}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] disabled:opacity-40"
        >
          {busy ? 'saving...' : 'Save target countries'}
        </button>
        <span className="text-xs text-[var(--color-muted)]">
          {chosen.length} selected — re-score from My Profile afterwards
        </span>
      </div>
      {message && <p className="text-sm text-[var(--color-accent)]">{message}</p>}
    </div>
  );
}
