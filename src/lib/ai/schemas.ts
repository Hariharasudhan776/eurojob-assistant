// The SDK's zodOutputFormat helper is built against Zod v4, which zod@3.25
// ships at the `zod/v4` subpath. The rest of the app stays on the classic
// API; only the schemas handed to the API need to be v4.
import * as z from 'zod/v4';

/**
 * Output schemas for every AI call.
 *
 * These are passed to the API as the response format, so a malformed reply is
 * retried at the tool-call layer rather than crashing a parser here. They are
 * also the contract the verifier checks against: `provenance` and `claimsMade`
 * exist specifically so generated text can be audited, which is what turns the
 * truthfulness rule from a prompt instruction into something enforced in code.
 */

export const MatchSummary = z.object({
  verdict: z.string().min(1),
  strengths: z.array(z.string().min(1)).min(1).max(4),
  concerns: z.array(z.string().min(1)).max(4),
  preparation: z.array(z.string().min(1)).max(3),
  applyPriority: z.enum(['now', 'soon', 'skip']),
});
export type MatchSummary = z.infer<typeof MatchSummary>;

export const TailoredResume = z.object({
  /**
   * The line under the candidate's name. Mirrors the advertised role when the
   * experience supports it -- the first of the four things a recruiter checks in
   * their six-second pass, and previously not tailored at all.
   */
  targetTitle: z.string().min(1),
  summary: z.string().min(1),
  skillOrder: z.array(z.string().min(1)),
  /**
   * Relabels: print the employer's word for a skill the profile holds under a
   * different name. `profileSkill` must exist in the profile, which is what
   * keeps this a relabel rather than an addition -- render.ts drops any pair
   * whose profileSkill it cannot find.
   */
  skillLabels: z.array(
    z.object({
      profileSkill: z.string().min(1),
      printAs: z.string().min(1),
    })
  ),
  bullets: z.array(
    z.object({
      company: z.string().min(1),
      bullets: z.array(z.string().min(1)),
    })
  ),
  projectOrder: z.array(z.string()),
  /** Posting terms the output claims to contain. Audited against the document. */
  keywordsUsed: z.array(z.string()),
  emphasis: z.array(z.string()),
  /** Rewritten text mapped back to the original it came from. Audited. */
  provenance: z.array(
    z.object({
      rewritten: z.string().min(1),
      original: z.string().min(1),
    })
  ),
  omitted: z.array(z.string()),
});
export type TailoredResume = z.infer<typeof TailoredResume>;

export const CoverLetter = z.object({
  greeting: z.string().min(1),
  // The prompt asks for 3-4. The ceiling here is looser on purpose: failing
  // the whole call over one extra paragraph is brittle, and the renderer
  // shows the length to the user anyway.
  paragraphs: z.array(z.string().min(1)).min(2).max(6),
  closing: z.string().min(1),
  subjectLine: z.string().min(1),
  /** Every factual assertion about the candidate, for verification. */
  claimsMade: z.array(z.string().min(1)),
});
export type CoverLetter = z.infer<typeof CoverLetter>;
