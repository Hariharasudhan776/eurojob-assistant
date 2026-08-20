import {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, TabStopType,
  TabStopPosition, LevelFormat, convertInchesToTwip,
} from 'docx';
import type { CandidateProfile } from '../resume/profile.ts';
import type { CoverLetter, TailoredResume } from '../ai/schemas.ts';

/**
 * DOCX rendering.
 *
 * ATS-safe by construction, which rules out most of what a word processor would
 * do for you: no tables (many parsers read cells column-wise and scramble them),
 * no text boxes, no images, no header or footer, one column, standard fonts, and
 * standard section headings an ATS can map. The layout is plain on purpose --
 * the document has to survive being parsed by software before a person sees it.
 */

const FONT = 'Calibri';
const BODY = 21; // half-points, 10.5pt
const SMALL = 20;
const H2 = 22;
const ACCENT = '1F3864';
const GREY = '3B3B3B';

const run = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}) =>
  new TextRun({ text, font: FONT, size: o.size ?? BODY, bold: o.bold, italics: o.italics, color: o.color ?? '000000' });

const heading = (title: string) =>
  new Paragraph({
    spacing: { before: 260, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, space: 3, color: ACCENT } },
    children: [run(title, { bold: true, size: H2, color: ACCENT })],
  });

const bullet = (text: string) =>
  new Paragraph({
    numbering: { reference: 'doc-bullets', level: 0 },
    spacing: { after: 40 },
    children: [run(text)],
  });

const plain = (text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string; after?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}) =>
  new Paragraph({ spacing: { after: o.after ?? 60 }, alignment: o.align, children: [run(text, o)] });

const numbering = {
  config: [
    {
      reference: 'doc-bullets',
      levels: [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: { indent: { left: convertInchesToTwip(0.22), hanging: convertInchesToTwip(0.16) } },
            run: { font: FONT, size: BODY },
          },
        },
      ],
    },
  ],
};

const pageSetup = {
  page: { size: { width: 12240, height: 15840 }, margin: { top: 720, right: 720, bottom: 720, left: 720 } },
};

function contactHeader(profile: CandidateProfile, headline: string): Paragraph[] {
  const links = [profile.links.linkedin, profile.links.github].filter(Boolean).join('  |  ');
  return [
    new Paragraph({
      spacing: { after: 20 },
      alignment: AlignmentType.CENTER,
      children: [run(profile.name.toUpperCase(), { bold: true, size: 40, color: ACCENT })],
    }),
    plain(headline, { size: SMALL, color: GREY, align: AlignmentType.CENTER, after: 40 }),
    plain([profile.email, profile.phone, links].filter(Boolean).join('  |  '), {
      size: SMALL, align: AlignmentType.CENTER, after: 20,
    }),
    plain(profile.location, { size: SMALL, color: GREY, align: AlignmentType.CENTER, after: 40 }),
  ];
}

/**
 * Render a tailored resume.
 *
 * The AI reorders and rephrases; this function only lays out. Crucially, bullets
 * are looked up from the AI output BY COMPANY and fall back to the profile's own
 * bullets when the AI omitted a role — so a partial AI response can never
 * silently delete a job from the candidate's history.
 */
export async function renderResume(
  profile: CandidateProfile,
  tailored: TailoredResume,
  jobTitle: string,
  company: string
): Promise<Buffer> {
  const children: Paragraph[] = [...contactHeader(profile, profile.headline)];

  children.push(heading('PROFESSIONAL SUMMARY'));
  children.push(plain(tailored.summary, { after: 40 }));

  children.push(heading('TECHNICAL SKILLS'));
  // Only names present in the profile survive. verify.ts already blocks an
  // invented skill, and this is the second gate: a name that is not in the
  // profile cannot reach the page even if verification were bypassed.
  const known = new Map(profile.skills.map((s) => [s.name.toLowerCase(), s]));
  const ordered = tailored.skillOrder.map((n) => known.get(n.toLowerCase())).filter((s): s is NonNullable<typeof s> => Boolean(s));
  const remaining = profile.skills.filter((s) => !ordered.includes(s));
  const grouped = new Map<string, string[]>();
  for (const skill of [...ordered, ...remaining]) {
    const list = grouped.get(skill.category) ?? [];
    list.push(skill.name);
    grouped.set(skill.category, list);
  }
  const LABELS: Record<string, string> = {
    language: 'Languages', database: 'Databases', database_admin: 'Database Administration',
    framework: 'Frameworks & Platforms', erp: 'Enterprise Systems', ai: 'AI & Automation',
    tool: 'Tools', domain: 'Domain Knowledge', os: 'Operating Systems', soft: 'Ways of Working',
  };
  for (const [category, names] of grouped) {
    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [run(`${LABELS[category] ?? category}: `, { bold: true }), run(names.join(', '))],
      })
    );
  }

  children.push(heading('PROFESSIONAL EXPERIENCE'));
  const bulletsByCompany = new Map(tailored.bullets.map((b) => [b.company.toLowerCase(), b.bullets]));
  for (const role of profile.experience) {
    children.push(
      new Paragraph({
        spacing: { before: 160, after: 0 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          run(role.title, { bold: true }),
          run('\t'),
          run(`${formatMonth(role.startDate)} – ${role.endDate ? formatMonth(role.endDate) : 'Present'}`, {
            size: SMALL, color: GREY,
          }),
        ],
      })
    );
    children.push(
      plain(`${role.company}  —  ${role.location}${role.context ? `   ·   ${role.context}` : ''}`, {
        italics: true, size: SMALL, color: GREY, after: 60,
      })
    );
    // Fall back to the candidate's own bullets rather than printing nothing.
    const chosen = bulletsByCompany.get(role.company.toLowerCase()) ?? role.bullets;
    for (const text of chosen) children.push(bullet(text));
  }

  if (profile.projects.length) {
    children.push(heading('SELECTED PROJECTS'));
    const order = new Map(tailored.projectOrder.map((name, i) => [name.toLowerCase(), i]));
    const projects = [...profile.projects].sort(
      (a, b) => (order.get(a.name.toLowerCase()) ?? 99) - (order.get(b.name.toLowerCase()) ?? 99)
    );
    for (const project of projects.slice(0, 5)) {
      children.push(plain(`${project.name} (${project.period})`, { bold: true, after: 20 }));
      children.push(bullet(`${project.stack.join(', ')} — ${project.summary}`));
    }
  }

  children.push(heading('EDUCATION'));
  for (const education of profile.education) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          run(education.qualification, { bold: true }),
          run('\t'),
          run(`${education.startYear} – ${education.endYear}`, { size: SMALL, color: GREY }),
        ],
      })
    );
    children.push(
      plain(`${education.institution}${education.result ? `   ·   ${education.result}` : ''}`, {
        italics: true, size: SMALL, color: GREY,
      })
    );
  }

  if (profile.certifications.length) {
    children.push(heading('CERTIFICATIONS'));
    for (const cert of profile.certifications) {
      children.push(plain(`${cert.name} — ${cert.issuer}, ${cert.date}`, { after: 40 }));
    }
  }

  children.push(heading('LANGUAGES'));
  children.push(plain(profile.languages.map((l) => `${l.language} (${l.description})`).join('   ·   '), { after: 0 }));

  const doc = new Document({
    title: `${profile.name} — ${jobTitle} at ${company}`,
    creator: profile.name,
    description: `Resume tailored for ${jobTitle} at ${company}`,
    styles: { default: { document: { run: { font: FONT, size: BODY }, paragraph: { spacing: { line: 252 } } } } },
    numbering,
    sections: [{ properties: pageSetup, children }],
  });
  return Packer.toBuffer(doc);
}

