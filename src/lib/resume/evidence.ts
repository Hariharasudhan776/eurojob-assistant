import * as z from 'zod/v4';
import type { Experience } from './profile.ts';

/**
 * Drafting an evidence line from the candidate's own fact.
 *
 * The confirm flow's rule has always been that the sentence behind a skill is
 * the candidate's, so they can defend it in an interview. What this module
 * changes is WHO does the typing, not WHOSE facts they are: the candidate picks
 * the employer and states the bare fact ("nightly backups of the production
 * database"), and the model's only job is to phrase that as one clean resume
 * line. It is a typist, not a witness.
 *
 * What it must never do is invent the scenario. A generated "configured RMAN
 * nightly backups with a 4-hour RPO" that never happened fails the first
 * follow-up question in an interview, and in most of Europe a resume is a
 * contractual representation. So the prompt forbids additions -- and because a
 * prompt is a request rather than a guarantee, `groundEvidence` checks the
 * output in code: the sentence must name the term and the employer, and may not
 * contain a single digit that the candidate (or the profile's dates) did not
 * supply. Numbers are where invented specifics live.
 */

export const EvidenceDraft = z.object({
  /** One sentence, starting with the employer's name. */
  evidence: z.string().min(30).max(300),
});
export type EvidenceDraft = z.infer<typeof EvidenceDraft>;

export const EVIDENCE_SYSTEM = `You turn a candidate's short statement about using a skill at work into ONE polished resume evidence line, in English.

Hard rules -- these protect the candidate from a resume they cannot defend:
- Use ONLY the facts given to you: the candidate's statement, the employer, the role title, and the dates. Nothing else exists.
- NEVER add numbers, frequencies, scale, team sizes, outcomes, systems, versions, or technologies the candidate did not state. If their statement is thin, the sentence stays thin -- that is correct, not a failure.
- Do not upgrade the claim: "used" stays "used", it does not become "led", "architected", or "owned" unless the candidate said so.
- Start the sentence with the employer's name, then a colon.
- Name the skill term exactly as given.
- One sentence, roughly 15-35 words. Fix grammar and phrasing; keep the meaning identical.`;

export function evidencePrompt(input: {
  term: string;
  company: string;
  title: string;
  startDate: string;
  endDate: string | null;
  fact: string;
}): string {
  const period = `${input.startDate} to ${input.endDate ?? 'present'}`;
  return [
    `Skill term (use it verbatim): ${input.term}`,
    `Employer: ${input.company}`,
    `Role there: ${input.title} (${period})`,
    `The candidate's own statement of what they did with it:`,
    `"""${input.fact}"""`,
    '',
    'Write the one-sentence evidence line.',
  ].join('\n');
}

/**
 * The in-code guarantee behind the prompt. Returns the reasons a drafted
 * sentence cannot be trusted; an empty array means it passed.
 */
export function groundEvidence(
  evidence: string,
  input: { term: string; company: string; fact: string; allowedText?: string[] }
): string[] {
  const problems: string[] = [];
  const lower = evidence.toLowerCase();

  if (!lower.includes(input.term.toLowerCase())) {
    problems.push(`the sentence does not name "${input.term}"`);
  }
  if (!lower.includes(input.company.toLowerCase())) {
    problems.push(`the sentence does not name ${input.company}`);
  }

  // Every digit-run in the output must exist somewhere in the inputs. This is
  // the check that catches "600+ users" appearing out of thin air.
  const allowed = [input.fact, input.company, input.term, ...(input.allowedText ?? [])].join(' ');
  for (const digits of evidence.match(/\d+/g) ?? []) {
    if (!allowed.includes(digits)) {
      problems.push(`"${digits}" is a number the candidate did not state`);
    }
  }
  return problems;
}

/**
 * The no-model fallback: mechanical, therefore incapable of invention. Used
 * when the AI draft fails `groundEvidence` or the AI is unavailable, so the
 * flow never dead-ends.
 */
export function templateEvidence(input: {
  term: string;
  company: string;
  startDate: string;
  endDate: string | null;
  fact: string;
}): string {
  const period = `${input.startDate.slice(0, 4)}–${input.endDate ? input.endDate.slice(0, 4) : 'present'}`;
  const fact = input.fact.trim().replace(/[.\s]+$/, '');
  return `${input.company} (${period}): used ${input.term} — ${fact}.`;
}

/** The experience entry the candidate pointed at, matched case-insensitively. */
export function findExperience(experience: Experience[], company: string): Experience | null {
  const needle = company.trim().toLowerCase();
  return experience.find((e) => e.company.trim().toLowerCase() === needle) ?? null;
}
