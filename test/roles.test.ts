import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRole, roleLabel } from '../src/lib/match/roles.ts';

/**
 * The role filter has one job: put a posting in the bucket a person would put
 * it in. These cases are the ones where a naive keyword list gets it wrong.
 */

test('a specialism beats the generic engineering title', () => {
  // "Engineer" appears in all three. The specific claim has to win, or the
  // whole feed collapses into `backend`.
  assert.equal(classifyRole('Senior Database Reliability Engineer'), 'database');
  assert.equal(classifyRole('Data Engineer (m/w/d)'), 'data');
  assert.equal(classifyRole('Site Reliability Engineer'), 'devops');
});

test('separators in a title do not hide the role', () => {
  // PL/SQL, PL-SQL and PL SQL are the same job.
  assert.equal(classifyRole('PL/SQL Developer'), 'database');
  assert.equal(classifyRole('PL-SQL Developer'), 'database');
  assert.equal(classifyRole('Oracle PL SQL Entwickler'), 'database');
  assert.equal(classifyRole('.NET Developer'), 'backend');
  assert.equal(classifyRole('C# Developer'), 'backend');
});

test('German titles are classified, not dropped into other', () => {
  assert.equal(classifyRole('Softwareentwickler Backend (m/w/d)'), 'backend');
  assert.equal(classifyRole('Datenbankadministrator'), 'database');
  assert.equal(classifyRole('Anwendungsentwickler'), 'backend');
  assert.equal(classifyRole('Systemadministrator Linux'), 'devops');
});

test('a non-engineering title is labelled as such, whatever the keywords', () => {
  // The posting that started all of this: it scored 89% because its description
  // mentioned "reporting". A role category must not launder it into a technical
  // bucket either.
  assert.equal(classifyRole('Junior Community Manager / Social Media'), 'non_technical');
  assert.equal(classifyRole('Marketing Manager with SQL knowledge'), 'non_technical');
  assert.equal(classifyRole('Pflegefachkraft'), 'non_technical');
});

test('a product or people role is management, not development', () => {
  assert.equal(classifyRole('Engineering Manager, Platform'), 'management');
  assert.equal(classifyRole('Scrum Master'), 'management');
});

test('an uninformative title falls back to the required skills', () => {
  // "Consultant" is genuinely ambiguous; the requirements decide.
  assert.equal(classifyRole('Specialist', ['oracle', 'plsql']), 'database');
  assert.equal(classifyRole('Specialist', ['kubernetes', 'docker']), 'devops');
  // Nothing to go on at all: `other`, never a guess.
  assert.equal(classifyRole('Specialist', []), 'other');
});

test('substring collisions do not create false matches', () => {
  // ` dba ` must be a whole word: "Sudbaden" and "Feedback" must not match it.
  assert.notEqual(classifyRole('Feedback Systems Lead'), 'database');
  assert.equal(classifyRole('DBA (Oracle)'), 'database');
});

test('every category has a human label, and an unknown value degrades to itself', () => {
  assert.equal(roleLabel('database'), 'Database / DBA');
  assert.equal(roleLabel('something_new'), 'something_new');
  // NULL and 'other' are different facts and must read differently.
  assert.equal(roleLabel(null), 'unclassified');
  assert.equal(roleLabel('other'), 'Other technical');
});

test('a systems role is infrastructure work, not a database job', () => {
  // Found in the live feed: "IT System Engineer (m/w/d)" landed in `database`
  // because its requirements mention SQL and the skill fallback ran first. The
  // title is the stronger signal and has to be read before the fallback.
  assert.equal(classifyRole('IT System Engineer (m/w/d)', ['sql']), 'devops');
  assert.equal(classifyRole('Systems Administrator', ['sql']), 'devops');
});
