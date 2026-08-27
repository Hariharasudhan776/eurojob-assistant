import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractSalary, formatSalary, formatSalaryUsd, sponsorshipEvidence } from '../src/lib/jobs/compensation.ts';

/**
 * Pay and sponsorship read out of the posting text.
 *
 * The risk here is not missing a salary, it is inventing one. Company money and
 * candidate money are written in exactly the same shape -- "€500k ARR" and
 * "€500k salary" differ only in the words around them -- and a wrong number on a
 * job card is worse than no number, because it gets acted on.
 */

const salaryOf = (text: string) => {
  const found = extractSalary(text);
  return found ? formatSalary(found) : null;
};

test('salary bands are read in the formats postings actually use', () => {
  assert.equal(salaryOf('We offer a salary of €65,000 - €80,000 per year.'), '€65,000 – €80,000 per year');
  assert.equal(salaryOf('The pay range for this role is $120,000 to $150,000 annually.'), '$120,000 – $150,000 per year');
  assert.equal(salaryOf('Base pay: £45k-£55k per annum plus bonus.'), '£45,000 – £55,000 per year');
  assert.equal(salaryOf('Hourly rate of £45 per hour for contract work.'), '£45 per hour');
});

test('German thousands separators survive sentence splitting', () => {
  // splitSentences breaks on a full stop, and "60.000 bis 75.000 €" contains
  // two. Every German salary band in the feed read as no salary at all until
  // the separators were masked for the split.
  assert.equal(salaryOf('Gehalt: 60.000 bis 75.000 € pro Jahr.'), '€60,000 – €75,000 per year');
  assert.equal(salaryOf('Monatliches Gehalt von 4.500 € brutto.'), '€4,500 per month');
});

test('a ceiling is not reported as a floor', () => {
  // "up to €90,000" and "from €90,000" describe very different offers, and
  // showing the first as the second overstates it by the whole band.
  assert.equal(salaryOf('Compensation up to 90,000 EUR.'), 'up to €90,000');
  assert.match(salaryOf('Salary from €90,000 depending on experience.') ?? '', /^€90,000/);
});

test('company money is not mistaken for the candidate’s', () => {
  // Real miss from the live feed: this was read as a €500,000 salary.
  assert.equal(extractSalary('We bootstrapped BoWatt to €500k+ ARR before raising our first round.'), null);
  assert.equal(extractSalary('We raised $50 million in our Series B funding round.'), null);
  assert.equal(extractSalary('Annual revenue of €250 million across the group.'), null);
});

test('numbers that are not money are left alone', () => {
  assert.equal(extractSalary('We are looking for 5+ years of experience since 2019.'), null);
  assert.equal(extractSalary('Our company was founded in 1998 and has 2000 employees.'), null);
  assert.equal(extractSalary('Salary is competitive and reviewed annually.'), null);
  // A figure with no currency and no pay word is not a salary.
  assert.equal(extractSalary('The team ships 40,000 builds a year.'), null);
});

test('markup never reaches the quoted evidence', () => {
  // Several sources store raw HTML, and the quote is shown to the user verbatim.
  const found = extractSalary('<p><strong>Salary range for this role is: </strong>30,000-120,000 USD/Year + Bonus.</p>');
  assert.ok(found, 'the salary should still be found inside markup');
  assert.ok(!/[<>]/.test(found.evidence), `markup leaked into the quote: ${found.evidence}`);
  assert.match(found.evidence, /Salary range for this role/);
});

test('sponsorship evidence quotes the posting rather than summarising it', () => {
  const positive = sponsorshipEvidence('Great team. We can offer visa sponsorship for the right candidate and support relocation.');
  assert.equal(positive.quotes.length, 1);
  assert.match(positive.quotes[0]!, /visa sponsorship/i);

  // A refusal is evidence too -- arguably the most useful kind.
  const negative = sponsorshipEvidence('Applicants must already hold the right to work in the EU.');
  assert.equal(negative.quotes.length, 1);

  assert.deepEqual(sponsorshipEvidence('This is a great team with free coffee.').quotes, []);
});

test('repeated boilerplate is quoted once', () => {
  const text = 'We offer visa sponsorship. Some other line. We offer visa sponsorship.';
  assert.equal(sponsorshipEvidence(text).quotes.length, 1);
});

test('conversion to USD keeps the shape and marks itself approximate', () => {
  const eur = extractSalary('Salary of €65,000 - €80,000 per year.')!;
  assert.equal(formatSalaryUsd(eur), '≈$70,850 – $87,200 per year');

  // Dollars are not approximated to themselves.
  const usd = extractSalary('The range is $120,000 to $150,000 annually.')!;
  assert.equal(formatSalaryUsd(usd), '$120,000 – $150,000 per year');

  // A ceiling stays a ceiling through the conversion.
  const capped = extractSalary('Compensation up to 90,000 EUR.')!;
  assert.match(formatSalaryUsd(capped) ?? '', /^up to ≈\$98,100$/);
});

test('an unlabelled figure is never assumed to be dollars', () => {
  // "60,000" in a German advert with no currency mark would be understated by
  // nearly ten percent if it were simply printed with a dollar sign.
  const noCurrency = extractSalary('The annual salary for this position is 60,000.');
  assert.ok(noCurrency, 'a pay word plus a figure is still a salary');
  assert.equal(noCurrency.currency, null);
  assert.equal(formatSalaryUsd(noCurrency), null, 'no currency means no conversion');
});
