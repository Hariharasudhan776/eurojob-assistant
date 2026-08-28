import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getJob, latestProfile } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { countryName } from '@/lib/jobs/types';
import { roleLabel } from '@/lib/match/roles';
import { atsReport } from '@/lib/match/ats';
import { Bar, Card, Pill, RecommendationPill, ScoreBadge, SponsorshipPill } from '@/components/ui';
import { AtsCard } from '@/components/AtsCard';
import { KeywordGaps } from '@/components/KeywordGaps';
import { CompensationCard } from '@/components/CompensationCard';
import { htmlToText } from '@/lib/jobs/parse';
import { BackButton } from '@/components/BackButton';
import { extractSalary, formatSalary, formatSalaryUsd, sponsorshipEvidence, toUsd } from '@/lib/jobs/compensation';
import { suggestQuote } from '@/lib/jobs/quote';
import { buildMirrorPlan } from '@/lib/resume/mirror';
import { scoreJob } from '@/lib/match/score';
import { jobRowToNormalised } from '@/lib/jobs/from-row';
import { JobActions } from '@/components/JobActions';

export const dynamic = 'force-dynamic';

interface Breakdown {
  components?: Record<string, { score: number; reasons: string[] }>;
  requirements?: {
    required?: { display: string; satisfiedBy: string | null; weight: number; evidence: string | null }[];
    minYears?: number | null;
    education?: string | null;
    languages?: string[];
  };
  relevance?: { discipline?: string; outOfScope?: boolean; reasons?: string[] };
  confidence?: { level: string; reason: string | null };
  blockers?: string[];
}

interface AiSummary {
  verdict?: string;
  strengths?: string[];
  concerns?: string[];
  preparation?: string[];
  applyPriority?: string;
  violations?: { severity: string; detail: string }[];
  safe?: boolean;
}

const COMPONENT_LABELS: Record<string, string> = {
  technical: 'Technical skills',
  experience: 'Experience',
  education: 'Education',
  location: 'Location & visa',
  language: 'Language',
  aiTools: 'AI / modern tools',
};

