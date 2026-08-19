import { z } from 'zod';

/**
 * The candidate profile: the single source of truth for every downstream step.
 *
 * Two rules are enforced by the types themselves rather than by convention:
 *
 *  1. Every skill carries `evidence` -- a quote or reference pointing at where
 *     in the resume it came from. A skill with no evidence cannot be
 *     constructed, which is what stops the resume tailor from quietly adding
 *     a technology because a job description asked for it.
 *
 *  2. `level` is a small enum, not free text, so the matcher can reason about
 *     depth instead of pattern-matching adjectives.
 */

export const SkillLevel = z.enum(['expert', 'strong', 'working', 'familiar']);
export type SkillLevel = z.infer<typeof SkillLevel>;

/** Ordered weakest to strongest, for comparisons. */
export const SKILL_LEVEL_RANK: Record<SkillLevel, number> = {
  familiar: 1,
  working: 2,
  strong: 3,
  expert: 4,
};

export const SkillCategory = z.enum([
  'language',
  'database',
  'database_admin',
  'framework',
  'erp',
  'tool',
  'domain',
  'ai',
  'soft',
  'os',
]);
export type SkillCategory = z.infer<typeof SkillCategory>;

export const Skill = z.object({
  /** As it should appear on a resume. */
  name: z.string().min(1),
  /** Lowercased match key. Populated by the taxonomy, not by hand. */
  canonical: z.string().min(1),
  category: SkillCategory,
  years: z.number().min(0).max(50).nullable(),
  level: SkillLevel,
  /**
   * Where this came from in the resume. Required, deliberately: an unevidenced
   * skill is a fabricated skill.
   */
  evidence: z.string().min(1),
});
export type Skill = z.infer<typeof Skill>;

export const Experience = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  current: z.boolean(),
  context: z.string(),
  bullets: z.array(z.string().min(1)),
  /** Canonical skill keys this role actually evidences. */
  skills: z.array(z.string()),
});
export type Experience = z.infer<typeof Experience>;

export const Project = z.object({
  name: z.string().min(1),
  period: z.string(),
  stack: z.array(z.string()),
  summary: z.string().min(1),
  url: z.string().url().nullable(),
});
export type Project = z.infer<typeof Project>;

export const Education = z.object({
  qualification: z.string().min(1),
  institution: z.string().min(1),
  startYear: z.number().int(),
  endYear: z.number().int(),
  result: z.string().nullable(),
  /** Mapped to the EQF band European employers actually ask for. */
  eqfLevel: z.number().int().min(1).max(8).nullable(),
});
export type Education = z.infer<typeof Education>;

export const Certification = z.object({
  name: z.string().min(1),
  issuer: z.string().min(1),
  date: z.string(),
});
export type Certification = z.infer<typeof Certification>;

export const Language = z.object({
  language: z.string().min(1),
  /** CEFR where it can be stated honestly, else null. */
  cefr: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native']).nullable(),
  description: z.string(),
});
export type Language = z.infer<typeof Language>;

export const CandidateProfile = z.object({
  version: z.number().int().positive(),
  name: z.string().min(1),
  headline: z.string().min(1),
  email: z.string().email(),
  phone: z.string(),
  location: z.string(),
  links: z.object({ linkedin: z.string().nullable(), github: z.string().nullable() }),
  summary: z.string().min(1),
  /**
   * Computed from the experience entries, excluding gaps -- not typed in by
   * hand, so it cannot drift away from the dates it is derived from.
   */
  totalYears: z.number(),
  experience: z.array(Experience).min(1),
  skills: z.array(Skill).min(1),
  projects: z.array(Project),
  education: z.array(Education),
  certifications: z.array(Certification),
  languages: z.array(Language),
  /**
   * Work-authorisation facts. Stated by the user, never guessed -- a wrong
   * answer here wastes applications on both sides.
   */
  workAuthorisation: z.object({
    euCitizen: z.boolean(),
    euWorkPermit: z.boolean(),
    needsSponsorship: z.boolean(),
    currentCountry: z.string(),
    notes: z.string(),
  }),
});
export type CandidateProfile = z.infer<typeof CandidateProfile>;

/**
 * Months of experience across the entries, counting each calendar month once
 * so overlapping roles are not double-counted and gaps are not silently
 * bridged.
 */
export function totalExperienceMonths(experience: Experience[], asOf = new Date()): number {
  const months = new Set<string>();
  for (const role of experience) {
    const [startYear, startMonth] = role.startDate.split('-').map(Number) as [number, number];
    const end = role.endDate
      ? (role.endDate.split('-').map(Number) as [number, number])
      : ([asOf.getUTCFullYear(), asOf.getUTCMonth() + 1] as [number, number]);

    let year = startYear;
    let month = startMonth;
    while (year < end[0] || (year === end[0] && month <= end[1])) {
      months.add(`${year}-${String(month).padStart(2, '0')}`);
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return months.size;
}

export const totalExperienceYears = (experience: Experience[], asOf = new Date()): number =>
  Math.round((totalExperienceMonths(experience, asOf) / 12) * 10) / 10;

/** Gaps of `minMonths` or more between roles, for the profile to surface honestly. */
export function findGaps(experience: Experience[], minMonths = 2): { from: string; to: string; months: number }[] {
  const sorted = [...experience].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const gaps: { from: string; to: string; months: number }[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    if (!current.endDate) continue;

    const [endYear, endMonth] = current.endDate.split('-').map(Number) as [number, number];
    const [startYear, startMonth] = next.startDate.split('-').map(Number) as [number, number];
    const months = (startYear - endYear) * 12 + (startMonth - endMonth) - 1;
    if (months >= minMonths) {
      gaps.push({ from: current.endDate, to: next.startDate, months });
    }
  }
  return gaps;
}
