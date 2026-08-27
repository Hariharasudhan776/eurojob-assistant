import type { CandidateProfile, Skill } from '../resume/profile.ts';
import { SKILL_LEVEL_RANK } from '../resume/profile.ts';
import { canonicalise, display, extractSkillMentions, extractSkills, lookup, transferWeight } from './taxonomy.ts';
import { assessRelevance, shrinkRatio, type RelevanceVerdict } from './relevance.ts';
import type { NormalisedJob } from '../jobs/types.ts';

/**
 * Deterministic, explainable job matching.
 *
 * The score is computed in code, not asked of a model. Three reasons, all of
 * which the spec calls for directly:
 *
 *  * Explainability (§6) -- every component returns the facts that produced it,
 *    so a number can always be defended. "The model said 87" cannot.
 *  * Consistency -- the same job and profile always produce the same score.
 *    A sampled model would drift between runs and make ranking meaningless.
 *  * Cost (§19) -- scoring is free, so every collected job can be scored and the
 *    AI is reserved for the handful worth narrating.
 *
 * The AI layer sits *after* this: it explains and tailors, it does not decide.
 */

export interface ScoreComponent {
  score: number;
  weight: number;
  /** Human-readable facts behind the number. Rendered directly in the UI. */
  reasons: string[];
}

export interface SkillVerdict {
  requirement: string;
  display: string;
  /** Which profile skill satisfied it, if any. */
  satisfiedBy: string | null;
  /** 1 = exact, 0 < w < 1 = transferable, 0 = missing. */
  weight: number;
  level: string | null;
  evidence: string | null;
  /**
   * The employer's own spellings of this requirement, taken verbatim from the
   * posting, longest first. Empty when the requirement came from an override
   * rather than from the text.
   *
   * This is what an applicant tracking system searches for and what a recruiter
   * skimming a stack of resumes visually locks onto. Our `display` name is for
   * our UI; `surface` is the vocabulary the document has to speak.
   */
  surface: string[];
}

export interface MatchResult {
  overall: number;
  components: {
    technical: ScoreComponent;
    experience: ScoreComponent;
    education: ScoreComponent;
    location: ScoreComponent;
    language: ScoreComponent;
    aiTools: ScoreComponent;
  };
  strongMatches: string[];
  partialMatches: string[];
  missingSkills: string[];
  recommendation: 'highly_recommended' | 'possible' | 'low';
  /** Facts that cap the recommendation regardless of the score. */
  blockers: string[];
  relevance: RelevanceVerdict;
  /**
   * How much the score can be trusted. 'low' means the source gave only a
   * snippet, so absent requirements may simply be past the truncation point --
   * the UI must show this rather than presenting a confident number.
   */
  confidence: { level: 'high' | 'low'; reason: string | null };
  requirements: {
    required: SkillVerdict[];
    preferred: SkillVerdict[];
    minYears: number | null;
    education: string | null;
    languages: string[];
  };
}

const WEIGHTS = {
  technical: 0.35,
  experience: 0.2,
  location: 0.15,
  language: 0.12,
  education: 0.1,
  aiTools: 0.08,
} as const;

const EDUCATION_RANK: Record<string, number> = { vocational: 1, bachelors: 2, masters: 3, phd: 4 };

/**
 * Skills that must never be credited from AI-tool fluency.
 *
 * This is the mechanism behind spec §3: being comfortable with Claude or
 * Copilot is a real, marketable skill, and it is *not* machine-learning
 * engineering. Without this list, a profile carrying `ai-assisted-dev` would
 * partially satisfy an ML Engineer posting through the taxonomy's relatedness
 * graph, and the app would be quietly overstating the candidate.
 */
const NEVER_FROM_AI_TOOLING = new Set(['machine-learning', 'data-science']);

