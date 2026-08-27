import type { CandidateProfile } from '../resume/profile.ts';

/**
 * ATS clearance report.
 *
 * A deterministic, free pre-flight check shown before a resume is tailored, so
 * the applicant knows two things up front: (1) the document this app produces is
 * machine-parseable, and (2) how well their profile already covers the keywords
 * this specific posting screens for. No AI, no cost — it reads the score
 * breakdown that already exists on the match.
 */

export interface AtsCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface AtsReport {
  score: number; // 0–100 overall ATS readiness
  verdict: 'clear' | 'review';
  coverage: { covered: string[]; transferable: string[]; missing: string[]; percent: number };
  format: AtsCheck[];
  contact: AtsCheck[];
}

interface Requirement {
  display: string;
  satisfiedBy: string | null;
  weight: number;
}

export function atsReport(
  required: Requirement[],
  profile: CandidateProfile,
  descriptionComplete: boolean
): AtsReport {
  const covered = required.filter((r) => r.satisfiedBy && r.weight >= 1).map((r) => r.display);
  const transferable = required.filter((r) => r.satisfiedBy && r.weight > 0 && r.weight < 1).map((r) => r.display);
  const missing = required.filter((r) => !r.satisfiedBy).map((r) => r.display);

  const total = required.length;
  // A transferable match counts as a half — an ATS keyword filter may or may not
  // credit it, so it should not score the same as an exact hit.
  const matched = covered.length + 0.5 * transferable.length;
  const percent = total ? Math.round((matched / total) * 100) : 100;

  // Format safety is guaranteed by how render.ts builds the file, so these are
  // stated facts about the output, not guesses about an uploaded document.
  const format: AtsCheck[] = [
    { label: 'Single-column layout', pass: true, detail: 'No tables or columns for a parser to scramble.' },
    { label: 'No images, text boxes, headers or footers', pass: true, detail: 'Everything is real, selectable text.' },
    { label: 'Standard section headings', pass: true, detail: 'Summary · Skills · Experience · Education — the ones ATS map.' },
    { label: 'Standard font & .docx format', pass: true, detail: 'Calibri in Word .docx: the most parseable combination.' },
  ];

  const contact: AtsCheck[] = [
    { label: 'Email present', pass: Boolean(profile.email), detail: profile.email || 'missing' },
    { label: 'Phone present', pass: Boolean(profile.phone), detail: profile.phone || 'missing' },
    { label: 'LinkedIn present', pass: Boolean(profile.links.linkedin), detail: profile.links.linkedin || 'missing' },
  ];
  const contactOk = contact.every((c) => c.pass);

  // Format is always sound, so it contributes a fixed share; the rest is keyword
  // coverage and contact completeness.
  const score = Math.min(100, Math.round(35 + 0.5 * percent + (contactOk ? 15 : 9)));

  // A truncated posting (an extract-only source) cannot be judged fairly on
  // keywords, so it is not failed on coverage alone.
  const verdict: 'clear' | 'review' = (percent >= 55 || !descriptionComplete) && contactOk ? 'clear' : 'review';

  return { score, verdict, coverage: { covered, transferable, missing, percent }, format, contact };
}
