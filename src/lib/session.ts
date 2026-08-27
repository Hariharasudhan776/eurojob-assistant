import { ensureUser } from './db/repo.ts';
import { requireUser } from './auth.ts';

/**
 * Who is using the app.
 *
 * This used to be "whoever APP_USER_EMAIL says", which was a deliberate choice
 * for a single-user tool bound to localhost and a documented blocker on ever
 * deploying it. It is now a real session (src/lib/auth.ts), and this module is
 * the thin seam between the two worlds:
 *
 *  * **Pages** call `currentUserId()`. No session means a redirect to the login
 *    screen, which is the right behaviour for something a person is looking at.
 *  * **API routes** call `requireUserId()` from lib/auth directly, so they can
 *    answer 401 with a message the client can display instead of redirecting an
 *    XHR to an HTML page.
 *  * **CLI scripts** have no cookie at all, so they identify themselves with
 *    APP_USER_EMAIL through `cliUserId()`. That path can create a row but never
 *    a usable password, so it is not a way around signing in.
 */

/** The CLI's identity. Scripts only -- never a request. */
export const cliUserEmail = () => process.env.APP_USER_EMAIL || 'local@eurojob';

let cachedCliId: number | null = null;

export async function cliUserId(): Promise<number> {
  if (cachedCliId !== null) return cachedCliId;
  cachedCliId = await ensureUser(cliUserEmail());
  return cachedCliId;
}

/** For pages: the signed-in user, or a redirect to /login. */
export async function currentUserId(): Promise<number> {
  const user = await requireUser();
  return user.userId;
}

/** Kept for compatibility with the pre-auth CLI scripts. */
export const currentUserEmail = cliUserEmail;
