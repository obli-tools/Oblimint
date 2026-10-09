import type { Request } from 'express';
import type { MailDnsRecord, MailDnsStatus, MailDomainDnsSettings, MailDomainDnsUpdate, MailPtrCheck } from '@oblimint/shared';
import { mailEngineHasMailboxes } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import { registerZoneRecordContributor, unregisterZoneRecordContributor } from '../../dns/contributors';
import { zoneForName } from '../../dns/store';
import { registerEdgeContributor, unregisterEdgeContributor } from '../../edge/contributors';
import { iso, json } from '../../hosting/rows';
import type { HostingActor } from '../../hosting/access';
import { platformSettings } from '../../platformSettings';
import { loadMailDomain } from '../access';
import { emitMail } from '../events';
import { activeMailEngine } from '../registry';
import { parseDnsSettings } from '../rows';
import { mailEdgeContributor } from '../tls/edgeContributor';
import { checkPtr, checkRecords, recordsHealthy } from './checks';
import { dkimService, retireAlgorithm, runDkimRotation } from './dkim.service';
import { expectedRecordsOf, loadMailPlatformContext, mailDomainView, mailDomainViews, type MailDomainView, type MailPlatformContext } from './domains';
import { mailDnsLookup, type MailDnsLookup } from './lookup';
import { dkimPublicKeyOf, isValidReportAddress, MailDnsInputError, validateExternalConfig, validateSpfExtra } from './records';
import { mailZoneContributor } from './zoneContributor';

// ─────────────────────────────────────────────────────────────────────────────
// Mail DNS (docs/P4-PLAN.md §6.3, §9.3) — module mail-dns-tls.
// start() registers the DNS zone contributor (dns/contributors.ts,
// zoneContributor.ts) and the edge contributor (edge/contributors.ts,
// tls/edgeContributor.ts), then runs the DKIM rotation (hourly) and the
// periodic DNS checks (every 6 h per domain; results in
// mail_domains.dns_check / dns_healthy / dns_checked_at, MAIL_UPDATED 'dns').
// ─────────────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 15_000;
const PTR_CACHE_MS = 60 * 60_000;
const PERIODIC_CHECK_AGE_MS = 6 * 3600_000;
const CHECK_SCAN_MS = 10 * 60_000;
const CHECKS_PER_SCAN = 25;
const ROTATION_MS = 60 * 60_000;
const BOOT_DELAY_MS = 90_000;

const lastCheck = new Map<number, number>();
let ptrCache: { at: number; value: Promise<PtrPair> } | null = null;
let timers: NodeJS.Timeout[] = [];
let rotationRunning = false;
let scanRunning = false;

type PtrPair = { ipv4: MailPtrCheck | null; ipv6: MailPtrCheck | null };

/** What mail_domains.dns_check holds. */
interface StoredCheck {
  checkedAt: string | null;
  records: MailDnsRecord[];
  ptr: PtrPair;
}

function parseStoredCheck(v: unknown): StoredCheck {
  const c = json<Partial<StoredCheck> | null>(v, null);
  return {
    checkedAt: typeof c?.checkedAt === 'string' ? c.checkedAt : null,
    records: Array.isArray(c?.records) ? c!.records.filter((r) => r && typeof r.name === 'string' && typeof r.type === 'string') : [],
    ptr: c?.ptr && typeof c.ptr === 'object' ? { ipv4: c.ptr.ipv4 ?? null, ipv6: c.ptr.ipv6 ?? null } : { ipv4: null, ipv6: null },
  };
}

const recordKey = (r: { name: string; type: string; content: string; priority: number | null }) => `${r.name}|${r.type}|${r.content}|${r.priority ?? ''}`;

function safeHook(what: string, fn: () => void): void {
  try { fn(); } catch (err) { logger.warn({ err: (err as Error)?.message, hook: what }, 'mail dns hook failed'); }
}

async function zoneInfo(v: Pick<MailDomainView, 'name' | 'accountId'>): Promise<{ managed: boolean; zoneId: number | null }> {
  const zone = await zoneForName(v.name, v.accountId);
  return { managed: !!zone && zone.kind === 'hosted' && zone.status === 'active', zoneId: zone?.id ?? null };
}

async function computePtr(ctx: MailPlatformContext, lookup: MailDnsLookup): Promise<PtrPair> {
  if (!ctx.host || !ctx.hasMailboxes) return { ipv4: null, ipv6: null };
  const host = ctx.host;
  const [ipv4, ipv6] = await Promise.all([
    ctx.ipv4 ? checkPtr(ctx.ipv4, host, lookup) : Promise.resolve(null),
    ctx.ipv6 ? checkPtr(ctx.ipv6, host, lookup) : Promise.resolve(null),
  ]);
  return { ipv4, ipv6 };
}

