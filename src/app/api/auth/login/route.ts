import { NextResponse } from 'next/server';
import { LoginCredentials, isPasswordlessLegacyHash, startSession, verifyPassword } from '@/lib/auth';
import { findUserByEmail, touchLogin } from '@/lib/db/repo';

export const runtime = 'nodejs';

/**
 * Sign in.
 *
 * A wrong email and a wrong password give the same answer, because telling an
 * attacker which one was right hands them a list of registered addresses. The
 * one exception is the pre-auth 'local-only' row: that account genuinely has no
 * password, and saying "wrong password" would be a lie that sends the owner
 * looking for a password that never existed.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Validated as a lookup, not as a new claim -- see LoginCredentials. Reporting
  // the actual issue matters here: "Enter your email and password" while both
  // were filled in is the most useless error a login form can give.
  const credentials = LoginCredentials.safeParse(body);
  if (!credentials.success) {
    return NextResponse.json(
      { error: credentials.error.issues.map((i) => i.message).join(' ') },
      { status: 400 }
    );
  }

  const user = await findUserByEmail(credentials.data.email);

  if (user && isPasswordlessLegacyHash(user.password_hash)) {
    return NextResponse.json(
      {
        error:
          'That account was created by the command line before sign-in existed, so it has no password yet. ' +
          'Set one with: npm run user:password -- ' + user.email + ' "your-password"',
      },
      { status: 409 }
    );
  }

  const ok = user ? await verifyPassword(credentials.data.password, user.password_hash) : false;
  if (!user || !ok) {
    return NextResponse.json({ error: 'That email and password do not match an account.' }, { status: 401 });
  }

  // Approval gate. The password was correct, but a new account cannot sign in
  // until an admin reviews it. Checked only after the password so this does not
  // reveal whether an address exists.
  if (user.status === 'pending') {
    return NextResponse.json(
      { error: 'Your account is still awaiting review by Hari. You will be able to sign in once it is approved.' },
      { status: 403 }
    );
  }
  if (user.status === 'rejected') {
    return NextResponse.json({ error: 'This account was not approved for access.' }, { status: 403 });
  }

  await startSession(user.id, request.headers.get('user-agent'));
  await touchLogin(user.id);
  return NextResponse.json({ ok: true });
}
