import { createHash } from 'node:crypto';
import { EUROPEAN_COUNTRIES, type RemoteMode, type Tristate } from './types.ts';

/**
 * Shared parsing helpers for job postings.
 *
 * Everything here is deliberately deterministic and free. Detecting whether a
 * posting mentions visa sponsorship is a text-matching problem; paying for a
 * model call per job to answer it would be slower, costlier, and less
 * consistent run to run. The AI layer is reserved for judgement that genuinely
 * needs it (explaining a match, tailoring prose), not for reading labels.
 */

/** Strip HTML to text. Sources return a mix of HTML and plain text. */
export function htmlToText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const COUNTRY_BY_NAME = new Map<string, string>(
  Object.entries(EUROPEAN_COUNTRIES).map(([code, name]) => [name.toLowerCase(), code])
);

/** Extra spellings and major cities that identify a country in a location string. */
const LOCATION_HINTS: Record<string, string> = {
  deutschland: 'DE', germany: 'DE', berlin: 'DE', munich: 'DE', münchen: 'DE', hamburg: 'DE',
  frankfurt: 'DE', cologne: 'DE', köln: 'DE', stuttgart: 'DE', düsseldorf: 'DE', dusseldorf: 'DE', leipzig: 'DE',
  netherlands: 'NL', holland: 'NL', nederland: 'NL', amsterdam: 'NL', rotterdam: 'NL', utrecht: 'NL',
  eindhoven: 'NL', 'the hague': 'NL', hague: 'NL', groningen: 'NL',
  sweden: 'SE', sverige: 'SE', stockholm: 'SE', gothenburg: 'SE', göteborg: 'SE', malmo: 'SE', malmö: 'SE',
  finland: 'FI', suomi: 'FI', helsinki: 'FI', espoo: 'FI', tampere: 'FI',
  denmark: 'DK', danmark: 'DK', copenhagen: 'DK', københavn: 'DK', aarhus: 'DK',
  norway: 'NO', norge: 'NO', oslo: 'NO', bergen: 'NO',
  ireland: 'IE', dublin: 'IE', cork: 'IE', galway: 'IE',
  belgium: 'BE', belgie: 'BE', belgique: 'BE', brussels: 'BE', brussel: 'BE', antwerp: 'BE', ghent: 'BE', leuven: 'BE',
  austria: 'AT', österreich: 'AT', osterreich: 'AT', vienna: 'AT', wien: 'AT', graz: 'AT', linz: 'AT',
  france: 'FR', paris: 'FR', lyon: 'FR', toulouse: 'FR', nantes: 'FR', bordeaux: 'FR', lille: 'FR',
  switzerland: 'CH', schweiz: 'CH', suisse: 'CH', zurich: 'CH', zürich: 'CH', geneva: 'CH',
  basel: 'CH', lausanne: 'CH', bern: 'CH', zug: 'CH',
  luxembourg: 'LU', luxemburg: 'LU',
  poland: 'PL', polska: 'PL', warsaw: 'PL', warszawa: 'PL', krakow: 'PL', kraków: 'PL', wroclaw: 'PL', gdansk: 'PL', poznan: 'PL',
  spain: 'ES', españa: 'ES', espana: 'ES', madrid: 'ES', barcelona: 'ES', valencia: 'ES', malaga: 'ES', málaga: 'ES',
  italy: 'IT', italia: 'IT', milan: 'IT', milano: 'IT', rome: 'IT', roma: 'IT', turin: 'IT', bologna: 'IT',
  portugal: 'PT', lisbon: 'PT', lisboa: 'PT', porto: 'PT', braga: 'PT',
  czechia: 'CZ', 'czech republic': 'CZ', prague: 'CZ', praha: 'CZ', brno: 'CZ',
  estonia: 'EE', tallinn: 'EE', tartu: 'EE',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', london: 'GB',
  manchester: 'GB', birmingham: 'GB', edinburgh: 'GB', glasgow: 'GB', bristol: 'GB', leeds: 'GB',
};

