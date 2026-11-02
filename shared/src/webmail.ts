import type { MailAutoresponder, MailRule } from './mail';

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
//   GET    /wm-api/forwarding           → WebmailForwarding
//   PUT    /wm-api/forwarding           WebmailForwardingInput → WebmailForwarding
//   GET    /wm-api/rules                → WebmailRules
//   PUT    /wm-api/rules                { rules } → WebmailRules
// Forwarding and rules are the panel's own settings of the mailbox (same
// rows, validation, sync and audit as the panel's mailbox page).
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
  /**
   * "Back to Oblimint" link of the webmail header (null: none configured).
   * SSO: the panel page of this mailbox, on the panel host the link was
   * opened from (/sso answer) else on the panel host; password: the panel's
   * home (client space when configured). Built from configured host names only.
   */
  panelUrl: string | null;
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

/** What the mailbox owner may do with forwarding / forward-redirect rule actions. */
export interface WebmailForwardingPolicy {
  /** Targets outside the account's own mail domains are accepted (settings mail.ownerExternalForwarding). */
  external: boolean;
  /** The account's own mail domains (always accepted); listed only when external is false ([] otherwise). */
  internalDomains: string[];
  /** Forwarding + rule redirections of one message at most. */
  maxRedirects: number;
}

/** The mailbox's forwarding (the panel's MailForwarding), as the owner sees it. */
export interface WebmailForwarding {
  enabled: boolean;
  targets: string[];
  keepCopy: boolean;
  /** Forwarding applies now (enabled with at least one target). */
  active: boolean;
  /** Last change made from the panel, not by the mailbox itself (null: never / by the mailbox). */
  changedByPanelAt: string | null;
  /** Enabled inbox rules that forward / redirect messages (shown in the banner like the forwarding). */
  ruleForwards: WebmailRuleForward[];
  policy: WebmailForwardingPolicy;
}

/** One enabled rule that sends messages on. */
export interface WebmailRuleForward {
  /** The rule's name. */
  rule: string;
  to: string[];
  /** false = redirect (the message is not kept in the mailbox). */
  kept: boolean;
}

export interface WebmailForwardingInput {
  enabled: boolean;
  targets: string[];
  keepCopy: boolean;
}

export interface WebmailRules {
  rules: MailRule[];
  /** The engine runs the rules (Stalwart). */
  supported: boolean;
  policy: WebmailForwardingPolicy;
}

export type WebmailErrorCode =
  | 'invalidCredentials' | 'tooManyAttempts' | 'csrf' | 'notAuthenticated' | 'forbidden' | 'invalidRequest'
  | 'unavailable' | 'tooLarge' | 'ssoInvalid' | 'notFound' | 'upstream'
  /** EmailSubmission refused: the mailbox may not send (send toggle off, outbound suspended…). */
  | 'sendDisabled'
  /** Forwarding / a rule to an address outside the account while the platform does not allow it. */
  | 'forwardingNotAllowed';

export interface WebmailError {
  error: WebmailErrorCode;
  message: string;
  /**
   * Business reason of a refused forwarding / rules change (the panel's
   * AppError code: invalidTarget, forwardingLoop, tooManyRedirects,
   * invalidRule, rulesUnsupported, forwardingNotAllowed…), for translation.
   */
  reason?: string;
  /** Values to show with the reason (no other field is ever sent). */
  details?: { target?: string; max?: number; rule?: number };
}