export default async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) notFound();

  const userId = await currentUserId();
  const [job, profile] = await Promise.all([getJob(userId, jobId), latestProfile(userId)]);
  if (!job) notFound();

  // `breakdown` is a jsonb column (already an object); `ai_summary` is a text
  // column holding JSON, so it arrives as a string and must be parsed. Handling
  // both shapes keeps this robust whichever way a column is typed.
  const breakdown = (parseMaybe(job.breakdown) ?? {}) as Breakdown;
  const ai = (parseMaybe(job.ai_summary) ?? null) as AiSummary | null;
  // Free, deterministic ATS pre-flight from the match that already exists.
  const ats = profile
    ? atsReport(breakdown.requirements?.required ?? [], profile.data, job.description_complete)
    : null;

  /**
   * Which of this posting's words the candidate has earned, which are worth
   * asking about, and which are simply absent.
   *
   * Scored fresh rather than read from `breakdown`: a stored breakdown predates
   * the vocabulary work, so it carries neither the employer's spellings nor the
   * Oracle tooling the matcher used to be blind to. Scoring is deterministic and
   * costs nothing, so recomputing here is cheaper than a stale answer.
   */
  // Pay and sponsorship, read out of the posting text at render time. Nothing is
  // stored, so this applies to every job already collected -- most of which
  // carry their salary only in prose, where no structured field ever saw it.
  const salary = extractSalary(job.description ?? '');
  const sponsorship = sponsorshipEvidence(job.description ?? '');

  // What this candidate could put in the salary-expectation box, in the job's
  // own currency. Per profile (it depends on their years), so no profile means
  // no quote rather than a generic one.
  const quote = profile
    ? suggestQuote({
        country: job.country,
        description: job.description ?? '',
        structured: { min: job.salary_min, max: job.salary_max, currency: job.salary_currency },
        extracted: salary,
        candidateYears: profile.data.totalYears,
      })
    : null;

  /**
   * Pay for the header, in US dollars.
   *
   * Dollars because bands arrive in a dozen currencies and cannot be compared at
   * a glance otherwise. The original is still shown in the Pay & sponsorship
   * card below: the posting's own figure is the fact, and the conversion is a
   * convenience laid over it.
   *
   * The source's structured field is used when it has one, and the text is read
   * when it does not -- which is the common case, since most postings state pay
   * only in prose.
   */
  const headlineSalary = (() => {
    if (job.salary_min || job.salary_max) {
      const currency = job.salary_currency ?? null;
      const lo = job.salary_min ? toUsd(job.salary_min, currency) : null;
      const hi = job.salary_max ? toUsd(job.salary_max, currency) : null;
      const usd = (v: number) => `$${v.toLocaleString('en-GB')}`;
      const approx = currency && currency.toUpperCase() !== 'USD' ? '≈' : '';
      if (lo !== null && hi !== null) return `${approx}${usd(lo)} – ${usd(hi)}`;
      if (lo !== null || hi !== null) return `${approx}${usd((lo ?? hi)!)}`;
    }
    if (salary) return formatSalaryUsd(salary) ?? formatSalary(salary);
    return 'not stated';
  })();

  const liveMatch = profile ? scoreJob(profile.data, jobRowToNormalised(job), { preferredCountries: [] }) : null;
  const mirror =
    profile && liveMatch
      ? buildMirrorPlan(liveMatch.requirements.required, liveMatch.requirements.preferred, profile.data)
      : null;

  return (
    <div className="space-y-4">
      <BackButton />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{job.title}</h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {job.company}
              {job.city ? ` — ${job.city}` : ''}
              {/* Country is always stated. "Not stated" is information too --
                  silently omitting it read as though the job had no location. */}
              {job.country ? `, ${countryName(job.country)}` : ', country not stated'}
            </p>

            {/* The three facts that decide whether to read on, on their own line
                so they are not lost among the classification pills. Each renders
                even when the posting is silent, because "not stated" is an
                answer and a missing row is not. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span>
                <span className="text-[var(--color-muted)]">Salary </span>
                <span className="tnum font-bold text-[var(--color-good)]">{headlineSalary}</span>
              </span>
              <span>
                <span className="text-[var(--color-muted)]">Type </span>
                <span className="font-semibold">{employmentLabel(job.employment_type)}</span>
              </span>
              <span>
                <span className="text-[var(--color-muted)]">Working mode </span>
                <span className="font-semibold">{job.remote ?? 'not stated'}</span>
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <RecommendationPill value={job.recommendation} />
              {job.role_category && <Pill tone="accent">{roleLabel(job.role_category)}</Pill>}
              <SponsorshipPill value={job.visa_sponsorship} />
              {job.relocation_support === 'yes' && <Pill tone="good">relocation support</Pill>}
              {job.languages?.length ? <Pill>needs {job.languages.join(', ')}</Pill> : <Pill>no language stated</Pill>}
              <Pill>from {job.source_slug}</Pill>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <ScoreBadge score={job.overall} />
            <a href={job.url} target="_blank" rel="noreferrer"
               className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink)]">
              Open original posting
            </a>
          </div>
        </div>
      </Card>

      {breakdown.confidence?.level === 'low' && (
        <Card>
          <p className="text-sm text-[var(--color-warn)]">
            Low confidence: {breakdown.confidence.reason}
          </p>
        </Card>
      )}

      {breakdown.blockers?.length ? (
        <Card title="Blockers">
          <ul className="space-y-1.5">
            {breakdown.blockers.map((blocker, i) => (
              <li key={i} className="text-sm text-[var(--color-bad)]">{blocker}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Why this score">
          <div className="space-y-2">
            {Object.entries(breakdown.components ?? {}).map(([key, component]) => (
              <Bar key={key} label={COMPONENT_LABELS[key] ?? key} score={component.score} />
            ))}
          </div>
          <div className="mt-4 space-y-3">
            {Object.entries(breakdown.components ?? {}).map(([key, component]) => (
              <div key={key}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  {COMPONENT_LABELS[key] ?? key}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {component.reasons.map((reason, i) => (
                    <li key={i} className="text-xs text-[var(--color-fg)]/85">{reason}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Skills">
            <SkillList label="Strong matches" tone="good" items={job.strong_matches ?? []} />
            <SkillList label="Transferable" tone="warn" items={job.partial_matches ?? []} />
            <SkillList
              label="Missing"
              tone="bad"
              items={job.missing_skills ?? []}
              empty={job.description_complete ? 'None found.' : 'Unknown — this source supplies only an extract.'}
            />
          </Card>

          <Card title="Requirements found in the posting">
            <dl className="space-y-1 text-sm">
              <Row label="Minimum experience" value={breakdown.requirements?.minYears ? `${breakdown.requirements.minYears} years` : 'not stated'} />
              <Row label="Education" value={breakdown.requirements?.education ?? 'not stated'} />
              <Row label="Languages" value={breakdown.requirements?.languages?.join(', ') || 'not stated'} />
              <Row label="Role type" value={breakdown.relevance?.discipline ?? 'unknown'} />
            </dl>
          </Card>
        </div>
      </div>

      {ai ? (
        <Card title={`AI verdict${ai.applyPriority ? ` — apply ${ai.applyPriority}` : ''}`}>
          {ai.verdict && <p className="text-sm">{ai.verdict}</p>}
          {ai.strengths?.length ? (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-good)]">Strengths</p>
              <ul className="mt-1 space-y-1">
                {ai.strengths.map((s, i) => <li key={i} className="text-sm text-[var(--color-fg)]/85">{s}</li>)}
              </ul>
            </>
          ) : null}
          {ai.concerns?.length ? (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-warn)]">Concerns</p>
              <ul className="mt-1 space-y-1">
                {ai.concerns.map((c, i) => <li key={i} className="text-sm text-[var(--color-fg)]/85">{c}</li>)}
              </ul>
            </>
          ) : null}
          {ai.preparation?.length ? (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">Before applying</p>
              <ul className="mt-1 space-y-1">
                {ai.preparation.map((p, i) => <li key={i} className="text-sm text-[var(--color-fg)]/85">{p}</li>)}
              </ul>
            </>
          ) : null}
          {ai.violations?.length ? (
            <p className="mt-3 text-xs text-[var(--color-warn)]">
              Verification flagged {ai.violations.length} item(s): {ai.violations.map((v) => v.detail).join(' ')}
            </p>
          ) : (
            <p className="mt-3 text-xs text-[var(--color-good)]">
              Verified against your profile — no unevidenced claims.
            </p>
          )}
        </Card>
      ) : (
        <Card title="AI verdict">
          <p className="text-sm text-[var(--color-muted)]">
            Not generated yet. Everything above is deterministic and free. Use the buttons below, or run{' '}
            <code className="text-[var(--color-fg)]">npm run sync -- --explain 5</code>.
          </p>
        </Card>
      )}

      <CompensationCard
        salary={salary}
        structured={{ min: job.salary_min, max: job.salary_max, currency: job.salary_currency }}
        sponsorship={sponsorship}
        verdict={job.visa_sponsorship}
        quote={quote}
      />

      {ats && <AtsCard report={ats} />}
      {mirror && profile && (
        <KeywordGaps
          mirrored={mirror.mirror}
          confirm={mirror.confirm}
          gaps={mirror.gaps}
          employers={profile.data.experience.map((e) => ({ company: e.company, title: e.title }))}
        />
      )}

      <JobActions jobId={job.id} currentStage={job.stage} notes={job.notes} />

      <Card title="Original description">
        {/* Tags stripped: several sources store raw HTML, and this panel was
            rendering "<li><strong>..." at the reader instead of the posting. */}
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-fg)]/80">
          {htmlToText(job.description ?? '')}
        </pre>
        {!job.description_complete && (
          <p className="mt-2 text-xs text-[var(--color-warn)]">
            This is the first 500 characters only. Open the original posting for the full text.
          </p>
        )}
      </Card>

      <Link href="/jobs" className="inline-block text-sm text-[var(--color-accent)]">← back to jobs</Link>
    </div>
  );
}