/** PTR of the node addresses (cached 1 h; a failed computation is not cached). */
function ptrCached(force = false): Promise<PtrPair> {
  const now = Date.now();
  if (!force && ptrCache && now - ptrCache.at < PTR_CACHE_MS) return ptrCache.value;
  const value = (async () => computePtr(await loadMailPlatformContext(), await mailDnsLookup()))();
  ptrCache = { at: now, value };
  value.catch(() => { ptrCache = null; });
  return value;
}

/** Expected records + the last check (no network). */
async function buildStatus(v: MailDomainView, ctx: MailPlatformContext): Promise<MailDnsStatus> {
  const specs = (await expectedRecordsOf([v], ctx)).get(v.id) ?? [];
  const row = await db('mail_domains').where({ id: v.id }).first('dns_check', 'dns_checked_at') as { dns_check: unknown; dns_checked_at: Date | string | null } | undefined;
  const stored = parseStoredCheck(row?.dns_check);
  const byKey = new Map(stored.records.map((r) => [recordKey(r), r]));
  const records: MailDnsRecord[] = specs.map((s) => {
    const last = byKey.get(recordKey({ name: s.fqdn, type: s.type, content: s.content, priority: s.priority }));
    return {
      kind: s.kind, name: s.fqdn, type: s.type, content: s.content, priority: s.priority, required: s.required,
      status: last?.status ?? 'unchecked', found: last?.found ?? [], message: last?.message ?? null, code: last?.code ?? null,
    };
  });
  const { managed, zoneId } = await zoneInfo(v);
  let ptr = stored.ptr;
  if (ptrCache && Date.now() - ptrCache.at < PTR_CACHE_MS) {
    try { ptr = await ptrCache.value; } catch { /* keep the stored one */ }
  }
  return {
    mailDomainId: v.id,
    domain: v.name,
    managed,
    zoneId,
    checkedAt: iso(row?.dns_checked_at ?? null),
    healthy: records.length > 0 && recordsHealthy(records),
    records,
    ptr,
  };
}

/** Live check of one mail domain; stores the result. */
async function runCheck(v: MailDomainView, ctx: MailPlatformContext, lookup: MailDnsLookup): Promise<void> {
  const specs = (await expectedRecordsOf([v], ctx)).get(v.id) ?? [];
  const records = await checkRecords(specs, lookup, { hasMailboxes: ctx.hasMailboxes, host: ctx.host, ipv4: ctx.ipv4, ipv6: ctx.ipv6 });
  let ptr: PtrPair = { ipv4: null, ipv6: null };
  try { ptr = await ptrCached(); } catch { /* PTR is a reminder only */ }
  const now = new Date();
  const healthy = records.length > 0 && recordsHealthy(records);
  const stored: StoredCheck = { checkedAt: now.toISOString(), records, ptr };
  await db('mail_domains').where({ id: v.id }).update({ dns_check: JSON.stringify(stored), dns_healthy: healthy, dns_checked_at: now });
  try {
    emitMail({ entity: 'dns', id: v.id, accountId: v.accountId, action: 'updated' }, { tenantId: v.tenantId, accountId: v.accountId });
  } catch { /* socket layer not ready (tests) */ }
}

async function viewOrThrow(id: number): Promise<MailDomainView> {
  const v = await mailDomainView(id);
  if (!v) throw new AppError(404, 'Mail domain not found', 'notFound');
  return v;
}

