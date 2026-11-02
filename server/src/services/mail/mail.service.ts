import type { Request } from 'express';
import type { Knex } from 'knex';
import type {
  MailAccountUsage, MailAlias, MailAliasInput, MailAliasUpdate, MailAutoresponder, MailAutoresponderInput, Mailbox, MailboxCreate,
  MailboxCreated, MailboxDetail, MailboxUpdate, MailDomain, MailDomainCreate, MailDomainDetail, MailDomainUpdate, MailEngine,
  MailForwardingInput, MailOverview, MailPasswordChange, MailPasswordResult, MailPasswordScheme, MailRule, MailSystemStatus, PlanLimits,
  WebmailForwarding, WebmailForwardingInput, WebmailForwardingPolicy, WebmailRuleForward, WebmailRules,
} from '@oblimint/shared';
import { isMailEngineSupported, MAIL_RULE_LIMITS, MASTER_TENANT_ID, mailEngineHasMailboxes, mailEngineSupportsRules } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { engineFor, localNodeId } from '../docker/engine';
import {
  assertNeedSomewhere, loadAccount, loadDomain, scopeToActor, type HostingActor,
} from '../hosting/access';
import { loadTenantLimits, withTenantLock } from '../hosting/envelope.service';
import { parentDomains } from '../hosting/hostingValidation.service';
import { planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { loadMailAlias, loadMailbox, loadMailDomain, type MailboxLoaded } from './access';
import { mailHostname } from './contracts';
import { mailCoreDeps } from './deps';
import { MailDriverError, type MailDriver } from './driver';
import { emitMail } from './events';
import {
  assertAliasCount, assertDomainMessageSize, assertMailboxCount, assertMailboxQuota, assertTenantMailboxRoom, defaultMailboxQuotaMb,
  mailAccountLimits,
} from './limits';
import {
  accountServesMail, mailClientSettings, toMailAlias, toMailbox, toMailboxDetail, toMailDomain, type MailDomainListRow,
} from './mappers';
import { ensureMailNetwork } from './network';
import {
  assertMailPasswordAcceptable, generateMailPassword, hashMailPassword, normalizeImportedHash,
} from './passwords';
import { purgeForeignTombstones } from './purge';
import { activeMailDriver, activeMailDriverIn, activeMailEngine, mailDriverFor } from './registry';
import { parseAutoresponder, parseDnsSettings, parseExternalConfig, parseMailRules, parseTargets, type MailAliasRow, type MailboxRow } from './rows';
import { assertOwnerTargets, assertRedirectBudget, folderPaths, parseMailRulesInput, ruleTargets } from './rules';
import {
  clearMailSyncApplied, mailSyncInfo, recordMailSyncError, requestMailSync, runMailExclusive, runSyncNow, startMailSync, stopMailSync,
} from './sync';
import {
  assertAutoresponderSchedule, assertLocalPartAllowed, assertNoForwardingLoop, assertTargetsExist, splitAddress, type ForwardGraph,
} from './validation';

// ─────────────────────────────────────────────────────────────────────────────
// Mail core (docs/P4-PLAN.md §6.1, §6.2, §9.1) — module mail-core.
//
// Access (§10, MA5): every object goes through services/mail/access.ts
// (404 invisible / 403 without the need), lists through scopeToActor, ids of
// a body (domainId, mailDomainId) are loaded with the need of the change.
// Writes that count against a limit run under the tenant lock (envelope +
// plan) AND the per-domain advisory lock (address unique across mailboxes and
// aliases). Passwords: never stored in clear, hashes never returned nor
// logged (MA4), a generated password is returned once. Changes ⇒
// requestSync (engine), emitMail, audit (§18), and the hooks of the other
// modules (DNS, outbound, webmail). Engine errors are masked for clients (A6).
// ─────────────────────────────────────────────────────────────────────────────

export interface MailListQuery {
  accountId?: number | null;
  tenantId?: number | null;
  mailDomainId?: number | null;
  search?: string | null;
}

type Conn = Knex | Knex.Transaction;

/** Mailbox columns read for the API (never password_hash, MA4). */
const MAILBOX_COLS = [
  'm.id', 'm.tenant_id', 'm.account_id', 'm.mail_domain_id', 'm.local_part', 'm.address', 'm.display_name', 'm.password_scheme',
  'm.password_set_at', 'm.imported', 'm.quota_mb', 'm.enabled', 'm.send_enabled', 'm.receive_enabled', 'm.forward_targets',
  'm.forward_keep_copy', 'm.forward_enabled', 'm.mail_rules', 'm.autoresponder', 'm.used_bytes', 'm.usage_checked_at', 'm.quota_warned_at',
  'm.created_at', 'm.updated_at',
];

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ── helpers ──────────────────────────────────────────────────────────────────

/** 409 mailEngineNoMailboxes when the active engine hosts no mailbox (external). */
function assertEngineHostsMailboxes(driver: MailDriver): void {
  if (!driver.capabilities.mailboxes || !mailEngineHasMailboxes(driver.engine)) {
    throw new AppError(409, 'The mail engine of this platform is external: no mailbox or alias is hosted here', 'mailEngineNoMailboxes');
  }
}

/** 409 accountSuspended: no new mail object on a suspended / deleted account. */
function assertAccountWritable(status: string): void {
  if (!accountServesMail(status)) throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
}

/** A6: a backend failure is 502 backendUnavailable; the raw cause only for the staff. AppErrors < 500 pass through. */
function backendError(actor: HostingActor, err: unknown, what: string): AppError {
  if (err instanceof AppError && err.statusCode < 500) return err;
  const raw = err instanceof MailDriverError ? [err.message, err.detail].filter(Boolean).join(' : ') : errText(err);
  logger.warn({ err: raw, what }, 'mail backend call failed');
  return new AppError(502, actor.kind === 'client' ? 'The mail service is unavailable, try again later' : `${what}: ${raw}`, 'backendUnavailable');
}

async function accountPlan(conn: Conn, accountId: number): Promise<{ limits: PlanLimits; status: string; tenantId: number }> {
  const row = await conn('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId)
    .first('a.status', 'a.tenant_id', 'p.limits') as { status: string; tenant_id: number; limits: unknown } | undefined;
  if (!row) throw new AppError(404, 'Account not found', 'notFound');
  return { limits: planLimits(row.limits), status: row.status, tenantId: row.tenant_id };
}

async function accountUsage(conn: Conn, accountId: number, excludeMailboxId: number | null = null): Promise<MailAccountUsage> {
  const q = conn('mailboxes').where({ account_id: accountId });
  if (excludeMailboxId !== null) q.whereNot({ id: excludeMailboxId });
  const mb = await q.first(conn.raw('COUNT(*) AS n'), conn.raw('COALESCE(SUM(quota_mb), 0) AS q'), conn.raw('SUM(used_bytes) AS u'),
    conn.raw('COUNT(used_bytes) AS measured')) as { n: unknown; q: unknown; u: unknown; measured: unknown } | undefined;
  const al = await conn('mail_aliases').where({ account_id: accountId }).first(conn.raw('COUNT(*) AS n')) as { n: unknown } | undefined;
  return {
    mailboxes: Number(mb?.n ?? 0),
    aliases: Number(al?.n ?? 0),
    quotaAllocatedMb: Number(mb?.q ?? 0),
    usedBytes: Number(mb?.measured ?? 0) > 0 ? Number(mb?.u ?? 0) : null,
  };
}

/** Delivery graph + own domains / addresses of an account (loop and target checks). */
async function accountAddressBook(conn: Conn, accountId: number): Promise<{ graph: Map<string, string[]>; ownDomains: Set<string>; existing: Set<string> }> {
  const domains = await conn('mail_domains').where({ account_id: accountId }).select('name') as Array<{ name: string }>;
  const boxes = await conn('mailboxes').where({ account_id: accountId }).select('address', 'forward_targets', 'forward_enabled', 'mail_rules') as
    Array<{ address: string; forward_targets: unknown; forward_enabled: boolean | null; mail_rules: unknown }>;
  const aliases = await conn('mail_aliases').where({ account_id: accountId }).select('address', 'targets') as Array<{ address: string; targets: unknown }>;
  const graph = new Map<string, string[]>();
  // A paused forwarding sends nothing; the enabled rules' forward / redirect targets are edges too.
  for (const b of boxes) {
    graph.set(b.address, [...(b.forward_enabled === false ? [] : parseTargets(b.forward_targets)), ...ruleTargets(parseMailRules(b.mail_rules), true)]);
  }
  for (const a of aliases) graph.set(a.address, parseTargets(a.targets));
  return {
    graph,
    ownDomains: new Set(domains.map((d) => d.name)),
    existing: new Set([...boxes.map((b) => b.address), ...aliases.map((a) => a.address)]),
  };
}

/** Targets of `address` (mailbox forwarding / alias): existing internal targets, no loop. */
async function assertTargets(conn: Conn, accountId: number, address: string, targets: string[], field: string): Promise<void> {
  if (targets.length === 0) return;
  const book = await accountAddressBook(conn, accountId);
  assertTargetsExist(targets.filter((t) => t !== address), { ownDomains: book.ownDomains, existing: book.existing, field });
  assertNoForwardingLoop(address, targets, book.graph as ForwardGraph);
}

/** Catch-all inside the domain itself must be an existing mailbox / alias (else every unknown address loops). */
async function assertCatchAll(conn: Conn, md: { id: number; name: string; account_id: number }, catchAll: string | null | undefined): Promise<void> {
  if (!catchAll) return;
  const book = await accountAddressBook(conn, md.account_id);
  assertTargetsExist([catchAll], { ownDomains: new Set([...book.ownDomains, md.name]), existing: book.existing, field: 'catchAll' });
}

/** Address free across mailboxes AND aliases. Caller holds the per-domain advisory lock. */
async function assertAddressFree(trx: Knex.Transaction, address: string): Promise<void> {
  const [box, alias] = [
    await trx('mailboxes').where({ address }).first('id'),
    await trx('mail_aliases').where({ address }).first('id'),
  ];
  if (box || alias) throw new AppError(409, `${address} already exists`, 'addressTaken', { address });
}

async function lockMailDomain(trx: Knex.Transaction, mailDomainId: number): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail:${mailDomainId}`]);
}

/**
 * Delivery graph of an account (forwarding / alias targets): loop checks and
 * the write happen under it, across all the account's domains. Always the
 * LAST lock taken (order: tenant → engine → mail domain → account).
 */
async function lockMailAccount(trx: Knex.Transaction, accountId: number): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail-acct:${accountId}`]);
}

