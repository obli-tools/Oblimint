import type {
  DbDatabase, DbEngine, DbGrant, DbInstance, DbInstanceStatus, DbPrivilegeLevel, DbTuningProfile, DbUser,
} from '@oblimint/shared';
import { DB_PROFILE_MEMORY_MB, dbFamilyOf } from '@oblimint/shared';
import { dbInstanceAlias } from '../hosting/naming';
import { iso } from '../hosting/rows';
import { DB_CONTAINER_PORT, siteSocketPath } from './engines';

// Raw rows of the database tables (migration 003) and their API mappers.

export interface DbInstanceRow {
  id: number;
  tenant_id: number;
  account_id: number;
  node_id: number;
  name: string;
  engine: DbEngine;
  version: string;
  profile: DbTuningProfile;
  status: DbInstanceStatus;
  status_message: string | null;
  is_default: boolean;
  root_secret: string;
  external_enabled: boolean;
  external_port: number | null;
  size_bytes: number | string | null;
  size_checked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  /** joined */ account_username?: string;
  database_count?: number | string | null;
  user_count?: number | string | null;
}

export interface DbDatabaseRow {
  id: number;
  instance_id: number;
  account_id: number;
  name: string;
  charset: string | null;
  collation: string | null;
  size_bytes: number | string | null;
  size_checked_at: Date | string | null;
  created_at: Date | string;
}

export interface DbUserRow {
  id: number;
  instance_id: number;
  account_id: number;
  username: string;
  password_set_at: Date | string | null;
  created_at: Date | string;
}

export interface DbGrantRow {
  instance_id: number;
  user_id: number;
  database_id: number;
  level: DbPrivilegeLevel;
}

const numOrNull = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function toDbInstance(r: DbInstanceRow): DbInstance {
  const family = dbFamilyOf(r.engine);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    accountUsername: r.account_username ?? '',
    nodeId: r.node_id,
    name: r.name,
    engine: r.engine,
    version: r.version,
    family,
    profile: r.profile,
    memoryLimitMb: DB_PROFILE_MEMORY_MB[r.profile],
    status: r.status,
    statusMessage: r.status_message,
    isDefault: !!r.is_default,
    socketPath: siteSocketPath(family, r.id, !!r.is_default),
    internalHost: dbInstanceAlias(r.id),
    internalPort: DB_CONTAINER_PORT[family],
    externalEnabled: !!r.external_enabled,
    externalPort: r.external_enabled ? r.external_port : null,
    databaseCount: Number(r.database_count ?? 0),
    userCount: Number(r.user_count ?? 0),
    sizeBytes: numOrNull(r.size_bytes),
    sizeCheckedAt: iso(r.size_checked_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export function toDbDatabase(r: DbDatabaseRow): DbDatabase {
  return {
    id: r.id,
    instanceId: r.instance_id,
    name: r.name,
    charset: r.charset,
    collation: r.collation,
    sizeBytes: numOrNull(r.size_bytes),
    sizeCheckedAt: iso(r.size_checked_at),
    createdAt: iso(r.created_at) as string,
  };
}

export function toDbUser(r: DbUserRow, grants: Array<DbGrantRow & { database_name: string }>): DbUser {
  return {
    id: r.id,
    instanceId: r.instance_id,
    username: r.username,
    grants: grants
      .filter((g) => g.user_id === r.id)
      .map((g): DbGrant => ({ databaseId: g.database_id, databaseName: g.database_name, level: g.level }))
      .sort((a, b) => a.databaseName.localeCompare(b.databaseName)),
    passwordSetAt: iso(r.password_set_at),
    createdAt: iso(r.created_at) as string,
  };
}
