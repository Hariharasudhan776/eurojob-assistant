import type { SkillCategory } from '../resume/profile.ts';

/**
 * Skill taxonomy: canonical keys, aliases, and relatedness.
 *
 * This exists so matching is not string equality. A posting asking for
 * "PL/SQL" must match a profile that says "Oracle PL/SQL", and a posting asking
 * for "Postgres" must match "PostgreSQL" -- without an AI call, because
 * normalising vocabulary is a lookup problem, not a reasoning problem. Spending
 * a model call on it would be slow, expensive, and less consistent.
 *
 * `related` encodes partial credit: PostgreSQL experience is genuine evidence
 * for a MySQL role, but it is not the same thing, so it scores as partial. The
 * weight is how much credit transfers.
 */

export interface TaxonomyEntry {
  canonical: string;
  display: string;
  category: SkillCategory;
  aliases: string[];
  /** canonical -> how much of this skill transfers (0..1). */
  related?: Record<string, number>;
}

export const TAXONOMY: TaxonomyEntry[] = [
  // --- databases ---
  {
    canonical: 'oracle',
    display: 'Oracle Database',
    category: 'database',
    aliases: ['oracle db', 'oracle database', 'oracle 19c', 'oracle 12c', 'oracle rdbms', 'oracle sql'],
    related: { postgresql: 0.5, 'sql-server': 0.45, db2: 0.4, mysql: 0.35 },
  },
  {
    canonical: 'plsql',
    display: 'PL/SQL',
    category: 'language',
    aliases: ['pl/sql', 'pl sql', 'oracle plsql', 'oracle pl/sql', 'plsql development'],
    related: { 'tsql': 0.5, 'pgplsql': 0.6, sql: 0.4 },
  },
  {
    canonical: 'sql',
    display: 'SQL',
    category: 'language',
    aliases: ['ansi sql', 'sql queries', 'advanced sql', 'complex sql'],
  },
  {
    canonical: 'postgresql',
    display: 'PostgreSQL',
    category: 'database',
    aliases: ['postgres', 'psql', 'postgre sql', 'postgresql database'],
    related: { oracle: 0.5, mysql: 0.6, 'sql-server': 0.45 },
  },
  {
    canonical: 'pgplsql',
    display: 'PL/pgSQL',
    category: 'language',
    aliases: ['pl/pgsql', 'plpgsql'],
    related: { plsql: 0.6 },
  },
  { canonical: 'mysql', display: 'MySQL', category: 'database', aliases: ['maria db', 'mariadb'], related: { postgresql: 0.6, oracle: 0.35 } },
  { canonical: 'sql-server', display: 'Microsoft SQL Server', category: 'database', aliases: ['mssql', 'ms sql', 'sqlserver', 't-sql server'], related: { oracle: 0.45, postgresql: 0.45 } },
  { canonical: 'tsql', display: 'T-SQL', category: 'language', aliases: ['t-sql', 'transact-sql'], related: { plsql: 0.5 } },
  { canonical: 'db2', display: 'IBM Db2', category: 'database', aliases: ['ibm db2'], related: { oracle: 0.4 } },
  { canonical: 'mongodb', display: 'MongoDB', category: 'database', aliases: ['mongo', 'nosql'] },
  { canonical: 'redis', display: 'Redis', category: 'database', aliases: [] },

  // --- dba ---
  {
    canonical: 'oracle-dba',
    display: 'Oracle DBA',
    category: 'database_admin',
    aliases: ['oracle database administration', 'oracle administrator', 'dba', 'database administration', 'database administrator'],
    related: { 'performance-tuning': 0.5, 'backup-recovery': 0.6 },
  },
  {
    canonical: 'performance-tuning',
    display: 'Query & Database Performance Tuning',
    category: 'database_admin',
    aliases: ['performance tuning', 'query optimisation', 'query optimization', 'sql tuning', 'query tuning', 'database tuning', 'indexing'],
  },
  { canonical: 'backup-recovery', display: 'Backup & Recovery', category: 'database_admin', aliases: ['backup and recovery', 'disaster recovery'] },

  // --- Oracle DBA tooling, named individually on purpose -------------------
  //
  // These used to be either invisible (Data Guard, ASM, AWR, Data Pump) or
  // silently folded into a broader skill ('rman' was an alias of
  // backup-recovery). Both behaviours lost the employer's own word, which is
  // the exact string an ATS screens for and the exact string a recruiter's eye
  // stops on. A posting demanding RMAN now produces a requirement called RMAN.
  //
  // Folding was also dishonest in the flattering direction: owning "backup and
  // recovery" was scored as fully satisfying "RMAN", so the gap never surfaced
  // and was never put to the candidate. Each of these now transfers only
  // partially from the general skill, so it shows up as a question to answer
  // rather than a box already ticked.
  {
    canonical: 'oracle-rman',
    display: 'Oracle RMAN',
    category: 'database_admin',
    aliases: ['rman', 'recovery manager', 'oracle recovery manager'],
    related: { 'backup-recovery': 0.7, 'oracle-dba': 0.45 },
  },
  {
    canonical: 'oracle-datapump',
    display: 'Oracle Data Pump',
    category: 'database_admin',
    aliases: ['data pump', 'datapump', 'expdp', 'impdp', 'exp/imp'],
    related: { 'data-migration': 0.6, 'oracle-dba': 0.4 },
  },
  {
    canonical: 'oracle-dataguard',
    display: 'Oracle Data Guard',
    category: 'database_admin',
    aliases: ['data guard', 'dataguard', 'physical standby', 'standby database'],
    related: { 'oracle-dba': 0.3, 'high-availability': 0.6 },
  },
  {
    // The bare 'asm' alias is kept deliberately: DBA postings write it alone far
    // more often than anything else means it. It can misfire on an embedded-
    // systems posting using 'asm' for assembly, which costs one spurious line in
    // a requirements list and nothing more.
    canonical: 'oracle-asm',
    display: 'Oracle ASM',
    category: 'database_admin',
    aliases: ['asm', 'automatic storage management'],
    related: { 'oracle-dba': 0.3 },
  },
  {
    canonical: 'oracle-rac',
    display: 'Oracle RAC',
    category: 'database_admin',
    aliases: ['oracle rac', 'real application clusters', 'rac cluster'],
    related: { 'oracle-dba': 0.3, 'high-availability': 0.6 },
  },
  {
    canonical: 'oracle-awr',
    display: 'AWR / ADDM diagnostics',
    category: 'database_admin',
    aliases: ['awr', 'addm', 'statspack', 'automatic workload repository', 'awr report'],
    related: { 'performance-tuning': 0.6 },
  },
  {
    canonical: 'oracle-oem',
    display: 'Oracle Enterprise Manager',
    category: 'tool',
    // No bare 'oem': it means original-equipment-manufacturer everywhere else.
    aliases: ['oracle enterprise manager', 'enterprise manager', 'oem cloud control', 'grid control'],
    related: { 'oracle-dba': 0.4 },
  },
  {
    canonical: 'high-availability',
    display: 'High Availability & Failover',
    category: 'database_admin',
    // 'disaster recovery' stays on backup-recovery; a needle must not appear twice.
    aliases: ['high availability', 'ha/dr', 'failover', 'clustering'],
    related: { 'backup-recovery': 0.5 },
  },
  {
    canonical: 'partitioning',
    display: 'Table Partitioning',
    category: 'database_admin',
    aliases: ['partitioning', 'table partitioning', 'partitioned tables'],
    related: { 'performance-tuning': 0.4, 'data-modelling': 0.4 },
  },
  {
    canonical: 'goldengate',
    display: 'Oracle GoldenGate',
    category: 'database_admin',
    aliases: ['goldengate', 'golden gate'],
    related: { 'data-migration': 0.4 },
  },
  {
    canonical: 'sql-loader',
    display: 'SQL*Loader',
    category: 'tool',
    aliases: ['sql*loader', 'sql loader', 'sqlldr'],
    related: { 'data-migration': 0.5 },
  },
  {
    canonical: 'data-migration',
    display: 'Data Migration',
    category: 'database_admin',
    aliases: ['data migration', 'etl', 'data transformation', 'database migration', 'data loading'],
  },
  { canonical: 'data-modelling', display: 'Data Modelling', category: 'database_admin', aliases: ['data modeling', 'schema design', 'database design', 'er modelling'] },

  // --- languages & runtime ---
  { canonical: 'javascript', display: 'JavaScript', category: 'language', aliases: ['js', 'es6', 'ecmascript', 'javascript es6'], related: { typescript: 0.7 } },
  { canonical: 'typescript', display: 'TypeScript', category: 'language', aliases: ['ts'], related: { javascript: 0.8 } },
  { canonical: 'nodejs', display: 'Node.js', category: 'framework', aliases: ['node', 'node js', 'nodejs'], related: { javascript: 0.7 } },
  { canonical: 'electron', display: 'Electron.js', category: 'framework', aliases: ['electron js', 'electronjs'], related: { javascript: 0.6, nodejs: 0.6 } },
  { canonical: 'html', display: 'HTML', category: 'language', aliases: ['html5'] },
  { canonical: 'css', display: 'CSS', category: 'language', aliases: ['css3'] },
  { canonical: 'c', display: 'C', category: 'language', aliases: [] },
  { canonical: 'cpp', display: 'C++', category: 'language', aliases: ['c++', 'cplusplus'] },
  { canonical: 'python', display: 'Python', category: 'language', aliases: ['python3'] },
  { canonical: 'java', display: 'Java', category: 'language', aliases: ['java 8', 'java 11', 'core java'] },
  { canonical: 'csharp', display: 'C#', category: 'language', aliases: ['c#', '.net', 'dotnet', 'asp.net'] },
  { canonical: 'shell', display: 'Shell scripting', category: 'language', aliases: ['bash', 'shell script', 'powershell'] },

  // --- erp / business systems ---
  {
    canonical: 'erp',
    display: 'ERP Systems',
    category: 'erp',
    aliases: ['erp system', 'erp implementation', 'enterprise resource planning', 'erp support', 'erp development'],
    related: { sap: 0.3, 'ms-dynamics': 0.3, 'oracle-ebs': 0.4 },
  },
  { canonical: 'axpert', display: 'Axpert ERP', category: 'erp', aliases: ['axpert 10.9', 'axpert erp'], related: { erp: 0.8, 'low-code': 0.6 } },
  { canonical: 'sap', display: 'SAP', category: 'erp', aliases: ['sap erp', 'sap abap', 'sap hana'], related: { erp: 0.4 } },
  { canonical: 'oracle-ebs', display: 'Oracle E-Business Suite', category: 'erp', aliases: ['oracle ebs', 'e-business suite', 'oracle fusion', 'oracle apps'], related: { erp: 0.5, oracle: 0.5 } },
  { canonical: 'ms-dynamics', display: 'Microsoft Dynamics', category: 'erp', aliases: ['dynamics 365', 'msdynamics', 'navision', 'business central'], related: { erp: 0.4 } },
  { canonical: 'low-code', display: 'Low-code platforms', category: 'framework', aliases: ['low code', 'nocode', 'no-code'] },

  // --- domain ---
  { canonical: 'inventory', display: 'Inventory & Warehouse Management', category: 'domain', aliases: ['inventory management', 'warehouse management', 'wms', 'stock management'] },
  { canonical: 'construction-domain', display: 'Construction Project Systems', category: 'domain', aliases: ['construction erp', 'construction industry', 'contracting'] },
  { canonical: 'finance-domain', display: 'Finance (AP/AR, GL)', category: 'domain', aliases: ['accounts payable', 'accounts receivable', 'general ledger', 'financial reporting', 'finance modules'] },
  { canonical: 'cost-reporting', display: 'Cost Reporting & Controlling', category: 'domain', aliases: ['cost report', 'cost control', 'costing', 'project costing'] },
  { canonical: 'qaqc', display: 'QA/QC Processes', category: 'domain', aliases: ['qa/qc', 'quality assurance', 'quality control'] },
  { canonical: 'reporting', display: 'Business Reporting', category: 'domain', aliases: ['report development', 'bi reporting', 'operational reporting', 'report builder'] },
  { canonical: 'pharma-domain', display: 'Pharmacy / Pharma systems', category: 'domain', aliases: ['pharmacy', 'pharmaceutical'] },
  { canonical: 'pos', display: 'Point of Sale', category: 'domain', aliases: ['point of sale', 'pos system', 'retail pos'] },
  { canonical: 'egov', display: 'e-Governance / Public sector', category: 'domain', aliases: ['e-governance', 'egovernance', 'public sector', 'government projects'] },

  // --- tools ---
  { canonical: 'git', display: 'Git', category: 'tool', aliases: ['github', 'gitlab', 'version control', 'source control'] },
  { canonical: 'sql-developer', display: 'Oracle SQL Developer', category: 'tool', aliases: ['sql developer'] },
  { canonical: 'toad', display: 'TOAD', category: 'tool', aliases: ['toad for oracle'] },
  { canonical: 'dbeaver', display: 'DBeaver', category: 'tool', aliases: [] },
  { canonical: 'pgadmin', display: 'pgAdmin', category: 'tool', aliases: ['pgagent'] },
  { canonical: 'postman', display: 'Postman', category: 'tool', aliases: ['api testing'] },
  { canonical: 'rest-api', display: 'REST APIs', category: 'framework', aliases: ['rest', 'restful', 'rest api', 'api integration', 'web services'] },
  { canonical: 'docker', display: 'Docker', category: 'tool', aliases: ['containers', 'containerisation'] },
  { canonical: 'kubernetes', display: 'Kubernetes', category: 'tool', aliases: ['k8s'] },
  { canonical: 'cicd', display: 'CI/CD', category: 'tool', aliases: ['ci/cd', 'continuous integration', 'jenkins', 'github actions', 'gitlab ci'] },
  { canonical: 'agile', display: 'Agile / Scrum', category: 'soft', aliases: ['scrum', 'agile methodology', 'kanban', 'sprint'] },
  { canonical: 'cloud', display: 'Cloud platforms', category: 'tool', aliases: ['aws', 'azure', 'gcp', 'google cloud', 'oci'] },

  // --- modern data platform, present so its ABSENCE is reported -------------
  //
  // The candidate holds none of these. That is exactly why they are here: a
  // requirement the taxonomy cannot see is not scored, not shown as a gap, and
  // not counted against keyword coverage -- so a posting demanding Kafka and
  // Terraform was being reported as fully covered. Blind spots always flatter,
  // and a flattering gap analysis is the one that gets a resume rejected without
  // ever explaining why.
  { canonical: 'terraform', display: 'Terraform', category: 'tool', aliases: ['iac', 'infrastructure as code'], related: { cloud: 0.3 } },
  { canonical: 'ansible', display: 'Ansible', category: 'tool', aliases: ['configuration management'] },
  { canonical: 'kafka', display: 'Apache Kafka', category: 'tool', aliases: ['apache kafka', 'event streaming'] },
  { canonical: 'airflow', display: 'Apache Airflow', category: 'tool', aliases: ['apache airflow', 'dag orchestration'] },
  { canonical: 'snowflake', display: 'Snowflake', category: 'database', aliases: [], related: { 'data-warehouse': 0.6 } },
  { canonical: 'databricks', display: 'Databricks', category: 'database', aliases: ['delta lake'] },
  { canonical: 'data-warehouse', display: 'Data Warehousing', category: 'database_admin', aliases: ['data warehouse', 'data warehousing', 'dwh', 'olap'], related: { 'data-modelling': 0.5 } },
  { canonical: 'dbt', display: 'dbt', category: 'tool', aliases: ['data build tool'] },
  { canonical: 'graphql', display: 'GraphQL', category: 'framework', aliases: [], related: { 'rest-api': 0.4 } },
  { canonical: 'microservices', display: 'Microservices', category: 'framework', aliases: ['microservice architecture'] },
  { canonical: 'observability', display: 'Observability tooling', category: 'tool', aliases: ['grafana', 'prometheus', 'datadog', 'monitoring and alerting'] },
  { canonical: 'exadata', display: 'Oracle Exadata', category: 'database_admin', aliases: [], related: { 'oracle-dba': 0.3 } },

  // --- os ---
  { canonical: 'linux', display: 'Linux', category: 'os', aliases: ['ubuntu', 'rhel', 'centos', 'unix'] },
  { canonical: 'windows-server', display: 'Windows Server', category: 'os', aliases: ['windows server', 'windows'] },

  // --- AI (see ai.ts for how these are earned, not asserted) ---
  {
    canonical: 'ai-assisted-dev',
    display: 'AI-assisted development',
    category: 'ai',
    aliases: ['ai assisted development', 'ai-assisted coding', 'copilot', 'github copilot', 'ai coding tools', 'ai pair programming', 'cursor'],
    related: { 'generative-ai': 0.6, 'prompt-engineering': 0.5 },
  },
  {
    canonical: 'generative-ai',
    display: 'Generative AI tools',
    category: 'ai',
    aliases: ['generative ai', 'genai', 'gen ai', 'llm', 'llms', 'large language models', 'chatgpt', 'claude'],
    related: { 'ai-assisted-dev': 0.6, 'prompt-engineering': 0.7 },
  },
  {
    canonical: 'prompt-engineering',
    display: 'Prompt engineering',
    category: 'ai',
    aliases: ['prompt engineering', 'prompt design'],
    related: { 'generative-ai': 0.7 },
  },
  {
    // Deliberately separate from 'ai-assisted-dev'. Using an AI assistant to
    // write code and building software that calls an LLM API are different
    // skills, and employers ask for them in different postings.
    canonical: 'llm-integration',
    display: 'LLM application development',
    category: 'ai',
    aliases: ['llm integration', 'llm api', 'openai api', 'anthropic api', 'ai integration',
              'ai agent', 'ai agents', 'agentic', 'rag', 'retrieval augmented generation',
              'llm application', 'genai application', 'ai application development'],
    related: { 'generative-ai': 0.7, 'prompt-engineering': 0.7 },
  },
  {
    canonical: 'ai-productivity',
    display: 'AI productivity tooling',
    category: 'ai',
    aliases: ['ai tools', 'ai productivity', 'ai automation'],
    related: { 'ai-assisted-dev': 0.5 },
  },
  // Kept distinct on purpose. A posting asking for ML engineering must NOT be
  // satisfied by AI-tool fluency -- see match/score.ts, which never awards
  // these from AI-assisted-development evidence.
  { canonical: 'machine-learning', display: 'Machine Learning', category: 'ai', aliases: ['ml', 'deep learning', 'tensorflow', 'pytorch', 'scikit-learn', 'model training', 'mlops'] },
  { canonical: 'data-science', display: 'Data Science', category: 'ai', aliases: ['data scientist', 'statistical modelling'] },
];

