import Link from 'next/link';

/**
 * What an account with no profile yet should be shown.
 *
 * Without this, such an account gets the full feed with an em dash where every
 * score belongs and nothing ranked — which reads as a broken application rather
 * than an unfinished setup, and that is exactly how it was reported. Scores are
 * per profile, so an account without one has nothing to score against; the page
 * was answering a question the user had not yet made answerable, and saying so
 * is the whole fix.
 *
 * It distinguishes the two ways of arriving here, because the next action is
 * different and the difference is the entire point of the CV flow:
 *
 *   with a stored CV     the work is nearly done. One click drafts the profile
 *                        from the CV already uploaded at signup.
 *   without one          they still need to supply a CV.
 *
 * Deliberately not a redirect. Someone may legitimately want to browse the feed
 * before committing to anything, and silently bouncing them off the page they
 * asked for is worse than telling them why it is empty.
 */
export function NoProfileNotice({ hasCv }: { hasCv: boolean }) {
  return (
    <section className="glass rounded-2xl p-5 ring-1 ring-[var(--color-warn)]/40">
      <h2 className="font-display text-sm font-bold">
        No profile yet — that is why nothing has a score
      </h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Every score is this feed measured against <em>your</em> experience, so there is nothing to
        rank until the app knows what that is. The jobs below are real; they are just unscored.
      </p>

      {hasCv ? (
        <>
          <p className="mt-3 text-sm">
            <strong>Your CV is already uploaded.</strong> Turning it into a profile takes about a
            minute, and you check every field before anything is saved.
          </p>
          <Link
            href="/profile"
            className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-bold text-white shadow"
            style={{ backgroundImage: 'var(--grad-brand)' }}
          >
            Build my profile from my CV
          </Link>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm">Upload your CV as a PDF or Word document to get started.</p>
          <Link
            href="/profile"
            className="mt-3 inline-block rounded-lg px-4 py-2 text-sm font-bold text-white shadow"
            style={{ backgroundImage: 'var(--grad-brand)' }}
          >
            Add my CV
          </Link>
        </>
      )}
    </section>
  );
}
