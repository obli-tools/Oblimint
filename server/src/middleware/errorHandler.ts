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
 * An answer whose JSON body is given whole (the step-up 401 / 403 bodies the
 * client interceptor reads at the top level, the 202 pendingApproval of a
 * restricted action). Still an AppError (code, message), so the MCP layer and
 * every catch that knows AppError keep working.
 */
export class ResponseError extends AppError {
  constructor(statusCode: number, public body: Record<string, unknown>) {
    super(statusCode, typeof body.error === 'string' ? body.error : (statusCode === 202 ? 'Pending approval' : 'Request refused'),
      typeof body.code === 'string' ? body.code : undefined, body.details ?? (statusCode === 202 ? body.data : undefined));
    this.name = 'ResponseError';
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
  // A request executing an approved pending action failed: kept on the request (never throws).
  const viaPending = (req as Request & { viaPendingAction?: number }).viaPendingAction;
  if (viaPending && !(err instanceof ResponseError && err.statusCode < 400)) {
    void import('../services/restrictions/pendingActions.service')
      .then((m) => m.recordExecutionError(viaPending, err.message))
      .catch(() => undefined);
  }
  if (err instanceof ResponseError) {
    if (!res.headersSent) res.status(err.statusCode).json(err.body);
    return;
  }
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
