import type { CandidateProfile } from './profile.ts';
import type { TailoredResume } from '../ai/schemas.ts';
import type { MirrorPlan } from './mirror.ts';
import type { NormalisedJob } from '../jobs/types.ts';

/**
 * What a senior recruiter sees in the first ten seconds, measured.
 *
 * `ats.ts` runs *before* generation and answers "how well does this profile
 * cover this posting". This runs *after* generation and answers a different,
 * harder question: **did the document we just produced actually do its job?**
 *
 * That distinction is the point. Seven applications were rejected while the
 * pre-flight check said "clear", because the check was grading the profile and
 * nobody was grading the output. A resume can be built from a perfectly matched
 * profile and still be binned in six seconds if the matched terms are phrased in
 * our vocabulary instead of the employer's, buried below the fold, or wrapped in
 * "responsible for".
 *
 * Everything here is deterministic and free. It reads the rendered text, not the
 * model's own account of what it wrote -- `keywordsUsed` is the model's claim,
 * and a claim is exactly the thing this module exists not to trust.
 *
 * The top third is where this is won. A recruiter's first pass covers the
 * headline, the summary and the skills line and very little else, so a keyword
 * present only in a bullet on page two counts for the software and barely counts
 * for the human. Both are reported separately.
 */

export interface AuditCheck {
  label: string;
  pass: boolean;
  /** What was actually found, so a failure says how to fix it. */
  detail: string;
  /** How much of the score this check carries. */
  weight: number;
}

export interface KeywordHit {
  term: string;
  /** Present anywhere in the document -- what an ATS string search sees. */
  present: boolean;
  /** Present in the headline, summary or skills line -- what a person sees. */
  inTopThird: boolean;
  /** Whether this was a must-have or a nice-to-have in the posting. */
  required: boolean;
}

export interface ResumeAudit {
  score: number;
  verdict: 'strong' | 'passable' | 'will_be_binned';
  checks: AuditCheck[];
  keywords: KeywordHit[];
  /** Mirror-map terms that never made it into the document. The costly misses. */
  missedOpportunities: string[];
  /** Confirmable terms still unanswered. Each one is a keyword going spare. */
  unanswered: string[];
}

/** Openings that tell a recruiter the bullet describes duties, not results. */
const WEAK_OPENERS =
  /^(?:responsible for|worked on|helped|assisted|involved in|participated in|tasked with|duties includ)/i;

/**
 * A company's name with its legal form removed.
 *
 * "Northwind Construction Group" and "Northwind Construction Group" are
 * the same employer to every human reader, and prose almost never carries the
 * suffix. Stripping it is what makes the employer check test whether the company
 * was named rather than how formally it was spelled.
 */
function tradingName(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(?:co|corp|corporation|inc|incorporated|ltd|limited|llc|llp|plc|gmbh|ag|bv|nv|sarl|srl|spa|oy|ab|as|pvt|private)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const boundary = (term: string): RegExp => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9+#])${escaped}($|[^a-z0-9+#])`, 'i');
};

