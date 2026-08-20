import { ensureUser } from './db/repo.ts';

/**
 * Who is using the app.
 *
 * This is a single-user personal tool that runs on the owner's own machine, so
 * there is no login: the user is whoever APP_USER_EMAIL says. That is a
 * deliberate, documented choice rather than an oversight -- adding a password
 * form to an app bound to 127.0.0.1 protects nothing.
 *
 * It becomes a real gap the moment this is deployed to a public host. The README
 * says so plainly, and the schema already carries users and sessions tables so
 * real authentication can be added without a migration.
 */
export const currentUserEmail = () => process.env.APP_USER_EMAIL || 'local@eurojob';

let cachedId: number | null = null;

export async function currentUserId(): Promise<number> {
  if (cachedId !== null) return cachedId;
  cachedId = await ensureUser(currentUserEmail());
  return cachedId;
}
