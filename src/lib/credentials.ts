import { z } from 'zod';

/**
 * What counts as a valid email/password pair.
 *
 * Kept in its own module because `auth.ts` imports `next/headers` for the cookie
 * jar, which only resolves inside the Next.js bundler -- so anything that pulls
 * in auth.ts cannot be unit-tested with plain `node --test`. Validation is pure
 * logic and deserves tests, so it lives here and auth.ts re-exports it.
 */

/** Minimum that is not security theatre. NIST-style: length over character classes. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Signing UP demands a real email address: it is the only way to identify an
 * account later, and with no password-reset flow a typo is unrecoverable.
 */
export const Credentials = z.object({
  email: z.string().trim().toLowerCase().email('That does not look like an email address.'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(200, 'That password is longer than bcrypt can use.'),
});
export type Credentials = z.infer<typeof Credentials>;

/**
 * Signing IN validates far less, deliberately.
 *
 * At sign-in the email is a lookup key, not a new claim, and re-checking its
 * format only creates ways to lock out an account that already exists. It locked
 * out a real one: the CLI's own identity is `local@eurojob` -- no dot, no TLD, so
 * `.email()` rejected it -- and the owner of the profile could not sign in, while
 * being told "Enter your email and password" with both correctly filled in.
 *
 * The same argument applies to length: a password that was accepted once must
 * stay checkable, whatever the current minimum happens to be.
 */
export const LoginCredentials = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter your email.'),
  password: z.string().min(1, 'Enter your password.').max(200),
});
export type LoginCredentials = z.infer<typeof LoginCredentials>;
