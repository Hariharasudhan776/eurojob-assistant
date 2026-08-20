import type { CandidateProfile } from '../resume/profile.ts';
import { extractSkills, display, lookup } from '../match/taxonomy.ts';

/**
 * Post-generation verification.
 *
 * A prompt saying "do not invent anything" is a request, not a guarantee. This
 * module is the guarantee: it re-reads whatever the model produced and checks
 * every claim against the profile. Anything the candidate cannot evidence is
 * reported, and the caller refuses to ship the document.
 *
 * THE HARD PART IS NOT DETECTION, IT IS NEGATION.
 *
 * The first version of this file flagged "No NoSQL experience of any kind is
 * recorded" as a fabricated MongoDB claim, and "15+ years of transactional
 * data" as fifteen years of experience. Both were honest sentences. A verifier
 * that fires on honest text is worse than none, because a wall of false
 * positives trains you to click past the real one. So mentions are only counted
 * as claims when their surrounding clause actually asserts them.
 *
 * What this can and cannot catch, stated plainly:
 *   CAN  -- a named technology asserted as the candidate's, absent from the profile.
 *   CAN  -- a years-of-experience figure above what the dates support.
 *   CAN  -- a rewritten bullet whose cited source is not in the profile.
 *   CAN  -- an assertion about work authorisation.
 *   CANNOT -- a subtle exaggeration of scope in prose ("led" vs "contributed
 *             to"). That needs a human read, which is why the UI shows the diff.
 */

export interface Violation {
  severity: 'blocking' | 'warning';
  kind: 'unevidenced_skill' | 'inflated_experience' | 'untraceable_text' | 'authorisation_claim';
  detail: string;
  offendingText: string;
}

export interface VerificationResult {
  ok: boolean;
  violations: Violation[];
  /** Skills that appear in the output and ARE evidenced. Useful for display. */
  verifiedSkills: string[];
  /** Skills correctly discussed as gaps. Counted so honesty is visible, not punished. */
  acknowledgedGaps: string[];
}

