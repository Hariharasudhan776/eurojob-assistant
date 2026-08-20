import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CacheStore, Usage } from './client.ts';

/**
 * Cache that survives between commands.
 *
 * The original in-memory cache was worse than useless for the actual usage
 * pattern. Every `npm run jobs:analyse` is a fresh process, so the cache was
 * empty every time and four development runs paid full price for substantially
 * the same work -- four runs, zero cache hits, USD 2.53.
 *
 * One file per entry rather than one big JSON blob: entries are written from
 * separate runs, and a single file would make concurrent runs clobber each
 * other's results.
 *
 * The key is content-addressed (a hash of the job text and profile version), so
 * re-running after a code change that does not affect prompts costs nothing, and
 * a job arriving from a second board reuses the first board's answer.
 */
export class FileCache implements CacheStore {
  private readonly dir: string;
  private hits = 0;
  private misses = 0;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(kind: string, key: string, model: string): string {
    // The model is part of the filename: a cheaper model's answer must not be
    // served when a better one was asked for.
    return join(this.dir, `${kind}__${model}__${key}.json`);
  }

  async get(kind: string, key: string, model: string): Promise<unknown | null> {
    const path = this.file(kind, key, model);
    if (!existsSync(path)) {
      this.misses += 1;
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { value: unknown };
      this.hits += 1;
      return parsed.value;
    } catch {
      // A truncated file (killed mid-write) must be a miss, not a crash.
      this.misses += 1;
      return null;
    }
  }

  async set(kind: string, key: string, model: string, value: unknown, usage: Usage): Promise<void> {
    const path = this.file(kind, key, model);
    // Written to a temporary name then moved, so an interrupted write cannot
    // leave a half-file that later reads as valid.
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify({ cachedAt: new Date().toISOString(), usage, value }, null, 2));
    writeFileSync(path, readFileSync(temp));
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(temp);
    } catch {
      // A leftover .tmp is harmless; it is never read.
    }
  }

  get stats() {
    return { hits: this.hits, misses: this.misses };
  }

  /** What the cache is holding, for the report. */
  summary(): { entries: number; bytes: number; byKind: Record<string, number> } {
    if (!existsSync(this.dir)) return { entries: 0, bytes: 0, byKind: {} };
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const byKind: Record<string, number> = {};
    let bytes = 0;
    for (const file of files) {
      bytes += statSync(join(this.dir, file)).size;
      const kind = file.split('__')[0] ?? 'unknown';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    return { entries: files.length, bytes, byKind };
  }
}
