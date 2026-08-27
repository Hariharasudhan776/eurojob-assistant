import { classifyTitle } from './relevance.ts';

/**
 * What KIND of role a posting is, independently of how well it fits the profile.
 *
 * The score answers "should I apply to this"; the role category answers "what is
 * this". They are different questions, and conflating them makes a global feed
 * hard to use: Data Engineer, DBA, DevOps and ERP posts arrive side by side, and
 * a candidate triaging 800 of them wants to look at one kind at a time.
 *
 * Rules, deliberately in this shape:
 *
 *  * **Deterministic keyword classification, never a model call.** Same rule as
 *    the scorer: the AI explains and writes, it never decides. Classifying 800
 *    jobs per sync with an LLM would also cost real money for something the
 *    title already tells you.
 *  * **Most specific bucket wins**, so "Senior Database Reliability Engineer"
 *    lands in `database` rather than `devops`. ROLE_ORDER is that rule.
 *  * **The category is stored on the job**, so the filter dropdown is built from
 *    `SELECT DISTINCT role_category` -- the UI offers what the database actually
 *    holds rather than a hardcoded list that drifts away from the data.
 *  * **`other` and NULL are different facts.** NULL means never classified;
 *    `other` means classified and it fits nothing named. The UI must not
 *    conflate them, the same way it must not conflate "no sponsorship" with
 *    "sponsorship not stated".
 */

export const ROLE_CATEGORIES = [
  'database',
  'data',
  'erp',
  'backend',
  'fullstack',
  'frontend',
  'mobile',
  'devops',
  'security',
  'qa',
  'analyst',
  'consultant',
  'support',
  'management',
  'other',
  'non_technical',
] as const;

export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export const ROLE_LABELS: Record<RoleCategory, string> = {
  database: 'Database / DBA',
  data: 'Data & analytics',
  erp: 'ERP & enterprise systems',
  backend: 'Backend development',
  fullstack: 'Full-stack development',
  frontend: 'Frontend development',
  mobile: 'Mobile development',
  devops: 'DevOps / SRE / cloud',
  security: 'Security',
  qa: 'QA & test',
  analyst: 'Analyst',
  consultant: 'Technical consulting',
  support: 'Technical support',
  management: 'Management & product',
  other: 'Other technical',
  non_technical: 'Non-technical',
};

/**
 * Title patterns per category.
 *
 * German terms are included for the same reason the language detector reads
 * German: for any search that includes DACH, an English-only keyword list
 * misses most of the market.
 */
const TITLE_PATTERNS: Record<Exclude<RoleCategory, 'other' | 'non_technical'>, string[]> = {
  database: [
    'dba', 'database administrator', 'datenbankadministrator', 'database engineer',
    'database developer', 'database specialist', 'datenbankentwickler', 'datenbank',
    'oracle', 'plsql', 'pl sql', 'postgres', 'postgresql', 'sql server', 'mysql',
    'mariadb', 'mongodb', 'sql developer', 'sql engineer', 't sql', 'db2', 'sybase',
    'database reliability', 'data base',
  ],
  data: [
    'data engineer', 'data warehouse', 'datawarehouse', 'etl', 'bi developer',
    'business intelligence', 'analytics engineer', 'data platform', 'big data',
    'data architect', 'datenarchitekt', 'data scientist', 'machine learning',
    'ml engineer', 'ai engineer', 'dataops', 'data ops', 'informatica', 'talend',
    'snowflake', 'databricks', 'power bi', 'tableau',
  ],
  erp: [
    'erp', 'sap', 'oracle ebs', 'e business suite', 'netsuite', 'dynamics 365',
    'dynamics ax', 'dynamics nav', 'business central', 'odoo', 'peoplesoft',
    'salesforce', 'servicenow', 'workday', 'jd edwards', 'abap',
  ],
  backend: [
    'backend', 'back end', 'server side', 'api developer', 'api engineer',
    'java developer', 'java engineer', 'python developer', 'python engineer',
    'net developer', 'net engineer', 'c# developer', 'golang', 'go developer',
    'node developer', 'node js developer', 'php developer', 'ruby developer',
    'rust developer', 'scala developer', 'kotlin developer', 'microservices',
    'software engineer', 'software developer', 'softwareentwickler', 'programmer',
    'programmierer', 'application developer', 'anwendungsentwickler',
    'entwickler', 'engineer software',
  ],
  fullstack: ['fullstack', 'full stack'],
  frontend: [
    'frontend', 'front end', 'react developer', 'angular developer',
    'vue developer', 'javascript developer', 'typescript developer', 'ui engineer',
    'web developer', 'webentwickler',
  ],
  mobile: [
    'mobile developer', 'ios developer', 'android developer', 'flutter',
    'react native', 'swift developer',
  ],
  devops: [
    'devops', 'sre', 'site reliability', 'platform engineer', 'infrastructure engineer',
    'cloud engineer', 'cloud architect', 'kubernetes', 'aws engineer', 'azure engineer',
    'gcp engineer', 'systems engineer', 'system engineer', 'systemadministrator',
    'system administrator', 'systems administrator', 'sysadmin', 'network engineer',
    'netzwerk', 'linux administrator', 'build engineer', 'release engineer',
    'it infrastructure',
  ],
  security: [
    'security engineer', 'security analyst', 'cyber', 'infosec', 'penetration test',
    'pentest', 'soc analyst', 'iam engineer', 'appsec', 'security specialist',
  ],
  qa: [
    'quality assurance', 'test engineer', 'test automation', 'sdet', 'tester',
    'testautomatisierung', 'qa engineer', 'qa analyst', 'qa lead',
  ],
  analyst: [
    'business analyst', 'data analyst', 'systems analyst', 'reporting analyst',
    'requirements engineer', 'product analyst', 'datenanalyst',
  ],
  consultant: [
    'consultant', 'berater', 'solution architect', 'technical architect', 'presales',
    'implementation specialist', 'integration specialist',
  ],
  support: [
    'support engineer', 'technical support', 'application support', 'service desk',
    'helpdesk', 'help desk', 'it support', 'anwenderbetreuung', 'operations engineer',
  ],
  management: [
    'engineering manager', 'team lead', 'teamlead', 'tech lead', 'head of',
    'director of', 'cto', 'vp engineering', 'product manager', 'produktmanager',
    'product owner', 'project manager', 'projektleiter', 'scrum master',
    'delivery manager', 'it manager',
  ],
};

