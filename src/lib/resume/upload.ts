import { CandidateProfile } from './profile.ts';
import { totalExperienceYears } from './profile.ts';
import { canonicalise } from '../match/taxonomy.ts';

/**
 * Accepting a profile from a user.
 *
 * The app used to read one hand-maintained JSON file from disk. With several
 * users and no writable disk on the host, the profile has to arrive over HTTP --
 * but the rule that made the file trustworthy has to survive the change:
 *
 *   **Every skill must carry `evidence`.** A skill without one cannot be
 *   constructed, so it cannot be scored against, and no generated document can
 *   cite it. That is the whole no-fabrication mechanism, and it is enforced by
 *   the schema rather than by a convention someone can forget.
 *
 * What this function will fill in, because it is derived rather than claimed:
 *
 *   * `canonical` on a skill -- looked up in the taxonomy from the display name.
 *     A match key is bookkeeping, not a claim about the candidate.
 *   * `totalYears` -- computed from the employment dates, which is how it is
 *     computed everywhere else. A hand-typed figure can drift away from the
 *     dates that are supposed to support it; §"Experience says 5+ years, not
 *     4+ -- the dates support it" only holds if the dates decide.
 *   * `version` -- defaults to 1 for a first upload.
 *
 * What it will NOT do: invent an evidence string, a skill, a date, or a
 * qualification. A profile missing any of those is rejected with the exact path
 * that is missing, so the user can fix it.
 */

export const MAX_UPLOAD_BYTES = 512 * 1024;

export interface UploadResult {
  profile: CandidateProfile | null;
  /** Human-readable problems, in the order they should be fixed. */
  errors: string[];
  /** Fields that were derived rather than supplied. Shown, never hidden. */
  filledIn: string[];
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9+#]+/g, '_').replace(/^_|_$/g, '') || 'skill';

/** Turn a zod issue into something a person can act on. */
function explain(path: string, message: string): string {
  if (/skills\.\d+\.evidence/.test(path)) {
    return `${path}: every skill needs an "evidence" line saying where it comes from (which job, which project). ` +
      'This is what stops a generated resume claiming something you cannot back up, so it cannot be skipped.';
  }
  if (/experience/.test(path) && /startDate|endDate/.test(path)) {
    return `${path}: dates must be "YYYY-MM" (use null for endDate on your current role).`;
  }
  return `${path}: ${message}`;
}

export function parseProfileUpload(text: string, nextVersion = 1): UploadResult {
  const errors: string[] = [];
  const filledIn: string[] = [];

  if (text.length > MAX_UPLOAD_BYTES) {
    return { profile: null, errors: [`That file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB.`], filledIn };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      profile: null,
      errors: [`That is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
      filledIn,
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { profile: null, errors: ['The file must contain a single JSON object describing one profile.'], filledIn };
  }

  const draft = { ...(raw as Record<string, unknown>) };

  if (draft.version === undefined || draft.version === null) {
    draft.version = nextVersion;
    filledIn.push(`version = ${nextVersion}`);
  }

  if (Array.isArray(draft.skills)) {
    draft.skills = draft.skills.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return entry;
      const skill = { ...(entry as Record<string, unknown>) };
      if (!skill.canonical && typeof skill.name === 'string') {
        skill.canonical = canonicalise(skill.name) ?? slug(skill.name);
        filledIn.push(`canonical for "${skill.name}" = ${String(skill.canonical)}`);
      }
      if (skill.years === undefined) skill.years = null;
      return skill;
    });
  }

  // Derived from the dates, always. Supplied values are replaced, not trusted.
  //
  // Only well-formed entries are counted: this runs BEFORE validation, so a
  // half-typed date must not reach the month arithmetic. The badly formed entry
  // is still reported as an error further down -- it is skipped here, not
  // forgiven.
  const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (Array.isArray(draft.experience)) {
    const computed = totalExperienceYears(
      draft.experience.filter((e): e is { startDate: string; endDate: string | null } => {
        const row = e as { startDate?: unknown; endDate?: unknown };
        if (typeof row.startDate !== 'string' || !MONTH.test(row.startDate)) return false;
        return row.endDate === null || row.endDate === undefined || (typeof row.endDate === 'string' && MONTH.test(row.endDate));
      }) as never
    );
    if (Number.isFinite(computed) && computed > 0) {
      if (draft.totalYears !== computed) filledIn.push(`totalYears = ${computed} (computed from your dates)`);
      draft.totalYears = computed;
    } else if (draft.totalYears === undefined) {
      draft.totalYears = 0;
    }
  }

  for (const key of ['projects', 'education', 'certifications', 'languages', 'employmentGaps'] as const) {
    if (draft[key] === undefined) {
      draft[key] = [];
      filledIn.push(`${key} = [] (none given)`);
    }
  }

  const parsed = CandidateProfile.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(explain(issue.path.join('.') || '(root)', issue.message));
    }
    return { profile: null, errors, filledIn };
  }

  return { profile: parsed.data, errors, filledIn };
}
