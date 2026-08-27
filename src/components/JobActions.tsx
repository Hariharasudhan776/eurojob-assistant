'use client';

import { useRouter } from 'next/navigation';
import { readJson } from '@/lib/http-json';
import { useEffect, useState, useTransition } from 'react';

const STAGES = [
  { value: 'shortlisted', label: 'Shortlist' },
  { value: 'applied', label: 'Mark applied' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
] as const;

const GEN_LABELS: Record<string, { title: string; steps: string[] }> = {
  explain: {
    title: 'Analysing the match…',
    steps: ['Reading the posting', 'Comparing it to your profile', 'Writing the verdict'],
  },
  cover_letter: {
    title: 'Writing your cover letter…',
    steps: ['Studying the role', 'Pulling your relevant evidence', 'Drafting the letter', 'Checking every claim'],
  },
  resume: {
    title: 'Tailoring your resume…',
    steps: ['Matching your skills to the job', 'Re-ordering your experience', 'Rewriting the summary', 'Verifying nothing is invented'],
  },
};

/** Full-screen overlay shown while a generation runs, so a slow call is never a dead button. */
function LoadingOverlay({ kind }: { kind: string }) {
  const info = GEN_LABELS[kind] ?? { title: 'Working…', steps: ['Working'] };
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % info.steps.length), 1400);
    return () => clearInterval(t);
  }, [info.steps.length]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass animate-rise mx-4 w-full max-w-sm rounded-2xl p-8 text-center">
        <div className="mx-auto h-14 w-14 animate-spin rounded-full border-4 border-white/10" style={{ borderTopColor: '#a06bff', borderRightColor: '#ec4899' }} />
        <h3 className="font-display mt-5 text-lg font-extrabold">{info.title}</h3>
        <p className="mt-2 h-5 text-sm text-[var(--color-muted)] transition-all">{info.steps[step]}…</p>
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/8">
          <div className="h-full w-1/2 animate-[rise_1.2s_ease-in-out_infinite] rounded-full" style={{ backgroundImage: 'var(--grad-brand)' }} />
        </div>
        <p className="mt-4 text-[11px] text-[var(--color-muted)]">This usually takes 10–20 seconds. Please keep this tab open.</p>
      </div>
    </div>
  );
}

/**
 * Everything the user can do to a job. Generation buttons state their cost
 * before being pressed, because a button that quietly bills you is a bad button.
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

  const generating = busy === 'explain' || busy === 'cover_letter' || busy === 'resume';

  async function setStage(stage: string) {
    setBusy(stage);
    setMessage(null);
    try {
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, stage, note: noteText || undefined }),
      });
      const body = await readJson(res);
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
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error ?? 'failed');
      const cost = body.provider === 'gemini'
        ? 'free (Gemini)'
        : body.fromCache
          ? '$0 (served from cache)'
          : `$${(body.costUsd ?? 0).toFixed(4)}`;
      setMessage(`Done — ${cost}.${body.violations?.length ? ` ${body.violations.length} verification note(s).` : ' Verified clean.'}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || pending;
  const stageBtn = 'rounded-full border px-3 py-1.5 text-sm font-semibold transition-all disabled:opacity-40';
  const genBtn = 'rounded-full px-3.5 py-2 text-sm font-bold text-white shadow-lg transition-transform hover:scale-[1.03] disabled:opacity-40 disabled:hover:scale-100';
  const dlBtn = 'rounded-full border border-white/12 px-3.5 py-2 text-sm font-semibold text-[var(--color-fg)] transition-colors hover:border-[var(--color-accent)]';

  return (
    <section className="glass rounded-2xl p-5">
      {generating && <LoadingOverlay kind={busy!} />}

      <h2 className="font-display text-sm font-bold">
        Actions {currentStage ? <span className="text-[var(--color-muted)]">— currently {currentStage}</span> : ''}
      </h2>

      {/* Pipeline */}
      <div className="mt-3 flex flex-wrap gap-2">
        {STAGES.map((stage) => (
          <button
            key={stage.value}
            onClick={() => setStage(stage.value)}
            disabled={disabled}
            className={stageBtn}
            style={
              currentStage === stage.value
                ? { backgroundImage: 'var(--grad-brand)', color: '#fff', borderColor: 'transparent' }
                : { borderColor: 'rgba(255,255,255,0.12)' }
            }
          >
            {busy === stage.value ? '…' : stage.label}
          </button>
        ))}
      </div>

      {/* Generate + download */}
      <div className="mt-5 flex flex-wrap gap-2">
        <button onClick={() => generate('explain')} disabled={disabled} className={genBtn} style={{ backgroundImage: 'var(--grad-blue)' }}>
          {busy === 'explain' ? 'thinking…' : '✨ Explain match'}
        </button>
        <button onClick={() => generate('cover_letter', 'technical')} disabled={disabled} className={genBtn} style={{ backgroundImage: 'var(--grad-violet)' }}>
          {busy === 'cover_letter' ? 'writing…' : '✉️ Cover letter'}
        </button>
        <button onClick={() => generate('resume')} disabled={disabled} className={genBtn} style={{ backgroundImage: 'var(--grad-pink)' }}>
          {busy === 'resume' ? 'tailoring…' : '📄 Tailored resume'}
        </button>
        <a href={`/api/export?jobId=${jobId}&kind=resume`} className={dlBtn}>⬇ Resume .docx</a>
        <a href={`/api/export?jobId=${jobId}&kind=cover_letter`} className={dlBtn}>⬇ Letter .docx</a>
      </div>
      <p className="mt-2 text-[11px] text-[var(--color-muted)]">
        Generate first, then download. Costs shown after each run; the same job is never charged twice.
      </p>

      {/* Notes */}
      <label className="mt-4 block">
        <span className="text-xs font-semibold text-[var(--color-muted)]">Notes</span>
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={2}
          placeholder="recruiter name, sponsorship answer, deadline…"
          className="mt-1 w-full rounded-xl border border-white/10 bg-[#1b1430] px-3 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      {message && <p className="mt-3 text-sm font-semibold text-[var(--color-accent)]">{message}</p>}
    </section>
  );
}