/** Split a job description into required vs preferred skill requirements. */
export function extractRequirements(job: NormalisedJob): { required: string[]; preferred: string[] } {
  const text = job.description;

  // Postings almost always separate "must have" from "nice to have" under
  // headings. Anything after a nice-to-have heading is treated as preferred.
  const preferredHeading =
    /\b(?:nice[- ]to[- ]have|preferred|bonus|plus(?:es)?|desirable|advantageous|would be a plus|good to have|optional)\b/i;

  const lines = text.split(/\n+/);
  const requiredLines: string[] = [];
  const preferredLines: string[] = [];
  let inPreferred = false;

  for (const line of lines) {
    if (preferredHeading.test(line)) {
      inPreferred = true;
      // The heading line itself may carry the skill ("Nice to have: Docker").
      preferredLines.push(line);
      continue;
    }
    // A new requirements-style heading switches back to required.
    if (/\b(?:requirements?|must have|we expect|your profile|qualifications?|what you bring|essential)\b/i.test(line)) {
      inPreferred = false;
    }
    (inPreferred ? preferredLines : requiredLines).push(line);
  }

  const required = extractSkills(requiredLines.join('\n'));
  const preferredOnly = extractSkills(preferredLines.join('\n')).filter((s) => !required.includes(s));

  // A posting mentioning the title's technology in passing still requires it.
  for (const fromTitle of extractSkills(job.title)) {
    if (!required.includes(fromTitle)) required.push(fromTitle);
  }
  return { required, preferred: preferredOnly };
}

function judge(requirement: string, skills: Skill[], surface: string[] = []): SkillVerdict {
  const base: SkillVerdict = {
    requirement,
    display: display(requirement),
    satisfiedBy: null,
    weight: 0,
    level: null,
    evidence: null,
    surface,
  };

  const exact = skills.find((s) => s.canonical === requirement);
  if (exact) {
    return { ...base, satisfiedBy: exact.name, weight: 1, level: exact.level, evidence: exact.evidence };
  }

  // Never let AI-tool experience stand in for ML/DS requirements.
  if (NEVER_FROM_AI_TOOLING.has(requirement)) return base;

  let best: { skill: Skill; weight: number } | null = null;
  for (const skill of skills) {
    if (lookup(skill.canonical)?.category === 'ai' && NEVER_FROM_AI_TOOLING.has(requirement)) continue;
    const weight = transferWeight(requirement, skill.canonical);
    if (weight > 0 && (!best || weight > best.weight)) best = { skill, weight };
  }
  if (!best) return base;

  return {
    ...base,
    satisfiedBy: best.skill.name,
    weight: best.weight,
    level: best.skill.level,
    evidence: best.skill.evidence,
  };
}

function scoreTechnical(required: SkillVerdict[], preferred: SkillVerdict[], descriptionComplete: boolean): ScoreComponent {
  const reasons: string[] = [];

  if (required.length === 0) {
    reasons.push('The posting names no specific technology this app recognises, so technical fit could not be assessed from it.');
    return { score: 50, weight: WEIGHTS.technical, reasons };
  }

  // Depth matters: holding a required skill at "familiar" is weaker evidence
  // than holding it at "expert", so the transfer weight is scaled by level.
  let earned = 0;
  for (const verdict of required) {
    const levelFactor = verdict.level ? 0.55 + 0.15 * SKILL_LEVEL_RANK[verdict.level as keyof typeof SKILL_LEVEL_RANK] : 0;
    earned += verdict.weight * Math.min(1, levelFactor);
  }

  // Shrunk, not raw. A posting naming one recognisable skill that the profile
  // happens to have is thin evidence, and a raw ratio would score it 100% --
  // which is how a social-media role once ranked above an Oracle role.
  //
  // A truncated description is shrunk harder still: it is a 500-character
  // snippet, so both the matches and the gaps it shows are a partial sample.
  let score = shrinkRatio(earned, required.length, descriptionComplete ? 3 : 6) * 100;

  // Preferred skills can lift a score but never rescue a failing one.
  if (preferred.length > 0) {
    const preferredCoverage = preferred.reduce((sum, v) => sum + v.weight, 0) / preferred.length;
    score = Math.min(100, score + preferredCoverage * 8);
    reasons.push(`Covers ${preferred.filter((v) => v.weight > 0).length} of ${preferred.length} preferred skills.`);
  }

  const exact = required.filter((v) => v.weight === 1);
  const partial = required.filter((v) => v.weight > 0 && v.weight < 1);
  const missing = required.filter((v) => v.weight === 0);

  reasons.unshift(`${exact.length} of ${required.length} required skills matched exactly.`);
  if (partial.length) {
    reasons.push(`Transferable rather than exact: ${partial.map((v) => `${v.display} (via ${v.satisfiedBy})`).join(', ')}.`);
  }
  if (missing.length) {
    reasons.push(`No evidence in the profile for: ${missing.map((v) => v.display).join(', ')}.`);
  }
  if (!descriptionComplete) {
    reasons.push(
      'This source returns only the first 500 characters of the posting, so the requirement list is incomplete. Open the original before ruling the job in or out.'
    );
  }
  return { score: Math.round(score), weight: WEIGHTS.technical, reasons };
}