/** Phrases that assert a work-authorisation status the app must never claim. */
const AUTHORISATION_CLAIMS = [
  /\b(?:i\s+(?:have|hold)|holding|holds)\s+(?:a\s+)?(?:valid\s+)?(?:eu|european|schengen|german|dutch)\s+(?:work\s+)?(?:permit|visa|authorisation|authorization)\b/i,
  /\b(?:i\s+am|i'm)\s+(?:an?\s+)?(?:eu|european)\s+(?:citizen|national)\b/i,
  /\bright\s+to\s+work\s+in\s+(?:the\s+)?(?:eu|europe)\b/i,
  /\bno\s+visa\s+(?:required|needed)\b/i,
  /\bauthorised\s+to\s+work\s+in\s+(?:the\s+)?(?:eu|europe)\b/i,
];

/**
 * Does this clause deny, rather than assert, whatever it mentions?
 *
 * Deliberately generous. The cost of missing a negation is a false alarm on
 * honest text, which erodes trust in every other finding; the cost of being
 * generous is that a genuinely dishonest sentence built around a negation word
 * slips through to the human review the UI already requires.
 */
export function isNegatedContext(clause: string): boolean {
  const t = clause.toLowerCase();
  return (
    /\b(?:no|not|never|none|neither|nor|without|lacks?|lacking|missing|absent|zero)\b/.test(t) ||
    /\b(?:do|does|did|is|are|was|were|has|have|had|can|could|would)(?:n't|\s+not)\b/.test(t) ||
    /\b(?:gap|gaps|shortfall|weakness|weaknesses|limitation|limitations)\b/.test(t) ||
    /\b(?:unfamiliar|inexperienced|no evidence|not evidenced|not recorded|not in the profile)\b/.test(t) ||
    /\b(?:would need|will need|needs? to learn|before applying|upskill|learning)\b/.test(t) ||
    /\b(?:if asked|be honest|acknowledge|admit|expect questions)\b/.test(t)
  );
}

/** Split into clauses, so a negation in one does not excuse a claim in another. */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+|\s+(?:but|while|whereas|although|though|however)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Years mentions that are genuinely about the candidate's experience.
 *
 * "15+ years of historical cost data" is a fact about a dataset, not a career.
 * Only phrasings that attach the figure to experience are considered.
 */
function experienceYearClaims(text: string): { value: number; text: string }[] {
  const claims: { value: number; text: string }[] = [];
  const pattern =
    /(\d{1,2})\s*(?:\+|plus)?\s*years?(?:'|’s)?\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|commercial\s+|proven\s+|solid\s+|industry\s+)?(experience|expertise|career|background|in\s+(?:oracle|sql|database|software|development|it))/gi;

  for (const match of text.matchAll(pattern)) {
    // Exclude figures describing data rather than a career.
    const window = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 40).toLowerCase();
    if (/\b(?:data|records?|history|historical|transactions?|rows?|archive)\b/.test(window)) continue;
    claims.push({ value: Number(match[1]), text: match[0] });
  }
  return claims;
}

export function verifyClaims(profile: CandidateProfile, texts: string[]): VerificationResult {
  const violations: Violation[] = [];
  const verifiedSkills = new Set<string>();
  const acknowledgedGaps = new Set<string>();

  const evidenced = new Set(profile.skills.map((s) => s.canonical));

  for (const text of texts) {
    if (!text) continue;

    // 1. Technologies asserted as the candidate's that the profile cannot evidence.
    for (const clause of clauses(text)) {
      const negated = isNegatedContext(clause);
      for (const mentioned of extractSkills(clause)) {
        if (evidenced.has(mentioned)) {
          verifiedSkills.add(mentioned);
          continue;
        }
        if (negated) {
          // Being told plainly what the candidate lacks is the desired
          // behaviour, so it is recorded rather than flagged.
          acknowledgedGaps.add(mentioned);
          continue;
        }

        // The split is concrete-and-checkable versus fuzzy.
        //
        // Anything an interviewer can test -- a language, a database, a
        // framework, an ERP, a tool such as Docker or Kubernetes, an operating
        // system -- blocks, because being caught claiming it is the harm this
        // whole module exists to prevent. ('tool' was missing from this list
        // originally, which let a fabricated Kubernetes claim through as a mere
        // warning.)
        //
        // Domain and soft-skill words stay warnings: "reporting", "inventory"
        // and "finance" appear incidentally in ordinary prose, and blocking on
        // them would bury the real findings.
        const category = lookup(mentioned)?.category;
        const isTechnical = category !== undefined && category !== 'domain' && category !== 'soft';

        violations.push({
          severity: isTechnical ? 'blocking' : 'warning',
          kind: 'unevidenced_skill',
          detail: `"${display(mentioned)}" is presented as the candidate's but there is no evidence for it in the profile.`,
          offendingText: clause.length > 200 ? `${clause.slice(0, 200)}...` : clause,
        });
      }
    }

    // 2. Work-authorisation assertions.
    for (const pattern of AUTHORISATION_CLAIMS) {
      const match = pattern.exec(text);
      if (match) {
        violations.push({
          severity: 'blocking',
          kind: 'authorisation_claim',
          detail: "The text asserts a work-authorisation status. This application never claims that on the candidate's behalf.",
          offendingText: match[0],
        });
      }
    }

    // 3. Years of experience above what the dates support.
    const ceiling = Math.ceil(profile.totalYears);
    for (const claim of experienceYearClaims(text)) {
      if (claim.value > ceiling) {
        violations.push({
          severity: 'blocking',
          kind: 'inflated_experience',
          detail: `Claims ${claim.value} years of experience, but the profile supports ${profile.totalYears}.`,
          offendingText: claim.text,
        });
      }
    }
  }

  return {
    ok: violations.every((v) => v.severity !== 'blocking'),
    violations,
    verifiedSkills: [...verifiedSkills].map(display),
    acknowledgedGaps: [...acknowledgedGaps].map(display),
  };
}

/**
 * Every rewritten bullet must trace back to something the candidate wrote.
 *
 * Matching is on significant-word overlap rather than substring containment: a
 * legitimate rewrite reorders and tightens a bullet, so it shares most of its
 * vocabulary with the original without either string containing the other.
 */
export function verifyProvenance(
  profile: CandidateProfile,
  provenance: { rewritten: string; original: string }[]
): Violation[] {
  const sources: string[] = [];
  for (const role of profile.experience) sources.push(...role.bullets);
  for (const project of profile.projects) sources.push(project.summary);
  sources.push(profile.summary);
  sources.push(profile.headline);

  const sourceTokens = sources.map((s) => ({ text: s, tokens: tokenSet(s) }));

  const violations: Violation[] = [];
  for (const entry of provenance) {
    const claimed = tokenSet(entry.original);
    if (claimed.size === 0) continue;

    const best = sourceTokens.reduce(
      (acc, source) => {
        const shared = [...claimed].filter((t) => source.tokens.has(t)).length;
        const overlap = shared / claimed.size;
        return overlap > acc.overlap ? { overlap, text: source.text } : acc;
      },
      { overlap: 0, text: '' }
    );

    // 60% of the cited text's significant words must appear in a real profile
    // entry. Below that, the citation is not pointing at anything.
    if (best.overlap < 0.6) {
      violations.push({
        severity: 'blocking',
        kind: 'untraceable_text',
        detail: `The cited source for this rewritten text does not match anything in the profile (best overlap ${Math.round(best.overlap * 100)}%).`,
        offendingText: entry.rewritten.length > 160 ? `${entry.rewritten.slice(0, 160)}...` : entry.rewritten,
      });
    }
  }
  return violations;
}

/** Significant words only: stopwords carry no evidence of a shared source. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'across', 'their', 'them',
  'was', 'were', 'has', 'have', 'had', 'are', 'not', 'but', 'all', 'any', 'its', 'his',
  'her', 'which', 'when', 'where', 'while', 'they', 'been', 'also', 'over', 'under', 'both',
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9+#/.]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}
