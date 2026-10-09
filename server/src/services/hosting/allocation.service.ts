import type { Knex } from 'knex';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { isUniqueViolation } from './hostingValidation.service';

// ─────────────────────────────────────────────────────────────────────────────
// System identifiers of a hosting account: uid (= gid) in
// [config.hosting.uidMin, uidMax] and the host port of its file server in
// [filesrvPortMin, filesrvPortMax] (unique per node). Lowest free value; the
// DB unique constraints arbitrate races (withAllocationRetry retries the
// insert on 23505).
// ─────────────────────────────────────────────────────────────────────────────

/** Lowest integer of [min, max] not in `used`, null when the range is exhausted. */
export function lowestFree(used: Iterable<number>, min: number, max: number): number | null {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return null;
  const taken = new Set<number>();
  for (const v of used) if (Number.isInteger(v) && v >= min && v <= max) taken.add(v);
  for (let v = min; v <= max; v++) if (!taken.has(v)) return v;
  return null;
}

function exhausted(what: string): AppError {
  return new AppError(409, `No free ${what} left in the configured range`, 'allocationExhausted');
}

export const allocationService = {
  /** Lowest free uid (gid = uid) of the platform (uids are unique across nodes). */
  async nextUid(trx: Knex | Knex.Transaction = db): Promise<number> {
    const { uidMin, uidMax } = config.hosting;
    const rows = await trx('hosting_accounts').whereBetween('uid', [uidMin, uidMax]).select('uid') as Array<{ uid: number }>;
    const gids = await trx('hosting_accounts').whereBetween('gid', [uidMin, uidMax]).select('gid') as Array<{ gid: number }>;
    const v = lowestFree([...rows.map((r) => Number(r.uid)), ...gids.map((r) => Number(r.gid))], Math.max(10000, uidMin), uidMax);
    if (v === null) throw exhausted('uid');
    return v;
  },

  /** Lowest free file-server host port of `nodeId`. */
  async nextFileServerPort(nodeId: number, trx: Knex | Knex.Transaction = db): Promise<number> {
    const { filesrvPortMin, filesrvPortMax } = config.hosting;
    const rows = await trx('hosting_accounts').where({ node_id: nodeId }).whereNotNull('filesrv_port')
      .select('filesrv_port') as Array<{ filesrv_port: number }>;
    const v = lowestFree(rows.map((r) => Number(r.filesrv_port)), filesrvPortMin, filesrvPortMax);
    if (v === null) throw exhausted('file-server port');
    return v;
  },
};

/**
 * Runs `attempt` (allocate + insert) up to `tries` times while it fails on a
 * unique violation (another request took the same uid / port meanwhile).
 * Any other error, or the last unique violation, is rethrown.
 */
export async function withAllocationRetry<T>(attempt: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