export function auditResume(
  profile: CandidateProfile,
  tailored: TailoredResume,
  mirror: MirrorPlan,
  job: NormalisedJob,
  fullText: string
): ResumeAudit {
  const headline = tailored.targetTitle?.trim() || profile.headline;
  const skillLine = [
    ...tailored.skillOrder,
    ...(tailored.skillLabels ?? []).map((p) => p.printAs),
  ].join(', ');
  const topThird = [headline, tailored.summary, skillLine].join('\n');
  const allBullets = tailored.bullets.flatMap((b) => b.bullets);

  // --- keyword coverage of the produced document --------------------------

  const requiredTerms = new Set(
    mirror.mirror.flatMap((e) => (e.term ? [e.term] : e.surface.slice(0, 1)))
  );
  const keywords: KeywordHit[] = [...new Set(mirror.mirror.flatMap((e) => e.surface))].map((term) => ({
    term,
    present: boundary(term).test(fullText),
    inTopThird: boundary(term).test(topThird),
    required: requiredTerms.has(term),
  }));

  const missedOpportunities = mirror.mirror
    .filter((entry) => !entry.surface.some((s) => boundary(s).test(fullText)))
    .map((entry) => entry.term ?? entry.display);

  const covered = keywords.filter((k) => k.present).length;
  const topCovered = keywords.filter((k) => k.inTopThird).length;

  // --- the six-second scan ------------------------------------------------

  const checks: AuditCheck[] = [];

  // 1. Title. The recruiter is matching shapes before reading words.
  const titleWords = job.title
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 3 && !['senior', 'junior', 'lead', 'staff', 'principal'].includes(w));
  const titleOverlap = titleWords.filter((w) => headline.toLowerCase().includes(w));
  checks.push({
    label: 'Headline reads like the advertised role',
    pass: titleWords.length === 0 || titleOverlap.length >= Math.min(2, titleWords.length),
    detail: titleOverlap.length
      ? `"${headline}" shares ${titleOverlap.join(', ')} with "${job.title}".`
      : `"${headline}" shares nothing with "${job.title}". This is the first thing scanned.`,
    weight: 18,
  });

  // 2. The years figure, in the first sentence, where the bar is checked.
  const firstSentence = tailored.summary.split(/(?<=[.!?])\s/)[0] ?? tailored.summary;
  checks.push({
    label: 'Years of experience in the opening sentence',
    pass: /\d+(?:\.\d+)?\s*\+?\s*years?/i.test(firstSentence),
    detail: /\d+(?:\.\d+)?\s*\+?\s*years?/i.test(firstSentence)
      ? firstSentence.slice(0, 120)
      : 'No years figure in the first sentence. A recruiter checking the experience bar has to hunt for it.',
    weight: 10,
  });

  // 3. Current employer named early: it is how seniority is judged at a glance.
  //
  // Matched on the trading name, not the registered one. A summary saying
  // "Northwind Construction Group" names the employer as clearly as one saying
  // "Northwind Construction Group" does, and an exact substring test
  // failed the first while passing the second -- penalising a resume for the one
  // thing nobody writing prose would ever include.
  const current = profile.experience.find((e) => !e.endDate) ?? profile.experience[0];
  const namesEmployer = (company: string): boolean => {
    const trading = tradingName(company);
    return trading.length > 0 && tailored.summary.toLowerCase().includes(trading);
  };
  checks.push({
    label: 'Current employer named in the summary',
    pass: !current || namesEmployer(current.company),
    detail: current
      ? namesEmployer(current.company)
        ? `${current.company} appears in the summary.`
        : `${current.company} is not in the summary.`
      : 'No experience recorded.',
    weight: 8,
  });

  // 4. The employer's own words, high on the page. The expensive one.
  const topThirdTarget = Math.min(5, keywords.length);
  checks.push({
    label: "Employer's own terms visible in the top third",
    pass: keywords.length === 0 || topCovered >= topThirdTarget,
    detail: `${topCovered} of ${keywords.length} matched terms appear in the headline, summary or skills line` +
      (topThirdTarget ? ` (target ${topThirdTarget}).` : '.'),
    weight: 22,
  });

  // 5. Total ATS coverage of the document.
  checks.push({
    label: 'Matched terms present anywhere in the document',
    pass: keywords.length === 0 || covered / keywords.length >= 0.8,
    detail: `${covered} of ${keywords.length} matched terms appear in the resume text.`,
    weight: 14,
  });

  // 6. Numbers. The profile has them; a tailoring pass can quietly drop them.
  const withNumbers = allBullets.filter((b) => /\d/.test(b)).length;
  checks.push({
    label: 'Quantified bullets',
    pass: allBullets.length === 0 || withNumbers >= Math.min(3, allBullets.length),
    detail: `${withNumbers} of ${allBullets.length} bullets contain a figure.`,
    weight: 12,
  });

  // 7. Duty language. "Responsible for" is the phrase that reads as filler.
  const weak = allBullets.filter((b) => WEAK_OPENERS.test(b.trim()));
  checks.push({
    label: 'No duty-list openers',
    pass: weak.length === 0,
    detail: weak.length ? `${weak.length} bullet(s) open with duty language: "${weak[0]?.slice(0, 60)}..."` : 'Every bullet opens with an action.',
    weight: 8,
  });

  // 8. Length. Past two pages the second page is not read at all.
  checks.push({
    label: 'Scannable length',
    pass: allBullets.length <= 24,
    detail: `${allBullets.length} bullets across ${tailored.bullets.length} roles.`,
    weight: 8,
  });

  const earned = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);
  const total = checks.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((earned / total) * 100);

  const verdict: ResumeAudit['verdict'] = score >= 85 ? 'strong' : score >= 65 ? 'passable' : 'will_be_binned';

  return {
    score,
    verdict,
    checks,
    keywords,
    missedOpportunities,
    unanswered: mirror.confirm.map((entry) => entry.surface[0] ?? entry.display),
  };
}
