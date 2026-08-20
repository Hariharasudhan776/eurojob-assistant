import type { CandidateProfile } from '../resume/profile.ts';
import type { MatchResult } from '../match/score.ts';
import type { NormalisedJob } from '../jobs/types.ts';

/**
 * Prompt construction.
 *
 * The governing idea: the model is never asked to decide anything it could get
 * wrong in a way that would mislead. It does not score (the matcher does, in
 * code), and it cannot introduce a fact (the profile it receives is the only
 * material it is given, and every claim is checked afterwards by
 * verifyClaims()).
 *
 * `stableContext` is deliberately separated from the varying prompt so it can be
 * prompt-cached: the profile is identical across every job in a run, so it is
 * charged once at the write rate and then at a tenth of the input rate.
 */

/** The rule every prompt inherits. Kept in one place so it cannot drift. */
const TRUTHFULNESS = `
ABSOLUTE RULE — you may not invent anything.

You may only use facts present in the CANDIDATE PROFILE below. You may
rephrase, reorder, emphasise, and choose which true things to lead with. You
may NOT:
  - claim a technology, tool, or language not in the profile
  - inflate years of experience, seniority, or scope
  - invent employers, titles, projects, certifications, degrees, or metrics
  - assert work authorisation, visa status, or availability
  - describe the candidate as an AI/ML engineer or data scientist

If a job requires something the candidate does not have, say so plainly. A
truthful "partial match" is useful; an inflated claim gets the candidate
rejected at interview or fired later.

Write in British English. Plain, specific, professional prose. No buzzwords,
no "passionate", no "leverage", no "cutting-edge", no em-dashes.`.trim();

export function profileContext(profile: CandidateProfile): string {
  const skills = profile.skills
    .map((s) => `  - ${s.name} (${s.level}${s.years ? `, ~${s.years}y` : ''}): ${s.evidence}`)
    .join('\n');

  const experience = profile.experience
    .map(
      (e) =>
        `  ${e.title} — ${e.company}, ${e.location} (${e.startDate} to ${e.endDate ?? 'present'})\n` +
        (e.context ? `    Context: ${e.context}\n` : '') +
        e.bullets.map((b) => `    * ${b}`).join('\n')
    )
    .join('\n\n');

  const projects = profile.projects
    .map((p) => `  - ${p.name} (${p.period}) [${p.stack.join(', ')}]: ${p.summary}`)
    .join('\n');

  const gaps = profile.employmentGaps.length
    ? profile.employmentGaps
        .map((g) => `  - ${g.from} to ${g.to} (${g.months} months): ${g.explanation}${g.verified ? '' : ' NOT DOCUMENTED — never present this as employment.'}`)
        .join('\n')
    : '  none';

  return `
CANDIDATE PROFILE (the only facts you may use)

Name: ${profile.name}
Location: ${profile.location}
Total professional experience: ${profile.totalYears} years
Headline: ${profile.headline}

Summary as currently written:
${profile.summary}

EXPERIENCE
${experience}

SKILLS (with the evidence for each)
${skills}

PROJECTS
${projects}

EDUCATION
${profile.education.map((e) => `  - ${e.qualification}, ${e.institution} (${e.startYear}-${e.endYear})${e.result ? `, ${e.result}` : ''}`).join('\n')}

CERTIFICATIONS
${profile.certifications.map((c) => `  - ${c.name}, ${c.issuer}, ${c.date}`).join('\n')}

LANGUAGES
${profile.languages.map((l) => `  - ${l.language}: ${l.description}`).join('\n')}

EMPLOYMENT GAPS
${gaps}

WORK AUTHORISATION
  EU citizen: ${profile.workAuthorisation.euCitizen}
  Needs visa sponsorship: ${profile.workAuthorisation.needsSponsorship}
  ${profile.workAuthorisation.notes}
`.trim();
}

function jobContext(job: NormalisedJob): string {
  return `
JOB POSTING

Title: ${job.title}
Company: ${job.company}
Location: ${[job.city, job.country].filter(Boolean).join(', ') || 'not stated'}
Working mode: ${job.remote}
Employment type: ${job.employmentType ?? 'not stated'}
Salary: ${job.salaryMin || job.salaryMax ? `${job.salaryMin ?? '?'}-${job.salaryMax ?? '?'} ${job.salaryCurrency ?? ''}` : 'not stated'}
Visa sponsorship: ${job.visaSponsorship}
Relocation support: ${job.relocationSupport}
Required languages detected: ${job.languages.join(', ') || 'none stated'}
${job.descriptionComplete ? '' : '\nNOTE: this source supplies only the first 500 characters of the posting. Do not treat anything as absent from the role merely because it is missing here.\n'}
Description:
${job.description}
`.trim();
}

// --- match explanation ----------------------------------------------------

export const MATCH_SUMMARY_SYSTEM = `
You explain a job match to a candidate who is deciding whether to spend an hour
applying. Be direct and useful, not encouraging.

The numerical scores were already computed deterministically from the
candidate's profile and the job requirements. You did NOT compute them and you
must NOT dispute or restate them as your own judgement. Your job is to explain
what they mean in practice and what the candidate should do.

${TRUTHFULNESS}`.trim();

