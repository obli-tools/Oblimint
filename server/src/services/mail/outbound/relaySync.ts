import path from 'path';
import type Docker from 'dockerode';
import { db } from '../../../db';
import { logger } from '../../../utils/logger';
import { open as openSecret, seal } from '../../../utils/secretBox';
import { attachWithAlias, disconnectNetwork, inspectContainer, inspectNetwork } from '../../docker/dockerOps';
import { engineFor, execWith, localNodeId } from '../../docker/engine';
import { accountNetwork, MAIL_RELAY_ALIAS, MAIL_RELAY_CONTAINER, siteRelayUsername } from '../../hosting/naming';
import { localPaths } from '../../hosting/paths';
import { planLimits } from '../../hosting/rows';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { mailHostname } from '../contracts';
import { generateMailPassword, hashMailPassword } from '../passwords';
import { activeMailDriver } from '../registry';
import type { MailSiteRelayRow } from '../rows';
import { ensureDir, readRegularFile, realDirectory, removeFile, sha256, writeFileAtomic } from './files';
import { renderMsmtprc } from './msmtprc';
import {
  effectiveDefaultSender, effectiveSiteLimit, RELAY_CONFIG_DIR, RELAY_FILES, RELAY_GID, RELAY_HOLD_TARGET, RELAY_SPOOL_DIR,
  renderRelayPasswd, renderRelayPolicy, renderRelayPostfixOverrides, type RelayAccountInput, type RelayUserInput,
} from './relayConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Convergence of the site relay (docs/P4-PLAN.md §9.5, MA3, MA4, MA7):
//
//  per account (reconcile hook, mail domains change, API):
//    - one mail_site_relays row per site (user site-<id>, random credential:
//      SHA512-CRYPT hash for the relay, clear value sealed 'mail-relay');
//    - each site's msmtprc (runtime dir, 0640 root:<account gid>) written
//      when the relay is on for it, REMOVED otherwise (setting off, row
//      disabled, account not active, no allowed sender);
//    - oblimint-mail-relay attached to the account network (alias
//      MAIL_RELAY_ALIAS), detached from the network of an account being deleted;
//  platform-wide (debounced): the relay files (passwd, policy.json,
//  postfix.cf) under mail/relay/config, Postfix reloaded when postfix.cf
//  changed.
//
// Work is queued (hooks never block a reconcile pass, never throw).
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;

export interface RelaySyncBackends {
  docker(): Promise<Docker>;
  /** Root of the hosting tree as seen by the panel (tests: a temp dir). */
  paths: typeof localPaths;
}

const defaultBackends: RelaySyncBackends = {
  docker: async () => engineFor(await localNodeId()),
  paths: localPaths,
};
let backends: RelaySyncBackends = defaultBackends;

export function setRelaySyncBackendsForTests(b: Partial<RelaySyncBackends> | null): void {
  backends = b ? { ...defaultBackends, ...b } : defaultBackends;
  queue.clear();
  filesPending = false;
  lastFiles = null;
}

export function relayConfigDir(): string {
  return path.posix.join(backends.paths.mailRelay(), RELAY_CONFIG_DIR);
}

export function relaySpoolDir(): string {
  return path.posix.join(backends.paths.mailRelay(), RELAY_SPOOL_DIR);
}

// ── data ─────────────────────────────────────────────────────────────────────

interface AccountInfo {
  id: number;
  tenant_id: number;
  status: string;
  gid: number;
  limits: ReturnType<typeof planLimits>;
}

