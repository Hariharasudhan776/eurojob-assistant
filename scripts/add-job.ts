/**
 * Pull specific postings from one company board into the database and score
 * them, for vacancies the daily sweep missed (it stops at its job limit before
 * reaching boards late in ATS_BOARDS).
 *
 *   npm run job:add -- greenhouse adyen 8163866 6919020
 *   npm run job:add -- ashby supabase 9f2ba0b2
 *   npm run job:add -- file jobs.json       postings copied from a page (e.g. LinkedIn):
 *                                            [{ id, url, title, company, location, description }]
 *
 * The ids match anywhere in the posting URL. Prints the stored job ids.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fetchAshby, fetchGreenhouse, fetchLever, normalise } from '../src/lib/jobs/sources/ats.ts';
import { parseLocation } from '../src/lib/jobs/parse.ts';
import type { AtsPlatform } from '../src/lib/jobs/sources/ats-boards.ts';
import { contentHash } from '../src/lib/jobs/parse.ts';
import { latestProfile, saveMatches, upsertJob } from '../src/lib/db/repo.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { targetCountriesFor } from '../src/lib/match/rescore.ts';
import { getPool } from '../src/lib/db/pool.ts';

const [platform, slug, ...ids] = process.argv.slice(2) as [AtsPlatform | 'file', string, ...string[]];
if (!slug || (platform !== 'file' && ids.length === 0)) throw new Error('usage: npm run job:add -- <greenhouse|lever|ashby> <board-slug> <id>... | file <jobs.json>');

interface CopiedJob { id: string; url: string; title: string; company: string; location: string; description: string }
const fetchers = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby } as const;
const wanted =
  platform === 'file'
    ? (JSON.parse(readFileSync(slug, 'utf8')) as CopiedJob[]).map((j) =>
        normalise({ slug: `copied:${j.id}`, url: j.url, title: j.title, company: j.company, ...parseLocation(j.location), locationText: j.location, description: j.description, postedAt: new Date(), raw: j })
      )
    : await (async () => {
        const fetcher = fetchers[platform as keyof typeof fetchers];
        if (!fetcher) throw new Error(`unsupported platform: ${platform}`);
        return (await fetcher({ platform, slug, name: slug })).filter((j) => ids.some((id) => j.url.includes(id)));
      })();
const profile = await latestProfile(1);
if (!profile) throw new Error('no profile');
const preferredCountries = await targetCountriesFor(1);

const entries = [];
for (const job of wanted) {
  const jobId = await upsertJob(job, contentHash(job));
  entries.push({ jobId, match: scoreJob(profile.data, job, { preferredCountries }) });
  console.log(`${jobId} | ${job.title} | ${job.company} | ${job.url}`);
}
await saveMatches(profile.id, entries);
if (platform !== 'file' && wanted.length < ids.length) console.log(`found ${wanted.length} of ${ids.length} ids on ${platform}/${slug}`);
await getPool().end();