/** Periodic checks: domains never checked, or checked more than 6 h ago (bounded per scan). Never throws. */
export async function runPeriodicChecks(now = Date.now()): Promise<number> {
  if (scanRunning) return 0;
  scanRunning = true;
  let done = 0;
  try {
    const cutoff = new Date(now - PERIODIC_CHECK_AGE_MS);
    const ids = (await db('mail_domains').where((q) => q.whereNull('dns_checked_at').orWhere('dns_checked_at', '<', cutoff))
      .orderByRaw('dns_checked_at ASC NULLS FIRST').limit(CHECKS_PER_SCAN).select('id') as Array<{ id: number }>).map((r) => r.id);
    if (ids.length === 0) return 0;
    const ctx = await loadMailPlatformContext();
    const lookup = await mailDnsLookup();
    for (const v of await mailDomainViews((q) => q.whereIn('md.id', ids))) {
      try {
        await runCheck(v, ctx, lookup);
        done++;
      } catch (err) {
        logger.warn({ mailDomain: v.name, err: (err as Error)?.message }, 'mail dns: periodic check failed');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'mail dns: periodic check scan failed');
  } finally {
    scanRunning = false;
  }
  return done;
}

/** DKIM rotation pass with the real resolvers / zone lookup. Never throws. */
export async function runRotationPass(): Promise<void> {
  if (rotationRunning) return;
  rotationRunning = true;
  try {
    const lookup = await mailDnsLookup();
    await runDkimRotation({
      async visible(fqdn, publicKey) {
        return (await lookup.txt(fqdn)).some((t) => dkimPublicKeyOf(t) === publicKey);
      },
      async hostedActive(domain, accountId) {
        return (await zoneInfo({ name: domain, accountId })).managed;
      },
    });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'mail dns: DKIM rotation pass failed');
  } finally {
    rotationRunning = false;
  }
}

/** Tests. */
export function resetMailDnsStateForTests(): void {
  lastCheck.clear();
  ptrCache = null;
}

function inputError(err: MailDnsInputError): AppError {
  return new AppError(400, err.message, err.code, { field: err.field });
}