export async function renderCoverLetter(
  profile: CandidateProfile,
  letter: CoverLetter,
  jobTitle: string,
  company: string
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      spacing: { after: 20 },
      children: [run(profile.name, { bold: true, size: 28, color: ACCENT })],
    }),
    plain([profile.email, profile.phone, profile.location].filter(Boolean).join('  |  '), {
      size: SMALL, color: GREY, after: 240,
    }),
    plain(company, { bold: true, after: 20 }),
    plain(`Re: ${jobTitle}`, { color: GREY, after: 240 }),
    plain(letter.greeting, { after: 160 }),
  ];

  for (const paragraph of letter.paragraphs) {
    children.push(new Paragraph({ spacing: { after: 160 }, children: [run(paragraph)] }));
  }

  children.push(plain(letter.closing, { after: 40 }));
  children.push(plain(profile.name, { bold: true, after: 0 }));

  const doc = new Document({
    title: `Cover letter — ${jobTitle} at ${company}`,
    creator: profile.name,
    styles: { default: { document: { run: { font: FONT, size: BODY }, paragraph: { spacing: { line: 276 } } } } },
    sections: [{ properties: pageSetup, children }],
  });
  return Packer.toBuffer(doc);
}

/** Plain-text resume for the boxes that make you paste rather than upload. */
export function renderResumeText(profile: CandidateProfile, tailored: TailoredResume): string {
  const lines: string[] = [
    profile.name.toUpperCase(),
    profile.headline,
    [profile.email, profile.phone, profile.links.linkedin, profile.links.github].filter(Boolean).join(' | '),
    profile.location,
    '',
    'PROFESSIONAL SUMMARY',
    '',
    tailored.summary,
    '',
    'TECHNICAL SKILLS',
    '',
  ];

  const known = new Map(profile.skills.map((s) => [s.name.toLowerCase(), s]));
  const ordered = tailored.skillOrder.map((n) => known.get(n.toLowerCase())).filter(Boolean);
  const names = [...new Set([...ordered.map((s) => s!.name), ...profile.skills.map((s) => s.name)])];
  lines.push(names.join(', '), '', 'PROFESSIONAL EXPERIENCE', '');

  const byCompany = new Map(tailored.bullets.map((b) => [b.company.toLowerCase(), b.bullets]));
  for (const role of profile.experience) {
    lines.push(`${role.title} | ${formatMonth(role.startDate)} - ${role.endDate ? formatMonth(role.endDate) : 'Present'}`);
    lines.push(`${role.company}, ${role.location}`);
    for (const text of byCompany.get(role.company.toLowerCase()) ?? role.bullets) lines.push(`- ${text}`);
    lines.push('');
  }

  lines.push('EDUCATION', '');
  for (const e of profile.education) {
    lines.push(`${e.qualification} | ${e.startYear} - ${e.endYear}`, `${e.institution}${e.result ? ` | ${e.result}` : ''}`, '');
  }
  if (profile.certifications.length) {
    lines.push('CERTIFICATIONS', '');
    for (const c of profile.certifications) lines.push(`${c.name} - ${c.issuer}, ${c.date}`);
    lines.push('');
  }
  lines.push('LANGUAGES', '', profile.languages.map((l) => `${l.language} (${l.description})`).join('; '));
  return lines.join('\r\n');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatMonth(value: string): string {
  const [year, month] = value.split('-').map(Number);
  if (!year || !month) return value;
  return `${MONTHS[month - 1]} ${year}`;
}
