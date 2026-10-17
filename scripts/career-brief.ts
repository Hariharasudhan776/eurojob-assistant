/** Read-only cloud career brief. No AI calls, applications or social publishing. */
import { appendFile, writeFile } from 'node:fs/promises';
import { getPool } from '../src/lib/db/pool.ts';

const portfolio = 'https://hariharasudhan776.github.io/';
const safe = (value: unknown) => String(value ?? 'Not stated').replace(/[\r\n|<>\[\]]/g, ' ').slice(0, 220);
const safeUrl = (value: unknown) => { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href.replace(/[()]/g, c => encodeURIComponent(c)) : ''; } catch { return ''; } };
const sponsor = (value: string) => value === 'yes' ? 'Stated by source; confirm with employer' : value === 'no' ? 'No' : 'Unknown — ask employer';
const now = new Date();
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short' }).format(now);
const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' }).format(now);
const posts = [
  `An approval email needs to work where the approver reads it.\n\nWhile working on an ERP material-requisition notification, I encountered a layout that looked fine on desktop but hid item columns on Android. My redesign direction is to let descriptions wrap and present quantities as labelled values, rather than relying on an internally scrolling table.\n\nThe next check is the real inbox. A browser preview alone cannot prove an email works for its recipients.\n\nFor business applications, readability is part of the workflow.`,
  `When a SQL query is slow, I want to see the execution plan before deciding it needs another index.\n\nIn my PostgreSQL performance lab, I built eight reproducible cases with before-and-after EXPLAIN ANALYZE evidence. Some fixes add indexes. Others change the query.\n\nThe useful part is being able to rerun the benchmark and inspect what changed. Lab measurements still need context before being applied to production.\n\nhttps://github.com/Hariharasudhan776/pg-perf-lab`,
  `A budget warning is useful. A complete exception workflow is more useful.\n\nIn ERP budget-control work, the interesting questions come after an order exceeds its budget: who can revise the budget, what happens to approval, and how can someone understand the change later?\n\nThose questions connect interface design, permissions, database rules and audit history. That is one reason I enjoy building business applications end to end.`,
  `I want a job-search assistant to be honest about what it does not know.\n\nIn my EuroJob project, sponsorship is treated as yes, no or unknown. A posting that says nothing about visas is not a promise, but it is not automatically a rejection either.\n\nKeeping those states separate makes the next action clearer: apply, ask, or move on.\n\nhttps://github.com/Hariharasudhan776/eurojob-assistant`,
  `A useful data answer should be traceable.\n\nIn my ERP stock-assistant work, the interface shows the SQL and results behind an answer. The query layer is read-only and access follows the user's ERP roles.\n\nA convenient interface still needs the same boundaries as the system behind it.`,
  `One part of software development I value is following a feature past the first successful demo.\n\nWhat happens when a required value is missing? When a query fails? When a user does not have permission? When someone needs support next month?\n\nERP and retail application work keeps bringing me back to those questions. They influence both the implementation and the documentation.`,
  `A fast query and a correct query are separate things to check.\n\nWhen comparing two SQL approaches, I want the same result set, a visible execution plan, and a repeatable measurement. Otherwise a smaller number can hide a changed question.\n\nThat is the discipline I am practising in my PostgreSQL performance lab.\n\nhttps://github.com/Hariharasudhan776/pg-perf-lab`,
  `I have published a portfolio covering business applications, database engineering and personal projects.\n\nThe case studies explain the problem, the approach and the engineering decisions, with enterprise work described without publishing company data.\n\nI am interested in software development opportunities internationally, especially where business workflows and data meet.\n\n${portfolio}`,
];