function scoreExperience(profileYears: number, minYears: number | null): ScoreComponent {
  const reasons: string[] = [];
  if (minYears === null) {
    reasons.push(`The posting states no minimum experience; the profile has ${profileYears} years.`);
    return { score: 75, weight: WEIGHTS.experience, reasons };
  }

  const ratio = profileYears / minYears;
  let score: number;
  if (ratio >= 1) {
    // Being far over the bar is not better than comfortably over it, and can
    // indicate the role is too junior -- so this tops out rather than climbing.
    score = ratio >= 1.5 ? 100 : 90 + Math.round((ratio - 1) * 20);
    reasons.push(`Asks for ${minYears}+ years; the profile has ${profileYears}.`);
  } else {
    score = Math.round(ratio * 85);
    const short = Math.round((minYears - profileYears) * 10) / 10;
    reasons.push(`Asks for ${minYears}+ years; the profile has ${profileYears} — ${short} short.`);
  }
  return { score: Math.min(100, score), weight: WEIGHTS.experience, reasons };
}

function scoreEducation(profile: CandidateProfile, required: string | null): ScoreComponent {
  const reasons: string[] = [];
  if (!required) {
    reasons.push('No formal education requirement stated.');
    return { score: 85, weight: WEIGHTS.education, reasons };
  }

  const highest = profile.education.reduce((best, e) => {
    const rank = /master/i.test(e.qualification) ? 3 : /bachelor|b\.?sc/i.test(e.qualification) ? 2 : 1;
    return Math.max(best, rank);
  }, 0);
  const wanted = EDUCATION_RANK[required] ?? 2;

  if (highest >= wanted) {
    reasons.push(`Requires ${required}; the profile has ${profile.education[0]?.qualification ?? 'a degree'}.`);
    return { score: 100, weight: WEIGHTS.education, reasons };
  }
  // A shortfall on paper is routinely offset by experience in Europe, so this
  // is a soft penalty rather than a disqualification.
  reasons.push(`Requires ${required}, which is above the profile's highest qualification. Often negotiable with strong experience.`);
  return { score: wanted - highest === 1 ? 65 : 40, weight: WEIGHTS.education, reasons };
}

function scoreLocation(
  profile: CandidateProfile,
  job: NormalisedJob,
  preferredCountries: string[]
): { component: ScoreComponent; blockers: string[] } {
  const reasons: string[] = [];
  const blockers: string[] = [];
  let score = 50;

  if (job.country && preferredCountries.includes(job.country)) {
    score = 95;
    reasons.push(`In ${job.country}, one of the target countries.`);
  } else if (job.country) {
    score = 45;
    reasons.push(`In ${job.country}, which is not on the target list.`);
  } else if (job.remote === 'remote') {
    score = 70;
    reasons.push('Location not stated, but the role is remote.');
  } else {
    reasons.push('Location could not be determined from the posting.');
  }

  if (job.remote === 'remote') {
    score = Math.min(100, score + 5);
    reasons.push('Fully remote.');
  } else if (job.remote === 'hybrid') {
    reasons.push('Hybrid — requires being in the area.');
  }

  // Sponsorship is the single biggest practical filter for a non-EU candidate,
  // so an explicit refusal is a blocker rather than a few lost points.
  if (profile.workAuthorisation.needsSponsorship) {
    if (job.visaSponsorship === 'no') {
      score = Math.min(score, 10);
      blockers.push('The posting states it cannot sponsor a visa, and the profile needs sponsorship.');
      reasons.push('Explicitly no visa sponsorship.');
    } else if (job.visaSponsorship === 'yes') {
      score = Math.min(100, score + 10);
      reasons.push('Visa sponsorship is explicitly offered.');
    } else {
      reasons.push('Visa sponsorship not specified — worth asking before applying.');
    }
  }

  if (job.relocationSupport === 'yes') reasons.push('Relocation support mentioned.');

  return { component: { score: Math.round(score), weight: WEIGHTS.location, reasons }, blockers };
}

