import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findExperience, groundEvidence, templateEvidence } from '../src/lib/resume/evidence.ts';
import type { Experience } from '../src/lib/resume/profile.ts';

/**
 * The confirm flow lets a model phrase the candidate's fact -- and these tests
 * are the reason that is safe rather than a fabrication back door. The model is
 * a typist: `groundEvidence` is the in-code check that it named the right skill
 * at the right employer and added no specific the candidate did not state.
 * Numbers are where invented specifics live ("600+ users", "15 databases"), so
 * every digit in the output must be traceable to an input.
 */

const base = { term: 'RMAN', company: 'Northwind', fact: 'nightly backups of the production Oracle database' };

test('a faithful sentence passes', () => {
  const ok = groundEvidence('Northwind: used RMAN for nightly backups of the production Oracle database.', base);
  assert.deepEqual(ok, []);
});

test('an invented number is caught', () => {
  const problems = groundEvidence('Northwind: used RMAN for nightly backups across 15 production databases.', base);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /"15"/);
});

test('a number the candidate DID state is allowed', () => {
  const problems = groundEvidence('Northwind: used RMAN for backups of 5 Oracle instances.', {
    ...base,
    fact: 'backups of 5 oracle instances',
  });
  assert.deepEqual(problems, []);
});

test('dates from the profile are allowed as numbers', () => {
  const problems = groundEvidence('Northwind: used RMAN for nightly backups since 2021.', {
    ...base,
    allowedText: ['2021-04'],
  });
  assert.deepEqual(problems, []);
});

test('dropping the term or the employer is caught', () => {
  assert.equal(groundEvidence('Northwind: ran nightly database backups.', base).length, 1);
  assert.equal(groundEvidence('Used RMAN for nightly database backups.', base).length, 1);
});

test('the template fallback is mechanical and complete', () => {
  const line = templateEvidence({
    term: 'RMAN',
    company: 'Northwind',
    startDate: '2021-04',
    endDate: null,
    fact: 'nightly backups of the production Oracle database.',
  });
  assert.equal(line, 'Northwind (2021–present): used RMAN — nightly backups of the production Oracle database.');
  // The template's own output must pass the same guard the AI is held to.
  assert.deepEqual(groundEvidence(line, { ...base, allowedText: ['2021-04'] }), []);
});

test('the employer must be one the profile records', () => {
  const experience = [
    { company: 'Northwind', title: 'Software Developer' },
    { company: 'RetailForge', title: 'Software Engineer' },
  ] as Experience[];
  assert.equal(findExperience(experience, 'Northwind')?.title, 'Software Developer');
  assert.equal(findExperience(experience, 'Google'), null);
});
