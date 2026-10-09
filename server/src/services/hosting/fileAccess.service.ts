import type { Request } from 'express';
import type { AccountSshKey, FileAccessInfo, FileAccessPasswordResult, FileServerMode } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { comparePassword, generatePassword, hashPassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { fileServerService } from '../docker/filesrv.service';
import { emitHosting } from './events';
import { iso, type AccountRow } from './rows';
import { parseSshPublicKey, sshKeysService } from './sshKeys.service';

// ─────────────────────────────────────────────────────────────────────────────
// File-server credentials of an account (SFTP password + SSH keys + mode).
// OWNED BY MODULE `hosting-api`. verifyLogin is consumed by the internal
// SFTPGo auth hook of module `releases` (invariants F1, F2).
// ─────────────────────────────────────────────────────────────────────────────

export interface FileServerLoginAttempt {
  username: string;
  /** Plain password (SFTPGo external auth "password"), absent for key auth. */
  password?: string | null;
  /** OpenSSH public key line (SFTPGo external auth "public_key"), absent for password auth. */
  publicKey?: string | null;
  ip?: string | null;
  protocol?: string | null;
}

export interface FileServerLoginResult {
  ok: boolean;
  method: 'password' | 'publickey' | null;
}

/** On-demand window still open: filesrv_active_until set and in the future. */
export function activeWindowOpen(until: Date | string | null | undefined, now = Date.now()): boolean {
  if (until === null || until === undefined) return false;
  const t = until instanceof Date ? until.getTime() : new Date(until).getTime();
  return Number.isFinite(t) && t > now;
}

/** Length of the generated SFTP password (F2: ≥ 20). */
export const FILESRV_PASSWORD_LENGTH = 24;

// bcrypt hash of a random secret: compared when there is nothing real to
// compare against, so every login attempt costs one bcrypt (flat timing).
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword(generatePassword(32));
  return dummyHash;
}

async function panelHost(): Promise<string | null> {
  try {
    const host = (await appConfigService.get('panel_hostname'))?.trim();
    if (host) return host;
    return (await appConfigService.get('public_ipv4'))?.trim() || null;
  } catch {
    return null;
  }
}

function emitChanged(account: AccountRow): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: account.id, accountId: account.id, action: 'updated' },
    { tenantId: account.tenant_id, accountId: account.id });
}

/** fileServerService.applyMode never blocks the API: the reconcile converges later. */
async function applyModeQuietly(accountId: number): Promise<void> {
  try {
    await fileServerService.applyMode(accountId);
  } catch (err) {
    logger.warn({ err, accountId }, 'fileServerService.applyMode failed (the reconcile will retry)');
  }
}

async function loadRow(accountId: number): Promise<AccountRow> {
  const row = await db('hosting_accounts').where({ id: accountId }).first() as AccountRow | undefined;
  if (!row) throw new AppError(404, 'Account not found', 'notFound');
  return row;
}