/**
 * Best-effort country + city from a free-text location.
 * Returns nulls rather than a guess when nothing matches -- an unknown location
 * is downgraded by the matcher, which is safer than a confident wrong country.
 */
export function parseLocation(location: string | null | undefined): { country: string | null; city: string | null } {
  if (!location) return { country: null, city: null };

  const cleaned = location.replace(/\s+/g, ' ').trim();
  const lower = cleaned.toLowerCase();

  // Explicit "City, Country" is the common and most reliable shape.
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of [...parts].reverse()) {
    const code = COUNTRY_BY_NAME.get(part.toLowerCase()) ?? LOCATION_HINTS[part.toLowerCase()];
    if (code) {
      const city = parts.find((p) => p.toLowerCase() !== part.toLowerCase()) ?? null;
      return { country: code, city: city && city.length <= 60 ? city : null };
    }
  }

  // Otherwise scan for any hint anywhere in the string, longest first so
  // "the hague" beats "hague" and multi-word countries beat their cities.
  const hints = Object.entries(LOCATION_HINTS).sort((a, b) => b[0].length - a[0].length);
  for (const [needle, code] of hints) {
    if (new RegExp(`(^|[^a-zà-ü])${needle}($|[^a-zà-ü])`, 'i').test(lower)) {
      return { country: code, city: parts[0] ?? null };
    }
  }
  return { country: null, city: parts[0] ?? null };
}

export function detectRemote(text: string, tags: string[] = []): RemoteMode {
  const haystack = `${text} ${tags.join(' ')}`.toLowerCase();
  if (/\bhybrid\b|\bpartially remote\b|\b\d\s*days?\s+(?:per|a)\s+week\s+(?:in|at)\s+(?:the\s+)?office\b/.test(haystack)) {
    return 'hybrid';
  }
  if (/\bfully remote\b|\b100%\s*remote\b|\bremote[- ]first\b|\bwork from home\b|\bwork from anywhere\b|\bremote\b/.test(haystack)) {
    return 'remote';
  }
  if (/\bon[- ]site\b|\bonsite\b|\bin[- ]office\b|\bin our .{0,20}office\b/.test(haystack)) {
    return 'onsite';
  }
  return 'unknown';
}

/**
 * Visa sponsorship. Negations are checked FIRST: a posting saying
 * "we cannot sponsor visas" contains the phrase "sponsor visa", so
 * positive-first matching would read it exactly backwards.
 */
