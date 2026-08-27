import { NextResponse } from 'next/server';
import { latestProfile, saveProfile } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { CandidateProfile, SkillLevel, SkillCategory } from '@/lib/resume/profile';
import { canonicalise, lookup, display } from '@/lib/match/taxonomy';

export const runtime = 'nodejs';

/**
 * Confirming a skill the profile did not record.
 *
 * This is the honest answer to "the resume is missing the keywords the advert
 * screens for". The tempting answer is to let the generator write them in. That
 * produces a document that fails the first technical screen and, in most of
 * Europe, a document a rejected offer can be withdrawn over -- a resume forms
 * part of the contractual representation.
 *
 * The real cause is almost always duller and entirely fixable: the profile
 * records a skill at the wrong granularity. It says "Backup & recovery" where
 * the industry says RMAN, and "Data migration" where the industry says Data
 * Pump. The experience is genuine; only the vocabulary is missing. So this
 * endpoint asks the one person who knows -- the candidate -- and writes the
 * answer down in their own words.
 *
 * Two rules make this safe rather than a back door:
 *
 *   1. `evidence` is mandatory and must be substantive. It is the same rule the
 *      profile schema has always enforced (§"every skill requires evidence"),
 *      and it is what makes the new skill defensible in an interview.
 *   2. The evidence is the CANDIDATE'S text. Nothing here is generated. This
 *      endpoint cannot invent a justification, only record one.
 *
 * A confirmation writes a new profile version rather than editing the current
 * one, because profiles are append-only here and a document already generated
 * must keep pointing at the profile it was generated from.
 */

/** Short or evasive evidence defeats the point, so it is refused up front. */
const MIN_EVIDENCE = 25;

export async function POST(request: Request) {
  let body: { requirement?: unknown; name?: unknown; evidence?: unknown; level?: unknown; years?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const requirement = String(body.requirement ?? '').trim();
  const evidence = String(body.evidence ?? '').trim();
  const rawName = String(body.name ?? '').trim();

  if (!requirement) {
    return NextResponse.json({ error: 'requirement is required' }, { status: 400 });
  }
  if (evidence.length < MIN_EVIDENCE) {
    return NextResponse.json(
      {
        error:
          `Say where you did this, in at least ${MIN_EVIDENCE} characters. ` +
          'Which employer, which system, roughly when. This line is what goes on the resume ' +
          'behind the skill, and it is what you will be asked about in the interview.',
      },
      { status: 400 }
    );
  }

  const levelParsed = SkillLevel.safeParse(body.level);
  if (!levelParsed.success) {
    return NextResponse.json(
      { error: 'level must be one of: expert, strong, working, familiar' },
      { status: 400 }
    );
  }

  try {
    const userId = await requireUserId();
    const current = await latestProfile(userId);
    if (!current) {
      return NextResponse.json({ error: 'You have no profile yet. Upload one from My Profile.' }, { status: 400 });
    }

    // The canonical key comes from the taxonomy, never from the request. A
    // client that could choose its own key could file a skill under whatever
    // requirement it wanted it to satisfy.
    const canonical = canonicalise(requirement) ?? requirement.toLowerCase();
    const entry = lookup(canonical);
    const name = rawName || display(canonical);
    const category = entry?.category ?? SkillCategory.parse('tool');

    if (current.data.skills.some((s) => s.canonical === canonical)) {
      return NextResponse.json(
        { error: `"${name}" is already in your profile.`, alreadyPresent: true },
        { status: 409 }
      );
    }

    const years =
      typeof body.years === 'number' && Number.isFinite(body.years) && body.years >= 0 && body.years <= 50
        ? body.years
        : null;

    const next: CandidateProfile = CandidateProfile.parse({
      ...current.data,
      version: current.data.version + 1,
      skills: [
        ...current.data.skills,
        {
          name,
          canonical,
          category,
          years,
          level: levelParsed.data,
          // Stamped so a later reader can tell a confirmed skill from one that
          // came off the original resume, and can see when it was added.
          evidence: `${evidence} (confirmed by the candidate, ${new Date().toISOString().slice(0, 10)})`,
        },
      ],
    });

    const profileId = await saveProfile(userId, next);

    return NextResponse.json({
      ok: true,
      profileId,
      version: next.version,
      skill: name,
      // Generation re-scores from the live profile, so the next tailored resume
      // picks this up without a rescore pass over the whole feed. Existing
      // stored match rows stay as they were until the user re-scores.
      note: `"${name}" is now part of your profile and will be used the next time you generate a document.`,
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
