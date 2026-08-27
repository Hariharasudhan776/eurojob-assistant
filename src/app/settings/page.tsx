import { getPool } from '@/lib/db/pool';
import { getTargetCountries, spendBreakdown, spentLast24h } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { Card, Pill } from '@/components/ui';
import { TargetCountries } from '@/components/TargetCountries';
import { DEFAULT_LIMITS } from '@/lib/ai/budget';
import { STAGE_MODELS } from '@/lib/ai/client';
import { DEFAULT_SEARCH, DEFAULT_TARGET_COUNTRIES } from '@/lib/search-config';
import { COUNTRY_NAMES } from '@/lib/jobs/types';
import { SOURCES } from '@/lib/jobs/registry';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const userId = await currentUserId();

  const [{ rows: sources }, total, byKind, chosenCountries] = await Promise.all([
    getPool().query(
      'SELECT slug, display_name, requires_key, last_run_at, last_status, last_error FROM job_sources ORDER BY slug'
    ),
    // Spend comes from the ai_spend table, per user. It used to be read from
    // data/ai-spend.json, which cannot be right once there is more than one
    // account (one shared allowance) or once the host has no writable disk
    // (every request would start from zero and the cap would not exist).
    spentLast24h(userId),
    spendBreakdown(userId),
    getTargetCountries(userId),
  ]);

  const usedFraction = DEFAULT_LIMITS.dailyUsd > 0 ? total / DEFAULT_LIMITS.dailyUsd : 0;
  const usingDefaultCountries = chosenCountries.length === 0;
  const selected = usingDefaultCountries ? DEFAULT_TARGET_COUNTRIES : chosenCountries;

  // Offer the default targets plus anywhere a source can actually reach, so the
  // list is useful without being a scroll through every country on earth.
  const offered = [...new Set([...DEFAULT_TARGET_COUNTRIES, ...selected, ...SOURCES.flatMap((s) => (s.coverage === 'any' ? [] : s.coverage))])]
    .map((code) => ({ code, name: COUNTRY_NAMES[code] ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-4">
      <Card title="Your AI spend, last 24 hours">
        <p className="tnum text-2xl font-semibold">
          ${total.toFixed(4)}
          <span className="ml-2 text-sm font-normal text-[var(--color-muted)]">
            of ${DEFAULT_LIMITS.dailyUsd.toFixed(2)} daily cap
          </span>
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded bg-[var(--color-line)]">
          <div
            className="h-full rounded"
            style={{
              width: `${Math.min(100, usedFraction * 100)}%`,
              background: usedFraction > 0.8 ? 'var(--color-bad)' : 'var(--color-good)',
            }}
          />
        </div>
        {byKind.length > 0 && (
          <ul className="mt-3 space-y-1">
            {byKind.map((entry) => (
              <li key={entry.kind} className="flex justify-between text-sm">
                <span className="text-[var(--color-muted)]">
                  {entry.kind} ({entry.calls} calls)
                </span>
                <span className="tnum">${entry.usd.toFixed(4)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          This cap is <strong className="text-[var(--color-fg)]">yours alone</strong> — every account has its own
          ${DEFAULT_LIMITS.dailyUsd.toFixed(2)} a day, so nobody else&rsquo;s generating can spend your allowance.
          Caps are enforced before a request is sent, not after: exceeding one aborts the action and says which cap
          stopped it. AI_MAX_RUN_USD is currently ${DEFAULT_LIMITS.perRunUsd.toFixed(2)}, AI_MAX_DAILY_USD $
          {DEFAULT_LIMITS.dailyUsd.toFixed(2)}, AI_MAX_CALL_USD ${DEFAULT_LIMITS.perCallUsd.toFixed(2)}.
        </p>
      </Card>

      <Card title="Target countries — what the location score rewards">
        <TargetCountries options={offered} selected={selected} isDefault={usingDefaultCountries} />
      </Card>

      <Card title="Models per stage">
        <ul className="space-y-1 text-sm">
          {Object.entries(STAGE_MODELS).map(([stage, model]) => (
            <li key={stage} className="flex justify-between">
              <span className="text-[var(--color-muted)]">{stage}</span>
              <span>{model}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Explanations run often and only summarise numbers already computed in code, so they use the cheapest
          capable model. Override with AI_MODEL_SUMMARY, AI_MODEL_LETTER, AI_MODEL_RESUME, or force one model for
          everything with AI_MODEL. No model ever produces a score.
        </p>
      </Card>

      <Card title="Job sources">
        <ul className="space-y-2">
          {sources.map((source) => (
            <li key={source.slug} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {source.display_name}
                <span className="ml-2 text-xs text-[var(--color-muted)]">
                  {source.requires_key ? 'needs an API key' : 'no key needed'}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {source.last_status === 'ok' ? (
                  <Pill tone="good">ok</Pill>
                ) : (
                  <Pill tone="warn">{source.last_status ?? 'never run'}</Pill>
                )}
                {source.last_run_at && (
                  <span className="text-xs text-[var(--color-muted)]">
                    {new Date(source.last_run_at).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Adzuna covers 21 countries but not Ireland, which is why The Muse was added — it needs no key, returns full
          descriptions, and covers Dublin, Cork, Galway and the Nordics. Adding another source means implementing the
          JobSource interface in src/lib/jobs/sources and adding one line to registry.ts.
        </p>
      </Card>

      <Card title="What is searched">
        <p className="text-sm">
          <span className="text-[var(--color-muted)]">Countries: </span>
          {DEFAULT_SEARCH.countries.length === 0
            ? 'everywhere the sources reach — collection is not restricted by country. Filter on the Jobs page instead.'
            : DEFAULT_SEARCH.countries.join(', ')}
        </p>
        <p className="mt-2 text-sm">
          <span className="text-[var(--color-muted)]">Titles: </span>
          {DEFAULT_SEARCH.titles.join(' · ')}
        </p>
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Edit <code className="text-[var(--color-fg)]">src/lib/search-config.ts</code>. Titles are deliberately
          broad: searching only your current title would miss most of the roles you actually fit.
        </p>
      </Card>
    </div>
  );
}
