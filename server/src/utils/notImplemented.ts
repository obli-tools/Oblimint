import type { Request, Response } from 'express';

/** Placeholder handler of a P1 route whose module is not implemented yet (501). */
export function notImplemented(module: string) {
  return (req: Request, res: Response): void => {
    res.status(501).json({
      success: false,
      error: `Not implemented yet: ${req.method} ${req.baseUrl}${req.path} (module ${module})`,
      code: 'notImplemented',
    });
  };
}

/** P2 stubs: the error a not-yet-implemented service method throws (501 through errorHandler). */
export function notImplementedError(module: string, what: string): Error {
  // Lazy require: errorHandler imports nothing from here, no cycle either way.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { AppError } = require('../middleware/errorHandler') as typeof import('../middleware/errorHandler');
  return new AppError(501, `Not implemented yet: ${what} (module ${module})`, 'notImplemented');
}
