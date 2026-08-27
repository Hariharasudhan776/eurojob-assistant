import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Credentials, LoginCredentials } from '../src/lib/credentials.ts';

/**
 * Signing in and signing up validate different things, and conflating them
 * locked a real account out of the app.
 */

test('signing in accepts an identifier the browser would not call an email', () => {
  // The CLI's own account is `local@eurojob`: no dot, no TLD. It owns the
  // profile and every match, and `.email()` rejected it -- so the owner saw
  // "Enter your email and password" with both correctly filled in.
  const result = LoginCredentials.safeParse({ email: 'local@eurojob', password: 'a long passphrase' });
  assert.equal(result.success, true);
  assert.equal(result.data!.email, 'local@eurojob');
});

test('signing in still requires both fields, and says which is missing', () => {
  const noEmail = LoginCredentials.safeParse({ email: '', password: 'something' });
  assert.equal(noEmail.success, false);
  assert.ok(noEmail.error!.issues[0]!.message.includes('email'));

  const noPassword = LoginCredentials.safeParse({ email: 'a@b.com', password: '' });
  assert.equal(noPassword.success, false);
  assert.ok(noPassword.error!.issues[0]!.message.includes('password'));
});

test('signing in does not re-apply the minimum length', () => {
  // A password that was accepted once has to stay checkable, whatever the
  // current minimum is -- otherwise raising it locks people out silently.
  assert.equal(LoginCredentials.safeParse({ email: 'a@b.com', password: 'short' }).success, true);
});

test('signing UP still demands a real address and a long password', () => {
  // With no password-reset flow, a typo in the address is unrecoverable.
  assert.equal(Credentials.safeParse({ email: 'local@eurojob', password: 'a long passphrase' }).success, false);
  assert.equal(Credentials.safeParse({ email: 'me@example.com', password: 'short' }).success, false);
  assert.equal(Credentials.safeParse({ email: 'ME@Example.com ', password: 'a long passphrase' }).success, true);
});

test('an email is normalised the same way on both paths', () => {
  assert.equal(Credentials.parse({ email: ' ME@Example.COM ', password: 'a long passphrase' }).email, 'me@example.com');
  assert.equal(LoginCredentials.parse({ email: ' Local@EuroJob ', password: 'x' }).email, 'local@eurojob');
});
