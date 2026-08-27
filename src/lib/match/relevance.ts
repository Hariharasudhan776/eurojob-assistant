import { lookup } from './taxonomy.ts';
import type { SkillCategory } from '../resume/profile.ts';

/**
 * Role relevance: is this posting even the kind of job the profile is for?
 *
 * This module exists because of a real failure. Without it, a "Junior Community
 * Manager / Social Media" posting scored 89% and ranked as HIGHLY RECOMMENDED:
 * the description happened to mention "reporting", the profile has reporting
 * experience, so skill coverage came out at 1 of 1 = 100%.
 *
 * Two independent mistakes produced that, and both are fixed here and in
 * scoreTechnical:
 *
 *  1. Coverage ratios are unreliable on thin evidence. One matched skill out of
 *     one is not stronger evidence than seven out of ten -- it is *less*
 *     evidence. Handled by shrinkage in score.ts.
 *
 *  2. Matching a `domain` skill alone says nothing about whether the role is
 *     technical. "Reporting" and "inventory" appear in warehouse-supervisor and
 *     marketing postings. A software role has to require at least one skill from
 *     a genuinely technical category.
 *
 * Spec §22 asks for quality over quantity: a smaller list of genuinely suitable
 * roles. Filtering these out is most of that.
 */

/** Categories that indicate actual engineering work, not just familiarity with a business area. */
const TECHNICAL_CATEGORIES: ReadonlySet<SkillCategory> = new Set<SkillCategory>([
  'language',
  'database',
  'database_admin',
  'framework',
  'erp',
]);

/** Title words that mark a technical individual-contributor role. */
const TECHNICAL_TITLE = [
  'developer', 'entwickler', 'engineer', 'ingenieur', 'programmer', 'programmierer',
  'architect', 'architekt', 'dba', 'database', 'datenbank', 'sql', 'oracle', 'plsql',
  'backend', 'back-end', 'fullstack', 'full-stack', 'software', 'data engineer',
  'etl', 'integration', 'devops', 'sre', 'platform', 'systems', 'informatiker',
];

/** Technical-adjacent: real possibilities, but not a straight development role. */
const ADJACENT_TITLE = [
  'consultant', 'berater', 'analyst', 'specialist', 'spezialist', 'administrator',
  'support engineer', 'technical', 'technisch', 'erp', 'bi ', 'business intelligence',
  'application', 'anwendung', 'it-', 'it ', 'qa ', 'tester', 'automation',
];

/**
 * Titles that are definitively not this profile's work. Matching one of these
 * caps the recommendation regardless of incidental keyword overlap.
 */
const NON_TECHNICAL_TITLE = [
  // people / commercial
  'community manager', 'social media', 'marketing', 'brand', 'sales', 'vertrieb',
  'account manager', 'account executive', 'recruiter', 'recruiting', 'talent',
  'human resources', 'personal', 'hr ', 'customer success', 'customer service',
  'kundenberater', 'kundenservice', 'event', 'public relations', 'content creator',
  'copywriter', 'redakteur', 'texter', 'influencer', 'partnerships',
  // creative
  'video editor', 'cutter', 'graphic designer', 'grafik', 'photographer', 'fotograf',
  'illustrator', 'motion designer', 'art director', 'ux designer', 'ui designer',
  // operations / trades / care
  'driver', 'fahrer', 'warehouse worker', 'lagerhelfer', 'produktionshelfer',
  'nurse', 'pflege', 'arzt', 'teacher', 'lehrer', 'erzieher', 'koch', 'chef de',
  'kellner', 'reinigung', 'security', 'wachmann', 'monteur', 'elektriker',
  'mechaniker', 'schlosser', 'verkäufer', 'verkaeufer', 'kassierer', 'friseur',
  'physiotherap', 'apotheker', 'steuerberater', 'buchhalter', 'accountant',
  // leadership roles that are not IC engineering
  'chief product', 'head of product', 'product manager', 'produktmanager',
  'teamlead product', 'experience manager', 'office manager', 'projektleiter bau',
  'werkstudent marketing', 'praktikum marketing',
];

export type Discipline = 'technical' | 'adjacent' | 'non_technical' | 'unclear';

export interface RelevanceVerdict {
  discipline: Discipline;
  /** Required skills that fall in a genuinely technical category. */
  technicalRequirements: string[];
  /** True when the posting cannot reasonably be this profile's role. */
  outOfScope: boolean;
  reasons: string[];
}

export function classifyTitle(title: string): Discipline {
  const t = ` ${title.toLowerCase().replace(/\(m\/w\/d\)|\(all genders\)|\*in|:in|\(d\/f\/m\)/g, ' ').replace(/\s+/g, ' ')} `;

  // Non-technical is checked first and wins: "Product Manager - SQL knowledge a
  // plus" is still not a developer role, and a positive keyword should not
  // rescue it.
  if (NON_TECHNICAL_TITLE.some((needle) => t.includes(needle))) return 'non_technical';
  if (TECHNICAL_TITLE.some((needle) => t.includes(needle))) return 'technical';
  if (ADJACENT_TITLE.some((needle) => t.includes(needle))) return 'adjacent';
  return 'unclear';
}

