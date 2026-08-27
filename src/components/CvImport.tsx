'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readJson } from '@/lib/http-json';
import type { ProfileDraft, DraftSkill } from '@/lib/resume/draft';

/**
 * Upload a CV, check what was read out of it, keep it.
 *
 * This replaces the demand that a user hand-write their profile as JSON — 690
 * lines and 318 skill fields in the one real example — which is the single
 * reason nobody but its author could use this application.
 *
 * The review step is not a formality and must not be made skippable. Everything
 * the app later generates is built from these fields, so a misread date becomes
 * a false claim on a resume sent to an employer, and neither side notices until
 * an interview. The old design prevented that by making the human type
 * everything; this one keeps the human as the source of truth while moving the
 * typing to the model, which is the same guarantee at a fraction of the cost.
 *
 * Three details carry that weight:
 *
 *   * Anything the model flagged `uncertain` arrives **unticked**. The default
 *     for a doubtful reading is to leave it out, so a reviewer who skims adds
 *     nothing they did not look at.
 *   * Every skill shows the line of the CV it came from, so the reviewer is
 *     checking a claim against its source rather than recalling their career.
 *   * Work authorisation is asked outright. A CV almost never states it, it
 *     cannot be inferred, and for this application it decides which jobs are
 *     even possible.
 *
 * Saving goes through the existing profile endpoint, so the schema, the
 * mandatory evidence rule, the taxonomy lookup and the totalYears calculation
 * all still apply exactly as they did to a hand-written file.
 */

type Stage = 'upload' | 'review' | 'saved';

