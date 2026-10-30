import type { NotificationEvent } from './usage';
import type { AccountNotificationEvent } from './identity';

// ─────────────────────────────────────────────────────────────────────────────
// Per-user notification center (the bell, /notifications). Every platform
// event that goes through notify() (server/src/services/usage/
// notifications.service.ts) is also written, for the users concerned (tenant,
// account and capability computed on the server), into user_notifications:
// read / unread, pushed live on the socket (room user:<id>), kept 90 days.
// Each user chooses, per event family, in-app and / or e-mail (transactional
// sender of the platform).
// ─────────────────────────────────────────────────────────────────────────────

export type NotificationFamily =
  | 'releases'
  | 'certificates'
  | 'domains'
  | 'quota'
  | 'mail'
  | 'apps'
  | 'monitoring'
  | 'security'
  | 'platform'
  // Personal notices about one's own account (recovery code used, password reset,
  // e-mail changed): written for that user only, always in the bell and e-mailed
  // when possible, never configurable (absent from the preferences).
  | 'account';

export const NOTIFICATION_FAMILIES: readonly NotificationFamily[] = [
  'releases', 'certificates', 'domains', 'quota', 'mail', 'apps', 'monitoring', 'security', 'platform', 'account',
];

/** Families whose delivery each user chooses (the preferences); 'account' is always delivered. */
export const CONFIGURABLE_NOTIFICATION_FAMILIES: readonly NotificationFamily[] = [
  'releases', 'certificates', 'domains', 'quota', 'mail', 'apps', 'monitoring', 'security', 'platform',
];

/** Families a client user (kind 'client') can receive: never security / platform. */
export const CLIENT_NOTIFICATION_FAMILIES: readonly NotificationFamily[] = [
  'releases', 'certificates', 'domains', 'quota', 'mail', 'apps', 'monitoring', 'account',
];

/** Family of every notification event (preferences are set per family). */
export const NOTIFICATION_EVENT_FAMILY: Record<NotificationEvent, NotificationFamily> = {
  'release.pendingApproval': 'releases',
  'release.approved': 'releases',
  'release.rejected': 'releases',
  'window.pendingReview': 'releases',
  'window.autoValidated': 'releases',
  'window.failed': 'releases',
  'adapter.completed': 'releases',
  'adapter.failed': 'releases',
  'scan.threat': 'releases',
  'quarantine.added': 'releases',
  'supervision.digest': 'releases',
  'certificate.failed': 'certificates',
  'certificate.issued': 'certificates',
  'certificate.expiringSoon': 'certificates',
  'domain.verified': 'domains',
  'domain.reclaimed': 'domains',
  'dns.syncFailed': 'domains',
  'quota.warning': 'quota',
  'quota.exceeded': 'quota',
  'quota.action': 'quota',
  'mail.outboundSuspended': 'mail',
  'mail.serviceFailed': 'mail',
  'mail.quotaWarning': 'mail',
  'app.updateAvailable': 'apps',
  'app.updated': 'apps',
  'app.updateFailed': 'apps',
  'app.deployFailed': 'apps',
  'db.instanceFailed': 'apps',
  'uptime.down': 'monitoring',
  'uptime.up': 'monitoring',
  'workflow.failed': 'monitoring',
  'cron.failed': 'monitoring',
  'security.banned': 'security',
  'edge.unitQuarantined': 'security',
  'edge.rollback': 'security',
  'platform.updateAvailable': 'platform',
  'platform.updated': 'platform',
  'platform.updateFailed': 'platform',
};

export type UserNotificationSeverity = 'info' | 'warning' | 'critical';

