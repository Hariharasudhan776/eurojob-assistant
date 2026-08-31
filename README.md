# Job Assistant

**A job-search assistant: collects real postings from around the world, scores them against your actual resume with explainable arithmetic, and writes tailored resumes and cover letters that cannot claim anything you can't back up.**

Runs on your own machine, or on a host you control. Several people can share one
instance and see nothing of each other's: separate profiles, separate scores,
separate documents, separate AI spend.

---

## Quick start

You need **Node 22+** and **PostgreSQL 13+**.

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in **three** things (everything else has a working default):

| Variable | Where to get it | Needed for |
|---|---|---|
| `PGPASSWORD` | your local PostgreSQL password (leave blank if your `pg_hba.conf` says `trust`) | everything |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | signing in |
| `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) → API keys | AI features only |
| `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` | [developer.adzuna.com](https://developer.adzuna.com) — free | more job coverage (optional) |

Then:

```bash
npm run db:migrate     # creates the database, applies both migrations, loads any local profile
npm run sync           # collects and scores real jobs — costs nothing
npm run dev            # open http://localhost:3000
```

Open the app and **create an account**: an email, a password, and your profile as
JSON (there is a template linked on the page). Everything else follows from that
profile — there is nothing to score against without it.

Deploying it instead? [DEPLOY.md](DEPLOY.md) covers Neon and Vercel.

`npm run sync` uses **no AI and costs nothing**. It found 732 jobs on the first run here, when it was still restricted to Europe.

---

## Accounts, and what is shared

**Jobs are shared. Everything derived from a person is not.**

A posting is public data, and fetching every job board once per account would multiply the requests for identical results. So the feed is collected once, for everyone.

Scores are not shared, because a score is a statement about one person: every match records the profile version that produced it, and every query that reads a match joins through the caller's own profile. Applications, generated documents, notifications and AI spend are the same. There is no query shape in `repo.ts` that can return another user's data — isolation is structural, not a filter someone has to remember to add.

Signing up takes an email, a password, and a profile JSON file. The profile is required at signup rather than optional afterwards, because there is nothing to score against, no evidence to write from, and no dashboard to show without one.

Two commands you may need:

```bash
npm run user:password -- you@example.com "a long passphrase"   # set or reset a password
npm run db:copy -- --write                                     # copy a local database to a managed one
```

The first is also how you adopt the account the CLI created before sign-in existed: it owns the profile and history from that era, and setting a password keeps all of it rather than abandoning it behind an account nobody can reach.

## The three commands you will actually use

```bash
npm run sync                    # refresh jobs, score for every user. Free. Run it daily.
npm run sync -- --explain 5     # also write verdicts for the top 5. About $0.05 total.
npm run dev                     # the web app
```

`sync` scores the whole feed against **every** registered profile, because scoring is arithmetic and costs nothing. `--explain` spends money, so it runs for one user — `APP_USER_EMAIL` by default, or `--user someone@example.com` — and is charged to that person's own daily cap.

Everything else happens in the browser.

### Keep it fed automatically (Windows)

```bash
schtasks /create /tn "EuroJob sync" /tr "cmd /c cd /d C:\Users\ITS44\Desktop\Work\eurojob-assistant && npm run sync" /sc daily /st 07:00
```

On Linux or macOS, the cron equivalent:

```bash
0 7 * * * cd /path/to/eurojob-assistant && npm run sync
```

---

## What it costs, measured

| Action | Measured cost | Model |
|---|---:|---|
| Collecting and scoring **every** job | **$0.00** | none — plain code |
| Explaining one match | **$0.009** | Claude Haiku 4.5 |
| One cover letter | **$0.041** | Claude Sonnet 5 |
| One tailored resume | **$0.115** | Claude Sonnet 5 |

Realistic month: triage 100 jobs (~$0.90) plus documents for 10 real applications (~$1.60) — **about $2.50**.

### It cannot run away

Three caps, all checked **before** a request is sent:

```
AI_MAX_RUN_USD=0.50     one command can never spend more than this
AI_MAX_DAILY_USD=2.00   PER USER, rolling 24 hours
AI_MAX_CALL_USD=0.35    absurdity check on a single request
```

Hitting a cap aborts and tells you which one. Work already done is kept and cached, so re-running picks up where it stopped **for free**.

The daily cap is **per user**, not per instance: every account has its own $2 a day, so one person generating tailored resumes all afternoon cannot spend anyone else's allowance. Spend lives in the `ai_spend` table — one row per billed call — rather than in memory or a JSON file, so separate commands can't each start from zero and a host with no writable disk can't quietly lose the cap. Each charge is written **before** the response is sent, because a serverless function can be frozen the moment it responds and an unrecorded charge is a cap that stopped applying. Watch it on the **Settings** page.

Every AI answer is cached by content hash — on disk locally, in the `ai_cache` table when the host has no writable disk. Re-analysing a job you already analysed costs nothing, and the same posting arriving from a second job board reuses the first answer.

---

## How matching works, and why it isn't an AI guess

**The score is computed in code, not asked of a model.** Six components, each returning the facts that produced it:

```
Overall 82%
  Technical skills   64   5 of 8 required skills matched exactly
  Experience         91   asks for 3+ years, profile has 5.2
  Education         100   requires bachelors, profile has BSc
  Location & visa    95   in DE, one of the target countries
  Language          100   requires English, covered
  AI / modern tools  70   posting does not mention AI tooling
