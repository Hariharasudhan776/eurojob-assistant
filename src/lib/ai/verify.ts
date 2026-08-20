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

/**
 * Is the clause hypothetical rather than assertive?
 *
 * A real cover letter said: "If cloud and NoSQL are day-one requirements rather
 * than things to pick up, I am a partial match and you should weigh that."
 * Nothing there claims cloud or NoSQL experience -- it is the candidate telling
 * the employer to weigh a gap. The first verifier read it as two fabricated
 * claims, which would have blocked one of the most honest sentences in the
 * letter.
 */
export function isHypotheticalContext(clause: string): boolean {
  const t = clause.toLowerCase();
  return (
    /^\s*if\b/.test(t) ||
    /\bif\s+\w+\s+(?:and|are|is|were|was)\b/.test(t) ||
    /\brather than\b|\bwhether\b|\bin case\b|\bshould you\b|\bassuming\b/.test(t) ||
    /\bpick(?:ing)? up\b|\bpartial match\b|\bday[- ]one\b|\bwilling to learn\b/.test(t) ||
    /\bweigh (?:that|this)\b|\bup to you\b|\byou should\b/.test(t)
  );
}

/**
 * Is the clause describing what the EMPLOYER wants, rather than what the
 * candidate has?
 *
 * "NoSQL databases: the posting lists 'familiarity with NoSQL solutions' as a
 * requirement" mentions a technology while attributing it entirely to the job
 * advert. Nothing is being claimed on the candidate's behalf, so flagging it
 * reports the app for correctly quoting the employer.
 *
 * This is a third category, distinct from negation and from hypotheticals: the
 * subject of the sentence is the posting, not the person.
 */
export function isAboutTheEmployer(clause: string): boolean {
  const t = clause.toLowerCase();
  return (
    /\b(?:the\s+)?(?:posting|advert|advertisement|listing|role|job|employer|company|team|they)\s+(?:explicitly\s+)?(?:lists?|requires?|asks?|states?|mentions?|wants?|specifies|expects?|covers?|includes?|needs?)\b/.test(t) ||
    /\b(?:is|are)\s+(?:a\s+|an\s+)?(?:stated\s+|explicit\s+|hard\s+)?(?:requirement|required|listed|stated|mentioned|essential|mandatory|expected|preferred|desirable)\b/.test(t) ||
    /\b(?:listed|stated|mentioned|described|flagged)\s+as\b/.test(t) ||
    /\brequirements?\s+(?:include|includes|are|is|list)\b/.test(t) ||
    /\basks?\s+for\b|\blooking for\b|\bwould like\b/.test(t)
  );
}

/**
 * Names from the profile that must not be read as skills: employers,
 * institutions, and project names. Longest first, so a longer company name is
 * masked before a shorter substring of it.
 */
function collectProperNouns(profile: CandidateProfile): string[] {
  const names = new Set<string>();
  for (const role of profile.experience) names.add(role.company);
  for (const education of profile.education) names.add(education.institution);
  for (const project of profile.projects) names.add(project.name);
  names.add(profile.name);
  return [...names].filter((n) => n.trim().length > 2).sort((a, b) => b.length - a.length);
}

function maskProperNouns(text: string, properNouns: string[]): string {
  let masked = text;
  for (const name of properNouns) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    masked = masked.replace(new RegExp(escaped, 'gi'), ' NAME ');
  }
  return masked;
}

/**
 * Split into clauses, so a negation in one does not excuse a claim in another.
 *
 * Colons and semicolons are NOT split points, and that distinction was learned
 * the hard way. Splitting on ':' severed a label from its own explanation in
 * "Cloud platforms (AWS/GCP): the role requires this; your profile shows none."
 * — leaving a fragment that names a technology with no negation in it, and
 * raising six blocking violations against text that was entirely honest.
 *
 * A colon or semicolon continues a thought; only a sentence end or a
 * contrastive conjunction changes who is being described.
 */
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|\s+(?:but|while|whereas|although|though|however)\s+/i)
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

export interface VerifyOptions {
  /**
   * Canonical skill keys the deterministic matcher already classified as
   * TRANSFERABLE for this job (e.g. MySQL satisfied partially by PostgreSQL).
   *
   * Without this, the verifier blocks the AI for faithfully reporting what the
   * matcher decided. A real run flagged "MySQL" in a sentence explaining that
   * the candidate's PostgreSQL depth partially covers a MySQL requirement --
   * which is true, useful, and exactly what the summary is for. These are
   * downgraded to warnings so a human still sees the framing, rather than
   * blocked outright.
   */
  transferable?: string[];
}

export function verifyClaims(
  profile: CandidateProfile,
  texts: string[],
  options: VerifyOptions = {}
): VerificationResult {
  const violations: Violation[] = [];
  const verifiedSkills = new Set<string>();
  const acknowledgedGaps = new Set<string>();

  const evidenced = new Set(profile.skills.map((s) => s.canonical));
  const transferable = new Set(options.transferable ?? []);
  const properNouns = collectProperNouns(profile);

  for (const text of texts) {
    if (!text) continue;

    // 1. Technologies asserted as the candidate's that the profile cannot evidence.
    for (const clause of clauses(text)) {
      // Three ways a technology can appear without being claimed: denied,
      // hypothetical, or attributed to the employer.
      const notAClaim =
        isNegatedContext(clause) || isHypotheticalContext(clause) || isAboutTheEmployer(clause);
      // Proper nouns are masked first. "Meridian" is one of this candidate's
      // actual employers, and the taxonomy's `agile` alias matched inside the
      // company name -- so every honest sentence saying where he worked was
      // reported as a fabricated Scrum claim.
      for (const mentioned of extractSkills(maskProperNouns(clause, properNouns))) {
        if (evidenced.has(mentioned)) {
          verifiedSkills.add(mentioned);
          continue;
        }
        if (notAClaim) {
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

        if (transferable.has(mentioned)) {
          violations.push({
            severity: 'warning',
            kind: 'unevidenced_skill',
            detail: `"${display(mentioned)}" is discussed as a transferable match. Check it is framed as adjacent experience, not as direct experience.`,
            offendingText: excerpt(clause, display(mentioned)),
          });
          continue;
        }

        violations.push({
          severity: isTechnical ? 'blocking' : 'warning',
          kind: 'unevidenced_skill',
          detail: `"${display(mentioned)}" is presented as the candidate's but there is no evidence for it in the profile.`,
          // Centred on the mention, not the start of the clause: a long clause
          // truncated from the front hides the very words being reported.
          offendingText: excerpt(clause, display(mentioned)),
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


/** A window around `needle`, so a violation always shows the words it is about. */
function excerpt(text: string, needle: string, radius = 90): string {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}...` : text;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + needle.length + radius);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}
