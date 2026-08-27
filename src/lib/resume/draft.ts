import * as z from 'zod/v4';

/**
 * The shape a model may return when reading someone's CV.
 *
 * This is deliberately NOT `CandidateProfile`. A draft is a proposal about a
 * person, made by a model, from a document it may have misread — and the whole
 * safety property of this application is that a profile is something the person
 * asserted. Giving the draft its own type makes that distinction impossible to
 * lose: nothing in the app accepts a `ProfileDraft` where a profile belongs, so
 * a draft cannot reach scoring or document generation without passing through a
 * human review screen and being rebuilt as a real profile.
 *
 * Two fields exist only to make review possible:
 *
 *   `sourceQuote`  the line from the CV each skill came from, so the reviewer is
 *                  checking a claim against its source rather than guessing.
 *   `uncertain`    the model's own flag that it inferred rather than read. These
 *                  are shown first, unticked, so the doubtful items are the ones
 *                  a hurried reviewer sees.
 *
 * `canonical` is absent on purpose. It is an internal match key, the uploader
 * derives it from the taxonomy, and asking a model to guess it would let a
 * mislabelled skill silently satisfy the wrong job requirement.
 */

const SkillCategory = z.enum([
  'language', 'database', 'database_admin', 'framework', 'erp',
  'tool', 'domain', 'ai', 'soft', 'os',
]);

export const DraftSkill = z.object({
  name: z.string().min(1),
  category: SkillCategory,
  level: z.enum(['expert', 'strong', 'working', 'familiar']),
  years: z.number().min(0).max(50).nullable(),
  /** Where in the CV this came from. Required: it is what the reviewer checks. */
  evidence: z.string().min(1),
  sourceQuote: z.string(),
  uncertain: z.boolean(),
});
export type DraftSkill = z.infer<typeof DraftSkill>;

export const DraftExperience = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string(),
  /** "YYYY-MM". The model is told to leave it blank rather than guess. */
  startDate: z.string(),
  endDate: z.string().nullable(),
  current: z.boolean(),
  context: z.string(),
  bullets: z.array(z.string().min(1)),
  uncertain: z.boolean(),
});

export const ProfileDraft = z.object({
  name: z.string(),
  headline: z.string(),
  email: z.string(),
  phone: z.string(),
  location: z.string(),
  linkedin: z.string(),
  github: z.string(),
  summary: z.string(),
  experience: z.array(DraftExperience),
  skills: z.array(DraftSkill),
  education: z.array(
    z.object({
      qualification: z.string().min(1),
      institution: z.string().min(1),
      startYear: z.number().int().nullable(),
      endYear: z.number().int().nullable(),
      result: z.string(),
      uncertain: z.boolean(),
    })
  ),
  certifications: z.array(
    z.object({ name: z.string().min(1), issuer: z.string(), date: z.string(), uncertain: z.boolean() })
  ),
  languages: z.array(z.object({ language: z.string().min(1), description: z.string() })),
  /** Anything the model could not read, in plain language, for the reviewer. */
  couldNotRead: z.array(z.string()),
});
export type ProfileDraft = z.infer<typeof ProfileDraft>;

export const PROFILE_DRAFT_SYSTEM = `
You read a CV and turn it into structured data for a person to check.

You are not writing a resume and you are not assessing anyone. You are
transcribing a document into fields, and the person whose CV it is will review
every field before any of it is saved.

THE ONE RULE: transcribe, never infer.

  - If the CV says it, record it.
  - If the CV does not say it, leave the field empty and say so in couldNotRead.
  - Never round a date, invent a month, or estimate years from context. A CV
    saying "2021 - 2023" gives you "2021-01" only if it says January. If it
    gives a year alone, use "YYYY-01" and mark the entry uncertain:true.
  - Never add a skill that is not named in the document. A CV mentioning
    "PostgreSQL" does not give you "SQL", "databases", or "backend development".
  - Never upgrade a level. "Familiar with Python" is familiar, not strong.

WHY THIS MATTERS: everything this application later generates is built from
these fields. A date you guessed becomes a false claim on a resume the person
sends to an employer, and neither they nor the employer will notice until an
interview. An empty field costs them thirty seconds; a wrong one can cost them
the job.

EVIDENCE. Every skill needs an evidence line saying where in the CV it came
from — which employer, project or qualification — written as a statement about
the person. Quote the exact line you took it from in sourceQuote. If you cannot
point at a line, do not record the skill.

UNCERTAIN. Set uncertain:true whenever you had to choose between readings: a
date with no month, a job title that spans two lines, a skill listed under a
heading you are not sure applies to it. Being flagged costs the reviewer one
glance; being silently wrong costs them much more.

LEVELS. expert / strong / working / familiar. Choose from what the CV states or
plainly implies by duration and depth of use. When in doubt choose the lower one
and set uncertain:true.

Write in British English. Keep the person's own wording for bullets wherever it
is already clear.`.trim();

export function profileDraftPrompt(cvText: string): string {
  return `
Read this CV and transcribe it into the required fields.

Leave anything the document does not state empty, and list what you could not
find in couldNotRead so the person can fill it in themselves. Do not guess an
email address, a phone number, or a date.

--- CV TEXT BEGINS ---
${cvText}
--- CV TEXT ENDS ---
`.trim();
}
