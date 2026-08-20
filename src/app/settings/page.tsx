import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from '@/lib/db/pool';
import { Card, Pill } from '@/components/ui';
import { DEFAULT_LIMITS } from '@/lib/ai/budget';
import { STAGE_MODELS } from '@/lib/ai/client';
import { DEFAULT_SEARCH } from '@/lib/search-config';

export const dynamic = 'force-dynamic';

interface LedgerEntry {
  at: string;
  usd: number;
  kind: string;
  model: string;
}

export default async function SettingsPage() {
  const { rows: sources } = await getPool().query(
    'SELECT slug, display_name, requires_key, last_run_at, last_status, last_error FROM job_sources ORDER BY slug'
  );

  const ledgerPath = join(process.cwd(), 'data', 'ai-spend.json');
  let spend: LedgerEntry[] = [];
  if (existsSync(ledgerPath)) {
    try {
      spend = JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerEntry[];
    } catch {
      spend = [];
    }
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = spend.filter((e) => Date.parse(e.at) >= cutoff);
  const total = recent.reduce((sum, e) => sum + e.usd, 0);

  const byKind = new Map<string, { calls: number; usd: number }>();
  for (const entry of recent) {
    const current = byKind.get(entry.kind) ?? { calls: 0, usd: 0 };
    byKind.set(entry.kind, { calls: current.calls + 1, usd: current.usd + entry.usd });
  }

  const usedFraction = DEFAULT_LIMITS.dailyUsd > 0 ? total / DEFAULT_LIMITS.dailyUsd : 0;

  return (
    <div className="space-y-4">
      <Card title="AI spend, last 24 hours">
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
        {byKind.size > 0 && (
          <ul className="mt-3 space-y-1">
            {[...byKind.entries()]
              .sort((a, b) => b[1].usd - a[1].usd)
              .map(([kind, v]) => (
                <li key={kind} className="flex justify-between text-sm">
                  <span className="text-[var(--color-muted)]">
                    {kind} ({v.calls} calls)
                  </span>
                  <span className="tnum">${v.usd.toFixed(4)}</span>
                </li>
              ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Caps are enforced before a request is sent, not after. Exceeding one aborts the action and says why.
          Change them in <code className="text-[var(--color-fg)]">.env</code> — AI_MAX_RUN_USD is currently $
          {DEFAULT_LIMITS.perRunUsd.toFixed(2)}, AI_MAX_DAILY_USD ${DEFAULT_LIMITS.dailyUsd.toFixed(2)}.
        </p>
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
          everything with AI_MODEL.
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
          Adzuna does not cover Ireland, Sweden, Denmark, Norway or Luxembourg. Adding a source means implementing
          the JobSource interface in src/lib/jobs/sources and adding one line to registry.ts.
        </p>
      </Card>

      <Card title="What is searched">
        <p className="text-sm">
          <span className="text-[var(--color-muted)]">Countries: </span>
          {DEFAULT_SEARCH.countries.join(', ')}
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
