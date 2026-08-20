'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

const STAGES = [
  { value: 'shortlisted', label: 'Shortlist' },
  { value: 'applied', label: 'Mark applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
] as const;

/**
 * Everything the user can do to a job.
 *
 * Generation buttons state their cost before being pressed. This app spends real
 * money per click, and a button that quietly bills you is a bad button.
 */
export function JobActions({
  jobId,
  currentStage,
  notes,
}: {
  jobId: number;
  currentStage: string | null;
  notes: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [noteText, setNoteText] = useState(notes ?? '');

  async function setStage(stage: string) {
    setBusy(stage);
    setMessage(null);
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, stage, note: noteText || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'failed');
      setMessage(`Moved to ${stage}.`);
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  async function generate(kind: 'explain' | 'cover_letter' | 'resume', tone?: string) {
    setBusy(kind);
    setMessage(null);
    try {
      const res = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, kind, tone }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'failed');
      setMessage(
        `Done. Cost $${(body.costUsd ?? 0).toFixed(4)}${body.fromCache ? ' (served from cache, nothing spent)' : ''}` +
          (body.violations?.length ? ` — ${body.violations.length} verification note(s).` : ' — verified clean.')
      );
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || pending;

  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] p-4">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
        Actions {currentStage ? `— currently ${currentStage}` : ''}
      </h2>

      <div className="flex flex-wrap gap-2">
        {STAGES.map((stage) => (
          <button
            key={stage.value}
            onClick={() => setStage(stage.value)}
            disabled={disabled}
            className={`rounded border px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
              currentStage === stage.value
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-line)] hover:border-[var(--color-accent)]'
            }`}
          >
            {busy === stage.value ? '...' : stage.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => generate('explain')} disabled={disabled}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-good)] disabled:opacity-40">
          {busy === 'explain' ? 'thinking...' : 'Explain match (~$0.01)'}
        </button>
        <button onClick={() => generate('cover_letter', 'technical')} disabled={disabled}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-good)] disabled:opacity-40">
          {busy === 'cover_letter' ? 'writing...' : 'Cover letter (~$0.05)'}
        </button>
        <button onClick={() => generate('resume')} disabled={disabled}
          className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-good)] disabled:opacity-40">
          {busy === 'resume' ? 'tailoring...' : 'Tailored resume (~$0.16)'}
        </button>
        <a href={`/api/export?jobId=${jobId}&kind=resume`}
           className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]">
          Download resume .docx
        </a>
        <a href={`/api/export?jobId=${jobId}&kind=cover_letter`}
           className="rounded border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]">
          Download letter .docx
        </a>
      </div>

      <label className="mt-4 block">
        <span className="text-xs text-[var(--color-muted)]">Notes</span>
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={2}
          placeholder="recruiter name, sponsorship answer, deadline..."
          className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-ink)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
        />
      </label>

      {message && <p className="mt-3 text-sm text-[var(--color-accent)]">{message}</p>}
    </section>
  );
}
