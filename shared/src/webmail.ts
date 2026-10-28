import type { MailAutoresponder } from './mail';

// ─────────────────────────────────────────────────────────────────────────────
// Oblimint webmail (settings mail.webmail = 'oblimint'): API of the webmail
// host, served by the panel's webmail listener (server/src/services/mail/
// webmail/oblimint/). The browser only ever talks to this API; the panel talks
// JMAP to the mail engine (Stalwart) for the session's mailbox only.
//
//   GET    /wm-api/session              → WebmailSessionInfo (sets the pre-login CSRF cookie)
//   POST   /wm-api/login                WebmailLoginRequest → WebmailSessionInfo
//   POST   /wm-api/sso/target           { token } → WebmailSsoTarget (token NOT used: confirmation screen)
//   POST   /wm-api/sso                  { token } → WebmailSessionInfo
//   POST   /wm-api/logout               → { ok }
//   POST   /wm-api/jmap                 { methodCalls } → { methodResponses } (validated, own account only)
//   POST   /wm-api/upload               raw body → { blobId, type, size }
//   GET    /wm-api/blob/:blobId?name=   attachment download (always Content-Disposition: attachment)
//   GET    /wm-api/events               text/event-stream (JMAP StateChange relay)
//   GET    /wm-api/vacation             → WebmailVacation
//   PUT    /wm-api/vacation             WebmailVacation → WebmailVacation
// Every state-changing call: same Origin + header X-Oblimint-CSRF.
// ─────────────────────────────────────────────────────────────────────────────

export const WEBMAIL_API_PREFIX = '/wm-api';
/** CSRF token header (session token, or the pre-login double-submit value). */
export const WEBMAIL_CSRF_HEADER = 'X-Oblimint-CSRF';
/** Background call (event stream, refresh): does not extend the idle timeout. */
export const WEBMAIL_BACKGROUND_HEADER = 'X-Oblimint-Background';
/** Fragment parameter of the panel's single sign-on link: https://<webmail host>/#sso=<token>. */
export const WEBMAIL_SSO_FRAGMENT = 'sso';

export interface WebmailIdentity {
  id: string;
  name: string;
  email: string;
}

export interface WebmailSessionInfo {
  authenticated: boolean;
  /** CSRF token to send in X-Oblimint-CSRF (session token once logged in, pre-login token before). */
  csrf: string;
  address: string | null;
  displayName: string | null;
  /** JMAP account of the session (the only one the proxy accepts). */
  accountId: string | null;
  identities: WebmailIdentity[];
  /** Largest attachment accepted by /wm-api/upload (bytes). */
  maxUploadBytes: number;
  idleTimeoutSec: number;
  /** How the session was opened. */
  method: 'password' | 'sso' | null;
}

/** Mailbox a panel SSO link opens, shown (and confirmed) before the token is used. */
export interface WebmailSsoTarget {
  address: string;
}

export interface WebmailLoginRequest {
  address: string;
  password: string;
}

/** The mailbox's autoresponder (the panel's, rendered into its managed sieve script). */
export type WebmailVacation = MailAutoresponder;

export type WebmailErrorCode =
  | 'invalidCredentials' | 'tooManyAttempts' | 'csrf' | 'notAuthenticated' | 'forbidden' | 'invalidRequest'
  | 'unavailable' | 'tooLarge' | 'ssoInvalid' | 'notFound' | 'upstream'
  /** EmailSubmission refused: the mailbox may not send (send toggle off, outbound suspended…). */
  | 'sendDisabled';

export interface WebmailError {
  error: WebmailErrorCode;
  message: string;
}
