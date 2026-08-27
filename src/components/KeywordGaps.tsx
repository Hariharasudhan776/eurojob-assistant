'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readJson } from '@/lib/http-json';
import type { MirrorEntry } from '@/lib/resume/mirror';

/**
 * The panel that turns a missing keyword into a real profile skill.
 *
 * This is the answer to "the advert wants RMAN and my resume does not say RMAN".
 * The wrong fix is to let the generator write it in; the right fix is to notice
 * that the profile records the same work at a coarser grain -- "Backup &
 * recovery" -- and ask the only person who can settle it.
 *
 * Three groups, deliberately styled differently, because they mean different
 * things:
 *
 *   mirrored  already handled. The employer's word is now printed for a skill
 *             held under another name, with no input needed. Shown so the value
 *             is visible rather than invisible.
 *   confirm   a question. The profile holds something adjacent, so this may well
 *             be true and simply unrecorded. Answering once fixes every future
 *             application, not just this one.
 *   gaps      nothing behind it. No box to fill, because there is nothing
 *             honest to write. These are a study list.
 *
 * The evidence box is a plain textarea and its contents are stored verbatim.
 * Nothing on this screen generates text on the candidate's behalf: the whole
 * point is that the sentence backing a skill is theirs, so they can defend it.
 */

export function KeywordGaps({
  mirrored,
  confirm,
  gaps,
}: {
  mirrored: MirrorEntry[];
  confirm: MirrorEntry[];
  gaps: MirrorEntry[];
}) {
  if (!mirrored.length && !confirm.length && !gaps.length) return null;

  return (
    <section className="glass rounded-2xl p-5">
      <h2 className="font-display text-sm font-bold">This posting&apos;s vocabulary</h2>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
        An applicant tracking system searches for the employer&apos;s exact words, and a recruiter
        skimming spends about six seconds looking for them. These are the terms this advert screens
        for, and where you stand on each.
      </p>

      {mirrored.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-[var(--color-good)]">
            Already yours — your resume will now use their word
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {mirrored.map((entry) => (
              <span
                key={entry.requirement}
                title={`You hold this as "${entry.heldSkill}" — ${entry.heldEvidence ?? ''}`}
                className="rounded-full border border-[var(--color-good)]/40 bg-[var(--color-good)]/10 px-2.5 py-1 text-xs font-medium"
              >
                {entry.term ?? entry.display}
              </span>
            ))}
          </div>
        </div>
      )}

      {confirm.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-semibold text-[var(--color-warn)]">
            Worth {confirm.length} keyword{confirm.length === 1 ? '' : 's'} — but only you can confirm {confirm.length === 1 ? 'it' : 'them'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Your profile records something adjacent to each of these. If you have actually done the
            specific thing, say where and it joins your profile permanently. If you have not, leave
            it — it stays off the document.
          </p>
          <div className="mt-3 space-y-3">
            {confirm.map((entry) => (
              <ConfirmRow key={entry.requirement} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {gaps.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-semibold text-[var(--color-bad)]">
            Not in your profile — these will not appear on the resume
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Nothing here has anything behind it, so there is no honest way to put it on the page.
            Treat it as what to learn next, and be straight about it in the cover letter.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {gaps.map((entry) => (
              <span
                key={entry.requirement}
                className="rounded-full border border-white/12 px-2.5 py-1 text-xs text-[var(--color-muted)]"
              >
                {entry.surface[0] ?? entry.display}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const LEVELS = ['familiar', 'working', 'strong', 'expert'] as const;

function ConfirmRow({ entry }: { entry: MirrorEntry }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('working');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const term = entry.surface[0] ?? entry.display;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/skills/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requirement: entry.requirement,
        name: entry.display,
        evidence,
        level,
      }),
    });
    const body = (await readJson(res)) as { error?: string; skill?: string };
    setBusy(false);

    if (!res.ok) {
      setError(body.error ?? 'Could not save that.');
      return;
    }
    setDone(true);
    // The score and the mirror plan are both derived from the profile, so the
    // page has to be refetched for this to show up as handled.
    router.refresh();
  }

  if (done) {
    return (
      <div className="rounded-xl border border-[var(--color-good)]/40 bg-[var(--color-good)]/10 p-3 text-xs">
        <strong>{entry.display}</strong> is now part of your profile. It will appear on every resume
        you generate from here, in the employer&apos;s wording.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{term}</p>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            Nearest thing you have recorded: <strong>{entry.heldSkill}</strong>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-white/12 px-3 py-1.5 text-xs font-semibold hover:bg-white/5"
        >
          {open ? 'Cancel' : `I have used ${term}`}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-[var(--color-muted)]">
            Where did you use it? Employer, system, roughly when. This is what an interviewer will
            ask you about, so write what you can defend.
          </label>
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            rows={3}
            placeholder={`e.g. Northwind: ran ${term} for the nightly backups of the production Oracle database, 2024-2026.`}
            className="w-full rounded-lg border border-white/12 bg-black/20 p-2 text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--color-muted)]">How well?</span>
            {LEVELS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setLevel(value)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  level === value ? 'bg-white/15' : 'border border-white/12 hover:bg-white/5'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}
          <button
            type="button"
            disabled={busy || evidence.trim().length < 25}
            onClick={submit}
            className="rounded-lg px-3 py-1.5 text-xs font-bold text-white shadow disabled:opacity-40"
            style={{ backgroundImage: 'var(--grad-green)' }}
          >
            {busy ? 'Saving…' : 'Add to my profile'}
          </button>
        </div>
      )}
    </div>
  );
}