async function main() {
  const pool = getPool();
  const lines = [`# Career briefing — ${stamp} GST`, '', `Portfolio: ${portfolio}`, '', 'This briefing runs on GitHub, independent of a personal computer. Matches are recommendations, not hiring probabilities. Source flags are not employer confirmations.', ''];
  const email = process.env.CAREER_USER_EMAIL || 'hariharasudhan776@gmail.com';
  try {
    const { rows: users } = await pool.query(`SELECT u.id, p.id AS profile_id, p.version, p.created_at FROM users u JOIN LATERAL (SELECT id,version,created_at,data FROM profiles WHERE user_id=u.id ORDER BY version DESC LIMIT 1) p ON true WHERE lower(u.email)=lower($1) OR lower(p.data->>'email')=lower($1)`, [email]);
    if (users.length !== 1) throw new Error('The intended candidate profile was not found. Set CAREER_USER_EMAIL to the correct existing account.');
    const profile = users[0];
    lines.push(`Profile version: ${profile.version}. No profile changes were made.`, '');
    const { rows } = await pool.query(`SELECT j.title,j.company,j.country,j.city,j.url,j.visa_sponsorship,j.relocation_support,j.posted_at,j.collected_at,j.last_seen_at,m.overall,m.missing_skills,m.strong_matches FROM matches m JOIN jobs j ON j.id=m.job_id WHERE m.profile_id=$1 AND j.duplicate_of IS NULL AND j.closed_at IS NULL AND j.visa_sponsorship <> 'no' AND m.overall >= 65 AND (j.role_category IN ('database','erp','backend','fullstack','frontend','mobile') OR j.title ~* '(software|application|dotnet|pl.?sql|c#|postgres|oracle|full.?stack|backend|front.?end).*(engineer|developer)|((engineer|developer).*(software|application|dotnet|pl.?sql|c#|postgres|oracle|full.?stack|backend|front.?end))') AND j.title !~* '(native language|native dutch|native german|native french|dutch-speaking|german-speaking|french-speaking|robotic|embedded|firmware|quantum|customer support|value engineer|sales engineer|director|head of|staff |principal |chief |security clearance)' AND j.title !~* '(internship|working student|werkstudent)' AND j.country IS NOT NULL AND j.collected_at >= now()-interval '24 hours' AND coalesce(j.country,'') !~* '^(Bahrain|Kuwait|Oman|Qatar|Saudi Arabia|United Arab Emirates|UAE|SA|AE|OM|QA|KW|BH)$' AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.user_id=$2 AND a.job_id=j.id) ORDER BY CASE WHEN lower(j.country) IN ('germany','netherlands','ireland','luxembourg','de','nl','ie','lu') THEN 0 ELSE 1 END,m.overall DESC,j.collected_at DESC LIMIT 5`, [profile.profile_id, profile.id]);
    lines.push('## Newly collected matches', '', 'Only postings first collected in the last 24 hours are included, so older vacancies are not endlessly recycled. A manual rerun within that window can repeat today’s results. Review location, language and eligibility on the employer page before applying.', '');
    if (!rows.length) lines.push('No new eligible matches met the threshold in this collection window. This is not evidence that no suitable vacancies exist.', '');
    for (const [i, job] of rows.entries()) {
      const link=safeUrl(job.url);
      lines.push(`### ${i+1}. ${safe(job.title)} — ${safe(job.company)}`, '', `- Location: ${safe(job.city)}, ${safe(job.country)}. Do not assume remote permits work from Oman.`, `- Match score: ${job.overall}/100.`, `- Sponsorship: ${sponsor(job.visa_sponsorship)}. Relocation: ${sponsor(job.relocation_support)}.`, `- Matching skills: ${(job.strong_matches || []).slice(0,8).map(safe).join(', ') || 'Review the application'}.`, `- Gaps: ${(job.missing_skills || []).slice(0,8).map(safe).join(', ') || 'No gaps extracted; still review the full requirements'}.`, `- Source first collected: ${new Date(job.collected_at).toISOString()}; last seen: ${job.last_seen_at ? new Date(job.last_seen_at).toISOString() : 'unknown'}.`, `- ${link ? `[Open original posting](${link})` : 'Original link unavailable'}`, '');
    }
    lines.push('## Germany networking queue', '', 'Prepared automatically from new German job matches. Search links identify possible contacts, not verified recruiters or sponsorship offers. Open a profile, check relevance and existing invitations, then send through LinkedIn. No invitations or messages are sent by this workflow.', '');
    const employers = [...new Set(rows.filter(job => ['de', 'germany'].includes(String(job.country).toLowerCase())).map(job => String(job.company || '').trim()).filter(Boolean))].slice(0, 3);
    if (!employers.length) lines.push('No new German employer targets in this shortlist today. Check previously saved targets instead of sending unrelated invitations.', '');
    for (const company of employers) {
      const search = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(company + ' talent acquisition Germany software');
      const shortCompany = safe(company).slice(0, 45);
      const note = `Hi [Name], I saw a software opening at ${shortCompany}. I build C#/.NET and database applications and am exploring roles in Germany. I would be glad to connect. Best, Hari`;
      lines.push(`### Networking target: ${safe(company)}`, '', `- [Find relevant hiring contacts](${search})`, '- Look for a Germany-based technical recruiter, engineering manager or software/data team member at this employer.', `- Note draft (replace [Name], keep within the displayed limit): ${note}`, '- Record who you invited and the date. A pending invitation is not an accepted connection.', '');
    }
    if (rows.length) lines.push('## Application preparation', '', 'For the best credible match, use the project case studies and current approved CV. Confirm hands-on requirements before tailoring. No application was submitted and no qualifications were generated.', '');
  } catch(error) {
    lines.push('## Collection/profile check needs attention', '', safe(error instanceof Error && error.message.startsWith('The intended') ? error.message : 'Could not read the current job matches. Check the workflow configuration and database availability; no candidate data was changed.'), '');
    process.exitCode = 1;
  } finally { await pool.end(); }
  if (day === 'Mon' || day === 'Thu' || process.env.INCLUDE_POST_DRAFT === '1') {
    const index = Math.floor((now.getTime()-Date.UTC(2026,9,19))/(7*86400000))*2+(day==='Thu'?1:0);
    const draft = posts[((index%posts.length)+posts.length)%posts.length];
    lines.push('## LinkedIn post draft — review before publishing', '', draft, '', 'Review current implementation status and confidentiality before posting. Schedule through LinkedIn’s native scheduler. Nothing has been published.', '');
  }
  lines.push('## Your next actions', '', 'Review the shortlist, select a credible vacancy, tailor the CV, and track the application in EuroJob. Keep LinkedIn Featured and contact details pointed to the portfolio. Review the Germany networking queue and send relevant invitations through LinkedIn. Publishing, recruiter messaging and connection requests are not sent by this workflow.', '');
  const output=lines.join('\n');
  await writeFile('career-brief.md',output);
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,output);
  console.log('Career brief written. No applications, social actions or AI calls were made.');
}
main().catch(()=>{console.error('Career brief failed; check the workflow and database configuration.');process.exitCode=1;});