const BY_CANONICAL = new Map(TAXONOMY.map((e) => [e.canonical, e]));

/**
 * alias -> canonical. Longer aliases are checked first when scanning free text,
 * so "oracle pl/sql" wins over the substrings "oracle" and "pl/sql".
 */
const ALIAS_INDEX: { needle: string; canonical: string }[] = TAXONOMY.flatMap((entry) => [
  { needle: entry.canonical.replace(/-/g, ' '), canonical: entry.canonical },
  { needle: entry.display.toLowerCase(), canonical: entry.canonical },
  ...entry.aliases.map((alias) => ({ needle: alias.toLowerCase(), canonical: entry.canonical })),
]).sort((a, b) => b.needle.length - a.needle.length);

export const lookup = (canonical: string): TaxonomyEntry | undefined => BY_CANONICAL.get(canonical);

export const display = (canonical: string): string => BY_CANONICAL.get(canonical)?.display ?? canonical;

/** Resolve one skill string to a canonical key, or null when unknown. */
export function canonicalise(raw: string): string | null {
  const text = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  if (BY_CANONICAL.has(text)) return text;
  for (const { needle, canonical } of ALIAS_INDEX) {
    if (text === needle) return canonical;
  }
  return null;
}

/**
 * Find every known skill mentioned in free text (a job description).
 *
 * Matching is word-boundary aware so "R" does not match "React" and "c" does
 * not match every word containing the letter. Punctuation in aliases (`c++`,
 * `pl/sql`) is escaped rather than treated as regex.
 */