/** A jsonb column returns an object; a text column returns a JSON string. Accept both. */
function parseMaybe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function SkillList({ label, tone, items, empty = 'None.' }: { label: string; tone: 'good' | 'warn' | 'bad'; items: string[]; empty?: string }) {
  const colour = { good: 'var(--color-good)', warn: 'var(--color-warn)', bad: 'var(--color-bad)' }[tone];
  return (
    <div className="mb-3 last:mb-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: colour }}>{label}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{empty}</p>
      ) : (
        <p className="mt-1 text-sm">{items.join(' · ')}</p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

/**
 * Full time, part time, contract -- or plainly "not stated".
 *
 * Sources spell this a dozen ways (`full_time`, `FULL_TIME`, `permanent`), and
 * most of them omit it entirely. It used to be hidden whenever it was missing,
 * which left the reader unable to tell a full-time role from one the posting had
 * simply not described.
 */
function employmentLabel(raw: string | null): string {
  if (!raw) return 'not stated';
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const known: Record<string, string> = {
    full_time: 'full time',
    fulltime: 'full time',
    permanent: 'full time (permanent)',
    part_time: 'part time',
    parttime: 'part time',
    contract: 'contract',
    contractor: 'contract',
    temporary: 'temporary',
    internship: 'internship',
    apprenticeship: 'apprenticeship',
    freelance: 'freelance',
    working_student: 'working student',
  };
  return known[key] ?? raw.replace(/_/g, ' ');
}
