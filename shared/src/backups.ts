// External backups (off-site copies) of the hosting accounts and of the panel.
// Every object is encrypted with the platform backup passphrase (OBKP format:
// scrypt + AES-256-GCM per 1 MiB frame) before it leaves the server: the
// destination never sees the content. Without the passphrase, nothing can be
// restored: it is shown once and must be kept outside the platform.

export type BackupDestinationKind = 'local' | 'sftp' | 's3';

export type BackupDestinationConfig =
  | { kind: 'local'; /** Sub-folder of <data dir>/backups. */ subdir?: string }
  | {
    kind: 'sftp'; host: string; port?: number; username: string;
    password?: string; privateKey?: string;
    /** Remote folder ("backups", "/srv/backups"). */
    path?: string;
    /** "SHA256:…" pinned at the first successful test. */
    hostKey?: string;
  }
  | {
    kind: 's3'; bucket: string; region?: string;
    /** Non-AWS providers (Backblaze B2, Wasabi, MinIO, Scaleway, OVH…). */
    endpoint?: string; prefix?: string; forcePathStyle?: boolean;
    accessKeyId: string; secretAccessKey: string;
  };

/** What the browser sees of a destination (secrets never sent back). */
export interface BackupDestination {
  id: number;
  name: string;
  kind: BackupDestinationKind;
  /** Non-secret fields (host, port, username, path, bucket, region, endpoint, prefix, subdir). */
  settings: Record<string, string | number | boolean | null>;
  hostKey: string | null;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  lastTestAt: string | null;
  lastTestError: string | null;
  createdAt: string;
}

/** Create / update. On update, an omitted or empty secret keeps the stored one. */
export interface BackupDestinationInput {
  name: string;
  config: BackupDestinationConfig;
}

export interface BackupSettings {
  enabled: boolean;
  destinationId: number | null;
  /** Hour of the daily run (server time, 0-23). */
  hour: number;
  retentionDays: number;
  /** Runs kept per account even when older than retentionDays. */
  keepMin: number;
  /** Panel database + configuration backed up too. */
  includePanel: boolean;
  passphraseSet: boolean;
  lastScheduledAt: string | null;
}

export interface BackupSettingsUpdate {
  enabled?: boolean;
  destinationId?: number | null;
  hour?: number;
  retentionDays?: number;
  keepMin?: number;
  includePanel?: boolean;
  /** Sets the passphrase (only when none is set yet, or with replacePassphrase). */
  passphrase?: string;
  replacePassphrase?: boolean;
}

export const BACKUP_PASSPHRASE_MIN = 12;

/** 'repo': `git bundle --all` of the site's internal repository (every release commit, refs included). */
export type BackupObjectKind = 'code' | 'data' | 'repo' | 'db' | 'manifest' | 'panel-db' | 'panel-config';

export interface BackupObject {
  kind: BackupObjectKind;
  key: string;
  bytes: number;
  siteId?: number;
  siteSlug?: string;
  databaseId?: number;
  databaseName?: string;
}

export type BackupRunStatus = 'running' | 'ok' | 'partial' | 'failed';

export interface BackupRun {
  id: number;
  scope: 'account' | 'panel';
  accountId: number | null;
  accountUsername: string | null;
  trigger: 'schedule' | 'manual';
  status: BackupRunStatus;
  destinationId: number | null;
  destinationName: string | null;
  objects: BackupObject[];
  bytes: number;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
  /** Objects removed by the retention (the row stays as history). */
  purgedAt: string | null;
}

export type BackupRestoreItem =
  | { kind: 'code'; siteId: number }
  | { kind: 'data'; siteId: number }
  /** The release history (repo.git) put back in place: refs reset to the backed-up state. */
  | { kind: 'repo'; siteId: number }
  | { kind: 'db'; databaseId: number };

export interface BackupRestoreRequest {
  items: BackupRestoreItem[];
}

export interface BackupRestoreResult {
  /** files: entries written (code / data); refs: references restored (repo). */
  restored: Array<BackupRestoreItem & { ok: boolean; error?: string; files?: number; refs?: number }>;
}