export function assessRelevance(title: string, requiredSkills: string[]): RelevanceVerdict {
  const reasons: string[] = [];
  const discipline = classifyTitle(title);

  const technicalRequirements = requiredSkills.filter((s) => {
    const category = lookup(s)?.category;
    return category !== undefined && TECHNICAL_CATEGORIES.has(category);
  });

  if (discipline === 'non_technical') {
    reasons.push(`The title "${title}" is not a software or database role, whatever keywords the description happens to contain.`);
    return { discipline, technicalRequirements, outOfScope: true, reasons };
  }

  if (technicalRequirements.length === 0) {
    reasons.push(
      'The posting names no programming language, database, framework, or ERP platform among its requirements, so there is nothing to assess an engineering fit against.'
    );
    return { discipline, technicalRequirements, outOfScope: true, reasons };
  }

  if (discipline === 'unclear') {
    reasons.push(`The title "${title}" does not clearly indicate a technical role, but the requirements do name technology.`);
  }
  if (discipline === 'adjacent') {
    reasons.push('Technical-adjacent role (consultant, analyst, or administrator) rather than a pure development post.');
  }
  return { discipline, technicalRequirements, outOfScope: false, reasons };
}

/**
 * Shrink a coverage ratio toward a neutral prior when it rests on few
 * observations.
 *
 * With `k` pseudo-observations at `prior`, one matched requirement out of one
 * lands near the prior instead of at 100%, while eight out of ten stays close to
 * its true ratio. This is what stops a posting that mentions a single
 * recognisable skill from outranking a genuine, detailed match.
 */
export function shrinkRatio(earned: number, total: number, k = 3, prior = 0.45): number {
  if (total <= 0) return prior;
  return (earned + k * prior) / (total + k);
}

/**
 * Roles whose entry requirement is a status the candidate cannot hold.
 *
 * A "Product Engineer — Working Student" posting scored 82% and came back
 * HIGHLY RECOMMENDED for a candidate with 5.2 years who needs visa sponsorship.
 * Every component was right on its own terms: the discipline is technical, the
 * four recognised skills all matched, no minimum experience was stated so
 * experience scored a neutral 75. The disqualifying requirement -- "you are
 * currently enrolled at a university" -- was invisible, and it was sitting in
 * the job title the whole time.
 *
 * This is the same shape of failure as the "Junior Community Manager" case that
 * `classifyTitle` exists to catch. That one filters the wrong DISCIPLINE; this
 * one filters the wrong ELIGIBILITY, and neither is expressible as a score
 * because no amount of technical fit makes a candidate a student again.
 *
 * It is judged against the profile rather than absolutely, because the app has
 * several users. A working-student post is exactly right for someone with no
 * professional experience yet, so it is only a blocker for a profile that has
 * clearly moved past it.
 *
 * Deliberately NOT included: "junior", "entry level", "graduate" on its own. A
 * junior role is a real, if unambitious, option -- it is a worse match, not an
 * impossible one, and the score already handles that. "Graduate" alone is
 * excluded because it far more often describes a degree than a scheme.
 */
const STUDENT_STATUS_TITLE = [
  /\bworking\s+student\b/i,
  /\bwerkstudent(?:in)?\b/i,
  /\bstudent\s+(?:assistant|worker|helper)\b/i,
  /\bstudentische[rn]?\s+hilfskraft\b/i,
  /\bintern(?:ship)?\b/i,
  /\bpraktik(?:um|ant(?:in)?)\b/i,
  /\bstagiaire\b/i,
  /\bapprentice(?:ship)?\b/i,
  /\b(?:azubi|ausbildung|lehrling)\b/i,
  /\bdual(?:es)?\s+(?:study|studium)\b/i,
  /\btrainee\b/i,
  /\bgraduate\s+(?:programme?|scheme|trainee)\b/i,
  /\bplacement\s+year\b/i,
];

/** Confirming phrases in the body, for postings with a plain title. */
const STUDENT_STATUS_BODY = [
  /\b(?:currently|must be|are|be)\s+enrolled\s+(?:at|in|as)\b/i,
  /\benrolled\s+(?:at|in)\s+a\s+(?:university|college|hochschule)\b/i,
  /\bstudent\s+status\b/i,
  /\bimmatrikuliert\b/i,
  /\bvalid\s+(?:university\s+)?enrolment\b/i,
];

/** Past this many years, a student or trainee post is no longer a fit. */
const OUTGROWN_AFTER_YEARS = 2;

export function detectStudentOnlyRole(
  title: string,
  description: string,
  profileYears: number
): string | null {
  if (profileYears < OUTGROWN_AFTER_YEARS) return null;

  const inTitle = STUDENT_STATUS_TITLE.some((re) => re.test(title));
  const inBody = STUDENT_STATUS_BODY.some((re) => re.test(description));
  if (!inTitle && !inBody) return null;

  const where = inTitle ? `The title "${title}" is` : 'The posting describes';
  return (
    `${where} a student, trainee or apprentice position, which requires a status ` +
    `the profile no longer has after ${profileYears} years of professional work. ` +
    'No amount of technical fit makes this applicable.'
  );
}
