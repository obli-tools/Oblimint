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
