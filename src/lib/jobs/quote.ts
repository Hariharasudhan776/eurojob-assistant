import type { SalaryFinding } from './compensation.ts';
import { detectMinYears } from './parse.ts';

/**
 * "What can I put in the salary-expectation box?" -- answered per job, in the
 * job's OWN currency, deliberately unconverted. The number goes into an
 * application form in the employer's market; a dollar figure is the wrong shape
 * for that box, so unlike the comparison pills this module never touches
 * USD_RATES.
 *
 * Deterministic on purpose, like the scorer: the same posting and the same
 * profile give the same quote every time, and the basis is reported so the
 * candidate can judge it. Two bases, in order of preference:
 *
 *   posting  the advert states a band. The quote positions inside THEIR band --
 *            the employer already named the budget, and quoting outside it is
 *            either underselling or a screening-out.
 *   market   the advert is silent. A static per-country band for a mid-level
 *            developer, shifted by seniority. Static and dated like USD_RATES,
 *            and for the same reason: this anchors a form field, it does not
 *            promise an offer, and a live datasource would add a failure mode
 *            to a page that is otherwise local arithmetic.
 *
 * Seniority comes from the candidate's own years, not the posting's ask: the
 * question is what THIS person can command. The posting's minimum only ever
 * lowers the level (quoting mid-level money on an explicitly junior role prices
 * the candidate out of a budget the advert already disclosed).
 */

export const SALARY_BANDS_AS_OF = '2026-08';

/**
 * Gross annual pay for a MID-LEVEL (3-6 years) software developer, local
 * currency. Deliberately wide and conservative: an anchor, not an offer.
 * If these drift enough to matter, edit this one table.
 */
const MARKET_BANDS: Record<string, { currency: string; min: number; max: number }> = {
  DE: { currency: 'EUR', min: 55_000, max: 68_000 },
  AT: { currency: 'EUR', min: 50_000, max: 62_000 },
  CH: { currency: 'CHF', min: 95_000, max: 115_000 },
  NL: { currency: 'EUR', min: 50_000, max: 65_000 },
  BE: { currency: 'EUR', min: 48_000, max: 60_000 },
  FR: { currency: 'EUR', min: 45_000, max: 58_000 },
  LU: { currency: 'EUR', min: 60_000, max: 75_000 },
  IE: { currency: 'EUR', min: 55_000, max: 70_000 },
  GB: { currency: 'GBP', min: 50_000, max: 65_000 },
  ES: { currency: 'EUR', min: 36_000, max: 48_000 },
  IT: { currency: 'EUR', min: 35_000, max: 45_000 },
  PT: { currency: 'EUR', min: 30_000, max: 42_000 },
  PL: { currency: 'PLN', min: 180_000, max: 260_000 },
  CZ: { currency: 'CZK', min: 1_100_000, max: 1_550_000 },
  DK: { currency: 'DKK', min: 550_000, max: 700_000 },
  US: { currency: 'USD', min: 110_000, max: 150_000 },
  CA: { currency: 'CAD', min: 90_000, max: 120_000 },
  MX: { currency: 'MXN', min: 600_000, max: 950_000 },
  BR: { currency: 'BRL', min: 120_000, max: 200_000 },
  AU: { currency: 'AUD', min: 110_000, max: 140_000 },
  NZ: { currency: 'NZD', min: 95_000, max: 125_000 },
  SG: { currency: 'SGD', min: 72_000, max: 100_000 },
  IN: { currency: 'INR', min: 1_500_000, max: 2_800_000 },
  ZA: { currency: 'ZAR', min: 550_000, max: 850_000 },
  AE: { currency: 'AED', min: 216_000, max: 330_000 },
  SA: { currency: 'SAR', min: 180_000, max: 290_000 },
  QA: { currency: 'QAR', min: 180_000, max: 290_000 },
  OM: { currency: 'OMR', min: 12_000, max: 21_000 },
  KW: { currency: 'KWD', min: 11_000, max: 18_000 },
  BH: { currency: 'BHD', min: 11_000, max: 18_000 },
};

export type QuoteLevel = 'junior' | 'mid' | 'senior';

/** Shift applied to the mid-level band. */
const LEVEL_FACTOR: Record<QuoteLevel, number> = { junior: 0.75, mid: 1, senior: 1.3 };

export interface SalaryQuote {
  min: number;
  max: number;
  currency: string;
  basis: 'posting' | 'market';
  level: QuoteLevel;
  /** The posting's own minimum-years ask, when it states one. */
  requiredYears: number | null;
  asOf: string;
}

