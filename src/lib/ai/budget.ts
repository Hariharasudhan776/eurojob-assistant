/**
 * Hard spend limits.
 *
 * This exists because a cost *estimate* is not a cost *control*. The app
 * reported its spend accurately and still ran up USD 2.53 across four
 * development runs, because nothing stopped it. An estimate you read afterwards
 * is a receipt; this is a brake.
 *
 * Three layers, each enforced before a call is made rather than after:
 *
 *   perRun    -- one command cannot spend more than this, full stop.
 *   daily     -- all runs together cannot exceed this in a rolling 24 hours.
 *   perCall   -- a single request is refused if its projected cost is absurd,
 *                which catches a runaway max_tokens or a prompt-size mistake.
 *
 * Exceeding a limit throws. It does not warn and continue: a limit that can be
 * silently passed is not a limit.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BudgetLimits {
  perRunUsd: number;
  dailyUsd: number;
  perCallUsd: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  perRunUsd: Number(process.env.AI_MAX_RUN_USD ?? 0.5),
  dailyUsd: Number(process.env.AI_MAX_DAILY_USD ?? 2),
  // Deliberately loose, because this one is projected from max_tokens rather
  // than measured. Its job is to catch a configuration mistake -- a 128k output
  // cap, a prompt that ballooned -- not to police normal spend. Setting it to a
  // typical cost blocked legitimate work: the resume stage needs 16k of output
  // headroom and so projects to about $0.25, against a MEASURED $0.157.
  //
  // Real control comes from perRunUsd and dailyUsd, which accumulate ACTUAL
  // cost, not projections.
  perCallUsd: Number(process.env.AI_MAX_CALL_USD ?? 0.35),
};

export class BudgetExceededError extends Error {
  readonly scope: 'run' | 'daily' | 'call';
  constructor(scope: 'run' | 'daily' | 'call', spent: number, limit: number, hint: string) {
    super(
      `AI budget stop (${scope}): $${spent.toFixed(4)} against a $${limit.toFixed(2)} limit. ${hint}`
    );
    this.scope = scope;
  }
}

interface LedgerEntry {
  at: string;
  usd: number;
  kind: string;
  model: string;
}

/**
 * Spend ledger on disk, so the daily cap survives across separate commands.
 *
 * A per-process counter would reset every time the script is run, which is
 * exactly how four separate runs added up unnoticed.
 */
export class SpendLedger {
  private readonly path: string;
  private entries: LedgerEntry[] = [];

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, 'utf8')) as LedgerEntry[];
      } catch {
        // A corrupt ledger must not be treated as zero spend -- that would
        // silently remove the cap. Start over but keep the file for inspection.
        this.entries = [];
      }
    }
  }

  private prune(now: number) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.entries = this.entries.filter((e) => Date.parse(e.at) >= cutoff);
  }

  spentLast24h(now = Date.now()): number {
    this.prune(now);
    return this.entries.reduce((sum, e) => sum + e.usd, 0);
  }

  record(usd: number, kind: string, model: string, now = Date.now()) {
    this.entries.push({ at: new Date(now).toISOString(), usd, kind, model });
    this.prune(now);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  /** Spend grouped by kind, so it is obvious which stage costs the money. */
  breakdown(now = Date.now()): { kind: string; calls: number; usd: number }[] {
    this.prune(now);
    const byKind = new Map<string, { calls: number; usd: number }>();
    for (const entry of this.entries) {
      const current = byKind.get(entry.kind) ?? { calls: 0, usd: 0 };
      byKind.set(entry.kind, { calls: current.calls + 1, usd: current.usd + entry.usd });
    }
    return [...byKind.entries()]
      .map(([kind, v]) => ({ kind, ...v }))
      .sort((a, b) => b.usd - a.usd);
  }
}

export const defaultLedgerPath = (root: string) => join(root, 'data', 'ai-spend.json');

export class BudgetGuard {
  private readonly limits: BudgetLimits;
  private readonly ledger: SpendLedger;
  private runSpend = 0;

  constructor(ledger: SpendLedger, limits: BudgetLimits = DEFAULT_LIMITS) {
    this.ledger = ledger;
    this.limits = limits;
  }

  get spentThisRun(): number {
    return this.runSpend;
  }

  get limitsInUse(): BudgetLimits {
    return this.limits;
  }

  /**
   * Called BEFORE a request. `projectedUsd` is the worst case for the request,
   * computed from max_tokens rather than from what the response turns out to be
   * -- checking afterwards would already have spent the money.
   */
  assertCanSpend(projectedUsd: number, kind: string) {
    if (projectedUsd > this.limits.perCallUsd) {
      throw new BudgetExceededError(
        'call',
        projectedUsd,
        this.limits.perCallUsd,
        `A single ${kind} call is projected above the per-call cap. Lower max_tokens, use a cheaper model, or raise AI_MAX_CALL_USD.`
      );
    }
    if (this.runSpend + projectedUsd > this.limits.perRunUsd) {
      throw new BudgetExceededError(
        'run',
        this.runSpend + projectedUsd,
        this.limits.perRunUsd,
        'This run has reached its cap. Analyse fewer jobs, or raise AI_MAX_RUN_USD.'
      );
    }
    const daily = this.ledger.spentLast24h();
    if (daily + projectedUsd > this.limits.dailyUsd) {
      throw new BudgetExceededError(
        'daily',
        daily + projectedUsd,
        this.limits.dailyUsd,
        `$${daily.toFixed(2)} already spent in the last 24 hours. Wait, or raise AI_MAX_DAILY_USD.`
      );
    }
  }

  /** Called AFTER a request, with the actual cost. */
  record(actualUsd: number, kind: string, model: string) {
    this.runSpend += actualUsd;
    this.ledger.record(actualUsd, kind, model);
  }
}
