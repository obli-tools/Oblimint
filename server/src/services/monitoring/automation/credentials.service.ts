import type { Request } from 'express';
import type {
  AutomationSshKey, AutomationSshKeyCreate, SftpTarget, SftpTargetInput, SftpTargetTestResult, SftpTargetUpdate,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { open, seal } from '../../../utils/secretBox';
import { auditService } from '../../audit.service';
import type { HostingActor } from '../../hosting/access';
import { loadOwned, type OwnedRow } from '../../hosting/p4bAccess';
import { platformSettings } from '../../platformSettings';
import { isPlatformAdmin, jsonValue, mayUsePrivateTargets, ownerForCreate, ownerOf, sameOwner, scopeList, toIso, type ListFilter, type RowOwner } from '../common';
import { emitMonitoring } from '../events';
import { nodePublicAddresses, nodeRefusal } from '../nodeAddresses';
import { assertTargetAllowed, isNodeAddress, resolveTarget, TargetRefusedError, type PinnedAddress } from '../targetGuard';
import { connectSftp, HostKeyMismatchError, remotePathUnder, sftpErrorText, SftpError, type SftpSession } from './sftp';
import { generateEd25519, importPrivateKey, keyComment, SshKeyError } from './sshKeys';

// ─────────────────────────────────────────────────────────────────────────────
// SSH keys and SFTP targets of the automation (docs/P4b-PLAN.md §11.2 /
// §11.3, invariant MO3): private keys and passwords sealed with
// secretBox('automation'), never returned nor logged; SFTP host key pinned at
// the first successful connection (TOFU), any later difference refused
// (409 hostKeyMismatch) until the owner resets the pin; anti-SSRF on the
// target host (public addresses only, except platform rows of the master
// tenant with settings.monitoring.allowPrivateTargets; never the node's own
// public addresses for the others); a target used by a workflow exporting a
// PLATFORM certificate is edited by platform admins only.
// ─────────────────────────────────────────────────────────────────────────────

export interface SshKeyRow extends OwnedRow {
  name: string;
  public_key: string;
  fingerprint: string;
  private_key_sealed: string;
  created_at: Date | string;
}

export interface SftpTargetRow extends OwnedRow {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'key' | 'password';
  ssh_key_id: number | null;
  password_sealed: string | null;
  base_path: string;
  host_key_fingerprint: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toSshKey(r: SshKeyRow): AutomationSshKey {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    name: r.name,
    publicKey: r.public_key,
    fingerprint: r.fingerprint,
    createdAt: toIso(r.created_at)!,
  };
}

function toTarget(r: SftpTargetRow): SftpTarget {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    name: r.name,
    host: r.host,
    port: Number(r.port),
    username: r.username,
    authMethod: r.auth_method,
    sshKeyId: r.ssh_key_id === null ? null : Number(r.ssh_key_id),
    hasPassword: !!r.password_sealed,
    basePath: r.base_path,
    hostKeyFingerprint: r.host_key_fingerprint,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  };
}

const invalid = (message: string, field?: string) => new AppError(400, message, 'validation', field ? { [field]: [message] } : undefined);
const targetNotAllowed = () => new AppError(403, 'This destination is not allowed (private or internal address)', 'targetNotAllowed');

async function allowPrivateFor(owner: RowOwner): Promise<boolean> {
  return mayUsePrivateTargets(owner) && (await platformSettings.section('monitoring')).allowPrivateTargets;
}

// ── test seam: resolution of the SFTP hosts ─────────────────────────────────

type Resolver = (host: string, allowPrivate: boolean) => Promise<PinnedAddress>;
let resolver: Resolver = (host, allowPrivate) => resolveTarget(host, { allowPrivate });
let saveLookup: ((host: string) => Promise<Array<{ address: string; family: number }>>) | undefined;

export function setSftpResolverForTests(r: Resolver | null, lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>): void {
  resolver = r ?? ((host, allowPrivate) => resolveTarget(host, { allowPrivate }));
  saveLookup = lookup;
}

// ── SSH keys ─────────────────────────────────────────────────────────────────