function scoreLanguage(profile: CandidateProfile, required: string[]): { component: ScoreComponent; blockers: string[] } {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const spoken = new Map(profile.languages.map((l) => [l.language.toLowerCase(), l]));

  if (required.length === 0) {
    reasons.push('No language requirement stated. English is the usual default in European tech roles.');
    return { component: { score: 80, weight: WEIGHTS.language, reasons }, blockers };
  }

  const met = required.filter((lang) => spoken.has(lang.toLowerCase()));
  const unmet = required.filter((lang) => !spoken.has(lang.toLowerCase()));

  if (unmet.length === 0) {
    reasons.push(`Requires ${required.join(', ')} — all covered by the profile.`);
    return { component: { score: 100, weight: WEIGHTS.language, reasons }, blockers };
  }

  // ANY unmet required language is a blocker, not a deduction.
  //
  // The earlier version only blocked when English was also unmet, reasoning
  // that an English-speaking candidate could still get by. A real posting
  // disproved that: "Du kommunizierst sicher auf Deutsch und Englisch (mind.
  // C1)" requires BOTH at C1, and the job scored 81% and was recommended to a
  // candidate who speaks no German. The AI summary caught it and said SKIP.
  //
  // Detection only fires on genuine requirement sentences, so "German is a
  // plus" does not reach here. Given that, an unmet requirement means rejection,
  // and saying so is more useful than a slightly lower score.
  const englishMet = met.some((l) => l.toLowerCase() === 'english');
  const score = englishMet ? 45 : 20;
  reasons.push(`Requires ${unmet.join(', ')}, which the profile does not list.`);
  blockers.push(
    `Requires ${unmet.join(', ')}, which the candidate does not speak.` +
      (englishMet ? ' English is also required and is covered, but both are stated as requirements.' : '')
  );

  return { component: { score, weight: WEIGHTS.language, reasons }, blockers };
}

function scoreAiTools(profile: CandidateProfile, job: NormalisedJob): ScoreComponent {
  const reasons: string[] = [];
  const asked = extractSkills(job.description).filter((s) => lookup(s)?.category === 'ai');
  const held = profile.skills.filter((s) => lookup(s.canonical)?.category === 'ai');

  if (asked.length === 0) {
    reasons.push('The posting does not mention AI tooling.');
    // Neutral, not zero: not asking for it is not a mark against the candidate.
    return { score: 70, weight: WEIGHTS.aiTools, reasons };
  }

  const heldKeys = new Set(held.map((s) => s.canonical));
  const hardAi = asked.filter((s) => NEVER_FROM_AI_TOOLING.has(s));
  const toolingAi = asked.filter((s) => !NEVER_FROM_AI_TOOLING.has(s));

  const toolingMet = toolingAi.filter((s) => heldKeys.has(s));
  const hardMet = hardAi.filter((s) => heldKeys.has(s));

  let score = 50;
  if (toolingAi.length > 0) {
    score = Math.round((toolingMet.length / toolingAi.length) * 100);
    reasons.push(`Mentions ${toolingAi.map(display).join(', ')}; profile evidences ${toolingMet.length} of ${toolingAi.length}.`);
  }
  if (hardAi.length > 0 && hardMet.length < hardAi.length) {
    // Stated plainly rather than buried, because this is exactly the boundary
    // the spec insists must not be blurred.
    score = Math.min(score, 30);
    reasons.push(
      `Asks for ${hardAi.filter((s) => !heldKeys.has(s)).map(display).join(', ')} — genuine ML/data-science work, which AI-tool experience does not substitute for.`
    );
  }
  return { score, weight: WEIGHTS.aiTools, reasons };
}

export interface ScoreOptions {
  preferredCountries: string[];
  /** Overrides the parsed requirements, e.g. after a human correction. */
  requirementsOverride?: { required: string[]; preferred: string[] };
}

