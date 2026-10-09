import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Optional machine-readable code, sent next to `error` (lets the client translate). */
    public code?: string,
    /** Optional machine-readable details, sent as `details` (e.g. per-field errors). */
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Invariant A6 (docs/P1-PLAN.md §14): the message of these backend failures
 * embeds raw Docker / hostd text (socket paths, /srv/oblimint paths, daemon
 * messages). Staff sees it; any other caller (hosting client, unresolvable
 * actor) gets a generic message — the UI translates by `code` anyway.
 */
const BACKEND_CODES = new Set(['backendUnavailable', 'runtimeSwitchFailed', 'releaseRebuildFailed']);

/** Generic message of a backend failure for a non-staff caller (keeps only harmless details). */
export function redactBackendError(err: AppError): { error: string; details?: unknown } {
  switch (err.code) {
    case 'runtimeSwitchFailed': {
      const restored = (err.details as { restored?: unknown } | undefined)?.restored !== false;
      return {
        error: restored
          ? 'The runtime change failed; the previous runtime was restored'
          : 'The runtime change failed and the previous runtime could not be restored',
        details: { restored },
      };
    }
    case 'releaseRebuildFailed':
      return { error: 'The live release could not be rebuilt with the new data paths; nothing was changed' };
    default:
      return { error: 'The container engine or the host daemon is unreachable. Try again in a moment.' };
  }
}

function sendAppError(res: Response, err: AppError, body: { error: string; details?: unknown }): void {
  if (res.headersSent) return;
  res.status(err.statusCode).json({
    success: false,
    error: body.error,
    ...(err.code ? { code: err.code } : {}),
    ...(body.details !== undefined ? { details: body.details } : {}),
  });
}

/** True only for a caller resolved as hosting staff (cached per request by access.ts). */
async function isStaffCaller(req: Request): Promise<boolean> {
  if (!req.session?.userId) return false;
  try {
    // Lazy import: access.ts imports this file (AppError).
    const { resolveActor } = await import('../services/hosting/access');
    return (await resolveActor(req)).kind === 'staff';
  } catch {
    return false;
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.code && BACKEND_CODES.has(err.code)) {
      void isStaffCaller(req).then((staff) => {
        sendAppError(res, err, staff ? { error: err.message, details: err.details } : redactBackendError(err));
      });
      return;
    }
    sendAppError(res, err, { error: err.message, details: err.details });
    return;
  }

  logger.error(err, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}
