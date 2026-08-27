/**
 * A valid, empty-ish profile to start from.
 *
 * The profile is hand-written JSON on purpose: parsing a resume automatically is
 * the step most likely to introduce a mistake nobody notices, and everything
 * generated downstream is only as truthful as this file. So the app hands you a
 * skeleton that already satisfies the schema -- including an `evidence` line on
 * every skill, which is the one field that cannot be left out.
 */
const TEMPLATE = {
  version: 1,
  name: 'Your Name',
  headline: 'Software Developer',
  email: 'you@example.com',
  phone: '+00 000 000 000',
  location: 'City, Country',
  links: { linkedin: null, github: null },
  summary:
    'Two or three sentences describing what you actually do, in your own words. This is quoted in cover letters, so write it the way you would say it.',
  totalYears: 0,
  experience: [
    {
      company: 'Employer name',
      title: 'Your job title',
      location: 'City, Country',
      startDate: '2021-01',
      endDate: null,
      current: true,
      context: 'One line on the company and what the team does.',
      bullets: [
        'Something you did, with a number in it if you have one.',
        'Something you built or fixed, and what changed as a result.',
      ],
      skills: ['sql'],
    },
  ],
  skills: [
    {
      name: 'SQL',
      canonical: 'sql',
      category: 'database',
      years: 3,
      level: 'strong',
      evidence: 'REQUIRED. Where this came from: which employer, project, or course, and what you did with it.',
    },
  ],
  projects: [],
  education: [
    {
      qualification: 'BSc Computer Science',
      institution: 'University name',
      startYear: 2016,
      endYear: 2020,
      result: null,
      eqfLevel: 6,
    },
  ],
  certifications: [],
  languages: [{ language: 'English', cefr: 'C1', description: 'Professional working proficiency.' }],
  employmentGaps: [],
  workAuthorisation: {
    euCitizen: false,
    euWorkPermit: false,
    needsSponsorship: true,
    currentCountry: 'Country you are in now',
    notes: 'Anything a recruiter would need to know about your right to work.',
  },
};

export function GET() {
  return new Response(JSON.stringify(TEMPLATE, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="profile.template.json"',
    },
  });
}
