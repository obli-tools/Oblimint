import type { ChecksumComponent, ChecksumStatus } from '@oblimint/shared';
import type { ChecksumFetchJson, ChecksumInput, ChecksumProvider, ChecksumVerification } from '../maintenance/contracts';
import { logger } from '../../utils/logger';
import { createCachedFetch, fetchChecksumJson } from './fetch';
import { wordpressCoreProvider, wordpressPluginsProvider } from './wordpress';

// ─────────────────────────────────────────────────────────────────────────────
// Official checksums (docs/P3-PLAN.md §10.1). OWNED BY MODULE `checksums-snapshots`.
//
// Pluggable providers (ChecksumProvider, maintenance/contracts.ts):
//   wordpress-core     https://api.wordpress.org/core/checksums/1.0/?version=<v>&locale=<l> (md5)
//   wordpress-plugins  https://downloads.wordpress.org/plugin-checksums/<slug>/<version>.json (md5 + sha256)
// Other applications register their own provider; nothing else changes.
//
// verify() runs every provider whose applies() is true and merges their file
// statuses (mismatch wins over match, match over unknown); a changed path no
// provider covers is 'unknown'. It never throws for a remote failure nor for
// a failing provider (component 'error'); only an aborted signal stops it.
// ─────────────────────────────────────────────────────────────────────────────

const providers: ChecksumProvider[] = [];

/** Adds a provider (idempotent by id). */
export function registerChecksumProvider(p: ChecksumProvider): void {
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers[i] = p; else providers.push(p);
}

export function checksumProviders(): readonly ChecksumProvider[] {
  return providers;
}

// Built-in providers, registered at module load.
registerChecksumProvider(wordpressCoreProvider);
registerChecksumProvider(wordpressPluginsProvider);

/** Production fetcher: allow-listed HTTPS + 24 h LRU cache. */
const cachedFetch = createCachedFetch(fetchChecksumJson);
let fetchOverride: ChecksumFetchJson | null = null;

/** Test seam: replaces the fetcher given to the providers (null restores the real one and clears the cache). */
export function setChecksumFetchForTests(fn: ChecksumFetchJson | null): void {
  fetchOverride = fn;
  cachedFetch.clear();
}

const RANK: Record<ChecksumStatus, number> = { unknown: 0, match: 1, mismatch: 2 };

/** Merge rule of two providers' verdicts on one path: mismatch > match > unknown. */
export function mergeChecksumStatus(a: ChecksumStatus | undefined, b: ChecksumStatus): ChecksumStatus {
  return a !== undefined && RANK[a] >= RANK[b] ? a : b;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortError(): Error {
  const err = new Error('Checksum verification aborted');
  err.name = 'AbortError';
  return err;
}

export const checksumService = {
  /** Runs every applicable provider over the changed paths (never throws for a remote failure). */
  async verify(input: ChecksumInput): Promise<ChecksumVerification> {
    const fetchJson = fetchOverride ?? cachedFetch;
    const applied: string[] = [];
    const components: ChecksumComponent[] = [];
    const merged = new Map<string, ChecksumStatus>();
    for (const f of input.files) merged.set(f.path, 'unknown');

    for (const provider of [...providers]) {
      if (input.signal?.aborted) throw abortError();
      let applies = false;
      try {
        applies = await provider.applies(input);
      } catch (err) {
        logger.warn({ provider: provider.id, siteId: input.siteId, err: errText(err) }, 'Checksum provider applies() failed');
      }
      if (!applies) continue;
      applied.push(provider.id);
      try {
        const res = await provider.verify(input, fetchJson);
        components.push(...res.components);
        for (const [p, status] of res.files) {
          // Only the paths of the change set: a provider cannot add paths.
          if (merged.has(p)) merged.set(p, mergeChecksumStatus(merged.get(p), status));
        }
      } catch (err) {
        if (input.signal?.aborted) throw abortError();
        logger.warn({ provider: provider.id, siteId: input.siteId, err: errText(err) }, 'Checksum provider failed');
        components.push({
          provider: provider.id, kind: 'app', name: provider.label, version: null, status: 'error', files: 0, mismatches: 0,
          detail: errText(err).slice(0, 500),
        });
      }
    }

    let filesVerified = 0;
    let filesMismatched = 0;
    let filesUnknown = 0;
    for (const s of merged.values()) {
      if (s === 'match') filesVerified++;
      else if (s === 'mismatch') filesMismatched++;
      else filesUnknown++;
    }
    return {
      report: { providers: applied, components, filesVerified, filesMismatched, filesUnknown, checkedAt: new Date().toISOString() },
      files: merged,
    };
  },
};