async function accountInfo(accountId: number): Promise<AccountInfo | null> {
  const r = await db('hosting_accounts as a').leftJoin('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId)
    .first('a.id', 'a.tenant_id', 'a.status', 'a.gid', 'p.limits') as
    { id: number; tenant_id: number; status: string; gid: number; limits: unknown } | undefined;
  return r ? { id: Number(r.id), tenant_id: Number(r.tenant_id), status: r.status, gid: Number(r.gid), limits: planLimits(r.limits) } : null;
}

/** Active mail domains (enabled + ownership verified, account not being deleted) per account. */
export async function activeMailDomains(accountIds?: number[]): Promise<Map<number, string[]>> {
  const qb = db('mail_domains as md').join('domains as d', 'd.id', 'md.domain_id').join('hosting_accounts as a', 'a.id', 'md.account_id')
    .where('md.enabled', true).andWhere('d.verification_status', 'verified').andWhereNot('a.status', 'deleting')
    .select('md.account_id', 'md.name');
  if (accountIds) qb.whereIn('md.account_id', accountIds.length ? accountIds : [0]);
  const out = new Map<number, string[]>();
  for (const r of await qb as Array<{ account_id: number; name: string }>) {
    const id = Number(r.account_id);
    out.set(id, [...(out.get(id) ?? []), r.name.toLowerCase()]);
  }
  return out;
}

/** Creates the missing relay rows of an account's sites (random credential). */
export async function ensureRelayRows(accountId: number, tenantId: number): Promise<void> {
  const missing = await db('sites as s').leftJoin('mail_site_relays as r', 'r.site_id', 's.id')
    .where('s.account_id', accountId).whereNull('r.site_id').pluck('s.id') as number[];
  for (const siteId of missing.map(Number)) {
    const password = generateMailPassword(24);
    await db('mail_site_relays').insert({
      site_id: siteId,
      tenant_id: tenantId,
      account_id: accountId,
      enabled: true,
      username: siteRelayUsername(siteId),
      password_hash: hashMailPassword(password).hash,
      password_sealed: seal('mail-relay', password),
    }).onConflict('site_id').ignore();
  }
}

/** New credential for a site (rotate). The caller rewrites the files. */
export async function rotateCredential(siteId: number): Promise<void> {
  const password = generateMailPassword(24);
  await db('mail_site_relays').where({ site_id: siteId }).update({
    password_hash: hashMailPassword(password).hash,
    password_sealed: seal('mail-relay', password),
    config_hash: null,
    updated_at: db.fn.now(),
  });
}

/** Is the relay on for this site (msmtprc present), and with which envelope sender? */
export function siteRelayState(
  row: Pick<MailSiteRelayRow, 'enabled' | 'default_sender'>,
  ctx: { siteRelayOn: boolean; accountStatus: string; activeDomains: readonly string[] },
): { enabled: boolean; defaultSender: string | null } {
  const defaultSender = effectiveDefaultSender(row.default_sender, ctx.activeDomains);
  return { enabled: ctx.siteRelayOn && !!row.enabled && ctx.accountStatus === 'active' && defaultSender !== null, defaultSender };
}

async function siteRelayOn(): Promise<boolean> {
  try {
    return (await platformSettings.section('mail')).siteRelay;
  } catch {
    return false;
  }
}

// ── per account ──────────────────────────────────────────────────────────────

/** Rows + msmtprc of every site of an account. Throws on database errors (callers log). */
export async function syncAccountRelays(accountId: number): Promise<void> {
  const account = await accountInfo(accountId);
  if (!account) return; // deleted: rows went with the sites (CASCADE)
  if (account.status !== 'deleting') await ensureRelayRows(account.id, account.tenant_id);
  const domains = (await activeMailDomains([account.id])).get(account.id) ?? [];
  const on = await siteRelayOn();
  const rows = await db('mail_site_relays').where({ account_id: account.id }) as MailSiteRelayRow[];
  for (const row of rows) {
    const file = backends.paths.siteMsmtprc(account.id, row.site_id);
    try {
      const st = siteRelayState(row, { siteRelayOn: on, accountStatus: account.status, activeDomains: domains });
      if (!st.enabled) {
        if (await removeFile(file)) logger.info({ siteId: row.site_id }, 'site msmtprc removed (relay off for the site)');
        if (row.config_hash !== null) await db('mail_site_relays').where({ site_id: row.site_id }).update({ config_hash: null });
        continue;
      }
      // The runtime directory is created by the site provisioning: until then, nothing to write.
      if (!(await realDirectory(path.posix.dirname(file)))) continue;
      const content = renderMsmtprc({ username: row.username, password: openSecret('mail-relay', row.password_sealed), from: st.defaultSender! });
      const hash = sha256(content);
      if (row.config_hash === hash && (await readRegularFile(file)) === content) continue;
      // 0640 root:<account gid>: readable by the site containers (User uid:gid), by nobody else (MA4).
      await writeFileAtomic(file, content, { uid: 0, gid: account.gid, mode: 0o640 });
      await db('mail_site_relays').where({ site_id: row.site_id }).update({ config_hash: hash });
    } catch (err) {
      logger.warn({ err: errText(err), siteId: row.site_id }, 'site msmtprc not written');
    }
  }
}

// ── relay files (platform) ───────────────────────────────────────────────────

let lastFiles: { passwd: string; policy: string; postfix: string } | null = null;

/** Users / accounts of the relay as rendered (also used by the API: allowed senders, effective limits). */
export async function relayInputs(): Promise<{ users: RelayUserInput[]; accounts: RelayAccountInput[] }> {
  const on = await siteRelayOn();
  const rows = await db('mail_site_relays as r').join('hosting_accounts as a', 'a.id', 'r.account_id').leftJoin('plans as p', 'p.id', 'a.plan_id')
    .leftJoin('mail_outbound_state as o', 'o.account_id', 'r.account_id')
    .select('r.*', 'a.status as account_status', 'p.limits as plan_limits', 'o.status as outbound_status') as
    Array<MailSiteRelayRow & { account_status: string; plan_limits: unknown; outbound_status: string | null }>;
  const accountIds = [...new Set(rows.map((r) => Number(r.account_id)))];
  const domains = await activeMailDomains(accountIds);
  const accounts = new Map<number, RelayAccountInput>();
  const users: RelayUserInput[] = [];
  for (const r of rows) {
    const accountId = Number(r.account_id);
    const limits = planLimits(r.plan_limits);
    const active = domains.get(accountId) ?? [];
    if (!accounts.has(accountId)) {
      accounts.set(accountId, {
        accountId,
        suspended: r.outbound_status === 'suspended' || r.account_status !== 'active',
        perHour: limits.mailOutboundPerHour ?? null,
        activeDomains: active,
      });
    }
    const st = siteRelayState(r, { siteRelayOn: on, accountStatus: r.account_status, activeDomains: active });
    users.push({
      username: r.username,
      siteId: Number(r.site_id),
      accountId,
      passwordHash: r.password_hash,
      enabled: st.enabled,
      defaultSender: st.defaultSender,
      perHour: effectiveSiteLimit(r.per_hour, limits.mailSiteOutboundPerHour ?? null),
    });
  }
  return { users, accounts: [...accounts.values()] };
}

/**
 * Renders and writes the relay files (only those whose content changed);
 * reloads Postfix in the relay when postfix.cf changed. Returns what changed.
 */
export async function writeRelayFiles(): Promise<{ changed: string[] }> {
  const { users, accounts } = await relayInputs();
  const settings = await platformSettings.section('mail');
  const dir = relayConfigDir();
  // Direct delivery ONLY when the driver explicitly says so (relayTarget() ===
  // null, engine 'external'). Target unreadable → never fail open: keep the
  // last postfix.cf (memory, else disk), else hold the mail (RELAY_HOLD_TARGET).
  let postfix: string;
  try {
    const target = (await activeMailDriver()).relayTarget();
    postfix = renderRelayPostfixOverrides({ hostname: await mailHostname(), target, maxMessageSizeMb: settings.maxMessageSizeMb });
  } catch (err) {
    const kept = lastFiles?.postfix ?? (await readRegularFile(path.posix.join(dir, RELAY_FILES.postfix)).catch(() => null));
    logger.error({ err: errText(err), kept: !!kept }, 'relay: engine relay target unknown, previous postfix.cf kept (or mail held)');
    postfix = kept ?? renderRelayPostfixOverrides({ hostname: null, target: RELAY_HOLD_TARGET, maxMessageSizeMb: settings.maxMessageSizeMb });
  }
  const files = {
    passwd: renderRelayPasswd(users),
    policy: renderRelayPolicy(users, accounts),
    postfix,
  };
  await ensureDir(backends.paths.mailRelay(), { uid: 0, gid: 0, mode: 0o711 });
  await ensureDir(dir, { uid: 0, gid: RELAY_GID, mode: 0o750 });
  await ensureDir(relaySpoolDir(), { uid: 0, gid: 0, mode: 0o755 });
  const changed: string[] = [];
  for (const [key, name] of Object.entries(RELAY_FILES) as Array<[keyof typeof files, string]>) {
    const file = path.posix.join(dir, name);
    if (lastFiles?.[key] === files[key] && (await readRegularFile(file)) === files[key]) continue;
    if ((await readRegularFile(file)) === files[key]) continue;
    await writeFileAtomic(file, files[key], { uid: 0, gid: RELAY_GID, mode: 0o640 });
    changed.push(name);
  }
  lastFiles = files;
  if (changed.includes(RELAY_FILES.postfix)) await reloadRelayPostfix();
  return { changed };
}

async function reloadRelayPostfix(): Promise<void> {
  try {
    const docker = await backends.docker();
    const info = await inspectContainer(docker, MAIL_RELAY_CONTAINER);
    if (!info?.State?.Running) return;
    const r = await execWith(docker, MAIL_RELAY_CONTAINER, ['oblimint-relay-reload']);
    if (r.exitCode !== 0) logger.error({ exitCode: r.exitCode, out: r.stderr.slice(0, 500) }, 'relay Postfix reload failed');
  } catch (err) {
    logger.warn({ err: errText(err) }, 'relay Postfix reload skipped');
  }
}

// ── networks ─────────────────────────────────────────────────────────────────

/**
 * Attaches the relay to an account network (alias MAIL_RELAY_ALIAS), or
 * detaches it when the account is being deleted / gone (its network must
 * disappear). Never a database network (MA7). No-op while the relay is not running.
 */
export async function attachRelayToAccount(docker: Docker, accountId: number, status: string | null, log: (l: string) => void = () => {}): Promise<void> {
  const net = accountNetwork(accountId);
  if (status === null || status === 'deleting') {
    await disconnectNetwork(docker, net, MAIL_RELAY_CONTAINER);
    return;
  }
  const info = await inspectContainer(docker, MAIL_RELAY_CONTAINER);
  if (!info?.State?.Running) return;
  if (!(await inspectNetwork(docker, net))) return;
  await attachWithAlias(docker, net, MAIL_RELAY_CONTAINER, MAIL_RELAY_ALIAS, log);
}

/** Every account network (never `-db`): attach / detach as above. */
export async function attachRelayToAllAccounts(docker: Docker, log: (l: string) => void = () => {}): Promise<void> {
  const nets = await docker.listNetworks() as Array<{ Name: string }>;
  const ids = nets.map((n) => /^oblimint-acct-(\d+)$/.exec(n.Name)?.[1]).filter((x): x is string => !!x).map(Number);
  if (!ids.length) return;
  const statuses = new Map((await db('hosting_accounts').whereIn('id', ids).select('id', 'status') as Array<{ id: number; status: string }>)
    .map((r) => [Number(r.id), r.status]));
  for (const id of ids) {
    try {
      await attachRelayToAccount(docker, id, statuses.get(id) ?? null, log);
    } catch (err) {
      log(`relay ↔ ${accountNetwork(id)}: ${errText(err)}`);
    }
  }
}

// ── queue (hooks) ────────────────────────────────────────────────────────────

const queue = new Map<number, string>();
let filesPending = false;
let timer: NodeJS.Timeout | null = null;
let running = false;

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, DEBOUNCE_MS);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (running) { schedule(); return; }
  running = true;
  try {
    const batch = [...queue];
    queue.clear();
    let docker: Docker | null = null;
    for (const [accountId, reason] of batch) {
      try {
        await syncAccountRelays(accountId);
        filesPending = true;
      } catch (err) {
        logger.warn({ err: errText(err), accountId, reason }, 'relay: account sync failed');
      }
      try {
        docker ??= await backends.docker();
        const st = await db('hosting_accounts').where({ id: accountId }).first('status') as { status: string } | undefined;
        await attachRelayToAccount(docker, accountId, st?.status ?? null);
      } catch (err) {
        logger.debug({ err: errText(err), accountId }, 'relay: network attachment skipped');
      }
    }
    if (filesPending) {
      filesPending = false;
      try {
        await writeRelayFiles();
      } catch (err) {
        logger.error({ err: errText(err) }, 'relay files not written');
      }
    }
  } finally {
    running = false;
    if (queue.size || filesPending) schedule();
  }
}

/** Queue the relay work of an account (never throws, never blocks). */
export function requestAccountRelay(accountId: number, reason: string): void {
  if (!Number.isInteger(accountId) || accountId <= 0) return;
  queue.set(accountId, reason);
  schedule();
}

/** Queue a rewrite of the relay files only. */
export function requestRelayFiles(): void {
  filesPending = true;
  schedule();
}

/** Every account that has sites (settings change, worker start). */
export async function requestAllAccounts(reason: string): Promise<void> {
  const ids = await db('sites').distinct('account_id').pluck('account_id') as number[];
  for (const id of ids) requestAccountRelay(Number(id), reason);
  requestRelayFiles();
}

/** Tests: wait for the queue to drain. */
export async function relayQueueIdle(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((queue.size || filesPending || running || timer) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

export function stopRelaySync(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Docker client of the relay's node (the local one in P4). */
export async function relayEngine(): Promise<Docker> {
  return backends.docker();
}
