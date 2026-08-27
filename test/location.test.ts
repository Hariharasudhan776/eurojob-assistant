import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocation } from '../src/lib/jobs/parse.ts';

/**
 * Collection is global now, so a location string can come from anywhere. Every
 * case here is one that returned `country: null` before -- meaning the job was
 * collected, stored, and then invisible to the country filter.
 */

test('an American posting names a state, not a country', () => {
  assert.deepEqual(parseLocation('San Francisco, CA'), { country: 'US', city: 'San Francisco' });
  assert.deepEqual(parseLocation('Austin, TX'), { country: 'US', city: 'Austin' });
  assert.deepEqual(parseLocation('New York, NY'), { country: 'US', city: 'New York' });
});

test('CA as a state abbreviation is California, not Canada', () => {
  // In "City, XX" the second part is a subdivision. Canada writes its own name
  // or a province code.
  assert.equal(parseLocation('Los Angeles, CA').country, 'US');
  assert.equal(parseLocation('Toronto, ON').country, 'CA');
  assert.equal(parseLocation('Toronto, Canada').country, 'CA');
});

test('the countries the Ireland source exists for still parse', () => {
  assert.deepEqual(parseLocation('Dublin, Ireland'), { country: 'IE', city: 'Dublin' });
  assert.equal(parseLocation('Cork, Ireland').country, 'IE');
  assert.equal(parseLocation('Galway').country, 'IE');
});

test('non-European locations resolve', () => {
  assert.equal(parseLocation('Bangalore, India').country, 'IN');
  assert.equal(parseLocation('Chennai').country, 'IN');
  assert.equal(parseLocation('Singapore').country, 'SG');
  assert.equal(parseLocation('Sydney, Australia').country, 'AU');
  assert.equal(parseLocation('Cape Town, South Africa').country, 'ZA');
  assert.equal(parseLocation('Mexico City, Mexico').country, 'MX');
  assert.equal(parseLocation('São Paulo, Brazil').country, 'BR');
  assert.equal(parseLocation('Dubai, United Arab Emirates').country, 'AE');
  assert.equal(parseLocation('Muscat, Oman').country, 'OM');
});

test('European parsing is unchanged', () => {
  assert.deepEqual(parseLocation('Berlin, Germany'), { country: 'DE', city: 'Berlin' });
  assert.equal(parseLocation('München').country, 'DE');
  assert.equal(parseLocation('The Hague').country, 'NL');
});

test('an unknown location stays null rather than becoming a guess', () => {
  // A confident wrong country is worse than an admitted unknown: the matcher
  // downgrades unknown locations, but it trusts a stated one.
  assert.equal(parseLocation('Flexible / Remote').country, null);
  assert.equal(parseLocation('').country, null);
  assert.equal(parseLocation(null).country, null);
  assert.equal(parseLocation('Somewhere, Nowhere').country, null);
});