/** One notification of the signed-in user (GET /api/notifications/inbox). */
export interface UserNotification {
  id: number;
  tenantId: number;
  accountId: number | null;
  event: NotificationEvent | AccountNotificationEvent;
  family: NotificationFamily;
  severity: UserNotificationSeverity;
  /** French (server-rendered, like the channel messages). */
  title: string;
  message: string;
  /** Panel path (/sites/12?tab=releases) or null. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** GET /api/notifications/inbox?unread=1&family=&before=&limit= */
export interface UserNotificationPage {
  items: UserNotification[];
  unreadCount: number;
  /** More (older) items: pass before = the last id. */
  hasMore: boolean;
}

export interface UserNotificationChannelPref {
  inApp: boolean;
  email: boolean;
}

export type UserNotificationPrefs = Record<NotificationFamily, UserNotificationChannelPref>;

/** Defaults: everything in the bell (security too: staff only), no e-mail. */
export const DEFAULT_USER_NOTIFICATION_PREFS: UserNotificationPrefs = {
  releases: { inApp: true, email: false },
  certificates: { inApp: true, email: false },
  domains: { inApp: true, email: false },
  quota: { inApp: true, email: false },
  mail: { inApp: true, email: false },
  apps: { inApp: true, email: false },
  monitoring: { inApp: true, email: false },
  security: { inApp: true, email: false },
  platform: { inApp: true, email: false },
  account: { inApp: true, email: true },
};

/** GET /api/notifications/preferences */
export interface UserNotificationSettings {
  prefs: UserNotificationPrefs;
  /** Families this user can receive (client: no security / platform). */
  families: NotificationFamily[];
  /** The address e-mails go to (profile); null = no e-mail possible. */
  emailAddress: string | null;
  /** The platform has a working transactional sender. */
  emailAvailable: boolean;
}

/** PUT /api/notifications/preferences */
export interface UserNotificationPrefsInput {
  prefs: Partial<Record<NotificationFamily, Partial<UserNotificationChannelPref>>>;
}

/** Socket events, room user:<id> (every tab of the user, whatever its tenant). */
export const UserNotificationSocketEvents = {
  /** { tenantId, notification: UserNotification } */
  NEW: 'USER_NOTIFICATION',
  /** { tenantId, ids: number[] | 'all' | null, deleted?: boolean } — another tab read / dismissed */
  READ: 'USER_NOTIFICATIONS_READ',
} as const;

export const USER_NOTIFICATION_RETENTION_DAYS = 90;
/** Kept per user and tenant (oldest removed beyond). */
export const USER_NOTIFICATION_MAX_PER_USER = 500;
/** A same (event, key) is shown at most once per user in this window. */
export const USER_NOTIFICATION_DEDUP_HOURS = 24;
export const USER_NOTIFICATION_PAGE_MAX = 100;

// ── Transactional e-mail sender (platform) ──────────────────────────────────

/**
 * off      no e-mail at all;
 * platform the platform's own mail engine (authenticated submission of a
 *          mailbox hosted on the platform: the engine must be active);
 * smtp     an external SMTP server (provider / relay).
 */
export type TransactionalMailMode = 'off' | 'platform' | 'smtp';

export const TRANSACTIONAL_MAIL_MODES: readonly TransactionalMailMode[] = ['off', 'platform', 'smtp'];

/** GET /api/system/transactional-mail (platform admin). Passwords are write-only. */
export interface TransactionalMailSettings {
  mode: TransactionalMailMode;
  /** Display name of the sender ("Oblimint" when null). */
  fromName: string | null;
  platform: { mailbox: string | null; passwordSet: boolean };
  smtp: { host: string | null; port: number; secure: boolean; username: string | null; from: string | null; passwordSet: boolean };
  /** The active mail engine offers authenticated submission (mode platform possible). */
  platformAvailable: boolean;
  /** Mode set and complete: e-mails can leave. */
  ready: boolean;
}

/** PUT /api/system/transactional-mail. password: undefined / null = keep, '' = clear. */
export interface TransactionalMailSettingsInput {
  mode?: TransactionalMailMode;
  fromName?: string | null;
  platform?: { mailbox?: string | null; password?: string | null };
  smtp?: { host?: string | null; port?: number; secure?: boolean; username?: string | null; from?: string | null; password?: string | null };
}

/** account: password reset, e-mail confirmation and the personal notices of the account. */
export type TransactionalMailKind = 'notification' | 'test' | 'account';

/** GET /api/system/transactional-mail/log */
export interface TransactionalMailLogEntry {
  id: number;
  createdAt: string;
  kind: TransactionalMailKind;
  to: string;
  subject: string;
  status: 'sent' | 'failed' | 'skipped';
  transport: 'platform' | 'smtp' | null;
  error: string | null;
}

/** POST /api/system/transactional-mail/test { to } */
export interface TransactionalMailTestResult {
  ok: boolean;
  error: string | null;
}