const levelOf = (years: number): QuoteLevel => (years < 3 ? 'junior' : years < 7 ? 'mid' : 'senior');

/** Round to a step a human would actually type into a form. */
function tidy(value: number): number {
  const step = value >= 100_000 ? 5_000 : value >= 20_000 ? 1_000 : 500;
  return Math.round(value / step) * step;
}

export function suggestQuote(input: {
  country: string | null;
  description: string;
  /** The source's structured salary field, if any. */
  structured?: { min: number | null; max: number | null; currency: string | null } | null;
  /** A band read from the posting text, if any (extractSalary). */
  extracted?: SalaryFinding | null;
  candidateYears: number;
}): SalaryQuote | null {
  const requiredYears = detectMinYears(input.description);
  // The candidate's level is the starting point; an explicitly junior ask only
  // ever pulls it DOWN. It never pulls it up -- more required years do not make
  // this candidate more senior than they are.
  let level = levelOf(input.candidateYears);
  const rank: Record<QuoteLevel, number> = { junior: 0, mid: 1, senior: 2 };
  if (requiredYears !== null) {
    const askLevel = levelOf(requiredYears);
    // A junior ask caps at mid rather than junior: "2+ years" postings still
    // hire five-year candidates, they just do not pay senior money.
    if (rank[askLevel] < rank[level]) level = askLevel === 'junior' ? 'mid' : askLevel;
  }

  // --- posting basis --------------------------------------------------------
  const anchor = annualAnchor(input.structured, input.extracted);
  if (anchor) {
    const meets = requiredYears === null || input.candidateYears >= requiredYears;
    if (anchor.min !== null && anchor.max !== null && anchor.max > anchor.min) {
      // Inside their band: upper-middle when the years are met, lower-middle
      // when the posting asks for more than the candidate has.
      const [lo, hi] = meets ? [0.35, 0.75] : [0.15, 0.5];
      return {
        min: tidy(anchor.min + lo * (anchor.max - anchor.min)),
        max: tidy(anchor.min + hi * (anchor.max - anchor.min)),
        currency: anchor.currency,
        basis: 'posting',
        level,
        requiredYears,
        asOf: SALARY_BANDS_AS_OF,
      };
    }
    const single = anchor.max ?? anchor.min;
    if (single) {
      // "Up to X" is a ceiling: quote just under it. "From X" is a floor:
      // quote at it and slightly above.
      const ceiling = anchor.max !== null;
      return {
        min: tidy(ceiling ? single * 0.8 : single),
        max: tidy(ceiling ? single * 0.95 : single * 1.15),
        currency: anchor.currency,
        basis: 'posting',
        level,
        requiredYears,
        asOf: SALARY_BANDS_AS_OF,
      };
    }
  }

  // --- market basis ---------------------------------------------------------
  const band = input.country ? MARKET_BANDS[input.country.toUpperCase()] : undefined;
  if (!band) return null;
  const factor = LEVEL_FACTOR[level];
  return {
    min: tidy(band.min * factor),
    max: tidy(band.max * factor),
    currency: band.currency,
    basis: 'market',
    level,
    requiredYears,
    asOf: SALARY_BANDS_AS_OF,
  };
}

/**
 * The posting's own figures, annualised, or null when nothing usable exists.
 * Day and hour rates are contract-market numbers -- quoting an annual figure
 * from them multiplies an assumption, so they fall through to the market band.
 */
function annualAnchor(
  structured: { min: number | null; max: number | null; currency: string | null } | null | undefined,
  extracted: SalaryFinding | null | undefined
): { min: number | null; max: number | null; currency: string } | null {
  if (structured && (structured.min || structured.max) && structured.currency) {
    return { min: structured.min, max: structured.max, currency: structured.currency };
  }
  if (extracted && (extracted.min || extracted.max) && extracted.currency) {
    if (extracted.period === 'day' || extracted.period === 'hour') return null;
    const times = extracted.period === 'month' ? 12 : 1;
    return {
      min: extracted.min !== null ? extracted.min * times : null,
      max: extracted.max !== null ? extracted.max * times : null,
      currency: extracted.currency,
    };
  }
  return null;
}

export function formatQuote(quote: SalaryQuote): string {
  const money = (v: number) => v.toLocaleString('en-GB');
  return quote.min === quote.max
    ? `${quote.currency} ${money(quote.min)}`
    : `${quote.currency} ${money(quote.min)} – ${money(quote.max)}`;
}
