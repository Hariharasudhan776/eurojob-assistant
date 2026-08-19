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
