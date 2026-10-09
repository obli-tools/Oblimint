import os from 'os';
import type { MailSettings, PlanLimits } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { SCANNER_CLAMD_PORT, SCANNER_CONTAINER } from '../hosting/naming';
import { planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { mailHostname } from './contracts';
import { mailCoreDeps } from './deps';
import type {
  DesiredAlias, DesiredAppPassword, DesiredDkimKey, DesiredMailbox, DesiredMailDomain, DesiredRelayTrust, DesiredTlsCertificate,
  MailDesiredState,
} from './driver';
import { effectiveMessageSizeMb } from './limits';
import { accountServesMail, mailDomainActive } from './mappers';
import type { AccountSendPolicy } from './outbound/outbound.service';
import { parseAutoresponder, parseTargets, type MailAliasRow, type MailboxRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Desired state of the mail engine (docs/P4-PLAN.md §9.1). buildDesiredState
// is PURE (unit-tested): the panel rules of what the engine serves.
// loadDesiredState reads the DB + the providers of the other modules:
//  - send policy, DKIM keys, certificates and relay trust are MANDATORY: an
//    empty value would lift outbound suspensions, delete every DKIM key, drop
//    TLS or the relay. A failure reuses the last value loaded successfully
//    (logged), or — none yet — throws: no sync, the running configuration
//    stays live and lastSyncError says why;
//  - webmail sessions failing ⇒ none (a revoked credential never comes back
//    from a cache) + a log line; the host name falls back to the OS one;
//  - the domains / mailboxes / aliases themselves failing ⇒ throws (no sync:
//    an empty state would remove every login of the engine).
// The state carries password hashes and DKIM keys: in memory only, never
// logged (MA4).
// ─────────────────────────────────────────────────────────────────────────────

export interface DesiredDomainSource {
  id: number;
  account_id: number;
  name: string;
  enabled: boolean;
  catch_all: string | null;
  max_message_size_mb: number | null;
  account_status: string;
  verified: boolean;
  plan: PlanLimits;
}

export interface DesiredStateInput {
  now: Date;
  hostname: string;
  settings: Pick<MailSettings, 'maxMessageSizeMb' | 'spamTagScore' | 'spamRejectScore' | 'greylisting' | 'clamav'>;
  domains: DesiredDomainSource[];
  mailboxes: MailboxRow[];
  aliases: MailAliasRow[];
  sendPolicy: ReadonlyMap<number, AccountSendPolicy>;
  appPasswords: DesiredAppPassword[];
  dkim: DesiredDkimKey[];
  tls: DesiredTlsCertificate[];
  relay: DesiredRelayTrust;
}

/** clamd endpoint of the shared scanner on the mail network (settings mail.clamav). */
export function clamdAddressFor(clamav: boolean): string | null {
  return clamav ? `${SCANNER_CONTAINER}:${SCANNER_CLAMD_PORT}` : null;
}

export function buildDesiredState(input: DesiredStateInput): MailDesiredState {
  const { now, settings } = input;
  const domains: DesiredMailDomain[] = [];
  const byId = new Map<number, { src: DesiredDomainSource; active: boolean }>();
  for (const d of input.domains) {
    const active = mailDomainActive(d, { verified: d.verified, accountStatus: d.account_status });
    byId.set(d.id, { src: d, active });
    domains.push({
      id: d.id,
      accountId: d.account_id,
      name: d.name,
      active,
      catchAll: d.catch_all,
      maxMessageSizeMb: effectiveMessageSizeMb(d.max_message_size_mb, d.plan, settings.maxMessageSizeMb),
    });
  }

  // MA9: mail of an account (or mailbox) that may not send must not leave the
  // platform by any engine path either: forwarding, alias expansion,
  // catch-all and the panel autoresponder keep their LOCAL targets only (a
  // target on a domain the engine serves); Sieve redirect is refused by the
  // engine for a mailbox whose sendEnabled is false (render).
  const activeNames = new Set(domains.filter((d) => d.active).map((d) => d.name.toLowerCase()));
  const isLocal = (addr: string): boolean => activeNames.has(String(addr).split('@').pop()!.toLowerCase());
  const accountCanSend = (accountId: number, accountStatus: string): boolean =>
    accountServesMail(accountStatus) && !(input.sendPolicy.get(accountId)?.suspended ?? false);

  const mailboxes: DesiredMailbox[] = [];
  const loginEnabledIds = new Set<number>();
  for (const m of input.mailboxes) {
    const dom = byId.get(m.mail_domain_id);
    if (!dom) continue; // domain row gone between the two reads: next pass
    const domainActive = dom.active;
    const loginEnabled = !!m.enabled && accountServesMail(dom.src.account_status) && domainActive;
    const policy = input.sendPolicy.get(m.account_id);
    const sendEnabled = loginEnabled && !!m.send_enabled && !(policy?.suspended ?? false);
    const receiveEnabled = !!m.receive_enabled && domainActive;
    const mayForwardOut = accountCanSend(m.account_id, dom.src.account_status) && !!m.send_enabled;
    const targets = parseTargets(m.forward_targets).filter((t) => mayForwardOut || isLocal(t));
    const ar = mayForwardOut ? parseAutoresponder(m.autoresponder) : null;
    if (loginEnabled) loginEnabledIds.add(m.id);
    mailboxes.push({
      id: m.id,
      accountId: m.account_id,
      domainId: m.mail_domain_id,
      address: m.address,
      localPart: m.local_part,
      domain: dom.src.name,
      displayName: m.display_name,
      passwordHash: m.password_hash,
      passwordScheme: m.password_scheme,
      quotaMb: m.quota_mb,
      loginEnabled,
      sendEnabled,
      receiveEnabled,
      sendPerHour: policy ? policy.perHour : dom.src.plan.mailOutboundPerHour,
      forward: targets.length > 0 ? { targets, keepCopy: !!m.forward_keep_copy } : null,
      // Kept while not yet started (the engine checks the dates itself); dropped once over.
      autoresponder: ar && ar.enabled && (!ar.endsAt || Date.parse(ar.endsAt) > now.getTime())
        ? { subject: ar.subject, body: ar.body, startsAt: ar.startsAt, endsAt: ar.endsAt, intervalDays: ar.intervalDays }
        : null,
    });
  }

  const aliases: DesiredAlias[] = [];
  for (const a of input.aliases) {
    const dom = byId.get(a.mail_domain_id);
    if (!dom || !dom.active || !a.enabled) continue;
    const targets = parseTargets(a.targets).filter((t) => accountCanSend(a.account_id, dom.src.account_status) || isLocal(t));
    if (targets.length === 0) continue;
    aliases.push({ id: a.id, accountId: a.account_id, domainId: a.mail_domain_id, address: a.address, targets });
  }

  for (const d of domains) {
    const src = byId.get(d.id)!.src;
    if (d.catchAll && !isLocal(d.catchAll) && !accountCanSend(d.accountId, src.account_status)) d.catchAll = null;
  }

  return {
    generatedAt: now.toISOString(),
    settings: {
      hostname: input.hostname,
      maxMessageSizeMb: settings.maxMessageSizeMb,
      spamTagScore: settings.spamTagScore,
      spamRejectScore: settings.spamRejectScore,
      greylisting: settings.greylisting,
      clamav: settings.clamav,
      clamdAddress: clamdAddressFor(settings.clamav),
    },
    domains,
    mailboxes,
    aliases,
    // A webmail session only for a mailbox that may log in, until it expires.
    appPasswords: input.appPasswords.filter((p) => loginEnabledIds.has(p.mailboxId) && Date.parse(p.expiresAt) > now.getTime()),
    dkim: input.dkim.filter((k) => activeNames.has(k.domain.toLowerCase())),
    tls: input.tls,
    relay: input.relay,
  };
}

/** Optional provider: its failure leaves its part at the fallback (logged, never a secret). */
async function part<T>(what: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? String(err), part: what }, 'mail desired state: provider failed, part left empty');
    return fallback;
  }
}