export const fileAccessService = {
  /**
   * true only when: username === hosting_accounts.username of THIS account,
   * account status 'active', filesrv_mode <> 'off' (on-demand: only while
   * filesrv_active_until is in the future, even if the stop worker is late),
   * and the bcrypt password
   * matches OR the key's fingerprint is one of account_ssh_keys. Exactly one
   * bcrypt compare per call (a dummy one when there is nothing to compare).
   * Never throws.
   */
  async verifyLogin(accountId: number, attempt: FileServerLoginAttempt): Promise<FileServerLoginResult> {
    const denied: FileServerLoginResult = { ok: false, method: null };
    try {
      const dummy = await getDummyHash();
      const row = Number.isInteger(accountId) && accountId > 0
        ? await db('hosting_accounts').where({ id: accountId })
          .first('id', 'username', 'status', 'filesrv_mode', 'filesrv_active_until', 'filesrv_password_hash') as
          Pick<AccountRow, 'id' | 'username' | 'status' | 'filesrv_mode' | 'filesrv_active_until' | 'filesrv_password_hash'> | undefined
        : undefined;
      const eligible = !!row && row.status === 'active' && row.filesrv_mode !== 'off'
        && (row.filesrv_mode !== 'on-demand' || activeWindowOpen(row.filesrv_active_until))
        && typeof attempt?.username === 'string' && attempt.username === row.username;
      const password = typeof attempt?.password === 'string' && attempt.password.length > 0 && attempt.password.length <= 1024
        ? attempt.password : null;
      const publicKey = typeof attempt?.publicKey === 'string' && attempt.publicKey.trim() ? attempt.publicKey : null;

      if (password !== null) {
        const hash = eligible && row?.filesrv_password_hash ? row.filesrv_password_hash : dummy;
        const match = await comparePassword(password, hash);
        return eligible && !!row?.filesrv_password_hash && match ? { ok: true, method: 'password' } : denied;
      }
      // Key (or nothing): keep the same cost as a password attempt.
      await comparePassword('oblimint-timing-guard', dummy);
      if (!eligible || publicKey === null || !row) return denied;
      let fingerprint: string;
      try { fingerprint = parseSshPublicKey(publicKey).fingerprint; } catch { return denied; }
      return (await sshKeysService.hasFingerprint(row.id, fingerprint)) ? { ok: true, method: 'publickey' } : denied;
    } catch (err) {
      logger.warn({ err, accountId }, 'File-server login check failed');
      return denied;
    }
  },

  async info(accountId: number): Promise<FileAccessInfo> {
    const row = await loadRow(accountId);
    const [host, sshKeys, sites, running] = await Promise.all([
      panelHost(),
      sshKeysService.list(row.id),
      db('sites').where({ account_id: row.id }).orderBy('name').select('id', 'name', 'slug') as Promise<Array<{ id: number; name: string; slug: string }>>,
      fileServerService.status(row.id).then((s) => !!s.running).catch(() => false),
    ]);
    return {
      accountId: row.id,
      mode: row.filesrv_mode,
      protocol: 'sftp',
      host,
      port: row.filesrv_port,
      username: row.username,
      hasPassword: !!row.filesrv_password_hash,
      sshKeys,
      running,
      activeUntil: row.filesrv_mode === 'on-demand' ? iso(row.filesrv_active_until) : null,
      layout: sites.map((s) => ({ siteId: s.id, siteName: s.name, stagingPath: `/staging/${s.slug}/`, dataPath: `/data/${s.slug}/` })),
    };
  },

  /** PUT /accounts/:id/file-access {mode} (files.manage). */
  async setMode(req: Request, account: AccountRow, mode: FileServerMode): Promise<FileAccessInfo> {
    if (mode !== account.filesrv_mode) {
      await db('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id })
        .update({ filesrv_mode: mode, filesrv_active_until: mode === 'on-demand' ? account.filesrv_active_until : null, updated_at: db.fn.now() });
      await auditService.logReqAs(req, account.tenant_id, 'filesrv.mode', {
        resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, from: account.filesrv_mode, to: mode },
      });
      emitChanged(account);
      await applyModeQuietly(account.id);
    }
    return this.info(account.id);
  },

  /** POST /accounts/:id/file-access/password: new random password, returned ONCE, stored bcrypt. */
  async resetPassword(req: Request, account: AccountRow): Promise<FileAccessPasswordResult> {
    const password = generatePassword(FILESRV_PASSWORD_LENGTH);
    await db('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id })
      .update({ filesrv_password_hash: await hashPassword(password), updated_at: db.fn.now() });
    await auditService.logReqAs(req, account.tenant_id, 'filesrv.password_reset', {
      resourceType: 'account', resourcePath: String(account.id), details: { username: account.username },
    });
    emitChanged(account);
    return { password };
  },

  /** DELETE /accounts/:id/file-access/password: key authentication only. */
  async clearPassword(req: Request, account: AccountRow): Promise<FileAccessInfo> {
    if (account.filesrv_password_hash) {
      await db('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id })
        .update({ filesrv_password_hash: null, updated_at: db.fn.now() });
      await auditService.logReqAs(req, account.tenant_id, 'filesrv.password_clear', {
        resourceType: 'account', resourcePath: String(account.id), details: { username: account.username },
      });
      emitChanged(account);
    }
    return this.info(account.id);
  },

  async addKey(req: Request, account: AccountRow, input: { name: string; publicKey: string }): Promise<AccountSshKey> {
    const key = await sshKeysService.add(account.id, input);
    await auditService.logReqAs(req, account.tenant_id, 'filesrv.key_add', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, name: key.name, fingerprint: key.fingerprint, algorithm: key.algorithm },
    });
    emitChanged(account);
    return key;
  },

  async deleteKey(req: Request, account: AccountRow, keyId: number): Promise<void> {
    const removed = await sshKeysService.remove(account.id, keyId);
    if (!removed) throw new AppError(404, 'SSH key not found', 'notFound');
    await auditService.logReqAs(req, account.tenant_id, 'filesrv.key_delete', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, name: removed.name, fingerprint: removed.fingerprint },
    });
    emitChanged(account);
  },
};
