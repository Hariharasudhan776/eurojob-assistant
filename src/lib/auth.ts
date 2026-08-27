import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Credentials, LoginCredentials, MIN_PASSWORD_LENGTH } from './credentials.ts';
import { readSessionToken, SESSION_COOKIE, sessionSecret } from './auth-edge.ts';
import { createSessionRow, findUserByEmail, liveSession, revokeSessionRow } from './db/repo.ts';

/**
 * Real authentication.
 *
 * The app began as a single-user tool bound to localhost, where `APP_USER_EMAIL`
 * decided who you were. That was documented as the thing to fix before any
 * public deployment, and this is that fix: several people can now use one
 * instance, and each sees only their own profile, scores, documents, and spend.
 *
 * Two layers, on purpose:
 *
 *  1. **A signed cookie** (JWT, HS256, SESSION_SECRET). Tampering with it fails
 *     signature verification, and it can be checked in middleware at the edge
 *     without a database round trip.
 *  2. **A session row in the database.** The signature proves the cookie was
 *     issued by this app; only the row proves the session is still valid. Sign
 *     out, expiry, and revocation all have to be server-side facts, otherwise a
 *     stolen cookie is valid until its own `exp` and nothing can stop it.
 *
 * Sign-out **revokes** rather than deletes: `revoked_at` is set and the row
 * stays. Session history is an audit trail, and deleting rows to express "this
 * ended" throws away the answer to "when did this end".
 */

const COOKIE_NAME = SESSION_COOKIE;
const SESSION_DAYS = 30;

export interface SessionUser {
  userId: number;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

/**
 * The signing key comes from auth-edge.ts, so middleware and the app cannot
 * disagree about it. A missing secret is fatal in production rather than quietly
 * defaulted: a predictable key means anyone can mint a session cookie for any
 * account, which is worse than the app refusing to start. In development a fixed
 * dev key is used and announced once, so `npm run dev` works out of the box.
 */
function secretKey(): Uint8Array {
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV !== 'production' && !warnedAboutSecret) {
    console.warn('[auth] SESSION_SECRET not set; using the development key. Set one before deploying.');
    warnedAboutSecret = true;
  }
  return sessionSecret();
}
let warnedAboutSecret = false;

export async function hashPassword(plain: string): Promise<string> {
  // 12 rounds: roughly 250ms on this hardware. Slow enough to matter against an
  // offline attack, fast enough that a login does not feel broken.
  return bcrypt.hash(plain, 12);
}

/**
 * Check a password.
 *
 * The pre-auth single-user row carries the literal string 'local-only' as its
 * hash, which bcrypt cannot verify against anything. It is rejected with a
 * pointer rather than a bare failure, because "wrong password" would be a lie:
 * that account has no password yet.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash || hash === 'local-only') return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export const isPasswordlessLegacyHash = (hash: string): boolean => hash === 'local-only';

async function signToken(sessionId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());
}

/** Returns the session id carried by a cookie, or null if it is not ours. */
export const readToken = readSessionToken;

/** Create a session row and set the cookie. */
export async function startSession(userId: number, userAgent?: string | null): Promise<void> {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  const sessionId = await createSessionRow(userId, expiresAt, userAgent ?? null);
  const token = await signToken(sessionId, expiresAt);

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set on HTTPS deployments only, so local http development still works.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

/** Revoke the current session server-side, then clear the cookie. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    const sessionId = await readToken(token);
    if (sessionId) await revokeSessionRow(sessionId);
  }
  jar.set(COOKIE_NAME, '', { httpOnly: true, path: '/', maxAge: 0 });
}

/**
 * Who is making this request, or null.
 *
 * Both checks have to pass: a valid signature AND a live, unrevoked, unexpired
 * row. Everything user-facing goes through this or through requireUser().
 */
export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const sessionId = await readToken(token);
  if (!sessionId) return null;

  const session = await liveSession(sessionId);
  if (!session) return null;
  return { userId: session.user_id, email: session.email, displayName: session.display_name, isAdmin: session.is_admin };
}

/** For pages: no session means the login screen, not an error. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

/** For admin pages: a non-admin (or anonymous) visitor is bounced home. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.isAdmin) redirect('/');
  return user;
}

/** For admin API routes: 401 when anonymous, 403 when signed in but not admin. */
export async function requireAdminId(): Promise<number> {
  const user = await currentUser();
  if (!user) throw new UnauthenticatedError();
  if (!user.isAdmin) throw new ForbiddenError();
  return user.userId;
}

export class ForbiddenError extends Error {
  constructor() {
    super('Admins only.');
    this.name = 'ForbiddenError';
  }
}

/** For API routes: no session means 401, and the caller decides what to say. */
export async function requireUserId(): Promise<number> {
  const user = await currentUser();
  if (!user) throw new UnauthenticatedError();
  return user.userId;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Sign in to continue.');
    this.name = 'UnauthenticatedError';
  }
}

export { COOKIE_NAME as SESSION_COOKIE, findUserByEmail };
// Re-exported so callers have one import for everything auth-related, while the
// pure validation stays unit-testable on its own.
export { Credentials, LoginCredentials, MIN_PASSWORD_LENGTH };