export function CvImport({ storedCv }: { storedCv?: string | null } = {}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [source, setSource] = useState<{ kind: string; characters: number; pages: number | null } | null>(null);

  // Which skills to keep. Uncertain ones start unticked, on purpose.
  const [keptSkills, setKeptSkills] = useState<Record<number, boolean>>({});
  const [needsSponsorship, setNeedsSponsorship] = useState(true);
  const [currentCountry, setCurrentCountry] = useState('');

  /**
   * `file` omitted means "use the CV I uploaded when I signed up".
   *
   * That CV was turned into text for free while the visitor was still anonymous;
   * the model call it needs happens here, once, on an approved account with a
   * spend cap behind it.
   */
  async function upload(file?: File) {
    setBusy(true);
    setError(null);

    const body = new FormData();
    if (file) body.append('cv', file);
    const res = await fetch('/api/profile/from-cv', { method: 'POST', body });
    const payload = (await readJson(res)) as { error?: string; draft?: ProfileDraft; source?: typeof source };
    setBusy(false);

    if (!res.ok || !payload.draft) {
      setError(payload.error ?? 'That CV could not be read.');
      return;
    }

    setDraft(payload.draft);
    setSource(payload.source ?? null);
    setKeptSkills(Object.fromEntries(payload.draft.skills.map((s, i) => [i, !s.uncertain])));
    setCurrentCountry(payload.draft.location.split(',').pop()?.trim() ?? '');
    setStage('review');
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);

    const profile = {
      name: draft.name,
      headline: draft.headline,
      email: draft.email,
      phone: draft.phone,
      location: draft.location,
      links: { linkedin: draft.linkedin || null, github: draft.github || null },
      summary: draft.summary,
      experience: draft.experience.map((e) => ({
        company: e.company,
        title: e.title,
        location: e.location,
        startDate: e.startDate,
        endDate: e.current ? null : e.endDate,
        current: e.current,
        context: e.context,
        bullets: e.bullets,
        skills: [],
      })),
      // Only what the reviewer ticked. `canonical` is left out deliberately:
      // the server derives it from the taxonomy, and a guessed match key could
      // make a skill satisfy the wrong job requirement.
      skills: draft.skills
        .filter((_, i) => keptSkills[i])
        .map((s) => ({ name: s.name, category: s.category, years: s.years, level: s.level, evidence: s.evidence })),
      projects: [],
      education: draft.education.map((e) => ({
        qualification: e.qualification,
        institution: e.institution,
        startYear: e.startYear ?? 0,
        endYear: e.endYear ?? 0,
        result: e.result || null,
        eqfLevel: null,
      })),
      certifications: draft.certifications.map((c) => ({ name: c.name, issuer: c.issuer, date: c.date })),
      languages: draft.languages.map((l) => ({ language: l.language, cefr: null, description: l.description })),
      employmentGaps: [],
      workAuthorisation: {
        euCitizen: false,
        euWorkPermit: false,
        needsSponsorship,
        currentCountry,
        notes: needsSponsorship
          ? 'Requires visa sponsorship to work in the EU.'
          : 'Does not require visa sponsorship.',
      },
    };

    const body = new FormData();
    body.append('profile', new File([JSON.stringify(profile, null, 2)], 'profile.json', { type: 'application/json' }));
    const res = await fetch('/api/profile', { method: 'POST', body });
    const payload = (await readJson(res)) as { error?: string; errors?: string[] };
    setBusy(false);

    if (!res.ok) {
      setError(payload.errors?.join(' ') ?? payload.error ?? 'That profile could not be saved.');
      return;
    }
    setStage('saved');
    router.refresh();
  }

  if (stage === 'saved') {
    return (
      <div className="rounded-xl border border-[var(--color-good)]/40 bg-[var(--color-good)]/10 p-4">
        <p className="text-sm font-semibold">Profile saved.</p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Re-score the job feed to rank every posting against it.
        </p>
      </div>
    );
  }

  if (stage === 'review' && draft) {
    const kept = Object.values(keptSkills).filter(Boolean).length;
    const uncertain = draft.skills.filter((s) => s.uncertain).length;

    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3">
          <p className="text-xs font-semibold">Nothing has been saved yet — check this first.</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Everything this app writes for you is built from these fields, so a wrong date here
            becomes a wrong date on a resume an employer reads. Read{' '}
            {source ? `the ${source.characters.toLocaleString()} characters` : 'what was'} taken from
            your {source?.kind === 'pdf' ? 'PDF' : source?.kind === 'docx' ? 'Word file' : 'file'} and
            correct anything that is wrong.
            {uncertain > 0 && (
              <>
                {' '}
                <strong>{uncertain}</strong> item{uncertain === 1 ? ' was' : 's were'} uncertain and{' '}
                {uncertain === 1 ? 'is' : 'are'} unticked below.
              </>
            )}
          </p>
        </div>

        <Section title="You">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
            <Field label="Headline" value={draft.headline} onChange={(v) => setDraft({ ...draft, headline: v })} />
            <Field label="Email" value={draft.email} onChange={(v) => setDraft({ ...draft, email: v })} />
            <Field label="Phone" value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
            <Field label="Location" value={draft.location} onChange={(v) => setDraft({ ...draft, location: v })} />
            <Field label="LinkedIn" value={draft.linkedin} onChange={(v) => setDraft({ ...draft, linkedin: v })} />
          </div>
          <label className="mt-3 block">
            <span className="text-xs text-[var(--color-muted)]">Summary</span>
            <textarea
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              rows={3}
              className="mt-1 w-full rounded-lg border border-white/12 bg-black/20 p-2 text-xs"
            />
          </label>
        </Section>

        <Section title={`Experience — ${draft.experience.length}`}>
          <div className="space-y-2">
            {draft.experience.map((e, i) => (
              <div key={`${e.company}-${i}`} className="rounded-lg border border-white/10 p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold">{e.title}</span>
                  <span className="text-xs text-[var(--color-muted)]">{e.company}</span>
                  {e.uncertain && <Flag />}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {e.startDate || '(no start date)'} — {e.current ? 'present' : e.endDate || '(no end date)'}
                  {e.location ? ` · ${e.location}` : ''}
                </p>
                <ul className="mt-2 space-y-1">
                  {e.bullets.map((b) => (
                    <li key={b} className="text-xs text-[var(--color-muted)]">
                      • {b}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        <Section title={`Skills — ${kept} of ${draft.skills.length} kept`}>
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Untick anything you would not want to be asked about in an interview. The line under each
            one is where it was found in your CV.
          </p>
          <div className="max-h-80 space-y-1 overflow-auto pr-1">
            {draft.skills.map((s, i) => (
              <SkillRow
                key={`${s.name}-${i}`}
                skill={s}
                checked={Boolean(keptSkills[i])}
                onToggle={() => setKeptSkills({ ...keptSkills, [i]: !keptSkills[i] })}
              />
            ))}
          </div>
        </Section>

        <Section title="Work authorisation">
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            A CV almost never states this and it cannot be guessed, but it decides which jobs are
            possible at all — so it is asked outright.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={needsSponsorship}
                onChange={(e) => setNeedsSponsorship(e.target.checked)}
              />
              I need visa sponsorship to work in the EU
            </label>
            <Field label="Country you are in now" value={currentCountry} onChange={setCurrentCountry} />
          </div>
        </Section>

        {draft.couldNotRead.length > 0 && (
          <Section title="Could not be read from your CV">
            <ul className="space-y-1">
              {draft.couldNotRead.map((c) => (
                <li key={c} className="text-xs text-[var(--color-muted)]">
                  • {c}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-bold text-white shadow disabled:opacity-40"
            style={{ backgroundImage: 'var(--grad-green)' }}
          >
            {busy ? 'Saving…' : 'This is correct — save my profile'}
          </button>
          <button
            type="button"
            onClick={() => { setStage('upload'); setDraft(null); setError(null); }}
            className="rounded-lg border border-white/12 px-4 py-2 text-sm font-semibold hover:bg-white/5"
          >
            Start again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {storedCv && (
        <div className="mb-4 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 p-3">
          <p className="text-xs font-semibold">
            We already have the CV you signed up with{storedCv !== 'cv' ? ` (${storedCv})` : ''}.
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Read it into a profile now — you will check every field before anything is saved.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void upload()}
            className="mt-2 rounded-lg px-3 py-1.5 text-xs font-bold text-white shadow disabled:opacity-40"
            style={{ backgroundImage: 'var(--grad-brand)' }}
          >
            {busy ? 'Reading your CV…' : 'Build my profile from it'}
          </button>
        </div>
      )}

      <p className="text-sm text-[var(--color-muted)]">
        {storedCv ? 'Or upload a different CV' : 'Upload your CV'} as a PDF or a Word .docx. It is read
        into a profile that you check and correct before anything is saved.
      </p>
      <label className="mt-3 inline-block">
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md,application/pdf"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
          className="block w-full text-xs file:mr-3 file:rounded-lg file:border-0 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white"
        />
      </label>
      {busy && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Reading your CV… this takes up to a minute.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-[var(--color-bad)]">{error}</p>}
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        A scanned CV will not work: the words are pixels rather than text. Re-save it from the
        original document.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--color-muted)]">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-white/12 bg-black/20 px-2 py-1.5 text-xs"
      />
    </label>
  );
}

function Flag() {
  return (
    <span className="rounded-full bg-[var(--color-warn)]/20 px-2 py-0.5 text-[10px] font-bold text-[var(--color-warn)]">
      uncertain
    </span>
  );
}

function SkillRow({
  skill,
  checked,
  onToggle,
}: {
  skill: DraftSkill;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold">{skill.name}</span>
          <span className="text-[10px] text-[var(--color-muted)]">
            {skill.level}
            {skill.years ? ` · ${skill.years}y` : ''}
          </span>
          {skill.uncertain && <Flag />}
        </span>
        <span className="block text-[11px] leading-snug text-[var(--color-muted)]">{skill.evidence}</span>
        {skill.sourceQuote && (
          <span className="block truncate text-[10px] italic text-[var(--color-muted)]/70">
            from your CV: “{skill.sourceQuote}”
          </span>
        )}
      </span>
    </label>
  );
}