const ENGINE_LOCK = 'mail-engine';
/** app_config flag { to, at } set by changeEngine (with the counts, under the exclusive lock) until the switch is done. */
const ENGINE_CHANGE_KEY = 'mail_engine_changing';
/** A flag older than this is a crashed change: ignored. */
const ENGINE_CHANGE_STALE_MS = 30 * 60_000;

function engineChangeInProgress(raw: string | null | undefined, now = Date.now()): boolean {
  if (!raw) return false;
  try {
    const at = Date.parse(String((JSON.parse(raw) as { at?: unknown }).at));
    return Number.isFinite(at) && now - at < ENGINE_CHANGE_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Creations of mailboxes / aliases hold the engine lock SHARED and refuse
 * while an engine change is in progress (flag written by changeEngine under
 * the exclusive lock, together with its count check): no mailbox / alias can
 * slip in between the check and the switch. Then re-reads the active driver
 * (the engine may have changed while waiting).
 */
async function lockEngineShared(trx: Knex.Transaction, validated: MailDriver): Promise<MailDriver> {
  await trx.raw('SELECT pg_advisory_xact_lock_shared(hashtext(?))', [ENGINE_LOCK]);
  const flag = await trx('app_config').where({ key: ENGINE_CHANGE_KEY }).first('value') as { value: string } | undefined;
  if (engineChangeInProgress(flag?.value)) {
    throw new AppError(409, 'The mail engine of this platform is being changed: try again in a few minutes', 'mailEngineChanging');
  }
  const live = await activeMailDriverIn(trx);
  assertEngineHostsMailboxes(live);
  if (live.engine !== validated.engine) {
    throw new AppError(409, 'The mail engine of this platform has just changed: try again', 'mailEngineChanging');
  }
  return live;
}

/** Engine switched to one that signs: every existing mail domain gets its DKIM keys (never throws). */
async function ensureDkimForAll(deps: ReturnType<typeof mailCoreDeps>): Promise<void> {
  try {
    const ids = await db('mail_domains').orderBy('id').pluck('id') as number[];
    for (const id of ids) {
      try { await deps.ensureDkim(Number(id)); } catch (err) { logger.warn({ err: errText(err), mailDomainId: id }, 'mail: DKIM keys not created after the engine change'); }
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail: DKIM keys not created after the engine change');
  }
}

/** Zones of OUR PowerDNS holding each domain: its own zone, else a hosted zone of the same account named like a parent. */
async function managedDomains(rows: Array<{ domain_id: number; name: string; account_id: number }>): Promise<Set<number>> {
  const out = new Set<number>();
  if (rows.length === 0) return out;
  try {
    const names = [...new Set(rows.flatMap((r) => [r.name, ...parentDomains(r.name)]))];
    const zones = await db('dns_zones')
      .where((b) => { b.whereIn('domain_id', rows.map((r) => r.domain_id)).orWhereIn('name', names); })
      .select('domain_id', 'name', 'kind', 'account_id') as Array<{ domain_id: number | null; name: string; kind: string; account_id: number | null }>;
    for (const r of rows) {
      const own = zones.find((z) => z.domain_id === r.domain_id);
      const z = own ?? [r.name, ...parentDomains(r.name)].map((n) => zones.find((x) => x.name === n && x.account_id === r.account_id)).find(Boolean);
      if (z?.kind === 'hosted') out.add(r.domain_id);
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail: zone lookup failed');
  }
  return out;
}

function domainListQuery(): Knex.QueryBuilder {
  return db('mail_domains as md')
    .join('hosting_accounts as a', 'a.id', 'md.account_id')
    .leftJoin('domains as d', 'd.id', 'md.domain_id')
    .select('md.*', 'a.username as account_username', 'a.status as account_status', 'd.verification_status as domain_verification_status',
      db.raw('(SELECT COUNT(*) FROM mailboxes mb WHERE mb.mail_domain_id = md.id) AS mailbox_count'),
      db.raw('(SELECT COUNT(*) FROM mail_aliases ma WHERE ma.mail_domain_id = md.id) AS alias_count'));
}

async function mapDomains(actor: HostingActor, rows: MailDomainListRow[]): Promise<MailDomain[]> {
  const managed = await managedDomains(rows);
  return rows.map((r) => toMailDomain(r, { dnsManaged: managed.has(r.domain_id) }, actor));
}

async function domainDetail(actor: HostingActor, id: number): Promise<MailDomainDetail> {
  const row = await domainListQuery().where('md.id', id).first() as MailDomainListRow | undefined;
  if (!row) throw new AppError(404, 'Mail domain not found', 'notFound');
  const [base] = await mapDomains(actor, [row]);
  const [plan, usage, settings] = await Promise.all([
    accountPlan(db, row.account_id), accountUsage(db, row.account_id), platformSettings.section('mail'),
  ]);
  return {
    ...base,
    dnsSettings: parseDnsSettings(row.dns_settings),
    external: parseExternalConfig(row.external_dns),
    limits: mailAccountLimits(plan.limits, settings.maxMessageSizeMb),
    usage,
  };
}

async function mailboxDetail(row: MailboxLoaded | (MailboxRow & { domain_name: string })): Promise<MailboxDetail> {
  const deps = mailCoreDeps();
  let rulesSupported = false;
  try { rulesSupported = mailEngineSupportsRules(await activeMailEngine()); } catch { rulesSupported = false; }
  const domain = row.domain_name;
  const aliases = await db('mail_aliases').where({ account_id: row.account_id })
    .whereRaw('targets @> ?::jsonb', [JSON.stringify([row.address])]).orderBy('address').select('id', 'address') as Array<{ id: number; address: string }>;
  let webmailUrl: string | null = null;
  try { webmailUrl = await deps.webmailUrl(domain); } catch { webmailUrl = null; }
  let host: string | null = null;
  try { host = await mailHostname(); } catch { host = null; }
  return toMailboxDetail(row as MailboxRow & { domain_name: string }, {
    aliases: aliases.map((a) => ({ id: a.id, address: a.address })),
    clientSettings: mailClientSettings(row.address, host ?? `mail.${domain}`, webmailUrl),
    rulesSupported,
  });
}

// ── forwarding and inbox rules (panel + the mailbox's own webmail) ──────────

interface ForwardingValue { targets: string[]; keepCopy: boolean; enabled: boolean }

const forwardingOf = (r: Pick<MailboxRow, 'forward_targets' | 'forward_keep_copy' | 'forward_enabled'>): ForwardingValue => ({
  targets: parseTargets(r.forward_targets),
  keepCopy: !!r.forward_keep_copy,
  enabled: r.forward_enabled !== false,
});
/** Targets the forwarding sends to now ([] when paused / none). */
const effectiveTargets = (f: ForwardingValue): string[] => (f.enabled ? f.targets : []);

/**
 * What a mailbox owner (webmail) or a client user of the account (panel) may
 * forward to: the platform switch + the account's own mail domains (the
 * whole list, server-side only: see publicPolicy).
 */
async function ownerPolicy(accountId: number): Promise<WebmailForwardingPolicy> {
  const s = await platformSettings.section('mail');
  const domains = await db('mail_domains').where({ account_id: accountId }).orderBy('name').pluck('name') as string[];
  return { external: s.ownerExternalForwarding !== false, internalDomains: domains.map((d) => d.toLowerCase()), maxRedirects: MAIL_RULE_LIMITS.redirects };
}

/**
 * The policy as the webmail sees it: the account's other domains are only
 * named when they matter (external forwarding refused: the owner is told
 * where it may forward); otherwise a mailbox user learns nothing of them.
 */
const publicPolicy = (p: WebmailForwardingPolicy): WebmailForwardingPolicy => (p.external ? { ...p, internalDomains: [] } : p);

/**
 * The owner policy applied to new forward / redirect targets (403
 * forwardingNotAllowed). `alreadyThere`: targets already set (by staff), kept.
 */
async function assertPolicyTargets(accountId: number, targets: readonly string[], alreadyThere: Iterable<string>): Promise<void> {
  if (!targets.length) return;
  const policy = await ownerPolicy(accountId);
  assertOwnerTargets(targets, { external: policy.external, internalDomains: new Set(policy.internalDomains), alreadyThere: new Set(alreadyThere) });
}

/** Every forward / redirect target a mailbox row already has (forwarding, paused or not, and every rule). */
const storedTargets = (r: Pick<MailboxRow, 'forward_targets' | 'mail_rules'>): string[] =>
  [...parseTargets(r.forward_targets), ...ruleTargets(parseMailRules(r.mail_rules))];

/** Forward / redirect targets of the enabled rules, by rule (banner / notice): name, unique targets, kept or not. */
function ruleForwards(rules: readonly MailRule[]): WebmailRuleForward[] {
  const out: WebmailRuleForward[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const to = [...new Set(ruleTargets([r]))];
    if (to.length) out.push({ rule: r.name, to, kept: !r.actions.some((a) => a.kind === 'redirect') });
  }
  return out;
}

/** 409 rulesUnsupported when the active engine does not run inbox rules. */
async function assertRulesEngine(): Promise<void> {
  if (!mailEngineSupportsRules(await activeMailEngine())) {
    throw new AppError(409, 'Inbox rules need the Stalwart mail engine', 'rulesUnsupported');
  }
}

/**
 * Internal targets exist (only the `fresh` ones: an address already in use
 * that has since disappeared never blocks turning something off or
 * re-ordering) and the delivery graph has no loop once `edges` (everything
 * the mailbox forwards to after the change) replace the mailbox's own edges.
 */
async function assertTargetChange(conn: Conn, accountId: number, address: string, fresh: readonly string[], edges: readonly string[], field: string): Promise<void> {
  const check = fresh.filter((t) => t !== address);
  if (!check.length && !edges.length) return;
  const book = await accountAddressBook(conn, accountId);
  if (check.length) assertTargetsExist(check, { ownDomains: book.ownDomains, existing: book.existing, field });
  if (edges.length) assertNoForwardingLoop(address, [...edges], book.graph as ForwardGraph);
}

const minus = (list: readonly string[], known: Iterable<string>): string[] => {
  const k = new Set(known);
  return [...new Set(list)].filter((t) => !k.has(t));
};

/**
 * Writes the forwarding under the account lock: new internal targets exist,
 * no loop (the rules' targets count), redirect budget with the rules. The
 * caller checked the access (panel need / webmail session = the mailbox).
 * Turning the forwarding off (or pausing it) never re-checks the targets.
 */
async function writeForwarding(row: { id: number; tenant_id: number; account_id: number; address: string }, next: ForwardingValue, byPanel: boolean): Promise<void> {
  await db.transaction(async (trx) => {
    await lockMailAccount(trx, row.account_id);
    const cur = await trx('mailboxes').where({ id: row.id }).first('mail_rules', 'forward_targets', 'forward_keep_copy', 'forward_enabled') as
      Pick<MailboxRow, 'mail_rules' | 'forward_targets' | 'forward_keep_copy' | 'forward_enabled'> | undefined;
    if (!cur) throw new AppError(404, 'Mailbox not found', 'notFound');
    const rules = parseMailRules(cur.mail_rules);
    const was = forwardingOf(cur);
    if (next.enabled) {
      // Re-enabling a paused forwarding checks its targets again (they forward nothing until now).
      await assertTargetChange(trx, row.account_id, row.address, minus(next.targets, effectiveTargets(was)),
        next.targets.length ? [...next.targets, ...ruleTargets(rules, true)] : [], 'targets');
    } else {
      await assertTargetChange(trx, row.account_id, row.address, minus(next.targets, was.targets), [], 'targets');
    }
    assertRedirectBudget(effectiveTargets(next), rules);
    await trx('mailboxes').where({ id: row.id, tenant_id: row.tenant_id }).update({
      forward_targets: JSON.stringify(next.targets),
      forward_keep_copy: next.targets.length === 0 ? true : next.keepCopy,
      forward_enabled: next.targets.length === 0 ? true : next.enabled,
      forward_changed_at: new Date(),
      forward_changed_by_panel: byPanel,
      updated_at: new Date(),
    });
  });
}

/**
 * Writes the rules under the account lock (same target / loop / budget checks
 * as the forwarding). Only the targets a change ADDS are checked for
 * existence: a target of an enabled rule that was not enabled before, a
 * target of a disabled rule that no stored rule had (it may be turned on
 * later from the webmail); the forwarding's own targets are never re-checked.
 */
async function writeRules(row: { id: number; tenant_id: number; account_id: number; address: string }, rules: MailRule[]): Promise<void> {
  await db.transaction(async (trx) => {
    await lockMailAccount(trx, row.account_id);
    const cur = await trx('mailboxes').where({ id: row.id }).first('forward_targets', 'forward_keep_copy', 'forward_enabled', 'mail_rules') as
      Pick<MailboxRow, 'forward_targets' | 'forward_keep_copy' | 'forward_enabled' | 'mail_rules'> | undefined;
    if (!cur) throw new AppError(404, 'Mailbox not found', 'notFound');
    const fwd = effectiveTargets(forwardingOf(cur));
    const stored = parseMailRules(cur.mail_rules);
    const targets = ruleTargets(rules, true);
    const fresh = [
      ...minus(targets, ruleTargets(stored, true)),
      ...minus(ruleTargets(rules.filter((r) => !r.enabled)), ruleTargets(stored)),
    ];
    await assertTargetChange(trx, row.account_id, row.address, fresh, targets.length ? [...fwd, ...targets] : [], 'rules');
    assertRedirectBudget(fwd, rules);
    await trx('mailboxes').where({ id: row.id, tenant_id: row.tenant_id }).update({ mail_rules: JSON.stringify(rules), updated_at: new Date() });
  });
}

/** Normalized forwarding input (lower case, unique, ≤ 20). 400 invalidTarget. */
function forwardingInput(body: { targets: unknown; keepCopy?: unknown; enabled?: unknown }): ForwardingValue {
  if (!Array.isArray(body.targets)) throw new AppError(400, 'targets: a list expected', 'invalidTarget', { field: 'targets' });
  const targets = [...new Set(body.targets.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : '')))];
  if (targets.length > 20) throw new AppError(400, 'At most 20 forwarding targets', 'invalidTarget', { field: 'targets' });
  for (const t of targets) {
    if (!/^(?!.*\.\.)[a-z0-9._+-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(t)) {
      throw new AppError(400, `Invalid address ${t.slice(0, 80) || '(empty)'}`, 'invalidTarget', { field: 'targets' });
    }
  }
  return { targets, keepCopy: body.keepCopy === undefined ? true : !!body.keepCopy, enabled: body.enabled === undefined ? true : !!body.enabled };
}

const sameForwarding = (a: ForwardingValue, b: ForwardingValue): boolean =>
  effectiveTargets(a).slice().sort().join(',') === effectiveTargets(b).slice().sort().join(',') && (!effectiveTargets(a).length || a.keepCopy === b.keepCopy);

/**
 * Informational e-mail to the mailbox when the panel turned its forwarding on
 * or changed where it goes (Outlook-like notice). Bilingual, no secret.
 * Delivered straight into the Inbox when the engine allows it (deps
 * mailboxNotice: never through the mailbox's own forwarding / rules); by SMTP
 * only when that reaches the mailbox (a forwarding without a copy would hand
 * the notice to the forwarding target instead).
 */
function forwardingNotice(address: string, before: ForwardingValue, after: ForwardingValue): void {
  const now = effectiveTargets(after);
  if (!now.length || sameForwarding(before, after)) return;
  const list = now.join(', ');
  const copyFr = after.keepCopy ? 'Une copie reste dans votre boîte.' : 'Aucune copie ne reste dans votre boîte.';
  const copyEn = after.keepCopy ? 'A copy stays in your mailbox.' : 'No copy stays in your mailbox.';
  mailCoreDeps().mailboxNotice(address, '[Oblimint] Transfert de vos e-mails activé / Your e-mail is being forwarded', [
    `Le transfert des e-mails de ${address} a été activé ou modifié depuis le panel d'hébergement.`,
    `Vos e-mails sont transférés vers : ${list}. ${copyFr}`,
    "Si vous n'êtes pas à l'origine de ce changement, contactez votre hébergeur ou désactivez le transfert depuis le webmail (Paramètres → Transfert).",
    '',
    `The forwarding of ${address} was turned on or changed from the hosting panel.`,
    `Your e-mail is forwarded to: ${list}. ${copyEn}`,
    'If you did not make this change, contact your host or turn the forwarding off from the webmail (Settings → Forwarding).',
    '',
    '— Oblimint',
  ].join('\n'), { smtpReachesMailbox: after.keepCopy });
}

/**
 * Same notice when the panel's rules now forward / redirect to an address
 * no enabled rule sent to before (a rule without a condition does exactly
 * what a forwarding does).
 */
function rulesNotice(address: string, before: readonly MailRule[], after: readonly MailRule[], fwd: ForwardingValue): void {
  const added = minus(ruleTargets(after, true), ruleTargets(before, true));
  if (!added.length) return;
  const list = added.join(', ');
  mailCoreDeps().mailboxNotice(address, '[Oblimint] Une règle transfère vos e-mails / A rule forwards your e-mail', [
    `Les règles de réception de ${address} ont été modifiées depuis le panel d'hébergement.`,
    `Une règle transfère désormais des e-mails vers : ${list}.`,
    "Si vous n'êtes pas à l'origine de ce changement, contactez votre hébergeur ou désactivez la règle depuis le webmail (Paramètres → Règles).",
    '',
    `The inbox rules of ${address} were changed from the hosting panel.`,
    `A rule now forwards e-mail to: ${list}.`,
    'If you did not make this change, contact your host or turn the rule off from the webmail (Settings → Rules).',
    '',
    '— Oblimint',
  ].join('\n'), { smtpReachesMailbox: !(effectiveTargets(fwd).length && !fwd.keepCopy) });
}

async function reloadMailbox(id: number): Promise<MailboxRow & { domain_name: string }> {
  const row = await db('mailboxes as m').join('mail_domains as md', 'md.id', 'm.mail_domain_id').where('m.id', id)
    .first('m.*', 'md.name as domain_name') as (MailboxRow & { domain_name: string }) | undefined;
  if (!row) throw new AppError(404, 'Mailbox not found', 'notFound');
  return row;
}

/** Password of a create / change: given, imported hash (staff + engine scheme), or generated. */
function resolvePassword(actor: HostingActor, driver: MailDriver, body: { password?: string | null; passwordHash?: string | null }):
  { hash: string; scheme: MailPasswordScheme; imported: boolean; generated: string | null } {
  if (body.passwordHash) {
    if (actor.kind !== 'staff') throw new AppError(403, 'Only the staff may import a password hash', 'hashImportForbidden');
    const { hash, scheme } = normalizeImportedHash(body.passwordHash);
    if (!driver.capabilities.passwordSchemes.includes(scheme)) {
      throw new AppError(409, `The ${driver.engine} engine cannot verify ${scheme} hashes`, 'hashSchemeUnsupported',
        { scheme, supported: driver.capabilities.passwordSchemes });
    }
    return { hash, scheme, imported: true, generated: null };
  }
  if (body.password) {
    assertMailPasswordAcceptable(body.password);
    const { hash, scheme } = hashMailPassword(body.password);
    return { hash, scheme, imported: false, generated: null };
  }
  const generated = generateMailPassword();
  const { hash, scheme } = hashMailPassword(generated);
  return { hash, scheme, imported: false, generated };
}

function changed(entity: 'mailDomain' | 'mailbox' | 'alias', row: { id: number; tenant_id: number; account_id: number }, action: 'created' | 'updated' | 'deleted', reason: string): void {
  emitMail({ entity, id: row.id, accountId: row.account_id, action }, { tenantId: row.tenant_id, accountId: row.account_id });
  requestMailSync(reason);
}

async function countAll(table: 'mailboxes' | 'mail_aliases' | 'mail_domains'): Promise<number> {
  const r = await db(table).first(db.raw('COUNT(*) AS n')) as { n: unknown } | undefined;
  return Number(r?.n ?? 0);
}

function withTimeoutOr<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

// ── service ──────────────────────────────────────────────────────────────────

export const mailService = {
  // ── overview ──
  async overview(actor: HostingActor, q: { accountId?: number | null }): Promise<MailOverview> {
    assertNeedSomewhere(actor, 'read');
    const accountId = q.accountId ?? null;
    if (accountId !== null) await loadAccount(actor, accountId, 'read');
    const [engine, driver, settings, hostname] = await Promise.all([
      activeMailEngine(), activeMailDriver(), platformSettings.section('mail'), mailHostname().catch(() => null),
    ]);
    const scoped = (table: string, alias: string) => {
      const qb = scopeToActor(actor, db(`${table} as ${alias}`), { tenant: `${alias}.tenant_id`, account: `${alias}.account_id` });
      if (accountId !== null) qb.where(`${alias}.account_id`, accountId);
      return qb.first(db.raw('COUNT(*) AS n')).then((r: { n?: unknown } | undefined) => Number(r?.n ?? 0));
    };
    const [domains, mailboxes, aliases] = await Promise.all([scoped('mail_domains', 'md'), scoped('mailboxes', 'm'), scoped('mail_aliases', 'al')]);
    let limits = null;
    let usage = null;
    let outbound = null;
    if (accountId !== null) {
      const plan = await accountPlan(db, accountId);
      limits = mailAccountLimits(plan.limits, settings.maxMessageSizeMb);
      usage = await accountUsage(db, accountId);
      try { outbound = await mailCoreDeps().outboundInfo(actor, accountId); } catch { outbound = null; }
    }
    const webmailUrl = settings.webmail !== 'none' && settings.webmailHostname ? `https://${settings.webmailHostname}/` : null;
    return {
      engine,
      engineSupported: isMailEngineSupported(engine) && driver.capabilities.supported,
      hasMailboxes: mailEngineHasMailboxes(engine) && driver.capabilities.mailboxes,
      hostname,
      accountId,
      limits,
      usage,
      outbound,
      webmail: { kind: settings.webmail, url: webmailUrl },
      counts: { domains, mailboxes, aliases },
    };
  },

  // ── domains ──
  async listDomains(actor: HostingActor, q: MailListQuery): Promise<MailDomain[]> {
    assertNeedSomewhere(actor, 'read');
    const qb = scopeToActor(actor, domainListQuery(), { tenant: 'md.tenant_id', account: 'md.account_id' }, q.tenantId ?? null);
    if (q.accountId) qb.where('md.account_id', q.accountId);
    if (q.mailDomainId) qb.where('md.id', q.mailDomainId);
    if (q.search) qb.where('md.name', 'ilike', `%${likeEscape(q.search.toLowerCase())}%`);
    const rows = await qb.orderBy('md.name').limit(1000) as MailDomainListRow[];
    return mapDomains(actor, rows);
  },

  async getDomain(actor: HostingActor, id: number): Promise<MailDomainDetail> {
    await loadMailDomain(actor, id, 'read');
    return domainDetail(actor, id);
  },

  async createDomain(req: Request, actor: HostingActor, body: MailDomainCreate): Promise<MailDomainDetail> {
    const domain = await loadDomain(actor, body.domainId, 'mail.manage');
    const name = domain.name.toLowerCase();
    const plan = await accountPlan(db, domain.account_id);
    assertAccountWritable(plan.status);
    const enabled = body.enabled ?? true;
    const catchAll = body.catchAll ?? null;
    if (catchAll && splitAddress(catchAll).domain === name) {
      throw new AppError(400, `${catchAll} does not exist yet: create the mailbox first`, 'invalidTarget', { field: 'catchAll', target: catchAll });
    }

    const driver = await activeMailDriver();

    const row = await withTenantLock(domain.tenant_id, async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail-domain:${name}`]);
      const exists = await trx('mail_domains').where({ domain_id: domain.id }).orWhere({ name }).first('id');
      if (exists) throw new AppError(409, `${name} already has mail`, 'mailDomainExists');
      if (catchAll) await assertCatchAll(trx, { id: 0, name, account_id: domain.account_id }, catchAll);
      // MA5 / MA12: data another account left under this name (grace period) is purged before reuse, never inherited.
      await purgeForeignTombstones(trx, driver, { kind: 'domain', name, accountId: domain.account_id });
      const [inserted] = await trx('mail_domains').insert({
        tenant_id: domain.tenant_id, account_id: domain.account_id, domain_id: domain.id, name, enabled, catch_all: catchAll,
      }).returning('*');
      return inserted as { id: number; tenant_id: number; account_id: number; created_at: Date | string };
    });

    // DKIM keys first (mail-dns-tls): a domain without its key is not created (rolled back).
    try {
      await mailCoreDeps().ensureDkim(row.id);
    } catch (err) {
      await db.transaction(async (trx) => {
        await trx('mail_domains').where({ id: row.id }).del();
        // The tombstone the trigger just wrote is for a domain that never held data.
        await trx('mail_purge_queue').where({ kind: 'domain', name }).whereNull('purged_at').where('created_at', '>=', row.created_at).del();
      });
      throw backendError(actor, err, 'DKIM key generation failed');
    }

    const deps = mailCoreDeps();
    deps.domainChanged(row.id, domain.id, 'created');
    deps.mailDomainsChanged(row.account_id);
    deps.edgeSync('mail domain created');
    changed('mailDomain', row, 'created', `mail domain ${name} created`);
    await auditService.logReqAs(req, row.tenant_id, 'mail.domain.create', {
      resourceType: 'mail_domain', resourcePath: String(row.id), details: { name, accountId: row.account_id, enabled, catchAll },
    });
    return domainDetail(actor, row.id);
  },

  async updateDomain(req: Request, actor: HostingActor, id: number, body: MailDomainUpdate): Promise<MailDomainDetail> {
    const md = await loadMailDomain(actor, id, 'mail.manage');
    const patch: Record<string, unknown> = {};
    if (body.enabled !== undefined && body.enabled !== md.enabled) {
      if (body.enabled) {
        if (md.domain_verification_status !== 'verified') {
          throw new AppError(409, `The ownership of ${md.name} is not verified yet`, 'domainNotVerified');
        }
        assertAccountWritable(md.account_status);
      }
      patch.enabled = body.enabled;
    }
    if (body.catchAll !== undefined) {
      await assertCatchAll(db, md, body.catchAll);
      patch.catch_all = body.catchAll;
    }
    if (body.maxMessageSizeMb !== undefined) {
      const plan = await accountPlan(db, md.account_id);
      assertDomainMessageSize(body.maxMessageSizeMb, plan.limits);
      patch.max_message_size_mb = body.maxMessageSizeMb;
    }
    if (Object.keys(patch).length > 0) {
      await db('mail_domains').where({ id: md.id, tenant_id: md.tenant_id }).update({ ...patch, updated_at: new Date() });
      const deps = mailCoreDeps();
      if (patch.enabled !== undefined) {
        deps.domainChanged(md.id, md.domain_id, patch.enabled ? 'enabled' : 'disabled');
        deps.mailDomainsChanged(md.account_id);
        deps.edgeSync('mail domain toggled');
      }
      changed('mailDomain', md, 'updated', `mail domain ${md.name} updated`);
      await auditService.logReqAs(req, md.tenant_id, 'mail.domain.update', {
        resourceType: 'mail_domain', resourcePath: String(md.id),
        details: { name: md.name, enabled: body.enabled, catchAll: body.catchAll, maxMessageSizeMb: body.maxMessageSizeMb },
      });
    }
    return domainDetail(actor, md.id);
  },

  /** force (staff only): also deletes its mailboxes / aliases (else 409 mailDomainNotEmpty). */
  async deleteDomain(req: Request, actor: HostingActor, id: number, confirm: string, opts: { force?: boolean } = {}): Promise<void> {
    const md = await loadMailDomain(actor, id, 'mail.manage');
    if (confirm.trim().toLowerCase() !== md.name) throw new AppError(400, 'Type the domain name to confirm', 'confirmMismatch');
    if (opts.force && actor.kind !== 'staff') throw new AppError(403, 'Insufficient permissions');
    // Same locks as the creations: no mailbox / alias can appear between the count and the delete.
    const { mailboxIds, aliasCount } = await withTenantLock(md.tenant_id, async (trx) => {
      await lockMailDomain(trx, md.id);
      const ids = (await trx('mailboxes').where({ mail_domain_id: md.id }).select('id') as Array<{ id: number }>).map((r) => r.id);
      const aliases = Number((await trx('mail_aliases').where({ mail_domain_id: md.id }).first(trx.raw('COUNT(*) AS n')) as { n: unknown })?.n ?? 0);
      if ((ids.length > 0 || aliases > 0) && !opts.force) {
        throw new AppError(409, `${md.name} still has ${ids.length} mailbox(es) and ${aliases} alias(es)`, 'mailDomainNotEmpty',
          { mailboxes: ids.length, aliases });
      }
      // CASCADE: mailboxes, aliases, DKIM keys; the triggers write the tombstones (data purged after the grace period, MA12).
      await trx('mail_domains').where({ id: md.id, tenant_id: md.tenant_id }).del();
      return { mailboxIds: ids, aliasCount: aliases };
    });
    const deps = mailCoreDeps();
    for (const mid of mailboxIds) deps.mailboxChanged(mid, 'deleted');
    deps.domainChanged(null, md.domain_id, 'deleted');
    deps.mailDomainsChanged(md.account_id);
    deps.edgeSync('mail domain deleted');
    changed('mailDomain', md, 'deleted', `mail domain ${md.name} deleted`);
    await auditService.logReqAs(req, md.tenant_id, 'mail.domain.delete', {
      resourceType: 'mail_domain', resourcePath: String(md.id),
      details: { name: md.name, accountId: md.account_id, force: !!opts.force, mailboxes: mailboxIds.length, aliases: aliasCount },
    });
  },

  // ── mailboxes ──
  async listMailboxes(actor: HostingActor, q: MailListQuery & { limit: number; offset: number }): Promise<{ items: Mailbox[]; total: number }> {
    assertNeedSomewhere(actor, 'read');
    const base = () => {
      const qb = scopeToActor(actor, db('mailboxes as m').join('mail_domains as md', 'md.id', 'm.mail_domain_id'),
        { tenant: 'm.tenant_id', account: 'm.account_id' }, q.tenantId ?? null);
      if (q.accountId) qb.where('m.account_id', q.accountId);
      if (q.mailDomainId) qb.where('m.mail_domain_id', q.mailDomainId);
      if (q.search) qb.where('m.address', 'ilike', `%${likeEscape(q.search.toLowerCase())}%`);
      return qb;
    };
    const total = Number((await base().first(db.raw('COUNT(*) AS n')) as { n?: unknown } | undefined)?.n ?? 0);
    const rows = await base().select(...MAILBOX_COLS, 'md.name as domain_name').orderBy('m.address').limit(q.limit).offset(q.offset) as
      Array<MailboxRow & { domain_name: string }>;
    return { items: rows.map((r) => toMailbox(r)), total };
  },

  async getMailbox(actor: HostingActor, id: number): Promise<MailboxDetail> {
    const row = await loadMailbox(actor, id, 'read');
    return mailboxDetail(row);
  },

  async createMailbox(req: Request, actor: HostingActor, body: MailboxCreate): Promise<MailboxCreated> {
    const md = await loadMailDomain(actor, body.mailDomainId, 'mail.manage');
    const driver = await activeMailDriver();
    assertEngineHostsMailboxes(driver);
    assertAccountWritable(md.account_status);
    const localPart = body.localPart.trim().toLowerCase();
    assertLocalPartAllowed(localPart);
    const address = `${localPart}@${md.name}`;
    const pw = resolvePassword(actor, driver, body);
    const settings = await platformSettings.section('mail');

    const id = await withTenantLock(md.tenant_id, async (trx) => {
      const live = await lockEngineShared(trx, driver);
      if (pw.imported && !live.capabilities.passwordSchemes.includes(pw.scheme)) {
        throw new AppError(409, `The ${live.engine} engine cannot verify ${pw.scheme} hashes`, 'hashSchemeUnsupported',
          { scheme: pw.scheme, supported: live.capabilities.passwordSchemes });
      }
      await lockMailDomain(trx, md.id);
      await assertAddressFree(trx, address);
      const plan = await accountPlan(trx, md.account_id);
      const usage = await accountUsage(trx, md.account_id);
      assertMailboxCount(plan.limits, usage.mailboxes);
      const quotaMb = body.quotaMb === undefined ? defaultMailboxQuotaMb(settings.defaultMailboxQuotaMb, plan.limits, usage.quotaAllocatedMb) : body.quotaMb;
      assertMailboxQuota(plan.limits, quotaMb, usage.quotaAllocatedMb);
      const tenant = await loadTenantLimits(md.tenant_id, trx);
      const inTenant = Number((await trx('mailboxes').where({ tenant_id: md.tenant_id }).first(trx.raw('COUNT(*) AS n')) as { n: unknown })?.n ?? 0);
      assertTenantMailboxRoom(tenant, inTenant);
      // MA5 / MA12: the old data of this address left by ANOTHER account is purged before reuse, never inherited.
      await purgeForeignTombstones(trx, live, { kind: 'mailbox', name: address, accountId: md.account_id });
      const [inserted] = await trx('mailboxes').insert({
        tenant_id: md.tenant_id, account_id: md.account_id, mail_domain_id: md.id, local_part: localPart, address,
        display_name: body.displayName ?? null, password_hash: pw.hash, password_scheme: pw.scheme, password_set_at: new Date(),
        imported: pw.imported, quota_mb: quotaMb, send_enabled: body.sendEnabled ?? true, receive_enabled: body.receiveEnabled ?? true,
      }).returning('id');
      return Number((inserted as { id: number }).id ?? inserted);
    });

    const row = await reloadMailbox(id);
    changed('mailbox', row, 'created', `mailbox ${address} created`);
    await auditService.logReqAs(req, row.tenant_id, 'mail.mailbox.create', {
      resourceType: 'mailbox', resourcePath: String(id),
      details: { address, accountId: row.account_id, quotaMb: row.quota_mb, imported: pw.imported, generated: pw.generated !== null },
    });
    return { ...toMailbox(row), generatedPassword: pw.generated };
  },

  async updateMailbox(req: Request, actor: HostingActor, id: number, body: MailboxUpdate): Promise<MailboxDetail> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) patch.display_name = body.displayName;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.sendEnabled !== undefined) patch.send_enabled = body.sendEnabled;
    if (body.receiveEnabled !== undefined) patch.receive_enabled = body.receiveEnabled;
    if (body.quotaMb !== undefined && body.quotaMb !== mb.quota_mb) {
      await withTenantLock(mb.tenant_id, async (trx) => {
        const plan = await accountPlan(trx, mb.account_id);
        const others = await accountUsage(trx, mb.account_id, mb.id);
        assertMailboxQuota(plan.limits, body.quotaMb ?? null, others.quotaAllocatedMb);
        await trx('mailboxes').where({ id: mb.id, tenant_id: mb.tenant_id }).update({ ...patch, quota_mb: body.quotaMb, quota_warned_at: null, updated_at: new Date() });
      });
    } else if (Object.keys(patch).length > 0) {
      await db('mailboxes').where({ id: mb.id, tenant_id: mb.tenant_id }).update({ ...patch, updated_at: new Date() });
    } else {
      return mailboxDetail(mb);
    }
    if (body.enabled === false && mb.enabled) mailCoreDeps().mailboxChanged(mb.id, 'disabled');
    const row = await reloadMailbox(mb.id);
    changed('mailbox', row, 'updated', `mailbox ${mb.address} updated`);
    await auditService.logReqAs(req, mb.tenant_id, 'mail.mailbox.update', {
      resourceType: 'mailbox', resourcePath: String(mb.id),
      details: { address: mb.address, displayName: body.displayName, quotaMb: body.quotaMb, enabled: body.enabled,
        sendEnabled: body.sendEnabled, receiveEnabled: body.receiveEnabled },
    });
    return mailboxDetail(row);
  },

  async setPassword(req: Request, actor: HostingActor, id: number, body: MailPasswordChange): Promise<MailPasswordResult> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    const driver = await activeMailDriver();
    const pw = resolvePassword(actor, driver, body);
    await db('mailboxes').where({ id: mb.id, tenant_id: mb.tenant_id }).update({
      password_hash: pw.hash, password_scheme: pw.scheme, password_set_at: new Date(), imported: pw.imported, updated_at: new Date(),
    });
    mailCoreDeps().mailboxChanged(mb.id, 'password');
    changed('mailbox', mb, 'updated', `mailbox ${mb.address} password`);
    await auditService.logReqAs(req, mb.tenant_id, 'mail.mailbox.password', {
      resourceType: 'mailbox', resourcePath: String(mb.id),
      details: { address: mb.address, generated: pw.generated !== null, imported: pw.imported, scheme: pw.scheme },
    });
    return { password: pw.generated };
  },

  /**
   * Forwarding from the panel (mail.manage). Targets kept while paused
   * (enabled false); [] = off. The mailbox gets an informational e-mail when
   * its forwarding is turned on / sent elsewhere (opts.notify, default on;
   * the CWP import passes false).
   */
  async setForwarding(req: Request, actor: HostingActor, id: number, body: MailForwardingInput, opts: { notify?: boolean } = {}): Promise<MailboxDetail> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    const before = forwardingOf(mb);
    const next = forwardingInput(body);
    // A client user of the account is bound by the platform's external-forwarding switch like the
    // mailbox owner; staff is not (it may set an external target, which then stays allowed).
    if (actor.kind === 'client') await assertPolicyTargets(mb.account_id, next.targets, storedTargets(mb));
    await writeForwarding(mb, next, true);
    const row = await reloadMailbox(mb.id);
    changed('mailbox', row, 'updated', `mailbox ${mb.address} forwarding`);
    await auditService.logReqAs(req, mb.tenant_id, 'mail.mailbox.forwarding', {
      resourceType: 'mailbox', resourcePath: String(mb.id),
      details: { address: mb.address, targets: next.targets.length, keepCopy: next.keepCopy, enabled: next.enabled },
    });
    if (opts.notify !== false) forwardingNotice(mb.address, before, forwardingOf(row));
    return mailboxDetail(row);
  },

  /** Inbox rules from the panel (mail.manage), the whole ordered list. Stalwart only (409 rulesUnsupported). */
  async setRules(req: Request, actor: HostingActor, id: number, input: unknown): Promise<MailboxDetail> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    await assertRulesEngine();
    const rules = parseMailRulesInput(input, mb.address);
    const before = parseMailRules(mb.mail_rules);
    if (actor.kind === 'client') await assertPolicyTargets(mb.account_id, ruleTargets(rules), storedTargets(mb));
    await writeRules(mb, rules);
    const row = await reloadMailbox(mb.id);
    changed('mailbox', row, 'updated', `mailbox ${mb.address} rules`);
    // Counts only: the words of the conditions are the user's content (MA4).
    await auditService.logReqAs(req, mb.tenant_id, 'mail.mailbox.rules', {
      resourceType: 'mailbox', resourcePath: String(mb.id),
      details: { address: mb.address, rules: rules.length, enabled: rules.filter((r) => r.enabled).length, forwardTargets: ruleTargets(rules).length },
    });
    rulesNotice(mb.address, before, parseMailRules(row.mail_rules), forwardingOf(row));
    return mailboxDetail(row);
  },

  /**
   * Folders of the mailbox (rule "move to" picker): '/'-joined paths, from the
   * engine; [] when it cannot say. Folder names are the user's content: the
   * right that edits the rules (mail.manage), not a mere read.
   */
  async mailboxFolders(actor: HostingActor, id: number): Promise<string[]> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    if (!mailEngineSupportsRules(await activeMailEngine())) return [];
    try {
      const { webmailEngine } = await import('./webmail/oblimint/server');
      const ep = await webmailEngine.endpoints(mb.address);
      const out = await webmailEngine.call(mb.address, [['Mailbox/get', { accountId: ep.accountId, ids: null, properties: ['id', 'name', 'parentId', 'role'] }, 'm']]);
      const list = ((out.methodResponses?.[0]?.[1] as { list?: unknown[] } | undefined)?.list ?? []) as Array<{ id: string; name: string; parentId: string | null; role: string | null }>;
      return folderPaths(list);
    } catch (err) {
      logger.debug({ err: errText(err), mailbox: mb.id }, 'mail: folders of the mailbox not listed');
      return [];
    }
  },

  // ── the mailbox's own settings (Oblimint webmail: the session IS the mailbox) ──

  async ownerForwarding(mailboxId: number): Promise<WebmailForwarding> {
    const row = await reloadMailbox(mailboxId);
    const f = forwardingOf(row);
    return {
      ...f,
      active: f.enabled && f.targets.length > 0,
      changedByPanelAt: row.forward_changed_by_panel && row.forward_changed_at ? new Date(row.forward_changed_at as string).toISOString() : null,
      // Rules that forward / redirect (a rule without a condition does what a forwarding does): in the banner too.
      ruleForwards: ruleForwards(parseMailRules(row.mail_rules)),
      policy: publicPolicy(await ownerPolicy(row.account_id)),
    };
  },

  /**
   * The owner's forwarding (webmail). Same rows / checks / sync / audit as
   * the panel; external targets only when the platform allows it, except
   * those already there (set by the panel). 403 forwardingNotAllowed.
   */
  async setForwardingAsMailbox(mailboxId: number, input: WebmailForwardingInput, ip: string | null): Promise<WebmailForwarding> {
    const row0 = await reloadMailbox(mailboxId);
    const next = forwardingInput(input as unknown as { targets: unknown; keepCopy?: unknown; enabled?: unknown });
    await assertPolicyTargets(row0.account_id, next.targets, storedTargets(row0));
    await writeForwarding(row0, next, false);
    const row = await reloadMailbox(mailboxId);
    changed('mailbox', row, 'updated', `mailbox ${row.address} forwarding (webmail)`);
    await auditService.log({
      tenantId: row.tenant_id, action: 'mail.mailbox.forwarding', resourceType: 'mailbox', resourcePath: String(row.id), ipAddress: ip ?? undefined,
      details: { address: row.address, origin: 'webmail', targets: next.targets.length, keepCopy: next.keepCopy, enabled: next.enabled },
    });
    return this.ownerForwarding(mailboxId);
  },

  async ownerRules(mailboxId: number): Promise<WebmailRules> {
    const row = await reloadMailbox(mailboxId);
    return {
      rules: parseMailRules(row.mail_rules),
      supported: mailEngineSupportsRules(await activeMailEngine()),
      policy: publicPolicy(await ownerPolicy(row.account_id)),
    };
  },

  /** The owner's rules (webmail): forward / redirect targets bounded like the forwarding. */
  async setRulesAsMailbox(mailboxId: number, input: unknown, ip: string | null): Promise<WebmailRules> {
    await assertRulesEngine();
    const row0 = await reloadMailbox(mailboxId);
    const rules = parseMailRulesInput(input, row0.address);
    await assertPolicyTargets(row0.account_id, ruleTargets(rules), storedTargets(row0));
    await writeRules(row0, rules);
    const row = await reloadMailbox(mailboxId);
    changed('mailbox', row, 'updated', `mailbox ${row.address} rules (webmail)`);
    await auditService.log({
      tenantId: row.tenant_id, action: 'mail.mailbox.rules', resourceType: 'mailbox', resourcePath: String(row.id), ipAddress: ip ?? undefined,
      details: { address: row.address, origin: 'webmail', rules: rules.length, enabled: rules.filter((r) => r.enabled).length, forwardTargets: ruleTargets(rules).length },
    });
    return this.ownerRules(mailboxId);
  },

  async setAutoresponder(req: Request, actor: HostingActor, id: number, body: MailAutoresponderInput): Promise<MailboxDetail> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    assertAutoresponderSchedule(body.startsAt, body.endsAt);
    const value: MailAutoresponder = {
      enabled: !!body.enabled,
      subject: body.subject.trim().slice(0, 200),
      body: body.body.slice(0, 10_000),
      startsAt: body.startsAt ? new Date(body.startsAt).toISOString() : null,
      endsAt: body.endsAt ? new Date(body.endsAt).toISOString() : null,
      intervalDays: body.intervalDays ?? 7,
    };
    await db('mailboxes').where({ id: mb.id, tenant_id: mb.tenant_id }).update({ autoresponder: JSON.stringify(value), updated_at: new Date() });
    const row = await reloadMailbox(mb.id);
    changed('mailbox', row, 'updated', `mailbox ${mb.address} autoresponder`);
    // Never the subject / body in the audit (MA4).
    await auditService.logReqAs(req, mb.tenant_id, 'mail.mailbox.autoresponder', {
      resourceType: 'mailbox', resourcePath: String(mb.id),
      details: { address: mb.address, enabled: value.enabled, startsAt: value.startsAt, endsAt: value.endsAt, intervalDays: value.intervalDays },
    });
    return mailboxDetail(row);
  },

  /**
   * The mailbox's own autoresponder from the Oblimint webmail (the session IS
   * the mailbox: no panel actor). Same storage, sync and audit as
   * setAutoresponder (`mail.mailbox.autoresponder`, user null, origin webmail).
   * `value` is already validated (webmail/oblimint/vacation.ts).
   */
  async setAutoresponderAsMailbox(mailboxId: number, value: MailAutoresponder, ip: string | null): Promise<MailAutoresponder | null> {
    const row0 = await reloadMailbox(mailboxId);
    await db('mailboxes').where({ id: row0.id, tenant_id: row0.tenant_id }).update({ autoresponder: JSON.stringify(value), updated_at: new Date() });
    const row = await reloadMailbox(mailboxId);
    changed('mailbox', row, 'updated', `mailbox ${row.address} autoresponder (webmail)`);
    await auditService.log({
      tenantId: row.tenant_id,
      action: 'mail.mailbox.autoresponder',
      resourceType: 'mailbox',
      resourcePath: String(row.id),
      ipAddress: ip ?? undefined,
      details: { address: row.address, origin: 'webmail', enabled: value.enabled, startsAt: value.startsAt, endsAt: value.endsAt, intervalDays: value.intervalDays },
    });
    return parseAutoresponder(row.autoresponder);
  },

  async deleteMailbox(req: Request, actor: HostingActor, id: number, confirm: string): Promise<void> {
    const mb = await loadMailbox(actor, id, 'mail.manage');
    if (confirm.trim().toLowerCase() !== mb.address) throw new AppError(400, 'Type the address to confirm', 'confirmMismatch');
    // Trigger ⇒ tombstone: logins / delivery stop at the next sync, data purged after the grace period (MA12).
    await db('mailboxes').where({ id: mb.id, tenant_id: mb.tenant_id }).del();
    mailCoreDeps().mailboxChanged(mb.id, 'deleted');
    changed('mailbox', mb, 'deleted', `mailbox ${mb.address} deleted`);
    await auditService.logReqAs(req, mb.tenant_id, 'mail.mailbox.delete', {
      resourceType: 'mailbox', resourcePath: String(mb.id), details: { address: mb.address, accountId: mb.account_id },
    });
  },

  // ── aliases ──
  async listAliases(actor: HostingActor, q: MailListQuery): Promise<MailAlias[]> {
    assertNeedSomewhere(actor, 'read');
    const qb = scopeToActor(actor, db('mail_aliases as al').join('mail_domains as md', 'md.id', 'al.mail_domain_id'),
      { tenant: 'al.tenant_id', account: 'al.account_id' }, q.tenantId ?? null);
    if (q.accountId) qb.where('al.account_id', q.accountId);
    if (q.mailDomainId) qb.where('al.mail_domain_id', q.mailDomainId);
    if (q.search) qb.where('al.address', 'ilike', `%${likeEscape(q.search.toLowerCase())}%`);
    const rows = await qb.select('al.*', 'md.name as domain_name').orderBy('al.address').limit(2000) as Array<MailAliasRow & { domain_name: string }>;
    return rows.map((r) => toMailAlias(r));
  },

  async createAlias(req: Request, actor: HostingActor, body: MailAliasInput): Promise<MailAlias> {
    const md = await loadMailDomain(actor, body.mailDomainId, 'mail.manage');
    const driver = await activeMailDriver();
    assertEngineHostsMailboxes(driver);
    assertAccountWritable(md.account_status);
    const localPart = body.localPart.trim().toLowerCase();
    assertLocalPartAllowed(localPart);
    const address = `${localPart}@${md.name}`;
    const targets = [...new Set(body.targets.map((t) => t.trim().toLowerCase()))];

    const id = await withTenantLock(md.tenant_id, async (trx) => {
      await lockEngineShared(trx, driver);
      await lockMailDomain(trx, md.id);
      await assertAddressFree(trx, address);
      const plan = await accountPlan(trx, md.account_id);
      const usage = await accountUsage(trx, md.account_id);
      assertAliasCount(plan.limits, usage.aliases);
      await lockMailAccount(trx, md.account_id);
      await assertTargets(trx, md.account_id, address, targets, 'targets');
      const [inserted] = await trx('mail_aliases').insert({
        tenant_id: md.tenant_id, account_id: md.account_id, mail_domain_id: md.id, local_part: localPart, address,
        targets: JSON.stringify(targets), enabled: body.enabled ?? true, comment: body.comment ?? null,
      }).returning('id');
      return Number((inserted as { id: number }).id ?? inserted);
    });

    const row = await loadMailAlias(actor, id, 'read');
    changed('alias', row, 'created', `alias ${address} created`);
    await auditService.logReqAs(req, row.tenant_id, 'mail.alias.create', {
      resourceType: 'mail_alias', resourcePath: String(id), details: { address, accountId: row.account_id, targets: targets.length },
    });
    return toMailAlias(row);
  },

  async updateAlias(req: Request, actor: HostingActor, id: number, body: MailAliasUpdate): Promise<MailAlias> {
    const al = await loadMailAlias(actor, id, 'mail.manage');
    const patch: Record<string, unknown> = {};
    const targets = body.targets !== undefined ? [...new Set(body.targets.map((t) => t.trim().toLowerCase()))] : null;
    if (targets) patch.targets = JSON.stringify(targets);
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.comment !== undefined) patch.comment = body.comment;
    if (Object.keys(patch).length === 0) return toMailAlias(al);
    await db.transaction(async (trx) => {
      if (targets) {
        await lockMailAccount(trx, al.account_id);
        await assertTargets(trx, al.account_id, al.address, targets, 'targets');
      }
      await trx('mail_aliases').where({ id: al.id, tenant_id: al.tenant_id }).update({ ...patch, updated_at: new Date() });
    });
    const row = await loadMailAlias(actor, al.id, 'read');
    changed('alias', row, 'updated', `alias ${al.address} updated`);
    await auditService.logReqAs(req, al.tenant_id, 'mail.alias.update', {
      resourceType: 'mail_alias', resourcePath: String(al.id),
      details: { address: al.address, targets: body.targets?.length, enabled: body.enabled },
    });
    return toMailAlias(row);
  },

  async deleteAlias(req: Request, actor: HostingActor, id: number): Promise<void> {
    const al = await loadMailAlias(actor, id, 'mail.manage');
    await db('mail_aliases').where({ id: al.id, tenant_id: al.tenant_id }).del();
    changed('alias', al, 'deleted', `alias ${al.address} deleted`);
    await auditService.logReqAs(req, al.tenant_id, 'mail.alias.delete', {
      resourceType: 'mail_alias', resourcePath: String(al.id), details: { address: al.address, accountId: al.account_id },
    });
  },

  // ── platform admin (routes/systemMail.routes.ts) ──
  async systemStatus(): Promise<MailSystemStatus> {
    const deps = mailCoreDeps();
    const engine = await activeMailEngine();
    const driver = await activeMailDriver();
    const settings = await platformSettings.section('mail');
    let docker: Awaited<ReturnType<typeof engineFor>> | null = null;
    let dockerError: string | null = null;
    try { docker = await engineFor(await localNodeId()); } catch (err) { dockerError = errText(err); }
    const queue = driver.capabilities.queue
      ? withTimeoutOr(driver.queue({ limit: 5000 }).then((items) => {
        const out = { active: 0, deferred: 0, hold: 0 };
        for (const i of items) out[i.status] = (out[i.status] ?? 0) + 1;
        return out;
      }), 15_000, null)
      : Promise.resolve(null);
    const [hostname, components, version, domains, mailboxes, aliases, q, relay, webmail, ptr, activeBans] = await Promise.all([
      mailHostname().catch(() => null),
      withTimeoutOr(driver.status(), 15_000, []),
      withTimeoutOr(driver.version(), 10_000, null),
      countAll('mail_domains'),
      countAll('mailboxes'),
      countAll('mail_aliases'),
      queue,
      withTimeoutOr(deps.relayStatus(docker, dockerError), 15_000, null),
      settings.webmail === 'none' ? Promise.resolve(null) : withTimeoutOr(deps.webmailStatus(docker, dockerError), 15_000, null),
      withTimeoutOr(deps.ptrStatus(), 10_000, { ipv4: null, ipv6: null }),
      withTimeoutOr(deps.activeBanCount(), 10_000, 0),
    ]);
    const sync = mailSyncInfo();
    return {
      engine,
      engineSupported: isMailEngineSupported(engine) && driver.capabilities.supported,
      hasMailboxes: mailEngineHasMailboxes(engine) && driver.capabilities.mailboxes,
      hostname,
      components,
      version,
      lastSyncAt: sync.lastSyncAt,
      lastSyncError: sync.lastSyncError,
      counts: { domains, mailboxes, aliases },
      queue: q,
      relay: { enabled: settings.siteRelay, component: relay },
      webmail: { kind: settings.webmail, hostname: settings.webmailHostname, component: webmail },
      ptr,
      activeBans,
      engineChangeAllowed: mailboxes === 0 && aliases === 0,
    };
  },

  /** Converges the engine now (force = skip the mass-removal guard, audited by the route). */
  async syncNow(opts: { force?: boolean } = {}): Promise<MailSystemStatus> {
    await runSyncNow({ reason: opts.force ? 'manual (forced)' : 'manual', force: !!opts.force, ensureNetwork: true });
    return mailService.systemStatus();
  },

  /** 409 mailEngineInUse while a mailbox or an alias exists; 400 mailEngineNotSupported. */
  async changeEngine(req: Request, engine: MailEngine): Promise<MailSystemStatus> {
    if (!isMailEngineSupported(engine)) throw new AppError(400, `The ${engine} mail engine is not supported yet`, 'mailEngineNotSupported');
    // One job alone on the sync chain (no sync / purge with the old driver meanwhile, no second change).
    // The count check and the "changing" flag are written together under the exclusive engine lock: the
    // creations (shared lock) refuse from then on, so the counts checked stay true until the switch.
    const outcome = await runMailExclusive(async (syncInline) => {
      const current = await activeMailEngine();
      if (current === engine) return null;
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ENGINE_LOCK]);
        const counts = await trx.raw('SELECT (SELECT COUNT(*) FROM mailboxes) AS m, (SELECT COUNT(*) FROM mail_aliases) AS a') as
          { rows: Array<{ m: unknown; a: unknown }> };
        const mailboxes = Number(counts.rows[0]?.m ?? 0);
        const aliases = Number(counts.rows[0]?.a ?? 0);
        if (mailboxes > 0 || aliases > 0) {
          throw new AppError(409, 'The mail engine cannot be changed while mailboxes or aliases exist', 'mailEngineInUse', { mailboxes, aliases });
        }
        await trx('app_config').insert({ key: ENGINE_CHANGE_KEY, value: JSON.stringify({ to: engine, at: new Date().toISOString() }) })
          .onConflict('key').merge(['value']);
      });
      const log = (line: string) => { logger.info({ line }, 'mail engine change'); };
      try {
        const oldDriver = await mailDriverFor(current);
        try {
          await oldDriver.remove(log);
        } catch (err) {
          throw new AppError(502, `Could not remove the ${current} engine: ${err instanceof MailDriverError ? err.message : errText(err)}`, 'backendUnavailable');
        }
        await appConfigService.set('mail_engine', engine);
        await clearMailSyncApplied();
        // The Oblimint webmail needs Stalwart: another engine falls back to Roundcube.
        await import('./webmail/webmailDefault').then(async (m) => {
          if (await m.alignWebmailWithEngine()) (await import('./webmail/webmail.service')).webmailService.settingsChanged();
        }).catch(() => undefined);
      } finally {
        await db('app_config').where({ key: ENGINE_CHANGE_KEY }).del().catch(() => undefined);
      }
      const newDriver = await mailDriverFor(engine);
      let deployError: string | null = null;
      try {
        if (mailEngineHasMailboxes(engine)) await ensureMailNetwork(log);
        await newDriver.ensure(log);
      } catch (err) {
        deployError = err instanceof MailDriverError ? [err.message, err.detail].filter(Boolean).join(' : ') : errText(err);
        recordMailSyncError(`Déploiement du moteur ${engine} en échec : ${deployError}`);
      }
      if (!deployError) await syncInline(`engine changed to ${engine}`);
      return { current, deployError };
    });
    if (!outcome) return mailService.systemStatus();
    const { current, deployError } = outcome;
    const deps = mailCoreDeps();
    deps.dnsSyncAll('mail engine changed');
    deps.edgeSync('mail engine changed');
    // Mail domains created under 'external' have no DKIM key: create them now, not at the hourly rotation pass.
    if (mailEngineHasMailboxes(engine)) void ensureDkimForAll(deps);
    emitMail({ entity: 'engine', id: 0, accountId: null, action: 'updated' }, { tenantId: null, accountId: null });
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'mail.engine', {
      resourceType: 'mail', resourcePath: 'engine', details: { from: current, to: engine, deployed: !deployError },
    });
    if (deployError) {
      throw new AppError(502, `The engine is now ${engine} but its deployment failed: ${deployError} (deploy it again from the Nodes page)`,
        'backendUnavailable');
    }
    return mailService.systemStatus();
  },

  // ── hooks (never throw, debounced) ──
  /** Re-converge the engine (any P4 module after a change of what goes into the desired state). */
  requestSync(reason: string): void {
    requestMailSync(reason);
  },
  /** Settings section `mail` changed (contracts.notifyMailSettingsChanged). */
  settingsChanged(): void {
    requestMailSync('mail settings changed');
  },
  /** Account status / plan changed (reconcile hook): suspension, limits. */
  accountChanged(accountId: number, reason: string): void {
    requestMailSync(`account ${accountId}: ${reason}`);
  },
  start(): void {
    startMailSync();
  },
  stop(): void {
    stopMailSync();
  },
};

