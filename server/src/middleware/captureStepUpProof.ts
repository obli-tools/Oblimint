import type { Request, Response, NextFunction } from 'express';

// Step-up proofs sent by the client's 401 retry (twoFactorCode with
// twoFactorRequired, stepUpPassword with passwordRequired — client/src/api/
// client.ts) are MOVED out of req.body into req.stepUpProof before any
// router: they never reach validate(), logs, or `...req.body` writes.

export interface StepUpProof {
  twoFactorCode?: string;
  stepUpPassword?: string;
  /** "Trust this IP for 24 h" ticked in the prompt (honoured for sensitive panel actions only). */
  trustIp?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      stepUpProof?: StepUpProof;
    }
  }
}

export function captureStepUpProof(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const proof: StepUpProof = {};
    const code = body.twoFactorCode;
    if (typeof code === 'string' || typeof code === 'number') proof.twoFactorCode = String(code).trim().slice(0, 16);
    const pw = body.stepUpPassword;
    if (typeof pw === 'string' && pw.length > 0) proof.stepUpPassword = pw.slice(0, 1024);
    if (body.trustIp === true && proof.twoFactorCode !== undefined) proof.trustIp = true;
    delete body.twoFactorCode;
    delete body.stepUpPassword;
    delete body.trustIp;
    if (proof.twoFactorCode !== undefined || proof.stepUpPassword !== undefined) req.stepUpProof = proof;
  }
  next();
}
