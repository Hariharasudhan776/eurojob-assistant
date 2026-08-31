import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STALE_AFTER_DAYS, staleClause, closedLabel } from '../src/lib/jobs/lifecycle.ts';
import { geoCountry } from '../src/lib/jobs/sources/jobicy.ts';
import { parseLocation } from '../src/lib/jobs/parse.ts';
import { DEFAULT_SEARCH, DEFAULT_TARGET_COUNTRIES } from '../src/lib/search-config.ts';

// --- the closure rule --------------------------------------------------------

test('a posting is presumed open for longer than the collector looks back', () => {
  // If these ever cross, the sweep closes jobs that are demonstrably still open:
  // a live posting can go up to postedWithinDays without being returned purely
  // because it aged out of the SEARCH, not out of existence.
  assert.ok(
    STALE_AFTER_DAYS > (DEFAULT_SEARCH.postedWithinDays ?? 0),
    `STALE_AFTER_DAYS (${STALE_AFTER_DAYS}) must exceed the collection window (${DEFAULT_SEARCH.postedWithinDays})`
  );
});

test('the stale test takes the LATER of the two dates, so either kind of evidence keeps a job open', () => {
  const sql = staleClause('j');
  assert.match(sql, /GREATEST\(j\.last_seen_at, j\.posted_at\)/);
  // Not `posted_at <` on its own: a three-month-old posting a source returned
  // this morning is open, and the source saying so outranks the date on it.
  assert.doesNotMatch(sql, /^\s*j\.posted_at </);
});

test('the alias is honoured, so the clause can be used in an UPDATE and in a join', () => {
  assert.match(staleClause('jobs'), /GREATEST\(jobs\.last_seen_at, jobs\.posted_at\)/);
});

test('a reported closure reads as an observation, an expiry reads as an inference', () => {
  const reported = closedLabel('reported', '2026-08-20T00:00:00Z');
  const expired = closedLabel('expired', null);
  assert.match(reported, /Reported/);
  // The wording must not claim more than the date rule knows.
  assert.match(expired, /No source has listed/);
  assert.ok(!/gone|removed|deleted/i.test(expired), 'an expiry must not claim the posting was removed');
});

// --- Jobicy eligibility regions ---------------------------------------------

test('a region word is never read as a country', () => {
  assert.equal(geoCountry('Anywhere'), null);
  assert.equal(geoCountry('EMEA'), null);
  assert.equal(geoCountry('LATAM'), null);
  assert.equal(geoCountry('Europe'), null);
  assert.equal(geoCountry(undefined), null);
});

test('the first real country in an eligibility list is used, and region words are skipped over', () => {
  // "Europe" first would otherwise stop the scan and return nothing.
  assert.equal(geoCountry('Europe,  Ireland,  Poland,  Spain,  UK'), 'IE');
  assert.equal(geoCountry('EMEA'), null);
  assert.equal(geoCountry('LATAM,  Canada,  USA'), 'CA');
  assert.equal(geoCountry('Spain'), 'ES');
});

// --- the locations the feed was actually losing ------------------------------

test('German cities that were in the feed and unplaced now resolve', () => {
  for (const city of ['Mainz', 'Nuremberg', 'Karlsruhe', 'Heidelberg', 'Dresden', 'Münster', 'Essen', 'Bonn']) {
    assert.equal(parseLocation(city).country, 'DE', `${city} should resolve to DE`);
  }
});

test('a federal state places a village the city list will never contain', () => {
  assert.equal(parseLocation('Viernheim, Hesse').country, 'DE');
  assert.equal(parseLocation('Ottobrunn, Bavaria').country, 'DE');
  assert.equal(parseLocation('Barleben, Saxony-Anhalt').country, 'DE');
  assert.equal(parseLocation('Wilhelmshaven, Lower Saxony').country, 'DE');
});

test('a German word for "no particular place" still places the country', () => {
  assert.equal(parseLocation('deutschlandweit').country, 'DE');
  assert.equal(parseLocation('Homeoffice').country, 'DE');
});

test('REGRESSION: "New York" is not read as the English city of York', () => {
  // Hints are scanned longest-first for exactly this reason.
  assert.equal(parseLocation('New York').country, 'US');
  assert.equal(parseLocation('New York, NY').country, 'US');
});

test('a bare "Remote" is still refused a country rather than guessed at', () => {
  assert.equal(parseLocation('Remote').country, null);
  assert.equal(parseLocation('Hybrid').country, null);
});

// --- the collector's own budget ----------------------------------------------

test('priority countries are a scoring preference reused, not a second list to maintain', () => {
  assert.deepEqual(DEFAULT_SEARCH.priorityCountries, DEFAULT_TARGET_COUNTRIES);
});

test('collection is still global -- priority countries must not restrict it', () => {
  assert.deepEqual(DEFAULT_SEARCH.countries, []);
});