export const sshKeyService = {
  async list(actor: HostingActor, filter: ListFilter): Promise<AutomationSshKey[]> {
    const rows = await scopeList(actor, db('automation_ssh_keys as k'), 'k', filter).select('k.*').orderBy('k.name') as SshKeyRow[];
    return rows.map(toSshKey);
  },

  async create(req: Request, actor: HostingActor, body: AutomationSshKeyCreate): Promise<AutomationSshKey> {
    const owner = await ownerForCreate(actor, body.accountId);
    const comment = keyComment(body.name);
    let material;
    try {
      material = body.privateKey ? importPrivateKey(body.privateKey, comment) : generateEd25519(comment);
    } catch (err) {
      if (err instanceof SshKeyError) throw invalid(err.message, 'privateKey');
      throw err;
    }
    const [row] = await db('automation_ssh_keys').insert({
      tenant_id: owner.tenantId,
      account_id: owner.accountId,
      name: body.name,
      public_key: material.publicKey,
      fingerprint: material.fingerprint,
      private_key_sealed: seal('automation', material.privateKey),
    }).returning('*') as SshKeyRow[];
    emitMonitoring({ entity: 'sshKey', id: Number(row.id), accountId: owner.accountId, action: 'created' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.sshKey.create', {
      resourceType: 'ssh_key', resourcePath: String(row.id),
      details: { name: body.name, accountId: owner.accountId, imported: !!body.privateKey, fingerprint: material.fingerprint },
    });
    return toSshKey(row);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadOwned<SshKeyRow>(actor, 'automation_ssh_keys', id, 'monitoring.manage', 'SSH key');
    const used = await db('sftp_targets').where({ ssh_key_id: row.id }).first('id');
    if (used) throw new AppError(409, 'This SSH key is used by an SFTP target', 'sshKeyInUse');
    const owner = ownerOf(row);
    await db('automation_ssh_keys').where({ id: row.id }).delete();
    emitMonitoring({ entity: 'sshKey', id: Number(row.id), accountId: owner.accountId, action: 'deleted' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.sshKey.delete', {
      resourceType: 'ssh_key', resourcePath: String(row.id), details: { name: row.name, fingerprint: row.fingerprint },
    });
  },
};

// ── SFTP targets ─────────────────────────────────────────────────────────────

async function assertKeyOfOwner(actor: HostingActor, owner: RowOwner, keyId: number): Promise<void> {
  const key = await loadOwned<SshKeyRow>(actor, 'automation_ssh_keys', keyId, 'read', 'SSH key');
  if (!sameOwner(ownerOf(key), owner)) throw invalid('The SSH key belongs to another account', 'sshKeyId');
}

async function assertHost(owner: RowOwner, host: string): Promise<void> {
  const allowPrivate = await allowPrivateFor(owner);
  try {
    await assertTargetAllowed(host, { allowPrivate, lookup: saveLookup, refuse: await nodeRefusal({ exempt: allowPrivate }) });
  } catch (err) {
    if (err instanceof TargetRefusedError) throw targetNotAllowed();
    throw err;
  }
}

function checkBasePath(basePath: string): string {
  try {
    remotePathUnder(basePath, '');
  } catch (err) {
    if (err instanceof SftpError) throw invalid('Invalid base path', 'basePath');
    throw err;
  }
  return basePath;
}

/**
 * Opens a session on a target (runner + test): anti-SSRF resolution, sealed
 * credentials, pinned host key; a target without a pin is pinned to what
 * the server presented (TOFU). Throws TargetRefusedError /
 * HostKeyMismatchError / ssh errors.
 */
export async function openTargetSession(target: SftpTargetRow): Promise<{ session: SftpSession; pinned: boolean }> {
  const owner = ownerOf(target);
  const allowPrivate = await allowPrivateFor(owner);
  const pin = await resolver(target.host, allowPrivate);
  if (!allowPrivate && isNodeAddress(pin.address, await nodePublicAddresses())) throw new TargetRefusedError('destination refused (address not allowed)');
  let privateKey: string | undefined;
  let password: string | undefined;
  if (target.auth_method === 'key') {
    if (!target.ssh_key_id) throw new SftpError('no SSH key on the target');
    const key = await db('automation_ssh_keys').where({ id: target.ssh_key_id, tenant_id: target.tenant_id }).first() as SshKeyRow | undefined;
    if (!key || !sameOwner(ownerOf(key), owner)) throw new SftpError('SSH key missing');
    privateKey = open('automation', key.private_key_sealed);
  } else {
    if (!target.password_sealed) throw new SftpError('no password on the target');
    password = open('automation', target.password_sealed);
  }
  const session = await connectSftp({
    address: pin.address, port: Number(target.port), username: target.username, privateKey, password,
    expectedFingerprint: target.host_key_fingerprint,
  });
  let pinned = false;
  if (!target.host_key_fingerprint) {
    // Conditional update: a concurrent pin (or reset) wins over ours.
    const n = await db('sftp_targets').where({ id: target.id }).whereNull('host_key_fingerprint')
      .update({ host_key_fingerprint: session.fingerprint, updated_at: new Date() });
    pinned = Number(n) > 0;
  }
  return { session, pinned };
}

