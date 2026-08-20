# EuroJob Assistant

**A personal European job-search assistant: collects real postings, scores them against your actual resume with explainable arithmetic, and writes tailored resumes and cover letters that cannot claim anything you can't back up.**

Runs on your own machine. Your resume, your API key, your database, no third party involved.

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
| `ANTHROPIC_API_KEY` | [platform.claude.com](https://platform.claude.com) → API keys | AI features only |
| `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` | [developer.adzuna.com](https://developer.adzuna.com) — free | more job coverage (optional) |

Then:

```bash
npm run db:migrate     # creates the database, applies the schema, loads your profile
npm run sync           # collects and scores real jobs — costs nothing
npm run dev            # open http://localhost:3000
```

`npm run sync` uses **no AI and costs nothing**. It found 732 jobs on the first run here.

---

## The three commands you will actually use

```bash
npm run sync                    # refresh jobs and scores. Free. Run it daily.
npm run sync -- --explain 5     # also write verdicts for the top 5. About $0.05 total.
npm run dev                     # the web app
```

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
AI_MAX_DAILY_USD=2.00   all runs together, rolling 24 hours
AI_MAX_CALL_USD=0.35    absurdity check on a single request
```

Hitting a cap aborts and tells you which one. Work already done is kept and cached, so re-running picks up where it stopped **for free**. The daily figure lives in `data/ai-spend.json`, not in memory, so separate commands can't each start from zero. Watch it on the **Settings** page.

Every AI answer is cached on disk by content. Re-analysing a job you already analysed costs nothing, and the same posting arriving from a second job board reuses the first answer.

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

**Jobs** — filter by score, country, working mode, verdict, or sponsorship. Search by title or company.

**Job detail** — the full score breakdown with the reasons behind each component, strong / transferable / missing skills, blockers, and buttons to:

- **Explain match** (~$0.01) — a plain verdict: apply now, soon, or skip
- **Cover letter** (~$0.05)
- **Tailored resume** (~$0.16)
- **Download .docx** — ATS-safe: no tables, no text boxes, no images, no headers

Each button states its cost before you press it.

**Applications** — the pipeline. Every stage change is recorded with a timestamp, so "when did this reach interview" is always answerable.

**My Profile** — every skill with the evidence behind it. This is the source of truth for everything generated.

**Settings** — spend against the cap, models per stage, source health.

---

## Editing your profile

`data/profile.v3.json`. To change it, copy to `profile.v4.json`, edit, and re-run `npm run db:migrate`.

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

`src/lib/search-config.ts` — countries, job titles, keywords.

Titles are deliberately broad. Searching only your current title would miss most of the roles you actually fit, so an Oracle developer is also searched as Database Developer, Database Engineer, ERP Consultant, Backend Developer, and so on.

## Adding a job source

Implement `JobSource` in `src/lib/jobs/sources/`, add one line to `src/lib/jobs/registry.ts`. Nothing downstream knows how many sources there are.

**Current sources:** Arbeitnow (no key, good German and EU coverage) and Adzuna (free key, DE/NL/AT/CH/FR/IT/ES/PL/GB/BE).

**Known gap:** Adzuna does not cover **Ireland, Sweden, Denmark, Norway or Luxembourg**. Ireland matters — English-speaking with a Critical Skills permit route.

**Rules for any new source:** public APIs and feeds only. No CAPTCHA solving, no login bypass, no paywall circumvention, no scraping a site whose terms forbid it. Adzuna truncates descriptions to 500 characters and this app does *not* follow through to the employer page to get the rest, on purpose.

---

## Deploying it publicly

It works on your machine as-is. Before putting it on the internet, **read this**:

> **There is no authentication.** `APP_USER_EMAIL` in `.env` decides who you are. That is a deliberate choice for a single-user tool bound to localhost — a password form protects nothing there. Exposed publicly, **anyone who finds the URL gets your resume, your job data, and a button that spends your API credit.**

To deploy safely you must add real authentication first. The `users` and `sessions` tables already exist, so no migration is needed. Then:

- Set every `.env` value as host environment variables. Never commit `.env`.
- Use a managed PostgreSQL instance (Neon, Supabase, RDS).
- Keep the spend caps — they are your protection against a runaway loop.
- The app is a standard Next.js 15 build: `npm run build && npm start`. It runs anywhere Node runs — Vercel, Fly.io, Railway, a VPS, Docker.

Honestly: for one person searching for a job, running it locally is better. Nothing here benefits from being on the internet.

---

## Testing

```bash
npm test         # 35 tests: matching, parsing, verification
npm run typecheck
npm run build
```

Most of these tests exist because something was actually wrong. The regression tests use the exact text that produced the bug — the social-media posting that scored 89%, the German C1 requirement that was missed, the honest sentence the verifier blocked.

## Layout

```
src/lib/resume/profile.ts     the profile schema; every skill needs evidence
src/lib/match/taxonomy.ts     skill vocabulary, aliases, transferability
src/lib/match/relevance.ts    is this even a software role
src/lib/match/score.ts        the six-component scorer
src/lib/jobs/types.ts         the JobSource interface
src/lib/jobs/parse.ts         location, visa, language, experience extraction
src/lib/jobs/sources/         one file per job board
src/lib/ai/prompts.ts         prompts, with the truthfulness rule
src/lib/ai/verify.ts          checks generated text against the profile
src/lib/ai/budget.ts          spend caps
src/lib/ai/cache.ts           on-disk cache
src/lib/docs/render.ts        ATS-safe DOCX
src/lib/db/repo.ts            all SQL
src/app/                      the web UI
db/001_schema.sql             the schema, with reasoning in comments
scripts/                      migrate, sync, and CLI analysis
```

## What is not built

Being explicit, because a tool that pretends to be finished is worse than one that says where it stops:

- **No authentication.** See the deployment warning.
- **No email or push notifications.** The threshold is stored; the sending is not built. The dashboard is the notification.
- **No PDF export.** DOCX and plain text only. Word, Google Docs, and LibreOffice all export PDF in one click.
- **No résumé upload parsing.** The profile is hand-maintained JSON, which is deliberate: automatic parsing of your own resume is the step most likely to introduce an error you would not notice.
- **Salary data is thin.** Most European postings simply do not state it.
- **The visa and relocation flags read what the posting says.** They are not immigration advice, and "not specified" genuinely means unknown.

## License

MIT. It's yours.