/** Last value of each mandatory provider loaded successfully (in memory, never logged). */
const lastGood = new Map<string, unknown>();

/**
 * Mandatory provider: its value, else the last one loaded successfully, else
 * throws (never an empty fallback). Exported for the tests.
 */
export async function requiredPart<T>(what: string, run: () => Promise<T>, cache: Map<string, unknown> = lastGood): Promise<T> {
  try {
    const v = await run();
    cache.set(what, v);
    return v;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    if (cache.has(what)) {
      logger.warn({ err: message, part: what }, 'mail desired state: provider failed, last loaded value reused');
      return cache.get(what) as T;
    }
    throw new Error(`mail desired state: ${what} unavailable (${message.slice(0, 300)})`);
  }
}

/** Tests: forget the cached provider values. */
export function resetDesiredStateCacheForTests(): void {
  lastGood.clear();
}

/** Reads everything and builds the state. Throws when the mail tables or a mandatory provider cannot be read. */
export async function loadDesiredState(now = new Date()): Promise<MailDesiredState> {
  const deps = mailCoreDeps();
  const domainRows = await db('mail_domains as md')
    .join('hosting_accounts as a', 'a.id', 'md.account_id')
    .join('plans as p', 'p.id', 'a.plan_id')
    .leftJoin('domains as d', 'd.id', 'md.domain_id')
    .orderBy('md.id')
    .select('md.id', 'md.account_id', 'md.name', 'md.enabled', 'md.catch_all', 'md.max_message_size_mb',
      'a.status as account_status', 'd.verification_status', 'p.limits as plan_limits') as Array<{
      id: number; account_id: number; name: string; enabled: boolean; catch_all: string | null; max_message_size_mb: number | null;
      account_status: string; verification_status: string | null; plan_limits: unknown;
    }>;
  const mailboxes = await db('mailboxes').orderBy('id') as MailboxRow[];
  const aliases = await db('mail_aliases').orderBy('id') as MailAliasRow[];
  const settings = await platformSettings.section('mail');
  const hostname = (await part('hostname', null, mailHostname)) ?? os.hostname().toLowerCase();

  const [sendPolicy, appPasswords, dkim, tls, relay] = await Promise.all([
    requiredPart<ReadonlyMap<number, AccountSendPolicy>>('sendPolicy', () => deps.sendPolicy()),
    part('appPasswords', [] as DesiredAppPassword[], () => deps.appPasswords()),
    requiredPart<DesiredDkimKey[]>('dkim', () => deps.dkimSigningKeys()),
    requiredPart<DesiredTlsCertificate[]>('tls', () => deps.tlsCertificates()),
    requiredPart<DesiredRelayTrust>('relay', () => deps.relayTrust()),
  ]);

  return buildDesiredState({
    now,
    hostname,
    settings,
    domains: domainRows.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      name: r.name,
      enabled: !!r.enabled,
      catch_all: r.catch_all,
      max_message_size_mb: r.max_message_size_mb,
      account_status: r.account_status,
      verified: r.verification_status === 'verified',
      plan: planLimits(r.plan_limits),
    })),
    mailboxes,
    aliases,
    sendPolicy,
    appPasswords,
    dkim,
    tls,
    relay,
  });
}