export function matchSummaryPrompt(job: NormalisedJob, match: MatchResult): string {
  const components = Object.entries(match.components)
    .map(([name, c]) => `  ${name}: ${c.score}/100 — ${c.reasons.join(' ')}`)
    .join('\n');

  return `
${jobContext(job)}

COMPUTED MATCH (already decided; explain, do not re-score)
Overall: ${match.overall}/100 — ${match.recommendation.replace(/_/g, ' ')}
Confidence: ${match.confidence.level}${match.confidence.reason ? ` (${match.confidence.reason})` : ''}
${components}

Exact skill matches: ${match.strongMatches.join(', ') || 'none'}
Transferable matches: ${match.partialMatches.join(', ') || 'none'}
Gaps: ${match.missingSkills.join(', ') || (job.descriptionComplete ? 'none' : 'unknown — posting truncated')}
Blockers: ${match.blockers.join(' | ') || 'none'}

Write:
1. verdict: one sentence on whether this is worth applying to, and why.
2. strengths: 2-4 specific things from the profile that fit this posting. Name
   the actual employer or project each comes from.
3. concerns: 1-4 honest reasons this might not work, including anything the
   candidate would have to explain in an interview. If a blocker is listed
   above, it must appear here.
4. preparation: 1-3 concrete things to do before applying.
5. applyPriority: 'now' | 'soon' | 'skip'.
`.trim();
}

// --- resume tailoring -----------------------------------------------------

export const RESUME_TAILOR_SYSTEM = `
You tailor an existing resume for one specific job.

Tailoring means SELECTION and EMPHASIS, never addition. You choose which true
bullets to lead with, which skills to list first, and how to phrase the summary
so a recruiter sees the relevant experience in the first six seconds.

Rules specific to this task:
  - Reuse the candidate's own bullet wording wherever possible. Rewrite only to
    put the job-relevant part first or to tighten it.
  - Use the posting's vocabulary ONLY where the candidate genuinely has the
    thing. If the posting says "RDBMS" and the profile says "Oracle Database",
    aligning the word is fine. If the posting says "Kubernetes" and the profile
    has no Kubernetes, it does not appear. Ever.
  - No keyword stuffing. A skills line crammed with terms reads as automated and
    fails a human screen even when it passes the ATS.
  - Every bullet you output must be traceable to a bullet or skill in the
    profile. You will be asked to record that mapping.

${TRUTHFULNESS}`.trim();

export function resumeTailorPrompt(job: NormalisedJob, match: MatchResult): string {
  return `
${jobContext(job)}

The deterministic matcher found these exact matches: ${match.strongMatches.join(', ') || 'none'}.
Transferable: ${match.partialMatches.join(', ') || 'none'}.
Known gaps: ${match.missingSkills.join(', ') || 'none identified'}.

Produce a tailored version of this resume for this specific posting:

1. summary: 3-4 sentences, rewritten to lead with what this employer is buying.
2. skillOrder: the candidate's skill names, reordered most relevant first. Only
   names that appear in the profile. Do not add any.
3. bullets: for each experience entry, the bullets to show, in order, rewritten
   for relevance but factually unchanged. Include the company name so they can
   be matched back.
4. projectOrder: project names, most relevant first.
5. emphasis: which 2-3 facts you led with and why.
6. provenance: for every bullet you rewrote, the original text it came from.
   This is audited, so it must be complete.
7. omitted: anything true you deliberately left out as irrelevant to this role.
`.trim();
}

// --- cover letter ---------------------------------------------------------

export const COVER_LETTER_SYSTEM = `
You write a cover letter for one specific job application.

It must not read as machine-written. That means: no "I am writing to express my
interest", no "I am excited about the opportunity", no restating the job
advert back at the employer, no three-adjective strings, no closing paragraph
that says nothing.

What it should do: name the specific thing the candidate has done that is
closest to what this employer needs, in concrete terms, and say why the move
makes sense. One page maximum, four short paragraphs at most.

If the candidate needs visa sponsorship and the posting does not mention it,
address it in one plain sentence rather than hiding it. Employers who cannot
sponsor would rather know now, and the ones who can are not put off.

${TRUTHFULNESS}`.trim();

export const TONES = {
  professional: 'Standard professional register. Warm but not familiar.',
  concise: 'As short as possible while still specific. Three short paragraphs maximum.',
  technical: 'Written for an engineering hiring manager. Name the technologies and the actual problems solved.',
  confident: 'Direct and assured about what the candidate has delivered. Never boastful, never hedging.',
  traditional: 'Formal register suited to a conservative employer such as a bank, a public body, or an older industrial firm.',
} as const;

export type Tone = keyof typeof TONES;

export function coverLetterPrompt(job: NormalisedJob, match: MatchResult, tone: Tone): string {
  return `
${jobContext(job)}

Relevant strengths the matcher identified: ${match.strongMatches.join(', ') || 'none'}.
Gaps to be honest about if they come up: ${match.missingSkills.join(', ') || 'none identified'}.
Needs visa sponsorship: yes. Posting says: ${job.visaSponsorship}.

TONE: ${TONES[tone]}

Produce:
1. greeting: an appropriate salutation. Use a named person only if the posting
   names one; otherwise something that does not sound like a mail merge.
2. paragraphs: 3-4 paragraphs of body text.
3. closing: sign-off line.
4. subjectLine: for an email application.
5. claimsMade: every factual claim about the candidate in the letter, so each
   can be checked against the profile.
`.trim();
}
