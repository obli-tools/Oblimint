import { db } from './index';
import { logger } from '../utils/logger';

/**
 * Waits until PostgreSQL answers `SELECT 1` (the panel container may start
 * before oblimint-postgres after a host reboot: both restart unless-stopped,
 * in no particular order). Retries every `intervalMs` for `timeoutMs`, then
 * throws the last error.
 */
export async function waitForDatabase(opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.DB_WAIT_TIMEOUT_MS || 120_000);
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await db.raw('SELECT 1');
      if (attempt > 1) logger.info({ attempt }, 'Database reachable');
      return;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (Date.now() + intervalMs > deadline) {
        logger.error({ attempt, err: message }, 'Database still unreachable — giving up');
        throw err;
      }
      if (attempt === 1 || attempt % 5 === 0) {
        logger.warn({ attempt, err: message }, 'Database not reachable yet — retrying');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
