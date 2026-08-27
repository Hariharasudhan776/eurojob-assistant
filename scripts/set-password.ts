/**
 * Give an account a password.
 *
 *   npm run user:password -- you@example.com "a long passphrase"
 *
 * Two uses:
 *
 *  1. **Adopting the pre-auth row.** Before sign-in existed, the CLI created a
 *    user whose password_hash was the literal string 'local-only'. That row owns
 *    the profile, matches, applications and documents from that era. Setting a
 *    password turns it into a real account and keeps all of it -- the
 *    alternative would be abandoning the history behind an account nobody can
 *    sign in to.
 *  2. **A forgotten password**, on an instance with no email delivery. There is
 *    no reset flow built (see the README), so this is the honest substitute:
 *    whoever administers the server can set one.
 *
 * The hash is bcrypt, the same as the signup route. The plaintext is never
 * stored anywhere.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { getPool } from '../src/lib/db/pool.ts';
import { findUserByEmail, setUserPassword } from '../src/lib/db/repo.ts';

const MIN_LENGTH = 10;

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error('usage: npm run user:password -- <email> "<password>"');
    process.exit(1);
  }
  if (password.length < MIN_LENGTH) {
    console.error(`the password must be at least ${MIN_LENGTH} characters`);
    process.exit(1);
  }

  const user = await findUserByEmail(email);
  if (!user) {
    console.error(`no account with that email. Accounts are created by signing up in the app, or by npm run db:migrate.`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const ok = await setUserPassword(email, hash);
  console.log(ok ? `password set for ${user.email} (id ${user.id}). You can sign in now.` : 'nothing was updated');

  await getPool().end();
}

main().catch((err) => {
  console.error('failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