/**
 * Specificity order.
 *
 * "Senior Database Reliability Engineer" reads as both database and reliability
 * engineering; database is the more specific claim, so it is checked first.
 * Backend sits below the specialisms on purpose -- a very large share of
 * postings say "software engineer" somewhere in the title, and letting that
 * match first would swallow most of the feed into one bucket.
 */
const ROLE_ORDER: Exclude<RoleCategory, 'other' | 'non_technical'>[] = [
  'erp', 'database', 'data', 'devops', 'security', 'qa', 'mobile',
  'fullstack', 'frontend', 'backend', 'analyst', 'consultant', 'support', 'management',
];

/**
 * Skill fallbacks, consulted only when the title says nothing recognisable.
 * These are canonical keys from taxonomy.ts, not free text.
 */
const SKILL_FALLBACK: { category: RoleCategory; canonicals: string[] }[] = [
  { category: 'database', canonicals: ['oracle', 'plsql', 'pgplsql', 'postgresql', 'mysql', 'tsql', 'db2', 'sql', 'mongodb', 'redis'] },
  { category: 'erp', canonicals: ['erp', 'sap', 'axpert'] },
  { category: 'devops', canonicals: ['docker', 'kubernetes', 'cicd', 'cloud', 'linux'] },
  { category: 'backend', canonicals: ['java', 'python', 'csharp', 'nodejs', 'c', 'cpp', 'shell'] },
  { category: 'frontend', canonicals: ['javascript', 'typescript', 'html', 'css', 'electron'] },
];

/**
 * Separators are normalised away before matching, so "PL/SQL", "PL-SQL" and
 * "PL SQL" in a title are all found by the single pattern "pl sql", and
 * ".NET Developer" by "net developer".
 */
const normaliseTitle = (title: string): string =>
  ` ${title
    .toLowerCase()
    .replace(/\(m\/w\/d\)|\(m\/f\/d\)|\(all genders\)|\(d\/f\/m\)/g, ' ')
    .replace(/[^a-z0-9#äöüß+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

/**
 * Classify a posting.
 *
 * `requiredSkills` are the canonical keys the parser already extracted. They are
 * consulted only when the title is uninformative, because a title is a far
 * stronger signal than a keyword buried in a requirements list -- the same
 * mistake that once let a social-media posting score 89%.
 */
export function classifyRole(title: string, requiredSkills: string[] = []): RoleCategory {
  // A posting whose title is definitively not engineering work is labelled as
  // such rather than forced into a technical bucket. relevance.ts owns that
  // judgement and there is no second opinion here.
  if (classifyTitle(title) === 'non_technical') return 'non_technical';

  // The haystack is space-wrapped and single-spaced, so ` pattern ` is a whole-word
  // (or whole-phrase) match. Substring matching would put "sdba" in `database`.
  const haystack = normaliseTitle(title);
  for (const category of ROLE_ORDER) {
    if (TITLE_PATTERNS[category].some((pattern) => haystack.includes(` ${pattern} `))) return category;
  }

  for (const { category, canonicals } of SKILL_FALLBACK) {
    if (requiredSkills.some((skill) => canonicals.includes(skill))) return category;
  }

  return 'other';
}

export const roleLabel = (value: string | null | undefined): string =>
  value ? (ROLE_LABELS[value as RoleCategory] ?? value) : 'unclassified';

export const isRoleCategory = (value: string): value is RoleCategory =>
  (ROLE_CATEGORIES as readonly string[]).includes(value);
