import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';

// ─────────────────────────────────────────────────────────────────────────────
// A runtime change (switchBase, promotePreview) is applied to the rows, then
// converged by a reconcile pass, which REMOVES the old primary container
// before creating the new one. If the new one cannot be created / started,
// or does not answer its healthcheck, the site would stay down with the new
// base recorded (every periodic pass re-creating the broken runtime): the
// previous rows are restored and converged again, and the request fails.
// Pure orchestration (collaborators injected): unit-tested with fakes.
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeChangeSteps {
  /** Writes the new rows (sites.base / preview_base). */
  apply(): Promise<void>;
  /** Restores the previous rows. */
  revert(): Promise<void>;
  /** Reconcile pass of the account; throws on errors concerning the site. */
  converge(): Promise<void>;
  /** HTTP healthcheck of the new primary (null = healthy, or nothing to check). */
  verify(): Promise<string | null>;
}

export async function applyRuntimeChange(steps: RuntimeChangeSteps, what: string): Promise<void> {
  await steps.apply();
  let failure: string | null = null;
  try {
    await steps.converge();
    const hc = await steps.verify();
    if (hc) failure = `healthcheck: ${hc}`;
  } catch (err) {
    failure = errText(err);
  }
  if (failure === null) return;
  logger.warn({ what, failure }, 'Runtime change failed: restoring the previous runtime');
  let restored = true;
  try {
    await steps.revert();
    await steps.converge();
  } catch (err) {
    restored = false;
    logger.error({ what, err: errText(err) }, 'Runtime change: the previous runtime could not be restored');
  }
  throw new AppError(502, restored
    ? `${what} failed (${failure}); the previous runtime was restored`
    : `${what} failed (${failure}); restoring the previous runtime failed too`, 'runtimeSwitchFailed', { restored });
}