export const mailDnsService = {
  /** Expected records + last check (no network). */
  async status(actor: HostingActor, mailDomainId: number): Promise<MailDnsStatus> {
    await loadMailDomain(actor, mailDomainId, 'read');
    return buildStatus(await viewOrThrow(mailDomainId), await loadMailPlatformContext());
  },

  /** Live check through the public resolvers (heavyOpLimiter + 1 / 15 s / domain: 429 rateLimited). */
  async check(actor: HostingActor, mailDomainId: number): Promise<MailDnsStatus> {
    const md = await loadMailDomain(actor, mailDomainId, 'read');
    const now = Date.now();
    const last = lastCheck.get(md.id);
    if (last !== undefined && now - last < CHECK_INTERVAL_MS) {
      throw new AppError(429, 'A DNS check of this domain just ran: try again in a few seconds', 'rateLimited',
        { retryAfterSeconds: Math.ceil((CHECK_INTERVAL_MS - (now - last)) / 1000) });
    }
    lastCheck.set(md.id, now);
    const v = await viewOrThrow(md.id);
    const ctx = await loadMailPlatformContext();
    await runCheck(v, ctx, await mailDnsLookup());
    return buildStatus(v, ctx);
  },

  /** mail.manage. Validates (DMARC rua, SPF mechanisms, external records), audits `mail.dns.update`, resyncs the zone. */
  async update(req: Request, actor: HostingActor, mailDomainId: number, body: MailDomainDnsUpdate): Promise<MailDnsStatus> {
    const md = await loadMailDomain(actor, mailDomainId, 'mail.manage');
    const engine = await activeMailEngine();
    if (body.external !== undefined && mailEngineHasMailboxes(engine)) {
      throw new AppError(409, 'Provider records are only used with the external mail engine', 'externalOnly');
    }
    const current = parseDnsSettings(md.dns_settings);
    const next: MailDomainDnsSettings = { ...current };
    const s = body.settings ?? {};
    let external: unknown;
    try {
      if (s.spfExtra !== undefined) next.spfExtra = validateSpfExtra(s.spfExtra);
      if (s.dmarcRua !== undefined) {
        const rua = s.dmarcRua === null ? null : String(s.dmarcRua).trim().toLowerCase();
        if (rua !== null && !isValidReportAddress(rua)) throw new MailDnsInputError('invalidDmarcAddress', 'dmarcRua', 'Invalid DMARC report address');
        next.dmarcRua = rua;
      }
      if (s.dmarcPolicy !== undefined) next.dmarcPolicy = s.dmarcPolicy;
      if (s.mtaSts !== undefined) next.mtaSts = s.mtaSts;
      if (s.tlsRpt !== undefined) next.tlsRpt = s.tlsRpt;
      if (s.autoconfig !== undefined) next.autoconfig = s.autoconfig;
      if (s.srv !== undefined) next.srv = s.srv;
      if (s.dkimEd25519 !== undefined) next.dkimEd25519 = s.dkimEd25519;
      if (body.external !== undefined) external = body.external === null ? null : validateExternalConfig(md.name, body.external);
    } catch (err) {
      if (err instanceof MailDnsInputError) throw inputError(err);
      throw err;
    }
    const patch: Record<string, unknown> = { dns_settings: JSON.stringify(next), updated_at: db.fn.now() };
    if (body.external !== undefined) patch.external_dns = external === null ? null : JSON.stringify(external);
    await db('mail_domains').where({ id: md.id, account_id: md.account_id }).update(patch);
    await auditService.logReqAs(req, md.tenant_id, 'mail.dns.update', {
      resourceType: 'mailDomain', resourcePath: String(md.id),
      details: { domain: md.name, accountId: md.account_id, fields: Object.keys(s), external: body.external !== undefined },
    });

    // ed25519 switched (effective value: domain setting, else platform default).
    const platformEd = (await platformSettings.section('mail')).dkimEd25519;
    const before = current.dkimEd25519 ?? platformEd;
    const after = next.dkimEd25519 ?? platformEd;
    if (before !== after && mailEngineHasMailboxes(engine)) {
      try {
        if (after) await dkimService.ensureForDomain(md.id);
        else await retireAlgorithm(md.id, 'ed25519');
      } catch (err) {
        logger.warn({ mailDomain: md.name, err: (err as Error)?.message }, 'mail dns: ed25519 key change failed (next rotation pass retries)');
      }
    }
    try {
      emitMail({ entity: 'dns', id: md.id, accountId: md.account_id, action: 'updated' }, { tenantId: md.tenant_id, accountId: md.account_id });
    } catch { /* socket layer not ready (tests) */ }
    mailDnsService.domainChanged(md.id, md.domain_id, 'dns-settings');
    import('../mail.service').then(({ mailService }) => mailService.requestSync('dns-settings')).catch(() => undefined);
    return buildStatus(await viewOrThrow(md.id), await loadMailPlatformContext());
  },

  /** PTR of the node addresses (public_ipv4 / public_ipv6) vs the mail host name (cached 1 h). */
  async ptrStatus(): Promise<{ ipv4: MailPtrCheck | null; ipv6: MailPtrCheck | null }> {
    return ptrCached();
  },

  // ── hooks (never throw) ──
  /** Mail domain created / changed / deleted: zone records, edge vhosts, certificates. */
  domainChanged(mailDomainId: number | null, domainId: number, reason: string): void {
    safeHook('domainChanged', () => {
      if (mailDomainId !== null) lastCheck.delete(mailDomainId);
      import('../../dns/dns.service')
        .then(({ dnsService }) => dnsService.domainChanged(domainId, 'mail'))
        .catch((err) => logger.warn({ err: (err as Error)?.message, reason }, 'mail dns: zone resync request failed'));
      import('../../edge/edge.service')
        .then(({ edgeService }) => edgeService.scheduleSync(`mail:${reason}`))
        .catch((err) => logger.warn({ err: (err as Error)?.message, reason }, 'mail dns: edge resync request failed'));
    });
  },

  settingsChanged(): void {
    safeHook('settingsChanged', () => {
      // Mail host name / node addresses may have changed: PTR recomputed on demand,
      // keys of a newly wanted algorithm created soon (zone + edge resync: notifyMailSettingsChanged).
      ptrCache = null;
      if (timers.length) {
        const t = setTimeout(() => { void runRotationPass(); }, 5_000);
        t.unref?.();
      }
    });
  },

  start(): void {
    try {
      if (timers.length) return;
      registerZoneRecordContributor(mailZoneContributor);
      registerEdgeContributor(mailEdgeContributor);
      // Zones and vhosts written before the contributors existed (boot) follow them.
      import('../../dns/dns.service').then(({ dnsService }) => dnsService.requestSyncAll('mail contributor')).catch(() => undefined);
      import('../../edge/edge.service').then(({ edgeService }) => edgeService.scheduleSync('mail contributor')).catch(() => undefined);
      const boot = setTimeout(() => {
        void runRotationPass();
        void runPeriodicChecks();
        import('../tls/mailTls.service').then(({ mailTlsService }) => mailTlsService.certificates()).catch(() => undefined);
      }, BOOT_DELAY_MS);
      const rotation = setInterval(() => { void runRotationPass(); }, ROTATION_MS);
      const checks = setInterval(() => { void runPeriodicChecks(); }, CHECK_SCAN_MS);
      timers = [boot, rotation, checks];
      for (const t of timers) t.unref?.();
    } catch (err) {
      logger.error({ err: (err as Error)?.message }, 'mail dns worker failed to start');
    }
  },

  stop(): void {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
    try {
      unregisterZoneRecordContributor(mailZoneContributor.id);
      unregisterEdgeContributor(mailEdgeContributor.id);
    } catch { /* never throws */ }
  },
};