export function scoreJob(profile: CandidateProfile, job: NormalisedJob, options: ScoreOptions): MatchResult {
  const parsed = options.requirementsOverride ?? extractRequirements(job);

  // The employer's wording, keyed by canonical, so every verdict can carry the
  // term the posting actually used. Scanned over the whole description rather
  // than the required/preferred split: the split decides how much a requirement
  // counts, not how it is spelled.
  const spellings = new Map(
    extractSkillMentions(`${job.title}
${job.description}`).map((m) => [m.canonical, m.surface])
  );
  const surfacesFor = (canonical: string) => spellings.get(canonical) ?? [];

  const requiredVerdicts = parsed.required.map((r) => judge(r, profile.skills, surfacesFor(r)));
  const preferredVerdicts = parsed.preferred.map((r) => judge(r, profile.skills, surfacesFor(r)));
  const relevance = assessRelevance(job.title, parsed.required);

  const minYears = detectMinYearsFromJob(job);
  const educationRequired = detectEducationFromJob(job);

  const technical = scoreTechnical(requiredVerdicts, preferredVerdicts, job.descriptionComplete);
  const experience = scoreExperience(profile.totalYears, minYears);
  const education = scoreEducation(profile, educationRequired);
  const locationScored = scoreLocation(profile, job, options.preferredCountries);
  const languageScored = scoreLanguage(profile, job.languages);
  const aiTools = scoreAiTools(profile, job);

  const components = {
    technical,
    experience,
    education,
    location: locationScored.component,
    language: languageScored.component,
    aiTools,
  };

  let overall = Math.round(
    Object.values(components).reduce((sum, c) => sum + c.score * c.weight, 0) /
      Object.values(components).reduce((sum, c) => sum + c.weight, 0)
  );

  const blockers = [...locationScored.blockers, ...languageScored.blockers];

  // An out-of-scope posting is capped hard rather than nudged. Incidental
  // keyword overlap must never let a non-engineering role outrank a real one,
  // and the spec's priority is a short list of genuinely suitable jobs (§22).
  if (relevance.outOfScope) {
    overall = Math.min(overall, 30);
    blockers.push(...relevance.reasons);
  } else if (relevance.discipline === 'adjacent') {
    overall = Math.round(overall * 0.92);
  } else if (relevance.discipline === 'unclear') {
    overall = Math.round(overall * 0.85);
  }

  // A blocker caps the recommendation however good the technical fit is: a
  // perfect Oracle match that cannot sponsor a visa is not "highly recommended"
  // for someone who needs sponsorship.
  let recommendation: MatchResult['recommendation'];
  if (relevance.outOfScope) {
    recommendation = 'low';
  } else if (blockers.length > 0) {
    recommendation = overall >= 70 ? 'possible' : 'low';
  } else if (overall >= 80) {
    recommendation = 'highly_recommended';
  } else if (overall >= 60) {
    recommendation = 'possible';
  } else {
    recommendation = 'low';
  }

  const confidence: MatchResult['confidence'] = job.descriptionComplete
    ? { level: 'high', reason: null }
    : {
        level: 'low',
        reason:
          'The source provides only a 500-character extract of this posting. Skills it does not mention may still be required.',
      };

  return {
    overall,
    components,
    confidence,
    strongMatches: requiredVerdicts.filter((v) => v.weight === 1).map((v) => v.display),
    partialMatches: requiredVerdicts.filter((v) => v.weight > 0 && v.weight < 1).map((v) => v.display),
    // Only claimed as a gap when the whole posting was actually read. From a
    // snippet, "not mentioned" is not "not required".
    missingSkills: job.descriptionComplete
      ? requiredVerdicts.filter((v) => v.weight === 0).map((v) => v.display)
      : [],
    recommendation,
    blockers,
    relevance,
    requirements: {
      required: requiredVerdicts,
      preferred: preferredVerdicts,
      minYears,
      education: educationRequired,
      languages: job.languages,
    },
  };
}

// Imported lazily to keep this module's dependency direction one-way.
import { detectEducation, detectMinYears } from '../jobs/parse.ts';
const detectMinYearsFromJob = (job: NormalisedJob) => detectMinYears(job.description);
const detectEducationFromJob = (job: NormalisedJob) => detectEducation(job.description);

export { canonicalise };