export function extractSkills(text: string): string[] {
  const haystack = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  const found = new Set<string>();

  for (const { needle, canonical } of ALIAS_INDEX) {
    if (found.has(canonical)) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Boundaries are "not a word char", which correctly allows "(oracle," and
    // "oracle." while rejecting "oracles" and "myoracle".
    const pattern = new RegExp(`(^|[^a-z0-9+#])${escaped}($|[^a-z0-9+#])`, 'i');
    if (pattern.test(haystack)) found.add(canonical);
  }
  return [...found];
}

/**
 * The same scan as extractSkills, but it keeps the employer's own words.
 *
 * This exists because a canonical key is the wrong thing to put on a resume.
 * A posting that says "RMAN" resolves to the canonical `oracle-rman` whose
 * display name is "Oracle RMAN", and a posting that says "expdp" resolves to
 * one whose display name is "Oracle Data Pump" -- but an applicant tracking
 * system does a literal string search, and a recruiter scanning a stack of
 * resumes is looking for the token they wrote in the advert. Printing our
 * display name instead of theirs loses the match even when the candidate
 * genuinely has the skill, which is the single most expensive thing this app
 * was doing.
 *
 * `surface` is every distinct spelling the posting actually used, in the
 * posting's own casing, longest first. Nothing here decides whether a term may
 * be used -- that is `mirror.ts`, and it requires the candidate to hold the
 * skill. This function only preserves the vocabulary so the decision can be
 * made at all.
 */
export function extractSkillMentions(text: string): { canonical: string; surface: string[] }[] {
  const flat = text.replace(/\s+/g, ' ');
  const out = new Map<string, Set<string>>();

  for (const { needle, canonical } of ALIAS_INDEX) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z0-9+#])(${escaped})($|[^a-z0-9+#])`, 'gi');
    for (const match of flat.matchAll(pattern)) {
      // match[2] is the literal text as the employer wrote it, casing intact.
      const literal = match[2];
      if (!literal) continue;
      const found = out.get(canonical) ?? new Set<string>();
      found.add(literal);
      out.set(canonical, found);
    }
  }

  return [...out].map(([canonical, surface]) => ({
    canonical,
    // Longest first: a posting saying both "Oracle" and "Oracle Database" should
    // offer the more specific spelling as the one worth mirroring.
    surface: [...surface].sort((a, b) => b.length - a.length),
  }));
}

/** How much `have` counts toward a requirement for `want`. 1 = exact. */
export function transferWeight(want: string, have: string): number {
  if (want === have) return 1;
  return lookup(want)?.related?.[have] ?? lookup(have)?.related?.[want] ?? 0;
}
