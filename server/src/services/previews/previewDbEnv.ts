import type { PreviewDbClone } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import { openJson, sealJson } from '../../utils/secretBox';
import { json } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — environment of a preview with a database clone: the variables of
// the site (siteEnvForPreview), overridden by the clone's sealed overrides
// (random passwords of the users whose real password sits in a SECRET
// variable). Read by the reconcile planner; no heavy import (no cycle).
// ─────────────────────────────────────────────────────────────────────────────

export const CLONE_ENV_PURPOSE = 'site-preview-db' as const;

export function sealCloneEnv(overrides: Array<[string, string]>): string | null {
  return overrides.length ? sealJson(CLONE_ENV_PURPOSE, overrides) : null;
}

/** The overrides of a sealed value ([] when absent / unreadable: the env then lacks the password, never the real one). */
export function openCloneEnv(sealed: string | null | undefined): Array<[string, string]> {
  if (!sealed) return [];
  try {
    const v = openJson<unknown>(CLONE_ENV_PURPOSE, sealed);
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'preview: clone env overrides unreadable (skipped)');
    return [];
  }
}

/** env with the overrides applied (same name replaced, new ones added), sorted by name. */
export function mergeEnv(env: Array<[string, string]>, overrides: Array<[string, string]>): Array<[string, string]> {
  const m = new Map(env);
  for (const [k, v] of overrides) m.set(k, v);
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The clone of a db_clone column is ready (the preview container may join its network). */
export function cloneReady(raw: unknown): boolean {
  const c = json<{ state?: string } | null>(raw, null);
  return !!c && c.state === 'ready';
}

/** The db_clone column as PreviewDbClone (null: none / unreadable). */
export function readClone(raw: unknown): PreviewDbClone | null {
  const c = json<PreviewDbClone | null>(raw, null);
  if (!c || typeof c !== 'object' || !Array.isArray(c.databases)) return null;
  return {
    state: c.state ?? 'pending', databases: c.databases, sizeBytes: c.sizeBytes ?? null, streamedBytes: Number(c.streamedBytes ?? 0),
    errorCode: c.errorCode ?? null, error: c.error ?? null, startedAt: c.startedAt ?? null, readyAt: c.readyAt ?? null,
    rotatedUsers: Array.isArray(c.rotatedUsers) ? c.rotatedUsers.map(String) : [],
  };
}
