import type { SkillVerdict } from '../match/score.ts';
import type { CandidateProfile } from './profile.ts';
import { display } from '../match/taxonomy.ts';

/**
 * Vocabulary mirroring, and the questions that have to be asked before it.
 *
 * This module answers one question per requirement in a posting: **may the
 * employer's own word appear on this candidate's resume?**
 *
 * It exists because of a measurable failure. A posting asking for "RMAN"
 * resolved, correctly, to a skill the candidate genuinely holds -- production
 * Oracle backup and recovery -- and the resume then printed the words "Backup &
 * Recovery". An applicant tracking system searching for the literal string
 * "RMAN" scored that as a miss, and a recruiter spending ten seconds on the page
 * saw nothing that looked like the advert. Real experience, invisible.
 *
 * The fix is not to write "RMAN" anyway. RMAN is a specific tool, and owning a
 * backup strategy does not prove you drove that tool. The fix is three-way:
 *
 *   mirror   the profile holds exactly this thing under a different name, so
 *            the employer's spelling is simply the better label for a fact we
 *            already have. Print theirs.
 *   confirm  the profile holds something adjacent -- close enough that the
 *            candidate may well have done the specific thing and never wrote it
 *            down. Do NOT print it. Ask them, and if they answer with evidence,
 *            it becomes a real profile skill and mirrors from then on.
 *   gap      nothing in the profile supports it. It never reaches the document.
 *            It is worth showing the candidate as something to learn, and worth
 *            being honest about in a cover letter, and that is all.
 *
 * The middle case is the whole point. It converts "the resume is missing
 * keywords" from a temptation to invent into a one-time data-entry task whose
 * answers are the candidate's own words, and which pays off on every future
 * application rather than just this one.
 */

export type MirrorKind = 'mirror' | 'confirm' | 'gap';

export interface MirrorEntry {
  kind: MirrorKind;
  /** Canonical requirement key, e.g. `oracle-rman`. */
  requirement: string;
  /** Our label for it, e.g. "Oracle RMAN". */
  display: string;
  /** The employer's spelling that should be used, when one may be used. */
  term: string | null;
  /** Every spelling the posting used, for keyword auditing of the output. */
  surface: string[];
  /** The profile skill this leans on, if any. */
  heldSkill: string | null;
  heldEvidence: string | null;
  /** 1 = the same thing, 0 < w < 1 = adjacent, 0 = nothing. */
  weight: number;
  /** Shown to the candidate when kind is 'confirm'. */
  question: string | null;
}

export interface MirrorPlan {
  /** Employer terms the document may use, because the profile supports them. */
  mirror: MirrorEntry[];
  /** Questions to put to the candidate. Nothing here may reach the document. */
  confirm: MirrorEntry[];
  /** Unsupported by anything in the profile. */
  gaps: MirrorEntry[];
  /** Every literal token an ATS is likely to search this resume for. */
  keywords: string[];
}

/**
 * A surface term that pins a version or release the profile cannot support.
 *
 * "Oracle 19c" is an alias of the same canonical as "Oracle", so it would
 * otherwise qualify to be mirrored -- and printing it would assert a specific
 * release the candidate may never have run. Mirroring may relabel a fact; it may
 * not sharpen one.
 */
function addsUnsupportedSpecificity(term: string, evidence: string | null): boolean {
  const version = term.match(/\b\d{1,2}\s?[a-z]?\b/i);
  if (!version) return false;
  const found = version[0].toLowerCase().trim();
  return !(evidence ?? '').toLowerCase().includes(found);
}

/** Pick the employer spelling to print: the most specific one we may use. */
function chooseTerm(verdict: SkillVerdict, evidence: string | null): string | null {
  const usable = verdict.surface.filter((s) => !addsUnsupportedSpecificity(s, evidence));
  return usable[0] ?? null;
}

export function buildMirrorPlan(
  required: SkillVerdict[],
  preferred: SkillVerdict[],
  profile: CandidateProfile
): MirrorPlan {
  const plan: MirrorPlan = { mirror: [], confirm: [], gaps: [], keywords: [] };

  // Required first, then preferred: this order is what the candidate is asked
  // in, and a must-have deserves the question before a nice-to-have does.
  const all = [...required, ...preferred];
  const seen = new Set<string>();

  for (const verdict of all) {
    if (seen.has(verdict.requirement)) continue;
    seen.add(verdict.requirement);

    const base = {
      requirement: verdict.requirement,
      display: verdict.display || display(verdict.requirement),
      surface: verdict.surface,
      heldSkill: verdict.satisfiedBy,
      heldEvidence: verdict.evidence,
      weight: verdict.weight,
    };

    if (verdict.weight >= 1 && verdict.satisfiedBy) {
      const term = chooseTerm(verdict, verdict.evidence);
      plan.mirror.push({ ...base, kind: 'mirror', term, question: null });
      plan.keywords.push(...verdict.surface);
      continue;
    }

    if (verdict.weight > 0 && verdict.satisfiedBy) {
      const asked = verdict.surface[0] ?? base.display;
      plan.confirm.push({
        ...base,
        kind: 'confirm',
        term: null,
        question:
          `This posting asks for ${asked}. Your profile records "${verdict.satisfiedBy}"` +
          (verdict.evidence ? ` (${verdict.evidence})` : '') +
          `. Did you work with ${asked} itself? If yes, say where, and it goes on every ` +
          `resume from now on. If no, leave it blank and it stays off the document.`,
      });
      continue;
    }

    plan.gaps.push({ ...base, kind: 'gap', term: null, question: null });
  }

  void profile;

  plan.keywords = [...new Set(plan.keywords)];
  return plan;
}

/** The mirror map as the model should see it: one line per permitted relabel. */
export function mirrorBriefing(plan: MirrorPlan): string {
  if (!plan.mirror.length) return "  none - use the profile's own wording throughout.";

  return plan.mirror
    .map((entry) => {
      const term = entry.term ?? entry.display;
      return (
        `  - The posting says "${term}". The profile holds this as "${entry.heldSkill}". ` +
        `Write "${term}" (their word) because it names the same thing. Evidence: ${entry.heldEvidence}`
      );
    })
    .join('\n');
}

/** The terms that must NOT appear, stated explicitly so the model cannot drift. */
export function forbiddenBriefing(plan: MirrorPlan): string {
  const banned = [...plan.confirm, ...plan.gaps];
  if (!banned.length) return '  none.';

  return banned
    .map((entry) => {
      const term = entry.surface[0] ?? entry.display;
      return entry.kind === 'confirm'
        ? `  - "${term}" - NOT confirmed by the candidate. The nearest thing they have is ` +
            `"${entry.heldSkill}", which you may state as itself. You may not call it ${term}.`
        : `  - "${term}" - nothing in the profile supports this. It appears nowhere in the document.`;
    })
    .join('\n');
}