/**
 * Does a workflow export a PLATFORM certificate (panel / preview wildcard)
 * to this target? Such a target is changed by platform admins only:
 * redirecting it would hand the platform keys to whoever edits it.
 */
async function exportsPlatformCertificate(targetId: number): Promise<boolean> {
  const rows = await db('workflows').whereRaw(`actions @> ?::jsonb`, [JSON.stringify([{ sftpTargetId: targetId }])]).select('actions') as Array<{ actions: unknown }>;
  const certs: Array<{ kind: string; id: number }> = [];
  for (const r of rows) {
    for (const a of jsonValue<Array<{ kind?: string; sftpTargetId?: number; certificate?: { kind: string; id: number } }>>(r.actions, [])) {
      if (a.kind === 'export-certificate' && Number(a.sftpTargetId) === targetId && a.certificate) certs.push(a.certificate);
    }
  }
  const acme = certs.filter((c) => c.kind === 'acme').map((c) => Number(c.id));
  if (acme.length === 0) return false;
  const platform = await db('certificates').whereIn('id', acme).whereNull('domain_id').whereNull('site_id').first('id');
  return !!platform;
}

export const sftpTargetService = {
  async list(actor: HostingActor, filter: ListFilter): Promise<SftpTarget[]> {
    const rows = await scopeList(actor, db('sftp_targets as t'), 't', filter).select('t.*').orderBy('t.name') as SftpTargetRow[];
    return rows.map(toTarget);
  },

  async create(req: Request, actor: HostingActor, body: SftpTargetInput): Promise<SftpTarget> {
    const owner = await ownerForCreate(actor, body.accountId);
    if (body.authMethod === 'key') {
      if (!body.sshKeyId) throw invalid('Key authentication needs an SSH key', 'sshKeyId');
      await assertKeyOfOwner(actor, owner, body.sshKeyId);
    } else if (!body.password) {
      throw invalid('Password authentication needs a password', 'password');
    }
    await assertHost(owner, body.host);
    const basePath = checkBasePath(body.basePath ?? '.');
    const [row] = await db('sftp_targets').insert({
      tenant_id: owner.tenantId,
      account_id: owner.accountId,
      name: body.name,
      host: body.host.trim().toLowerCase(),
      port: body.port ?? 22,
      username: body.username,
      auth_method: body.authMethod,
      ssh_key_id: body.authMethod === 'key' ? body.sshKeyId : null,
      password_sealed: body.authMethod === 'password' && body.password ? seal('automation', body.password) : null,
      base_path: basePath,
      host_key_fingerprint: null,
    }).returning('*') as SftpTargetRow[];
    emitMonitoring({ entity: 'sftpTarget', id: Number(row.id), accountId: owner.accountId, action: 'created' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.sftpTarget.create', {
      resourceType: 'sftp_target', resourcePath: String(row.id),
      details: { name: body.name, host: row.host, port: row.port, username: body.username, authMethod: body.authMethod, accountId: owner.accountId },
    });
    return toTarget(row);
  },

  async update(req: Request, actor: HostingActor, id: number, body: SftpTargetUpdate): Promise<SftpTarget> {
    const current = await loadOwned<SftpTargetRow>(actor, 'sftp_targets', id, 'monitoring.manage', 'SFTP target');
    const owner = ownerOf(current);
    if (current.account_id === null && !isPlatformAdmin(actor) && await exportsPlatformCertificate(Number(current.id))) {
      throw new AppError(403, 'This SFTP target receives a platform certificate: only a platform administrator may change it', 'sftpTargetPlatformOnly');
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    const authMethod = body.authMethod ?? current.auth_method;
    if (body.name !== undefined) patch.name = body.name;
    if (body.username !== undefined) patch.username = body.username;
    if (body.host !== undefined && body.host.trim().toLowerCase() !== current.host) {
      await assertHost(owner, body.host);
      patch.host = body.host.trim().toLowerCase();
      patch.host_key_fingerprint = null; // another server: pinned again at the next test
    }
    if (body.port !== undefined && body.port !== Number(current.port)) {
      patch.port = body.port;
      patch.host_key_fingerprint = null;
    }
    if (body.basePath !== undefined) patch.base_path = checkBasePath(body.basePath);
    if (body.resetHostKey) patch.host_key_fingerprint = null;
    patch.auth_method = authMethod;
    if (authMethod === 'key') {
      const keyId = body.sshKeyId !== undefined ? body.sshKeyId : current.ssh_key_id;
      if (!keyId) throw invalid('Key authentication needs an SSH key', 'sshKeyId');
      if (body.sshKeyId !== undefined) await assertKeyOfOwner(actor, owner, keyId);
      patch.ssh_key_id = keyId;
      patch.password_sealed = null;
    } else {
      if (body.password) patch.password_sealed = seal('automation', body.password);
      else if (!current.password_sealed) throw invalid('Password authentication needs a password', 'password');
      // The stored password only goes to the server it was given for: another host or port needs it again (L8).
      else if (patch.host !== undefined || patch.port !== undefined) throw invalid('The server changed: enter the password again', 'password');
      patch.ssh_key_id = null;
    }
    const [row] = await db('sftp_targets').where({ id: current.id }).update(patch).returning('*') as SftpTargetRow[];
    emitMonitoring({ entity: 'sftpTarget', id: Number(row.id), accountId: owner.accountId, action: 'updated' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.sftpTarget.update', {
      resourceType: 'sftp_target', resourcePath: String(row.id),
      details: { fields: Object.keys(body).filter((k) => k !== 'password'), passwordChanged: !!body.password, hostKeyReset: patch.host_key_fingerprint === null },
    });
    return toTarget(row);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const current = await loadOwned<SftpTargetRow>(actor, 'sftp_targets', id, 'monitoring.manage', 'SFTP target');
    const used = await db('workflows').whereRaw(`actions @> ?::jsonb`, [JSON.stringify([{ sftpTargetId: Number(current.id) }])]).first('id');
    if (used) throw new AppError(409, 'This SFTP target is used by a workflow', 'sftpTargetInUse');
    const owner = ownerOf(current);
    await db('sftp_targets').where({ id: current.id }).delete();
    emitMonitoring({ entity: 'sftpTarget', id: Number(current.id), accountId: owner.accountId, action: 'deleted' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.sftpTarget.delete', {
      resourceType: 'sftp_target', resourcePath: String(current.id), details: { name: current.name },
    });
  },

  /** Connects and lists the base path; pins the host key the first time (TOFU). */
  async test(req: Request, actor: HostingActor, id: number): Promise<SftpTargetTestResult> {
    const target = await loadOwned<SftpTargetRow>(actor, 'sftp_targets', id, 'monitoring.manage', 'SFTP target');
    const owner = ownerOf(target);
    let result: SftpTargetTestResult;
    try {
      const { session, pinned } = await openTargetSession(target);
      try {
        await session.readdir(remotePathUnder(target.base_path, ''));
        result = { ok: true, fingerprint: session.fingerprint, error: null };
      } catch (err) {
        result = { ok: false, fingerprint: session.fingerprint, error: sftpErrorText(err) };
      } finally {
        session.close();
      }
      if (pinned) emitMonitoring({ entity: 'sftpTarget', id: Number(target.id), accountId: owner.accountId, action: 'updated' }, owner);
    } catch (err) {
      if (err instanceof TargetRefusedError) throw targetNotAllowed();
      if (err instanceof HostKeyMismatchError) {
        await auditService.logReqAs(req, owner.tenantId, 'automation.sftpTarget.test', {
          resourceType: 'sftp_target', resourcePath: String(target.id), details: { ok: false, error: 'host key mismatch', presented: err.fingerprint },
        });
        throw new AppError(409, 'The server presented a different host key than the pinned one', 'hostKeyMismatch',
          { pinned: target.host_key_fingerprint, presented: err.fingerprint });
      }
      result = { ok: false, fingerprint: null, error: sftpErrorText(err) };
    }
    await auditService.logReqAs(req, owner.tenantId, 'automation.sftpTarget.test', {
      resourceType: 'sftp_target', resourcePath: String(target.id), details: { ok: result.ok, error: result.error, fingerprint: result.fingerprint },
    });
    return result;
  },
};