export function detectVisaSponsorship(text: string): Tristate {
  const t = text.toLowerCase();

  const negative = [
    /\b(?:no|not|cannot|can't|unable to|do not|don't|won't|will not)\s+(?:offer\s+|provide\s+|able to\s+)?(?:visa\s+)?spons/,
    /\bwithout\s+(?:visa\s+)?sponsorship\b/,
    /\bsponsorship\s+is\s+not\s+(?:available|offered|provided|possible)\b/,
    /\bwe\s+(?:do\s+not|don't)\s+sponsor\b/,
    /\bmust\s+(?:already\s+)?(?:have|hold|possess)\s+(?:a\s+)?(?:valid\s+)?(?:eu\s+|right\s+to\s+)?work\s+(?:permit|authorisation|authorization|visa)\b/,
    /\bmust\s+be\s+(?:eligible\s+to\s+work|authorised|authorized|legally\s+able\s+to\s+work)\b/,
    /\bno\s+visa\s+support\b/,
    /\beu\s+(?:citizens?|nationals?)\s+only\b/,
    /\bexisting\s+right\s+to\s+work\b/,
  ];
  if (negative.some((re) => re.test(t))) return 'no';

  const positive = [
    /\bvisa\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided|possible)\b/,
    /\bwe\s+(?:offer|provide|support|can\s+offer|can\s+provide)\s+(?:visa\s+)?sponsorship\b/,
    /\bwe\s+(?:will\s+)?sponsor\b/,
    /\bsponsorship\s+available\b/,
    /\bhappy\s+to\s+sponsor\b/,
    /\bvisa\s+support\s+(?:is\s+)?(?:available|offered|provided)\b/,
    /\bwe\s+help\s+with\s+(?:the\s+)?visa\b/,
    /\b(?:blue\s*card|work\s+permit)\s+(?:sponsorship|support)\b/,
    /\bwe\s+assist\s+with\s+visa\b/,
  ];
  if (positive.some((re) => re.test(t))) return 'yes';

  return 'not_specified';
}

export function detectRelocationSupport(text: string): Tristate {
  const t = text.toLowerCase();
  if (/\bno\s+relocation\b|\brelocation\s+(?:is\s+)?not\s+(?:available|offered|provided|supported)\b/.test(t)) return 'no';
  if (
    /\brelocation\s+(?:package|assistance|support|bonus|allowance|budget)\b/.test(t) ||
    /\bwe\s+(?:offer|provide|support|help\s+with)\s+relocation\b/.test(t) ||
    /\brelocation\s+(?:is\s+)?(?:available|offered|provided|fully\s+covered)\b/.test(t)
  ) {
    return 'yes';
  }
  return 'not_specified';
}

/**
 * Sentence splitting that survives European abbreviations.
 *
 * Naive splitting on "." separates "(mind." from "C1)" in the very common German
 * construction "mind. C1", which loses the requirement level. Same problem with
 * bzw., z.B., ca., u.a., ggf., evtl., and Dutch/French equivalents.
 */
export function splitSentences(text: string): string[] {
  const ABBREVIATIONS = /\b(?:mind|max|ca|bzw|zzgl|inkl|evtl|ggf|u\.a|z\.B|d\.h|o\.g|s\.o|nr|bzgl|etc|vgl|resp|env|p\.ex)\.$/i;
  const parts: string[] = [];
  let current = '';

  for (const chunk of text.split(/(?<=[.!?\n])/)) {
    current += chunk;
    // Keep accumulating while the fragment ends in a known abbreviation.
    if (ABBREVIATIONS.test(current.trimEnd())) continue;
    parts.push(current);
    current = '';
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Languages the posting *requires*.
 *
 * Two things make this harder than it looks, and both were found on real
 * postings rather than imagined:
 *
 *  1. **German ads state the requirement in German.** "Du kommunizierst sicher
 *     auf Deutsch und Englisch (mind. C1)" is a hard C1 German requirement, and
 *     an English-only keyword list misses it completely. For a search aimed at
 *     Germany, Austria and Switzerland that is not an edge case, it is most of
 *     the market.
 *
 *  2. **Mentioning a language is not requiring it.** "Deutschland Ticket" and
 *     "our team speaks German" must not count, or every German posting would be
 *     excluded for a candidate who speaks only English. So a language only
 *     counts when its sentence also carries a requirement marker.
 */
const REQUIREMENT_MARKERS = [
  // English
  /\b(?:require[ds]?|requirement|must|need(?:ed)?|essential|mandatory|fluent|fluency|proficien\w*|native|speaker|mother\s*tongue|command of|level|business[- ]level|working knowledge)\b/i,
  /\b[abc][12]\b/i,
  // German
  /\b(?:erforderlich|voraussetzung|vorausgesetzt|verhandlungssicher|fließend|fliessend|sicher(?:e|es|em)?\s+(?:auf|in)|kenntnisse|sprachkenntnisse|beherrsch\w*|muttersprach\w*|mindestens|mind\.|niveau|benötigt|benoetigt|kommunizierst|kommunizieren|zwingend)\b/i,
  // Dutch / French
  /\b(?:vereist|noodzakelijk|vloeiend|beheersing|verplicht)\b/i,
  /\b(?:exig[ée]|obligatoire|courant|ma[îi]trise|requis)\b/i,
];

const LANGUAGE_PATTERNS: { language: string; patterns: RegExp[] }[] = [
  { language: 'English', patterns: [/\benglish\b/i, /\benglisch\b/i, /\bengels\b/i, /\banglais\b/i] },
  // \bdeutsch\b deliberately does not match "Deutschland" or "deutschlandweit",
  // which appear in benefits sections of almost every German posting.
  { language: 'German', patterns: [/\bgerman\b/i, /\bdeutsch(?:e|es|en|er)?\b/i, /\bduits\b/i, /\ballemand\b/i] },
  { language: 'Dutch', patterns: [/\bdutch\b/i, /\bnederlands\b/i, /\bniederl[äa]ndisch\b/i] },
  { language: 'French', patterns: [/\bfrench\b/i, /\bfran[çc]ais\b/i, /\bfranz[öo]sisch\b/i] },
  { language: 'Swedish', patterns: [/\bswedish\b/i, /\bsvenska\b/i, /\bschwedisch\b/i] },
  { language: 'Danish', patterns: [/\bdanish\b/i, /\bdansk\b/i, /\bd[äa]nisch\b/i] },
  { language: 'Norwegian', patterns: [/\bnorwegian\b/i, /\bnorsk\b/i, /\bnorwegisch\b/i] },
  { language: 'Finnish', patterns: [/\bfinnish\b/i, /\bsuomi\b/i, /\bfinnisch\b/i] },
  { language: 'Italian', patterns: [/\bitalian\b/i, /\bitaliano\b/i, /\bitalienisch\b/i] },
  { language: 'Spanish', patterns: [/\bspanish\b/i, /\bespa[ñn]ol\b/i, /\bspanisch\b/i] },
  { language: 'Polish', patterns: [/\bpolish\b/i, /\bpolski\b/i, /\bpolnisch\b/i] },
  { language: 'Portuguese', patterns: [/\bportuguese\b/i, /\bportugu[êe]s\b/i] },
];

export function detectRequiredLanguages(text: string): string[] {
  const found = new Set<string>();

  for (const sentence of splitSentences(text)) {
    if (!REQUIREMENT_MARKERS.some((marker) => marker.test(sentence))) continue;
    for (const { language, patterns } of LANGUAGE_PATTERNS) {
      if (patterns.some((p) => p.test(sentence))) found.add(language);
    }
  }
  return [...found];
}

export function detectMinYears(text: string): number | null {
  const found: number[] = [];
  const patterns = [
    /(\d{1,2})\s*(?:\+|plus)?\s*(?:-|–|to)\s*\d{1,2}\s*(?:\+)?\s*years?/gi,
    /(?:at\s+least|minimum(?:\s+of)?|min\.?)\s*(\d{1,2})\s*(?:\+)?\s*years?/gi,
    /(\d{1,2})\s*\+\s*years?/gi,
    /(\d{1,2})\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|proven\s+|commercial\s+)?experience/gi,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      // Above ~25 it is almost always a year ("since 1998") or a typo.
      if (Number.isFinite(value) && value > 0 && value <= 25) found.push(value);
    }
  }
  return found.length ? Math.min(...found) : null;
}

export function detectEducation(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bph\.?d\b|\bdoctorate\b/.test(t)) return 'phd';
  if (/\bmaster'?s?\b|\bm\.?sc\b|\bmsc\b|\bm\.?eng\b/.test(t)) return 'masters';
  if (/\bbachelor'?s?\b|\bb\.?sc\b|\bbsc\b|\bb\.?eng\b|\buniversity\s+degree\b|\bdegree\s+in\b/.test(t)) return 'bachelors';
  if (/\bapprenticeship\b|\bvocational\b|\bausbildung\b/.test(t)) return 'vocational';
  return null;
}

/**
 * Deduplication + AI-cache key.
 *
 * Company and title are normalised so "ACME GmbH" and "acme  gmbh" hash the
 * same, and the description is collapsed to its first 2000 significant
 * characters -- enough to distinguish two genuinely different postings, while
 * tolerating the boilerplate footers that differ between aggregators.
 */
export function contentHash(job: { company: string; title: string; description: string }): string {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const company = normalise(job.company).replace(/\b(gmbh|bv|nv|ab|as|oy|sa|ag|ltd|limited|inc|plc|sarl|srl|aps|spa)\b/g, '').trim();
  const body = normalise(job.description).slice(0, 2000);
  return createHash('sha256').update(`${company}|${normalise(job.title)}|${body}`).digest('hex');
}
