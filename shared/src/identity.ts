// ─────────────────────────────────────────────────────────────────────────────
// Self-service identity of LOCAL accounts (staff and clients; never an
// Obligate / SSO account, whose password and second factor live in Obligate):
//   - forgotten password: a single-use link e-mailed to the VERIFIED address of
//     the account (30 min), same answer whether the address exists or not;
//     the reset ends every session, the second factor stays required;
//   - 2FA recovery codes: 10 one-time codes, shown once, stored hashed;
//   - e-mail change: confirmed by a link sent to the new address (step-up).
// ─────────────────────────────────────────────────────────────────────────────

/** Password reset link lifetime. */
export const PASSWORD_RESET_TTL_MINUTES = 30;
/** E-mail change confirmation link lifetime. */
export const EMAIL_CHANGE_TTL_HOURS = 24;
/** Codes per batch. */
export const RECOVERY_CODE_COUNT = 10;
/** After a sign-in with a recovery code, the session may replace / remove the authenticator without a TOTP code for this long. */
export const RECOVERY_LOGIN_GRACE_MINUTES = 15;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Personal notices of the notification center (family 'account', always delivered, never configurable). */
export type AccountNotificationEvent =
  | 'account.recoveryCodeUsed'   // someone signed in with one of the recovery codes
  | 'account.passwordReset'      // the password was reset through an e-mailed link
  | 'account.emailChanged';      // the e-mail address was changed (confirmed)

export const ACCOUNT_NOTIFICATION_EVENTS: readonly AccountNotificationEvent[] = [
  'account.recoveryCodeUsed', 'account.passwordReset', 'account.emailChanged',
];

/** POST /api/auth/password-reset { email } — always { success: true, data: PasswordResetRequested }. */
export interface PasswordResetRequested {
  /** Always true: the answer never tells whether the address is known. */
  accepted: true;
  /** Lifetime of a link, minutes. */
  ttlMinutes: number;
}

/** POST /api/auth/password-reset/validate { token } */
export interface PasswordResetTokenState {
  valid: boolean;
  /** Sign-in host to go back to after the reset (the client space for a client), when known. */
  kind?: 'staff' | 'client';
}

/** POST /api/auth/password-reset/confirm { token, newPassword } → 200 or 400 code invalidToken. */
export interface PasswordResetConfirmInput {
  token: string;
  newPassword: string;
}

/** GET /api/profile/2fa/recovery-codes */
export interface RecoveryCodesStatus {
  /** The account has an authenticator (codes only exist with one). */
  totpEnabled: boolean;
  /** Codes of the current batch. 0 = none generated yet. */
  total: number;
  remaining: number;
  generatedAt: string | null;
}

/** POST /api/profile/2fa/recovery-codes (step-up) and POST /totp/enable: the plain codes, shown ONCE. */
export interface RecoveryCodesGenerated {
  codes: string[];
  generatedAt: string;
}

/** GET /api/profile/email */
export interface EmailState {
  email: string | null;
  /** The current address is proven (a password reset can be sent to it). */
  verified: boolean;
  /** A change waiting for its confirmation link. */
  pending: { email: string; expiresAt: string } | null;
  /** The platform can send e-mails (a change is confirmed by a link). */
  mailAvailable: boolean;
}

/** POST /api/profile/email { email } (step-up). */
export interface EmailChangeResult {
  /** pending: a link was sent to the new address; changed: applied (removal, or no e-mail sender: unverified). */
  status: 'pending' | 'changed';
  state: EmailState;
}
