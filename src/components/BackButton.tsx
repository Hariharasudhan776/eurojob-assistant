'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Back to the list you came from, with your filters still on it.
 *
 * A plain link to `/jobs` would have been the obvious thing and the wrong one.
 * The jobs list keeps its state in the URL -- score, country, role, working
 * mode, verdict, sponsorship -- so a hardcoded href drops the reader back at an
 * unfiltered list at the top of the page, having lost the search they built to
 * find this posting in the first place. `router.back()` returns the actual
 * previous entry, which restores the query string and the scroll position with
 * it.
 *
 * The fallback is for arriving without any history to go back to: a bookmarked
 * job, a link opened in a new tab, a page reloaded after the tab was restored.
 * `history.state.idx` is the App Router's own position counter, so index zero
 * means this page is the first entry in this tab and there is nothing behind it.
 * It is read in an effect rather than during render because `window` does not
 * exist on the server and reading it during render would mismatch hydration.
 *
 * The button looks and sits identically either way; only where it goes differs.
 */
export function BackButton({
  fallback = '/jobs',
  label = 'Back to jobs',
}: {
  fallback?: string;
  label?: string;
}) {
  const router = useRouter();
  const [hasHistory, setHasHistory] = useState(false);

  useEffect(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    setHasHistory(idx > 0);
  }, []);

  return (
    <button
      type="button"
      onClick={() => (hasHistory ? router.back() : router.push(fallback))}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/12 px-3 py-1.5 text-xs font-semibold text-[var(--color-muted)] transition hover:bg-white/5 hover:text-[var(--color-fg)]"
      aria-label={label}
    >
      <span aria-hidden="true">←</span>
      {label}
    </button>
  );
}
