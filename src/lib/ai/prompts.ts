import type { CandidateProfile } from '../resume/profile.ts';
import type { MatchResult } from '../match/score.ts';
import type { NormalisedJob } from '../jobs/types.ts';
import { forbiddenBriefing, mirrorBriefing, type MirrorPlan } from '../resume/mirror.ts';

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

WHO YOU ARE WRITING FOR

Two readers, in this order, and they want opposite things.

The first is software: an applicant tracking system doing a literal string
search for the terms in the advert. It does not know that "Backup & Recovery"
and "RMAN" are related. It matches text or it does not.

The second is a senior recruiter with 100 resumes and 10 minutes -- six seconds
per page on the first pass. They are not reading. They are looking for four
things, in the top third of page one, and if those are not there the page is
binned before anything else on it is read:

  1. Does the title on this resume look like the title we advertised?
  2. Do the years and the current employer clear the bar?
  3. Are the specific technologies from our advert visible right now, in our
     words, without me hunting for them?
  4. Is there a number anywhere, or is this all "responsible for"?

Everything below the top third is only ever read by someone already interested.
So the tailoring is won or lost in the headline, the summary, and the skills
line.

TAILORING MEANS SELECTION, EMPHASIS, AND VOCABULARY -- NEVER ADDITION

You may reorder, re-lead, tighten, and relabel. You may not add a fact.

Relabelling is the part that is new and the part that matters. You will be given
a MIRROR MAP: pairs where the posting's word and the profile's word name the
same thing, checked in code before it reached you. For those, write the
EMPLOYER'S word. That is not a claim, it is the better label for a fact the
candidate already owns, and it is the single highest-value thing you do here.

You will also be given a FORBIDDEN list: terms the posting uses that the
candidate has NOT confirmed. Some of those are near-misses, where the candidate
holds something adjacent. Write the adjacent thing as itself, under its own
name. Never borrow the forbidden word for it. A near-miss stated accurately is
an interview; a near-miss overstated is a rejection at the technical screen and
a withdrawn offer if it gets further.

Rules specific to this task:
  - Reuse the candidate's own bullet wording wherever possible. Rewrite only to
    put the job-relevant part first, to tighten, or to apply a mirror-map term.
  - Every number you write must already exist in the profile. If a bullet has no
    number, it stays without one. An invented metric is the easiest lie to catch
    and the most damaging.
  - Lead every bullet with a verb, and put the outcome before the method where
    the profile gives you an outcome.
  - Weight by relevance: the most relevant role gets the most bullets (up to
    six), older or less relevant roles get two or three. Drop bullets that say
    nothing to this employer -- and record them as omitted.
  - No keyword stuffing. A skills line crammed with terms reads as automated and
    fails the human screen even when it passes the ATS. Mirror-map terms belong
    where they are true and relevant, not everywhere.
  - The resume does not confess. Gaps, missing skills and things being learned
    belong in the cover letter and the interview, not on this page. Simply do
    not mention them here.

${TRUTHFULNESS}`.trim();

export function resumeTailorPrompt(job: NormalisedJob, match: MatchResult, mirror: MirrorPlan): string {
  return `
${jobContext(job)}

The deterministic matcher found these exact matches: ${match.strongMatches.join(', ') || 'none'}.
Transferable: ${match.partialMatches.join(', ') || 'none'}.
Known gaps: ${match.missingSkills.join(', ') || 'none identified'}.

MIRROR MAP — the employer's word for something the candidate genuinely has.
Use THEIR spelling for each of these. Normalise the capitalisation to suit the
line it sits on; do not otherwise change the term.
${mirrorBriefing(mirror)}

FORBIDDEN TERMS — these appear in the posting and the candidate has NOT
confirmed them. They must not appear anywhere in your output, in any form,
including inside a longer phrase.
${forbiddenBriefing(mirror)}

Produce a tailored version of this resume for this specific posting:

1. targetTitle: the line printed under the candidate's name. It must read as
   the role being advertised AND be supportable by the experience below. If the
   posting is "Senior Oracle Database Administrator" and the candidate has done
   Oracle DBA work, "Oracle Database Administrator" is right. If the posting is
   a role the candidate has never done, do NOT mirror it -- use the closest
   honest description of what they actually are. Never add a seniority word the
   experience does not support.
2. summary: 3-4 sentences. The first sentence must carry the years, the current
   or most recent employer, and the two or three mirror-map terms that matter
   most to this posting. This is the sentence that decides whether the rest of
   the page is read.
3. skillOrder: the candidate's skill names, reordered most relevant first. Only
   names that appear in the profile. Do not add any.
4. skillLabels: for any profile skill whose better label is in the mirror map,
   the pair {profileSkill, printAs}. profileSkill must be the exact name from the
   profile; printAs must be the employer's term for the same thing. Leave this
   empty if there is nothing to relabel.
5. bullets: for each experience entry, the bullets to show, in order, rewritten
   for relevance but factually unchanged. Include the company name so they can
   be matched back. Most relevant role first and longest.
6. projectOrder: project names, most relevant first.
7. keywordsUsed: every term from the posting that now appears in your output,
   spelled exactly as you wrote it. This is checked against the document.
8. emphasis: which 2-3 facts you led with and why, in recruiter terms.
9. provenance: for every bullet you rewrote, the original text it came from.
   This is audited, so it must be complete.
10. omitted: anything true you deliberately left out as irrelevant to this role.
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
