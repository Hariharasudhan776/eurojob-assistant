import { jwtVerify } from 'jose';

/**
 * The half of authentication that must run at the edge.
 *
 * Middleware runs in a runtime with no filesystem, no TCP sockets, and therefore
 * no database client -- importing the main auth module there would pull in `pg`
 * and fail to build. So the cookie name, the signing key, and signature
 * verification live here, and both runtimes import them from one place. Two
 * copies of a cookie name is exactly the kind of duplication that ends with the
 * middleware guarding a cookie the app no longer sets.
 *
 * Signature verification is all the middleware does. It proves the cookie was
 * issued by this app and has not expired; it cannot prove the session is still
 * live, because that is a row in the database. The pages and routes do that
 * second check. Middleware is a fast redirect for the common case, never the
 * security boundary.
 */

export const SESSION_COOKIE = 'eurojob_session';

export function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return new TextEncoder().encode(secret);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters.');
  }
  return new TextEncoder().encode('eurojob-development-only-key-not-for-deployment');
}

/** The session id inside a cookie, or null when the cookie is not ours. */
export async function readSessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { algorithms: ['HS256'] });
    return typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : null;
  } catch {
    return null;
  }
}
