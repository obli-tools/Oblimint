// Refusals of the sensitive-actions gate (server services/restrictions/gate.ts,
// pendingActions.service.ts) the API client surfaces by itself with a
// translated message — the call sites skip their own error toast
// (isStepUpHandled). Pure: unit-tested (restrictionErrors.test.ts).

export interface RestrictionErrorMessage {
  code: string;
  key: string;
  fallback: string;
  /** Link offered next to the message (enable 2FA, the request). */
  link?: { path: string; key: string; fallback: string };
}

const MESSAGES: Record<string, { status: number[]; key: string; fallback: string }> = {
  twoFactorNotEnrolled: {
    status: [403],
    key: 'approvals.errors.twoFactorNotEnrolled',
    fallback: 'This action needs two-factor authentication. Enable it in your profile (authenticator app), then try again.',
  },
  noEligibleApprover: {
    status: [409],
    key: 'approvals.errors.noEligibleApprover',
    fallback: 'This action needs the approval of a second authorised person with two-factor authentication, and there is none. Ask an administrator to add one.',
  },
  approvalMismatch: {
    status: [409],
    key: 'approvals.errors.approvalMismatch',
    fallback: 'This approval was given for other parameters: the action was not run. Send it again to file a new request.',
  },
  tooManyPendingActions: {
    status: [429],
    key: 'approvals.errors.tooManyPendingActions',
    fallback: 'Too many requests are waiting for a decision. Wait for them, or cancel some in Approvals.',
  },
  stepUpLocked: {
    status: [429],
    key: 'approvals.errors.stepUpLocked',
    fallback: 'Too many wrong codes. Try again in a few minutes.',
  },
  restrictionsLockout: {
    status: [400],
    key: 'approvals.errors.restrictionsLockout',
    fallback: 'This change would lock the matrix: nobody else could approve its next change. Add a second administrator with two-factor authentication first, or keep « Protected actions » at 2FA.',
  },
  notEligibleApprover: {
    status: [403],
    key: 'approvals.errors.notEligibleApprover',
    fallback: 'You may no longer approve this action (your rights changed).',
  },
  keyCannotDecide: {
    status: [403],
    key: 'approvals.errors.keyCannotDecide',
    fallback: 'An access key can never confirm, approve or deny a request.',
  },
  pendingActionExpired: {
    status: [410],
    key: 'approvals.errors.expired',
    fallback: 'This request expired.',
  },
  pendingActionNotPending: {
    status: [409],
    key: 'approvals.errors.notPending',
    fallback: 'This request was already decided.',
  },
};

/** The gate refusal carried by an error response, or null. */
export function restrictionErrorOf(status: number | undefined, body: unknown): RestrictionErrorMessage | null {
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  const m = MESSAGES[code];
  if (!m || status === undefined || !m.status.includes(status)) return null;
  const out: RestrictionErrorMessage = { code, key: m.key, fallback: m.fallback };
  if (code === 'twoFactorNotEnrolled') {
    const details = (body as { details?: { enrollPath?: unknown } }).details;
    const path = typeof details?.enrollPath === 'string' && details.enrollPath.startsWith('/') && !details.enrollPath.startsWith('//') ? details.enrollPath : '/profile';
    out.link = { path, key: 'approvals.errors.enable2fa', fallback: 'Enable 2FA' };
  }
  return out;
}
