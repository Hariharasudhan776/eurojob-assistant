import { NextResponse } from 'next/server';
import { getAiProvider, latestProfile } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { aiRuntime } from '@/lib/ai/runtime';
import { AiClient } from '@/lib/ai/client';
import { BudgetExceededError } from '@/lib/ai/budget';
import { findExperience, templateEvidence } from '@/lib/resume/evidence';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Turn the candidate's bare fact into the evidence sentence the confirm flow
 * saves. The division of labour is fixed: the candidate supplies the fact and
 * picks the employer, the model only phrases it. Nothing is saved here -- the
 * sentence goes back to the form, where the candidate can still edit every word
 * before /api/skills/confirm writes it to a profile version.
 *
 * The employer must be one of the profile's own experience entries. A free-text
 * company would let a typo (or an invention) attach evidence to a workplace the
 * resume never mentions.
 */
export async function POST(request: Request) {
  let body: { term?: unknown; company?: unknown; fact?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const term = String(body.term ?? '').trim();
  const company = String(body.company ?? '').trim();
  const fact = String(body.fact ?? '').trim();

  if (!term) return NextResponse.json({ error: 'term is required' }, { status: 400 });
  if (!company) return NextResponse.json({ error: 'Pick the employer where you used it.' }, { status: 400 });
  if (fact.length < 10) {
    return NextResponse.json(
      { error: 'Say in a few words what you actually did with it — that is the one part only you can supply.' },
      { status: 400 }
    );
  }

  try {
    const userId = await requireUserId();
    const [profile, provider] = await Promise.all([latestProfile(userId), getAiProvider(userId)]);
    if (!profile) {
      return NextResponse.json({ error: 'You have no profile yet. Upload one from My Profile.' }, { status: 400 });
    }

    const role = findExperience(profile.data.experience, company);
    if (!role) {
      return NextResponse.json({ error: `"${company}" is not an employer in your profile.` }, { status: 400 });
    }

    // No key for this account's provider? The template still answers -- the flow
    // must not dead-end on a missing key when a mechanical sentence will do.
    const chosen = (provider === 'gemini' ? 'gemini' : 'claude') as 'gemini' | 'claude';
    if (!AiClient.isConfigured(chosen)) {
      return NextResponse.json({
        ok: true,
        aiWritten: false,
        evidence: templateEvidence({ term, company: role.company, startDate: role.startDate, endDate: role.endDate, fact }),
      });
    }

    const { services, guard } = await aiRuntime(userId, profile.data, chosen);
    const result = await services.draftSkillEvidence({ term, company, fact });
    // Durable before responding; a frozen function must not lose a charge.
    await guard.flush();

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof BudgetExceededError) {
      return NextResponse.json({ error: err.message, scope: err.scope }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
