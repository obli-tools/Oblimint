// Containment of a hosting account after an incident (migration 042,
// services/containment). The sites keep serving; every way in is cut. Only the
// staff starts or lifts it. Credentials revoked stay revoked after the lift.

/** Audit rows are frozen this long on each side of the start. */
export const CONTAINMENT_AUDIT_HOURS = 72;

/** Error code of everything refused while an account is contained (HTTP 423). */
export const ACCOUNT_CONTAINED_CODE = 'accountContained';

/** Steps, in execution order. Each one is idempotent; a resume only runs what is not done. */
export const CONTAINMENT_STEPS = [
  'keys', 'siteTokens', 'sessions', 'sftp', 'firewall', 'sqlSessions', 'previews', 'pendingActions', 'consoles', 'publishMode', 'windows',
  'evidenceStaging', 'evidenceAudit', 'verify',
] as const;
export type ContainmentStepKey = typeof CONTAINMENT_STEPS[number];

export type ContainmentStepStatus = 'pending' | 'done' | 'failed';

export interface ContainmentStep {
  key: ContainmentStepKey;
  status: ContainmentStepStatus;
  /** What the step acted on (keys revoked, sites switched…). */
  count: number | null;
  /** Failure of the last attempt (staff only: the report is never shown to a client). */
  error: string | null;
  at: string | null;
}

/** running: steps in progress (or interrupted: start again to resume); partial: a step failed; active: all done. */
export type ContainmentStatus = 'running' | 'partial' | 'active' | 'lifted';

/** A credential as it was when revoked: never a secret nor a hash. */
export interface ContainmentCredential {
  family: 'key' | 'connector' | 'siteToken' | 'sshKey';
  id: number;
  name: string;
  /** Key / token prefix, or SSH fingerprint. */
  ref: string | null;
  createdBy: number | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  /** Site of a window token. */
  siteId?: number;
}

/** Staging diff frozen for one site: staging and live commit pinned by git refs. */
export interface ContainmentSiteFreeze {
  siteId: number;
  siteName: string;
  liveReleaseNumber: number | null;
  liveCommit: string | null;
  stagingCommit: string | null;
  /** Paths differing between the staging and the live release. */
  entries: Array<{ path: string; status: string }>;
  total: number;
  truncated: boolean;
  /** Why nothing could be frozen although the step passed (no repository yet). */
  note: string | null;
  frozenAt: string;
}

/**
 * External SQL sessions of one instance (step sqlSessions).
 * closed: the sessions through the external port are ended; notExposed: no external port;
 * stopped: the server is not running (its sessions died with it); unreliable: site and external
 * sessions could not be told apart on this engine, NOTHING was killed on it;
 * failed: the step comes back to it on the resume.
 */
export type ContainmentSqlState = 'closed' | 'notExposed' | 'stopped' | 'unreliable' | 'failed';
/** unknownNetwork: networks of the container not readable; unreadableSession: a session whose address cannot be read; sameEngine: another instance of the engine is in one of these cases. */
export type ContainmentSqlReason = 'unknownNetwork' | 'unreadableSession' | 'sameEngine';

/** A session that was ended, for the investigation. */
export interface ContainmentSqlSession {
  user: string;
  ip: string;
}

export interface ContainmentSqlInstance {
  instanceId: number;
  name: string;
  engine: 'mariadb' | 'mysql' | 'postgresql';
  state: ContainmentSqlState;
  reason: ContainmentSqlReason | null;
  /** External sessions ended, over the runs of the step. */
  killed: number;
  /** Sessions left alone: sockets, account network, threads of the server. */
  kept: number;
  /** External sessions still there after the attempt. */
  remaining: number;
  /** The first ones ended (the count above stays exact). */
  sessions: ContainmentSqlSession[];
  error: string | null;
}

/**
 * A client whose password the lift expires. The password belongs to the login, not to the account:
 * it is expired whatever other accounts the client has. selfService: he can get a link himself
 * (verified address, e-mail sender configured); otherwise the staff sets a new password.
 */
export interface ContainmentClientReset {
  userId: number;
  username: string;
  selfService: boolean;
  /** Accounts of this login not contained, which it also cannot reach until the reset. */
  otherAccounts: number;
  otherContained: number;
  /** After the lift: the link sent. null before the lift. */
  mail: 'sent' | 'unavailable' | 'failed' | null;
}

/** A window not decided yet: its content stays served until the staff rejects it. */
export interface ContainmentOpenWindow {
  windowId: number;
  number: number;
  siteId: number;
  siteName: string;
  status: string;
  closedAt: string | null;
  /** Page of the review, in the panel. */
  reviewPath: string;
}

export interface AccountContainment {
  id: number;
  tenantId: number;
  accountId: number | null;
  username: string;
  status: ContainmentStatus;
  reason: string | null;
  startedAt: string;
  startedByName: string | null;
  completedAt: string | null;
  liftedAt: string | null;
  liftedByName: string | null;
  liftNote: string | null;
  steps: ContainmentStep[];
  credentials: ContainmentCredential[];
  /** Allow-list rules of the account when contained: one may be the attacker's, they apply again after the lift. */
  accessRules: Array<{ cidr: string; note: string | null; createdAt: string | null }>;
  sites: ContainmentSiteFreeze[];
  /** External SQL sessions, per instance of the account. */
  sqlSessions: ContainmentSqlInstance[];
  /** Before the lift: who it will concern. After: who it concerned. */
  clientPasswordResets: ContainmentClientReset[];
  /** Windows of the account not decided, read when the report is asked. */
  reviewWindows: ContainmentOpenWindow[];
  auditFrom: string;
  auditUntil: string;
  auditCount: number;
  /** What the lift could not restore itself (the reconcile retries). */
  liftWarnings: string[];
}

export interface ContainmentStartRequest {
  reason?: string | null;
}

export interface ContainmentLiftRequest {
  note?: string | null;
}

export interface ContainmentAuditRow {
  id: number;
  userId: number | null;
  action: string;
  resourceType: string | null;
  resourcePath: string | null;
  details: unknown;
  ipAddress: string | null;
  createdAt: string;
}
