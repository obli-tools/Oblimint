import type { TFunction } from 'i18next';
import type { DbEngine, DbInstanceStatus, DbPrivilegeLevel, DbTuningProfile } from '@oblimint/shared';
import { codedErrorMessage, toastCodedError, DB_NS } from '@/components/dns/dnsErrors';

/** Instance label rule (shared/databases.ts DbInstance.name). */
export const DB_INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Database name rule (server: ^[A-Za-z0-9_]{1,64}$, PostgreSQL lower-cased). */
export const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
/** SQL user name rule. */
export const DB_USER_RE = /^[A-Za-z0-9_]{1,32}$/;
export const DB_MIN_PASSWORD = 12;
/** Maximum restore upload (server module limit). */
export const DB_RESTORE_MAX_BYTES = 2 * 1024 ** 3;

/**
 * Names the servers keep for themselves: an exact mirror of the server's
 * isReservedName (server/src/services/databases/sql.ts), the same rule for
 * database and user names. The server stays the authority (reservedName).
 */
const RESERVED_EXACT = new Set([
  'mysql', 'information_schema', 'performance_schema', 'sys', 'mariadb.sys', 'root', 'postgres',
  'template0', 'template1', 'pg_catalog', 'pg_toast', 'public', 'mysql.sys', 'mysql.session', 'mysql.infoschema',
  'healthcheck', 'pg_signal_backend', 'pg_monitor',
]);

function isReservedName(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED_EXACT.has(n) || n.startsWith('oblimint') || n.startsWith('oblsso_') || n.startsWith('pg_');
}

export function isReservedDbName(n: string): boolean {
  return isReservedName(n);
}
export function isReservedDbUser(n: string): boolean {
  return isReservedName(n);
}

export const DB_PROFILES: readonly DbTuningProfile[] = ['S', 'M', 'L'];

export function engineLabel(e: DbEngine): string {
  return e === 'mariadb' ? 'MariaDB' : e === 'mysql' ? 'MySQL' : 'PostgreSQL';
}

export function dbStatusLabel(t: TFunction, s: DbInstanceStatus): string {
  const fb: Record<DbInstanceStatus, string> = { provisioning: 'Provisioning', running: 'Running', stopped: 'Stopped', error: 'Error', deleting: 'Deleting' };
  return t(`databases.status.${s}`) || fb[s];
}

export function privilegeLabel(t: TFunction, l: DbPrivilegeLevel | 'none'): string {
  const fb = { all: 'All privileges', readonly: 'Read only', none: 'No access' } as const;
  return t(`databases.users.level.${l}`) || fb[l];
}

/** Bytes → "12.3 MB" (binary units, translated labels). */
export function formatBytes(t: TFunction, bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = [t('databases.units.b') || 'B', t('databases.units.kb') || 'KB', t('units.mb') || 'MB', t('units.gb') || 'GB', t('databases.units.tb') || 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const rounded = i === 0 ? String(v) : String(Math.round(v * (v >= 100 ? 1 : 10)) / (v >= 100 ? 1 : 10));
  return `${rounded} ${units[i]}`;
}

export const dbErrorMessage = (t: TFunction, err: unknown, fallback: string) => codedErrorMessage(t, err, fallback, DB_NS);
export const toastDbError = (t: TFunction, err: unknown, fallback: string) => toastCodedError(t, err, fallback, DB_NS);
