import type { Request } from 'express';
import {
  CONTAINMENT_AUDIT_HOURS, CONTAINMENT_STEPS, HostingSocketEvents,
  type AccountContainment, type ContainmentAuditRow, type ContainmentCredential, type ContainmentSiteFreeze, type ContainmentStatus,
  type ContainmentStep, type ContainmentStepKey,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { clientIp } from '../../utils/clientIp';
import { generatePassword, hashPassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { invalidateKeySurfaces } from '../apiKeys/apiKeys.service';
import { emitHosting } from '../hosting/events';
import type { HostingActor } from '../hosting/access';
import type { AccountRow } from '../hosting/rows';
import { notify, type NotificationPayload } from '../usage/notifications.service';
import { credentialHash } from './guard';

// ─────────────────────────────────────────────────────────────────────────────
// Containment of a hosting account (shared/containment.ts, migration 042).
//
// The barrier comes first and in one transaction: hosting_accounts.contained_at
// is set before anything is revoked, so nothing can be recreated while the
// steps run, and a crash in the middle leaves the account closed. Then each
// step runs on its own: one that fails does not stop the others (more cut is
// better), the report says which, and starting again only runs what is not
// done. The site is never stopped: nothing here touches its containers, its
// database containers or the passwords of its database users.
//
// Keys and tokens are DELETED, not disabled: no code path can bring them back.
// Their hash stays in containment_credentials until the lift, which is how an
// agent presenting one gets 423 accountContained instead of 401.
//
// What the rest of the panel does with the barrier: guard.ts (refusals), access.ts
// (a client keeps only read), firewall (no address allowed on the account's ports),
// windows (no opening, no automatic validation), keys and tokens (423), login.
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINMENTS = 'account_containments';
const MAX_FROZEN_ENTRIES = 5000;
const SWEEP_MS = 60_000;
const AUDIT_SWEEP_MS = 60 * 60_000;

interface ContainmentRow {
  id: number; tenant_id: number; account_id: number | null; username: string; status: ContainmentStatus; reason: string | null;
  started_by: number | null; started_at: Date | string; completed_at: Date | string | null;
  lifted_by: number | null; lifted_at: Date | string | null; lift_note: string | null;
  steps: ContainmentStep[]; previous: Previous; credentials: ContainmentCredential[];
  access_rules: AccountContainment['accessRules']; lift_warnings: string[];
  audit_from: Date | string; audit_until: Date | string;
}

/** What the lift restores. */
interface Previous {
  publishModes?: Record<string, string>;
  filesrvMode?: string;
  sftpCutAt?: string;
}

export interface SiteFreezeResult {
  liveReleaseNumber: number | null;
  liveCommit: string | null;
  stagingCommit: string | null;
  entries: Array<{ path: string; status: string }>;
  note: string | null;
}

export interface ContainmentDeps {
  killSessions(userId: number): Promise<unknown>;
  /** Applies filesrv_mode now: stops the file server and its open sessions. Throws on failure. */
  applyFileServer(accountId: number): Promise<void>;
  /** Pushes the firewall state of the account; throws when hostd refused it. */
  syncFirewall(accountId: number): Promise<void>;
  stopPreviews(accountId: number): Promise<number>;
  closeConsoles(accountId: number): Promise<number>;
  /** phpMyAdmin / Adminer and explorer sessions: their ephemeral SQL users, never the users the sites connect with. */
  closeDbSessions(accountId: number): Promise<number>;
  closeWindow(siteId: number, windowId: number, who: { userId: number | null; ip: string | null }): Promise<unknown>;
  freezeSite(siteId: number, containmentId: number): Promise<SiteFreezeResult>;
  notify(event: 'account.contained' | 'account.containmentLifted', payload: NotificationPayload): void;
}

const defaultDeps: ContainmentDeps = {
  async killSessions(userId) {
    const { killSessionsForUser } = await import('../userSessions.service');
    return killSessionsForUser(userId, 'account contained');
  },
  async applyFileServer(accountId) {
    const { fileServerService } = await import('../docker/filesrv.service');
    await fileServerService.applyMode(accountId);
  },
  async syncFirewall(accountId) {
    const { syncAccountNow } = await import('../firewall/firewall.service');
    await syncAccountNow(accountId);
  },
  async stopPreviews(accountId) {
    const { previewService } = await import('../previews/previews.service');
    return previewService.stopForAccount(accountId);
  },
  async closeConsoles(accountId) {
    const { closeAccountConsoles } = await import('../apps/socketHandlers');
    return closeAccountConsoles(accountId, 'contained');
  },
  async closeDbSessions(accountId) {
    const { closeAccountExplorerSessions } = await import('../databases/explorer/explorer.service');
    const { endAccountSsoSessions, expireSsoSessions } = await import('../databases/sso');
    const n = await closeAccountExplorerSessions(accountId) + endAccountSsoSessions(accountId);
    await expireSsoSessions();
    return n;
  },
  async closeWindow(siteId, windowId, who) {
    const { windowService } = await import('../windows/window.service');
    return windowService.closeInternal(siteId, windowId, 'policy', who);
  },
  async freezeSite(siteId, containmentId) {
    const { releaseService } = await import('../releases/release.service');
    return releaseService.freezeStagingDiff(siteId, containmentId);
  },
  notify: (event, payload) => notify(event, payload),
};

let deps: ContainmentDeps = defaultDeps;

export function setContainmentDepsForTests(over: Partial<ContainmentDeps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const errorText = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 500);

/** The context of one run: what the steps read and the report they fill. */
interface Run {
  row: ContainmentRow;
  accountId: number;
  tenantId: number;
  who: { userId: number | null; ip: string | null };
}

async function save(run: Run, patch: Record<string, unknown> = {}): Promise<void> {
  await db(CONTAINMENTS).where({ id: run.row.id }).update({
    steps: JSON.stringify(run.row.steps), previous: JSON.stringify(run.row.previous),
    credentials: JSON.stringify(run.row.credentials), access_rules: JSON.stringify(run.row.access_rules), ...patch,
  });
}

function remember(run: Run, items: ContainmentCredential[]): void {
  const seen = new Set(run.row.credentials.map((c) => `${c.family}:${c.id}`));
  for (const c of items) if (!seen.has(`${c.family}:${c.id}`)) run.row.credentials.push(c);
}

async function clientUsersOf(accountId: number): Promise<number[]> {
  return await db('account_users as au').join('users as u', 'u.id', 'au.user_id')
    .where('au.account_id', accountId).andWhere('u.kind', 'client').pluck('au.user_id') as number[];
}

async function sitesOf(run: Pick<Run, 'accountId' | 'tenantId'>): Promise<Array<{ id: number; name: string; publish_mode: string }>> {
  return await db('sites').where({ account_id: run.accountId, tenant_id: run.tenantId }).orderBy('id').select('id', 'name', 'publish_mode') as
    Array<{ id: number; name: string; publish_mode: string }>;
}

/** Copies the audit rows about the account on the frozen span (idempotent). */
async function freezeAudit(row: Pick<ContainmentRow, 'id' | 'tenant_id' | 'account_id' | 'audit_from' | 'audit_until' | 'credentials'>): Promise<number> {
  if (row.account_id !== null) {
    const siteIds = (await db('sites').where({ account_id: row.account_id, tenant_id: row.tenant_id }).pluck('id') as number[]).map(String);
    const userIds = await clientUsersOf(row.account_id);
    const keyIds = row.credentials.filter((c) => c.family === 'key' || c.family === 'connector').map((c) => String(c.id));
    await db.raw(`
      INSERT INTO containment_audit_freeze (containment_id, audit_id, user_id, action, resource_type, resource_path, details, ip_address, created_at)
      SELECT ?, l.id, l.user_id, l.action, l.resource_type, l.resource_path, l.details, l.ip_address, l.created_at
        FROM audit_logs l
       WHERE l.tenant_id = ? AND l.created_at >= ? AND l.created_at <= ?
         AND ((l.resource_type = 'account' AND l.resource_path = ?)
           OR (l.resource_type = 'site' AND l.resource_path = ANY(?::text[]))
           OR l.user_id = ANY(?::int[])
           OR l.details ->> 'accountId' = ?
           OR l.details ->> 'siteId' = ANY(?::text[])
           OR l.details -> 'apiKey' ->> 'id' = ANY(?::text[]))
      ON CONFLICT (containment_id, audit_id) DO NOTHING`,
    [row.id, row.tenant_id, new Date(row.audit_from), new Date(row.audit_until), String(row.account_id), siteIds, userIds, String(row.account_id), siteIds, keyIds]);
  }
  const [{ n }] = await db('containment_audit_freeze').where({ containment_id: row.id }).count<{ n: string }[]>('* as n');
  return Number(n);
}

// ── Steps ────────────────────────────────────────────────────────────────────

const STEPS: Record<ContainmentStepKey, (run: Run) => Promise<number>> = {
  /** obk_ keys and connectors, with the OAuth codes, access and refresh tokens they carry. */
  async keys(run) {
    const n = await db.transaction(async (trx) => {
      const keys = await trx('api_keys').where({ account_id: run.accountId, tenant_id: run.tenantId })
        .select('id', 'kind', 'name', 'prefix', 'token_hash', 'oauth_client_id', 'created_by', 'last_used_at', 'last_used_ip') as Array<{
          id: number; kind: string | null; name: string; prefix: string | null; token_hash: string | null; oauth_client_id: string | null;
          created_by: number | null; last_used_at: Date | string | null; last_used_ip: string | null;
        }>;
      if (!keys.length) return 0;
      const ids = keys.map((k) => k.id);
      const tokens = await trx('api_key_oauth_tokens').whereIn('key_id', ids).pluck('token_hash') as string[];
      const hashes = [
        ...keys.map((k) => k.token_hash).filter((h): h is string => !!h),
        ...keys.map((k) => k.oauth_client_id).filter((c): c is string => !!c).map(credentialHash),
        ...tokens,
      ];
      if (hashes.length) {
        await trx('containment_credentials').insert(hashes.map((token_hash) => ({ token_hash, containment_id: run.row.id }))).onConflict('token_hash').ignore();
      }
      await trx('api_keys').whereIn('id', ids).andWhere({ account_id: run.accountId }).del();
      remember(run, keys.map((k) => ({
        family: k.kind === 'connector' ? 'connector' : 'key', id: k.id, name: k.name, ref: k.prefix, createdBy: k.created_by,
        lastUsedAt: iso(k.last_used_at), lastUsedIp: k.last_used_ip,
      })));
      return keys.length;
    });
    if (n) invalidateKeySurfaces();
    return n;
  },

  /** obt_ window tokens. */
  async siteTokens(run) {
    return db.transaction(async (trx) => {
      const tokens = await trx('site_api_tokens').where({ account_id: run.accountId, tenant_id: run.tenantId })
        .select('id', 'site_id', 'name', 'prefix', 'token_hash', 'created_by', 'last_used_at', 'last_used_ip') as Array<{
          id: number; site_id: number; name: string; prefix: string; token_hash: string; created_by: number | null; last_used_at: Date | string | null; last_used_ip: string | null;
        }>;
      if (!tokens.length) return 0;
      await trx('containment_credentials').insert(tokens.map((t) => ({ token_hash: t.token_hash, containment_id: run.row.id }))).onConflict('token_hash').ignore();
      await trx('site_api_tokens').whereIn('id', tokens.map((t) => t.id)).andWhere({ account_id: run.accountId }).del();
      remember(run, tokens.map((t) => ({
        family: 'siteToken', id: t.id, name: t.name, ref: t.prefix, createdBy: t.created_by, lastUsedAt: iso(t.last_used_at), lastUsedIp: t.last_used_ip, siteId: t.site_id,
      })));
      return tokens.length;
    });
  },

  /** Sessions and connector tokens of the client logins, their reset / e-mail links, the 2FA grants of the account. Never the staff's. */
  async sessions(run) {
    const users = await clientUsersOf(run.accountId);
    for (const id of users) await deps.killSessions(id);
    if (users.length) await db('user_action_tokens').whereIn('user_id', users).whereNull('used_at').del();
    await db('access_grants').where({ account_id: run.accountId }).del();
    return users.length;
  },

  /**
   * The only SFTP entry of an account: its file server, with its password and
   * its SSH keys (there is no secondary SFTP login). The new password is random
   * and known to nobody; the keys are gone. Done once, so a resume does not lose
   * the mode it would restore.
   */
  async sftp(run) {
    if (!run.row.previous.sftpCutAt) {
      const row = await db('hosting_accounts').where({ id: run.accountId, tenant_id: run.tenantId }).first('filesrv_mode', 'filesrv_password_hash') as
        Pick<AccountRow, 'filesrv_mode' | 'filesrv_password_hash'>;
      const hash = row.filesrv_password_hash ? await hashPassword(generatePassword(32)) : null;
      const keys = await db('account_ssh_keys').where({ account_id: run.accountId }).select('id', 'name', 'fingerprint', 'created_at') as
        Array<{ id: number; name: string; fingerprint: string }>;
      await db.transaction(async (trx) => {
        await trx('hosting_accounts').where({ id: run.accountId, tenant_id: run.tenantId }).update({
          filesrv_mode: 'off', filesrv_active_until: null, filesrv_password_hash: hash, updated_at: trx.fn.now(),
        });
        await trx('account_ssh_keys').where({ account_id: run.accountId }).del();
      });
      remember(run, keys.map((k) => ({ family: 'sshKey', id: k.id, name: k.name, ref: k.fingerprint, createdBy: null, lastUsedAt: null, lastUsedIp: null })));
      run.row.previous.filesrvMode ??= row.filesrv_mode;
      run.row.previous.sftpCutAt = new Date().toISOString();
      await save(run);
    }
    await deps.applyFileServer(run.accountId);
    return 1;
  },

  /**
   * External SQL and SFTP ports: no address allowed while contained (firewall
   * state). No container is recreated, so the database the site uses never
   * restarts. The rules stay and apply again after the lift: listed for review.
   */
  async firewall(run) {
    const rules = await db('access_rules').where({ account_id: run.accountId }).orderBy('id').select('cidr', 'label', 'created_at') as
      Array<{ cidr: string; label: string | null; created_at: Date | string | null }>;
    run.row.access_rules = rules.map((r) => ({ cidr: r.cidr, note: r.label, createdAt: iso(r.created_at) }));
    await deps.syncFirewall(run.accountId);
    return rules.length;
  },

  /** Previews (they run the staging code on a public host) and their shared links. */
  async previews(run) {
    return deps.stopPreviews(run.accountId);
  },

  /** Requests and approvals in flight: nothing approved before the incident is consumed after it. */
  async pendingActions(run) {
    return Number(await db('pending_actions').where({ account_id: run.accountId, tenant_id: run.tenantId }).whereIn('status', ['pending', 'approved'])
      .update({ status: 'cancelled', decided_at: new Date(), reason: 'Compte confiné' }));
  },

  /** App consoles, database admin sessions, and the webmail opened from the panel. A mailbox's own password keeps working (the mail is part of the service). */
  async consoles(run) {
    const consoles = await deps.closeConsoles(run.accountId) + await deps.closeDbSessions(run.accountId);
    const sessions = Number(await db('webmail_sessions').where({ account_id: run.accountId, tenant_id: run.tenantId, method: 'sso' }).del());
    await db('mail_app_passwords').where({ account_id: run.accountId }).whereNull('revoked_at').update({ revoked_at: new Date(), updated_at: new Date() });
    return consoles + sessions;
  },

  /** Approval mode: nothing goes live without a human, even with a publication already queued. */
  async publishMode(run) {
    const sites = (await sitesOf(run)).filter((s) => s.publish_mode !== 'approval');
    if (!sites.length) return 0;
    const modes = { ...(run.row.previous.publishModes ?? {}) };
    for (const s of sites) modes[String(s.id)] ??= s.publish_mode;
    run.row.previous.publishModes = modes;
    await save(run);
    await db('sites').where({ account_id: run.accountId, tenant_id: run.tenantId }).whereIn('id', sites.map((s) => s.id))
      .update({ publish_mode: 'approval', updated_at: db.fn.now() });
    return sites.length;
  },

  /**
   * Open windows: the live code goes back to read-only and the changes wait for
   * a human, with their diff. They are not rejected here: that would erase the
   * evidence, and code the site now depends on. The staff decides on each one.
   */
  async windows(run) {
    const rows = await db('maintenance_windows').where({ account_id: run.accountId, tenant_id: run.tenantId }).whereIn('status', ['open', 'opening'])
      .select('id', 'site_id', 'status') as Array<{ id: number; site_id: number; status: string }>;
    const errors: string[] = [];
    let closed = 0;
    for (const w of rows) {
      if (w.status === 'opening') { errors.push(`window #${w.id} is still opening`); continue; }
      try {
        await deps.closeWindow(w.site_id, w.id, run.who);
        closed += 1;
      } catch (err) {
        errors.push(`window #${w.id}: ${errorText(err)}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
    return closed;
  },

  /** Staging / live diff of each site, pinned by git refs. A site already frozen is not frozen again. */
  async evidenceStaging(run) {
    const done = new Set(await db('containment_site_freezes').where({ containment_id: run.row.id }).pluck('site_id') as number[]);
    const errors: string[] = [];
    for (const s of await sitesOf(run)) {
      if (done.has(s.id)) continue;
      try {
        const f = await deps.freezeSite(s.id, run.row.id);
        await db('containment_site_freezes').insert({
          containment_id: run.row.id, site_id: s.id, site_name: s.name, live_release_number: f.liveReleaseNumber, live_commit: f.liveCommit, staging_commit: f.stagingCommit,
          entries: JSON.stringify(f.entries.slice(0, MAX_FROZEN_ENTRIES)), total: f.entries.length, truncated: f.entries.length > MAX_FROZEN_ENTRIES, note: f.note, frozen_at: new Date(),
        });
      } catch (err) {
        errors.push(`site #${s.id}: ${errorText(err)}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
    return (await sitesOf(run)).length;
  },

  async evidenceAudit(run) {
    return freezeAudit(run.row);
  },

  /** Reads the state back. Whatever is left sends its step back to pending, for the resume. */
  async verify(run) {
    const count = async (qb: PromiseLike<Array<{ n: string | number }>>): Promise<number> => Number((await qb)[0]?.n ?? 0);
    const users = (await clientUsersOf(run.accountId)).map(String);
    const sessions = users.length ? Number((await db.raw(
      "SELECT COUNT(*) AS n FROM session WHERE (sess::jsonb ->> 'userId') = ANY(?::text[]) OR (sess::jsonb ->> 'pendingMfaUserId') = ANY(?::text[])", [users, users],
    ) as { rows: Array<{ n: string }> }).rows[0].n) : 0;
    const account = await db('hosting_accounts').where({ id: run.accountId }).first('filesrv_mode', 'contained_at') as { filesrv_mode: string; contained_at: Date | null };
    const left: Partial<Record<ContainmentStepKey, number>> = {
      keys: await count(db('api_keys').where({ account_id: run.accountId }).count('* as n') as never),
      siteTokens: await count(db('site_api_tokens').where({ account_id: run.accountId }).count('* as n') as never),
      sessions,
      sftp: (account.filesrv_mode === 'off' ? 0 : 1) + await count(db('account_ssh_keys').where({ account_id: run.accountId }).count('* as n') as never),
      publishMode: await count(db('sites').where({ account_id: run.accountId }).whereNot('publish_mode', 'approval').count('* as n') as never),
      windows: await count(db('maintenance_windows').where({ account_id: run.accountId }).whereIn('status', ['open', 'opening']).count('* as n') as never),
    };
    const dirty = (Object.entries(left) as Array<[ContainmentStepKey, number]>).filter(([, n]) => n > 0);
    if (!account.contained_at) throw new Error('the barrier is not set');
    if (dirty.length) {
      for (const [key] of dirty) {
        const st = run.row.steps.find((s) => s.key === key);
        if (st) st.status = 'pending';
        if (key === 'sftp') delete run.row.previous.sftpCutAt;
      }
      throw new Error(`still present: ${dirty.map(([k, n]) => `${k}=${n}`).join(', ')}`);
    }
    return 0;
  },
};

// ── Report ───────────────────────────────────────────────────────────────────

async function toReport(row: ContainmentRow): Promise<AccountContainment> {
  const ids = [row.started_by, row.lifted_by].filter((v): v is number => v !== null);
  const users = ids.length ? await db('users').whereIn('id', ids).select('id', db.raw('COALESCE(display_name, username) AS name')) as Array<{ id: number; name: string }> : [];
  const nameOf = (id: number | null): string | null => users.find((u) => u.id === id)?.name ?? null;
  const freezes = await db('containment_site_freezes').where({ containment_id: row.id }).orderBy('site_id').select('*') as Array<{
    site_id: number; site_name: string; live_release_number: number | null; live_commit: string | null; staging_commit: string | null;
    entries: ContainmentSiteFreeze['entries']; total: number; truncated: boolean; note: string | null; frozen_at: Date | string;
  }>;
  const [{ n }] = await db('containment_audit_freeze').where({ containment_id: row.id }).count<{ n: string }[]>('* as n');
  return {
    id: row.id, tenantId: row.tenant_id, accountId: row.account_id, username: row.username, status: row.status, reason: row.reason,
    startedAt: iso(row.started_at) as string, startedByName: nameOf(row.started_by), completedAt: iso(row.completed_at),
    liftedAt: iso(row.lifted_at), liftedByName: nameOf(row.lifted_by), liftNote: row.lift_note,
    steps: row.steps, credentials: row.credentials, accessRules: row.access_rules,
    sites: freezes.map((f) => ({
      siteId: f.site_id, siteName: f.site_name, liveReleaseNumber: f.live_release_number, liveCommit: f.live_commit, stagingCommit: f.staging_commit,
      entries: f.entries, total: f.total, truncated: f.truncated, note: f.note, frozenAt: iso(f.frozen_at) as string,
    })),
    auditFrom: iso(row.audit_from) as string, auditUntil: iso(row.audit_until) as string, auditCount: Number(n), liftWarnings: row.lift_warnings,
  };
}

function emitChanged(account: { id: number; tenant_id: number }): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: account.id, accountId: account.id, action: 'updated' }, { tenantId: account.tenant_id, accountId: account.id });
}

// ── Service ──────────────────────────────────────────────────────────────────

const inFlight = new Set<number>();

/** The barrier and the row, in one transaction. An existing containment is returned as it is. */
async function begin(actor: HostingActor, account: AccountRow, reason: string | null): Promise<{ row: ContainmentRow; created: boolean }> {
  return db.transaction(async (trx) => {
    const fresh = await trx('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id }).forUpdate().first('status') as { status: string } | undefined;
    if (!fresh) throw new AppError(404, 'Account not found', 'notFound');
    if (fresh.status === 'deleting') throw new AppError(409, 'The account is being deleted', 'accountDeleting');
    const live = await trx(CONTAINMENTS).where({ account_id: account.id }).whereNot('status', 'lifted').first() as ContainmentRow | undefined;
    if (live) return { row: live, created: false };
    const now = new Date();
    const spanMs = CONTAINMENT_AUDIT_HOURS * 3_600_000;
    const steps: ContainmentStep[] = CONTAINMENT_STEPS.map((key) => ({ key, status: 'pending', count: null, error: null, at: null }));
    const [row] = await trx(CONTAINMENTS).insert({
      tenant_id: account.tenant_id, account_id: account.id, username: account.username, status: 'running', reason, started_by: actor.userId, started_at: now,
      steps: JSON.stringify(steps), audit_from: new Date(now.getTime() - spanMs), audit_until: new Date(now.getTime() + spanMs),
    }).returning('*') as ContainmentRow[];
    await trx('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id }).update({ contained_at: now, updated_at: now });
    return { row, created: true };
  });
}

export const containmentService = {
  /** The last containment of the account (running, lifted…), null when it never had one. */
  async latest(account: Pick<AccountRow, 'id' | 'tenant_id'>): Promise<AccountContainment | null> {
    const row = await db(CONTAINMENTS).where({ account_id: account.id, tenant_id: account.tenant_id }).orderBy('id', 'desc').first() as ContainmentRow | undefined;
    return row ? toReport(row) : null;
  },

  /** Audit rows frozen by the last containment of the account, oldest first. */
  async frozenAudit(account: Pick<AccountRow, 'id' | 'tenant_id'>, limit: number, offset: number): Promise<{ items: ContainmentAuditRow[]; total: number }> {
    const row = await db(CONTAINMENTS).where({ account_id: account.id, tenant_id: account.tenant_id }).orderBy('id', 'desc').first('id') as { id: number } | undefined;
    if (!row) return { items: [], total: 0 };
    const [{ n }] = await db('containment_audit_freeze').where({ containment_id: row.id }).count<{ n: string }[]>('* as n');
    const rows = await db('containment_audit_freeze').where({ containment_id: row.id }).orderBy([{ column: 'created_at' }, { column: 'audit_id' }]).limit(limit).offset(offset).select('*') as Array<{
      audit_id: number; user_id: number | null; action: string; resource_type: string | null; resource_path: string | null; details: unknown; ip_address: string | null; created_at: Date | string;
    }>;
    return {
      total: Number(n),
      items: rows.map((r) => ({
        id: r.audit_id, userId: r.user_id, action: r.action, resourceType: r.resource_type, resourcePath: r.resource_path, details: r.details, ipAddress: r.ip_address,
        createdAt: iso(r.created_at) as string,
      })),
    };
  },

  /**
   * Contains the account, or resumes a containment that did not finish. Called
   * again on a finished one: nothing runs, the report comes back.
   */
  async contain(req: Request, actor: HostingActor, account: AccountRow, reason: string | null): Promise<AccountContainment> {
    if (inFlight.has(account.id)) {
      const current = await this.latest(account);
      if (current) return current;
    }
    inFlight.add(account.id);
    try {
      const { row, created } = await begin(actor, account, reason);
      if (created) {
        await auditService.logReqAs(req, account.tenant_id, 'account.contain', {
          resourceType: 'account', resourcePath: String(account.id), details: { accountId: account.id, username: account.username, reason, containmentId: row.id },
        });
        emitChanged(account);
      }
      if (row.status === 'active') return toReport(row);

      const run: Run = { row, accountId: account.id, tenantId: account.tenant_id, who: { userId: actor.userId, ip: clientIp(req) || null } };
      if (row.status === 'partial') await save(run, { status: 'running' });
      let failed = false;
      for (const key of CONTAINMENT_STEPS) {
        const step = run.row.steps.find((s) => s.key === key) as ContainmentStep;
        if (step.status === 'done') continue;
        if (key === 'verify' && failed) continue; // left pending: the resume verifies once the others passed
        try {
          step.count = await STEPS[key](run);
          step.status = 'done';
          step.error = null;
        } catch (err) {
          failed = true;
          step.status = 'failed';
          step.error = errorText(err);
          logger.warn({ err, accountId: account.id, step: key }, 'Containment step failed');
        }
        step.at = new Date().toISOString();
        await save(run);
      }
      const status: ContainmentStatus = run.row.steps.every((s) => s.status === 'done') ? 'active' : 'partial';
      run.row.status = status;
      run.row.completed_at = status === 'active' ? new Date() : null;
      await save(run, { status, completed_at: run.row.completed_at });
      const summary = run.row.steps.map((s) => ({ key: s.key, status: s.status, count: s.count, error: s.error }));
      await auditService.logReqAs(req, account.tenant_id, 'account.contain_report', {
        resourceType: 'account', resourcePath: String(account.id), details: { accountId: account.id, containmentId: row.id, status, steps: summary },
      });
      // The rows this report and the last steps wrote belong to the evidence too.
      await freezeAudit(run.row);
      const failedSteps = run.row.steps.filter((s) => s.status === 'failed').map((s) => s.key);
      deps.notify('account.contained', {
        tenantId: account.tenant_id, accountId: account.id, key: `containment:${row.id}:${status}`, severity: 'critical', platform: true,
        title: `Compte confiné : ${account.username}`,
        message: status === 'active'
          ? `Le compte ${account.username} est confiné : clés, connecteurs, jetons, sessions et SFTP sont coupés, les sites continuent de servir. Seul le staff peut lever le confinement.`
          : `Le confinement du compte ${account.username} est incomplet (étapes en échec : ${failedSteps.join(', ')}). La barrière est en place : reprenez l'opération depuis la fiche du compte.`,
        link: `/accounts/${account.id}?tab=overview`,
      });
      emitChanged(account);
      return toReport(run.row);
    } finally {
      inFlight.delete(account.id);
    }
  },

  /**
   * Lifts the containment (staff, checked by the route). The publish modes and
   * the file server mode come back. Keys, tokens, sessions, the SFTP password
   * and the SSH keys do not: they were burnt, new ones are created.
   */
  async lift(req: Request, actor: HostingActor, account: AccountRow, note: string | null): Promise<AccountContainment> {
    if (inFlight.has(account.id)) throw new AppError(409, 'The containment of this account is still running', 'containmentBusy');
    const row = await db.transaction(async (trx) => {
      await trx('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id }).forUpdate().first('id');
      const live = await trx(CONTAINMENTS).where({ account_id: account.id, tenant_id: account.tenant_id }).whereNot('status', 'lifted').first('id') as { id: number } | undefined;
      if (!live) throw new AppError(409, 'This account is not contained', 'accountNotContained');
      await trx('containment_credentials').where({ containment_id: live.id }).del();
      await trx('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id }).update({ contained_at: null, updated_at: trx.fn.now() });
      const [updated] = await trx(CONTAINMENTS).where({ id: live.id }).update({ status: 'lifted', lifted_at: new Date(), lifted_by: actor.userId, lift_note: note }).returning('*') as ContainmentRow[];
      return updated;
    });

    const warnings: string[] = [];
    const modes = row.previous.publishModes ?? {};
    for (const [siteId, mode] of Object.entries(modes)) {
      // A site the staff set otherwise meanwhile keeps what the staff chose.
      await db('sites').where({ id: Number(siteId), account_id: account.id, tenant_id: account.tenant_id, publish_mode: 'approval' }).update({ publish_mode: mode, updated_at: db.fn.now() });
    }
    if (row.previous.filesrvMode && row.previous.filesrvMode !== 'off') {
      await db('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id, filesrv_mode: 'off' }).update({ filesrv_mode: row.previous.filesrvMode, updated_at: db.fn.now() });
      try {
        await deps.applyFileServer(account.id);
      } catch (err) {
        warnings.push(`file server: ${errorText(err)}`);
      }
    }
    try {
      await deps.syncFirewall(account.id);
    } catch (err) {
      warnings.push(`firewall: ${errorText(err)}`);
    }
    if (warnings.length) {
      await db(CONTAINMENTS).where({ id: row.id }).update({ lift_warnings: JSON.stringify(warnings) });
      row.lift_warnings = warnings;
    }
    await auditService.logReqAs(req, account.tenant_id, 'account.contain_lift', {
      resourceType: 'account', resourcePath: String(account.id), details: { accountId: account.id, username: account.username, containmentId: row.id, note, warnings },
    });
    deps.notify('account.containmentLifted', {
      tenantId: account.tenant_id, accountId: account.id, key: `containment:${row.id}:lifted`, severity: 'warning', platform: true,
      title: `Confinement levé : ${account.username}`,
      message: `Le confinement du compte ${account.username} est levé. Les anciennes clés, les anciens jetons et l'ancien mot de passe SFTP restent révoqués : créez-en de nouveaux.`,
      link: `/accounts/${account.id}?tab=overview`,
    });
    emitChanged(account);
    return toReport(row);
  },

  /** Worker: a window opened in the race is closed again; the audit keeps being copied until the end of the span, lift or not. */
  async sweep(now = new Date(), auditToo = true): Promise<void> {
    const live = await db(CONTAINMENTS).whereNot('status', 'lifted').whereNotNull('account_id').select('id', 'account_id', 'tenant_id') as Array<{ id: number; account_id: number; tenant_id: number }>;
    for (const c of live) {
      const open = await db('maintenance_windows').where({ account_id: c.account_id, tenant_id: c.tenant_id, status: 'open' }).select('id', 'site_id') as Array<{ id: number; site_id: number }>;
      for (const w of open) {
        await deps.closeWindow(w.site_id, w.id, { userId: null, ip: null }).catch((err: unknown) => logger.warn({ err, windowId: w.id }, 'Containment: window not closed'));
      }
    }
    if (!auditToo) return;
    const spans = await db(CONTAINMENTS).where('audit_until', '>', new Date(now.getTime() - AUDIT_SWEEP_MS)).select('id', 'tenant_id', 'account_id', 'audit_from', 'audit_until', 'credentials') as ContainmentRow[];
    for (const s of spans) await freezeAudit(s);
  },

  start(): void {
    if (timer) return;
    let lastAudit = 0;
    timer = setInterval(() => {
      const nowMs = Date.now();
      const auditToo = nowMs - lastAudit >= AUDIT_SWEEP_MS;
      if (auditToo) lastAudit = nowMs;
      containmentService.sweep(new Date(nowMs), auditToo).catch((err: unknown) => logger.warn({ err }, 'Containment sweep failed'));
    }, SWEEP_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

let timer: NodeJS.Timeout | null = null;