```

Three reasons it works this way:

- **Explainable.** Every number traces to a stated fact. "The model said 87" cannot be argued with; "5 of 8 required skills matched, these three are missing" can.
- **Consistent.** The same job and profile always produce the same score, so ranking means something.
- **Free.** Scoring costs nothing, so *every* collected job gets scored and the AI is reserved for the few worth writing about.

The AI layer sits **after** this. It explains and writes; it never scores and never decides.

### Things it deliberately gets right

- **Non-engineering roles are filtered out.** A "Junior Community Manager / Social Media" posting once scored 89% because its description mentioned "reporting". A role must now require at least one genuinely technical skill, and a non-technical title caps the result regardless of keyword overlap. 337 of 732 jobs get filtered on a typical run.
- **Thin evidence is discounted.** One matched requirement out of one is *less* evidence than seven out of ten, not more. Coverage ratios are shrunk toward a neutral prior.
- **Visa sponsorship is three-valued.** `yes` / `no` / `not specified`. "Not specified" is the most common answer and it means *ask*, not *rejected*. An explicit "we cannot sponsor" is a blocker that caps the recommendation however good the technical fit.
- **Language requirements written in German are detected.** `Du kommunizierst sicher auf Deutsch und Englisch (mind. C1)` is a hard C1 German requirement. An English-only keyword list misses it, and for a search aimed at Germany that is most of the market. "Deutschland Ticket" in a benefits list is correctly *not* treated as a language requirement.
- **Truncated postings are marked.** Adzuna returns only the first 500 characters. Those jobs are flagged low-confidence and the app refuses to report "missing skills" for them, because a requirement absent from a snippet is not an absent requirement.
- **The role filter reads titles, not keywords.** "Senior Database Reliability Engineer" is a database job, not an SRE one; `PL/SQL`, `PL-SQL` and `PL SQL` are the same job; `Softwareentwickler` and `Datenbankadministrator` are classified rather than dumped in "other". And `role_category` being NULL ("never classified") is kept distinct from `other` ("classified, fits nothing named") — the same discipline as "no sponsorship" versus "sponsorship not stated".

---

## The truthfulness rule, enforced twice

Generated documents may **reorder, rephrase, and emphasise**. They may not add anything.

1. **By instruction** — every prompt carries the rule.
2. **By inspection** — `src/lib/ai/verify.ts` re-reads whatever the model produced and checks it against your profile. Anything unevidenced is reported and the document is marked unsafe to send.

A prompt is a request. The verifier is the guarantee.

It blocks: a named technology absent from your profile, a years-of-experience figure above what your dates support, and any claim about work authorisation.

It deliberately **allows** — and these took real work to get right:

- *"No NoSQL experience of any kind is recorded"* — an honest gap, not a MongoDB claim.
- *"Migrated 15+ years of transactional data"* — years of **data**, not years of career.
- *"At Meridian I did query optimisation"* — Meridian is your **employer**, not a Scrum claim.
- *"The posting lists NoSQL as a requirement"* — quoting the **employer**, not claiming the skill.
- *"If cloud is a day-one requirement, I am a partial match"* — a **hypothetical** about a gap.

A verifier that fires on honest text is worse than none, because a wall of false positives trains you to click past the real one.

**What it cannot catch:** a subtle exaggeration of scope in prose — "led" versus "contributed to". That needs your eyes, which is why every generated document is shown to you before it can be downloaded.

---

## Using the app

**Dashboard** — counts, and your best matches.

**Jobs** — filter by score, **country**, **role**, working mode, verdict, or sponsorship. Search by title or company.

The country and role dropdowns are built from what the database actually holds, with counts: `Germany (395)`, `Database / DBA (115)`. A global feed makes a hardcoded list of 200 countries useless, and the options should never offer a filter that returns nothing.

**Job detail** — the full score breakdown with the reasons behind each component, strong / transferable / missing skills, blockers, and buttons to:

- **Explain match** (~$0.01) — a plain verdict: apply now, soon, or skip
- **Cover letter** (~$0.05)
- **Tailored resume** (~$0.16)
- **Download .docx** — ATS-safe: no tables, no text boxes, no images, no headers

Each button states its cost before you press it.

**Applications** — the pipeline. Every stage change is recorded with a timestamp, so "when did this reach interview" is always answerable.

**My Profile** — every skill with the evidence behind it. This is the source of truth for everything generated. Upload a new version here; the old one is kept, and the feed is re-scored against the new one for free.

**Settings** — your spend against your cap, your target countries, models per stage, source health.

---

## Editing your profile

In the app: **My Profile → upload**. It is validated, saved as the next version, and the feed is re-scored against it.

Locally you can also keep using files: `data/profile.v3.json`, copied to `profile.v4.json`, edited, then `npm run db:migrate`.

Versioning is the point: every match records which profile version scored it, so an old result stays explainable against the facts that were true at the time.

**Every skill needs an `evidence` field.** A skill without one cannot be loaded — that constraint is what stops generated documents from drifting.

```json
{
  "name": "PostgreSQL",
  "canonical": "postgresql",
  "category": "database",
  "years": 3,
  "level": "strong",
  "evidence": "RetailForge: designed and maintained schemas, optimised queries and indexes."
}
```

Levels are `expert`, `strong`, `working`, `familiar` — the matcher weights depth, so these matter.

## Changing what is searched

`src/lib/search-config.ts` — job titles and keywords.

**Collection is not restricted by country.** `DEFAULT_SEARCH.countries` is empty, which means "everywhere the sources reach"; deciding for you that nothing outside Europe was worth seeing belonged to you, not to the collector. Filter by country on the Jobs page instead.

Scoring is a different question: the location component rewards jobs in **your target countries**, which is a per-user setting on the Settings page (defaulting to `DEFAULT_TARGET_COUNTRIES`). Scoring against "everywhere" would make that component a constant.

Titles are deliberately broad. Searching only your current title would miss most of the roles you actually fit, so an Oracle developer is also searched as Database Developer, Database Engineer, ERP Consultant, Backend Developer, and so on.

## Adding a job source

Implement `JobSource` in `src/lib/jobs/sources/`, add one line to `src/lib/jobs/registry.ts`. Nothing downstream knows how many sources there are.

**Current sources:**

| Source | Key | Coverage | Descriptions |
|---|---|---|---|
| Arbeitnow | none | strong German and EU | full |
| Adzuna | free | 21 countries: GB DE NL FR PL AT BE CH IT ES US CA AU NZ ZA SG IN BR MX RU AR | first 500 characters only |
| The Muse | none (optional) | **Ireland** — Dublin, Cork, Galway — plus the Nordics and the Gulf | full |
| Jobicy | none | worldwide **remote** | full |

**The Muse exists to close the Ireland gap.** Adzuna operates no Irish endpoint, and Ireland is the most valuable market for a non-EU English-speaking candidate: the Critical Skills Employment Permit is a real sponsorship route. A search that silently omitted it was omitting the best odds in the feed.

**Jobicy exists to close the remote gap.** Adzuna serves no Gulf country, no Nordic country, no Ireland, no Luxembourg and no Portugal — eleven of the countries in the default target list — and the other two sources reach them thinly. Jobicy does not fix that country by country; it covers the one category where the employer's country is not a visa question at all. For a candidate who needs sponsorship, remote work is not a consolation prize.

**Adzuna asks for date order, not relevance order.** This is the single most consequential line in the collector. Adzuna sorts by relevance when `sort_by` is omitted, and relevance is unrelated to recency — measured on the live API, the first relevance-ranked result for this search was 12 days old in Germany and 30 days old in the UK. Reading the first pages of a relevance ranking therefore returns the same settled postings every day and never today's, which is why Adzuna's own (date-ordered) alert emails carried jobs the app had never shown. With `sort_by=date` a daily run is complete by construction.

**Rules for any new source:** public APIs and feeds only. No CAPTCHA solving, no login bypass, no paywall circumvention, no scraping a site whose terms forbid it. Adzuna truncates descriptions to 500 characters and this app does *not* follow through to the employer page to get the rest, on purpose.

---

## Deploying it

Full steps in **[DEPLOY.md](DEPLOY.md)** — Neon for the database, Vercel for the app, and the copy script that moves your local data across without deleting anything.

The blocker that used to be here is gone: **there is real authentication now.** Passwords are bcrypt, the session cookie is a signed `httpOnly` JWT backed by a `sessions` row that sign-out revokes, and every query that touches a score joins through the caller's own profile, so no query shape can return another user's data.

What is still missing before you hand the URL to strangers, stated plainly:

- **No email verification and no rate limiting on sign-in.** Anyone who can reach the URL can create an account, and each account can spend its own $2/day of *your* API credit.
- **No password reset by email**, because nothing sends mail. `npm run user:password -- <email> "<password>"` on the server is the substitute.
- **No admin interface.** Accounts are managed with SQL and the CLI.

Other than that: set every secret as a host environment variable, never commit `.env`, use a managed PostgreSQL, and keep the spend caps.

## Testing

```bash
npm test         # 59 tests: matching, parsing, verification, roles, uploads, locations
npm run typecheck
npm run build
```

Most of these tests exist because something was actually wrong. The regression tests use the exact text that produced the bug — the social-media posting that scored 89%, the German C1 requirement that was missed, the honest sentence the verifier blocked.

## Layout

```
src/lib/auth.ts               passwords, sessions, requireUser
src/lib/auth-edge.ts          the cookie half that middleware can run
src/middleware.ts             redirect anonymous visitors (a convenience, not the boundary)
src/lib/resume/profile.ts     the profile schema; every skill needs evidence
src/lib/resume/upload.ts      accepting a profile over HTTP, with the same rule
src/lib/match/taxonomy.ts     skill vocabulary, aliases, transferability
src/lib/match/relevance.ts    is this even a software role
src/lib/match/roles.ts        what KIND of role it is, for the role filter
src/lib/match/score.ts        the six-component scorer
src/lib/match/rescore.ts      score the shared feed against one user, in batches
src/lib/jobs/types.ts         the JobSource interface, and the country names
src/lib/jobs/parse.ts         location, visa, language, experience extraction
src/lib/jobs/sources/         one file per job board (arbeitnow, adzuna, themuse, jobicy)
src/lib/jobs/lifecycle.ts     when a posting stops counting as open, and why not more than that
src/lib/ai/prompts.ts         prompts, with the truthfulness rule
src/lib/ai/verify.ts          checks generated text against the profile
src/lib/ai/budget.ts          spend caps, per user
src/lib/ai/cache.ts           content-addressed cache, on disk or in the database
src/lib/docs/render.ts        ATS-safe DOCX
src/lib/db/repo.ts            all SQL, and where per-user isolation is enforced
src/app/                      the web UI
db/001_schema.sql             the schema, with reasoning in comments
db/002_multiuser_global.sql   auth, per-user spend, role categories
scripts/                      migrate, sync, set-password, copy-to-remote
```

## What is not built

Being explicit, because a tool that pretends to be finished is worse than one that says where it stops:

- **No email verification, password reset, or sign-in rate limiting.** Authentication itself is real; these three are not built. See [DEPLOY.md](DEPLOY.md).
- **No email or push notifications.** The threshold is stored; the sending is not built. The dashboard is the notification.
- **No PDF export.** DOCX and plain text only. Word, Google Docs, and LibreOffice all export PDF in one click.
- **No résumé parsing.** You upload JSON, not a .docx. This is deliberate: automatic parsing of your own resume is the step most likely to introduce an error you would not notice, and everything generated downstream is only as truthful as this file.
- **Salary data is thin.** Most European postings simply do not state it.
- **The visa and relocation flags read what the posting says.** They are not immigration advice, and "not specified" genuinely means unknown.

## License

MIT. It's yours.
