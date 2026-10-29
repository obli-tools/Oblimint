import { HostingSocketEvents, type DnsZoneKind } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { withLock } from '../docker/locks';
import { emitHosting } from '../hosting/events';
import { notify } from '../usage/notifications.service';
import { pdns, PdnsError, type PdnsClient } from './pdnsClient';
import {
  buildRrsets, diffRrsets, inZone, nextSerial, publicationOf, soaRname, soaSerialOf, type Rrset,
} from './records';
import { pendingZoneDecisionForZone, pendingZoneRefusalLabel } from './pendingZone';
import {
  domainRow, insertZone, loadContext, regenerateAuto, soaPrimary, zoneById, zoneForName, zoneRecords, zoneVerified,
  type DnsContext, type ZoneRow,
} from './store';

// ─────────────────────────────────────────────────────────────────────────────
// Projection of the panel DB onto PowerDNS (module dns, docs/P2-PLAN.md §9.1).
//
// syncZone(id): regenerates the auto records, applies the publication rule
// D1, then makes PowerDNS hold exactly the rrsets rendered from dns_records
// (+ SOA / apex NS from the settings): create, or PATCH the differences only
// (idempotent: nothing sent when nothing changed), serial YYYYMMDDnn bumped
// only on a real change, AXFR / NOTIFY metadata, DNSSEC keys. The own zone of
// an unverified domain may be served as a PENDING zone (SOA + NS only,
// pendingZone.ts; dns_zones.served tells what is served). Failure →
// status 'error' + status_message ("<label> : <cause>") + notify
// dns.syncFailed + DNS_ZONE_UPDATED.
//
// Queue: the hooks (domain events, request*) only enqueue; a debounced
// (1 s), serialized flush processes them once the worker started (start()).
// A full pass (boot + hourly + settings change) also deletes from PowerDNS
// the zones that must not be served anymore (deleted, unverified, external).
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 1_000;
const AXFR_META = 'ALLOW-AXFR-FROM';
const NOTIFY_META = 'ALSO-NOTIFY';
const SYNC_LABEL = 'Échec de la synchronisation DNS';
const UNREACHABLE_LABEL = 'Serveur DNS injoignable';

export interface ZoneSyncResult {
  ok: boolean;
  /** Published to PowerDNS after the pass. */
  published: boolean;
  changed: boolean;
  error: string | null;
}

export const syncState = {
  lastSyncAt: null as Date | null,
  lastSyncError: null as string | null,
};

function zoneLockKey(zoneId: number): string {
  return `dns:zone:${zoneId}`;
}

function errText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

function emitZone(zone: Pick<ZoneRow, 'id' | 'domain_id' | 'account_id' | 'tenant_id'>): void {
  emitHosting(HostingSocketEvents.DNS_ZONE_UPDATED, { zoneId: zone.id, domainId: zone.domain_id, accountId: zone.account_id },
    { tenantId: zone.tenant_id, accountId: zone.account_id });
}

async function setStatus(zone: ZoneRow, status: ZoneRow['status'], message: string | null, extra: Record<string, unknown> = {}): Promise<boolean> {
  const changed = zone.status !== status || (zone.status_message ?? null) !== (message ?? null);
  if (!changed && Object.keys(extra).length === 0) return false;
  await db('dns_zones').where({ id: zone.id }).update({ status, status_message: message, ...extra, updated_at: db.fn.now() });
  return changed;
}

/** Zone kind on PowerDNS: Master (sends NOTIFY to ALSO-NOTIFY) when secondaries are configured. */
function pdnsKind(ctx: DnsContext): 'Native' | 'Master' {
  return ctx.settings.alsoNotify.length > 0 ? 'Master' : 'Native';
}

/** Keeps the AXFR / NOTIFY metadata of the zone in line with the settings (only writes differences). */
async function syncMetadata(client: PdnsClient, name: string, ctx: DnsContext): Promise<boolean> {
  let changed = false;
  for (const [kind, wanted] of [[AXFR_META, ctx.settings.axfrAllowFrom], [NOTIFY_META, ctx.settings.alsoNotify]] as const) {
    const current = await client.getMetadata(name, kind);
    const a = [...current].sort().join(',');
    const b = [...wanted].sort().join(',');
    if (a !== b) {
      await client.setMetadata(name, kind, [...wanted]);
      changed = true;
    }
  }
  return changed;
}

/** DNSSEC keys follow zone.dnssec: one active CSK when on, none when off. */
async function syncDnssec(client: PdnsClient, name: string, enabled: boolean): Promise<boolean> {
  const keys = await client.listCryptokeys(name);
  if (enabled && !keys.some((k) => k.active)) {
    await client.createCryptokey(name);
    return true;
  }
  if (!enabled && keys.length) {
    for (const k of keys) await client.deleteCryptokey(name, k.id);
    return true;
  }
  return false;
}

/** Cache flush after a change: best effort (the cached answers expire anyway). */
async function flushZoneCache(client: PdnsClient, name: string): Promise<void> {
  await client.flushCache(name).catch((err) => logger.warn({ zone: name, err: errText(err) }, 'dns: cache flush failed'));
}

/** Removes the zone from PowerDNS (not served). Errors only matter when the server is supposed to run. */
async function unpublish(name: string, ctx: DnsContext): Promise<void> {
  try {
    const client = await pdns();
    if (await client.deleteZone(name)) await flushZoneCache(client, name);
  } catch (err) {
    if (ctx.settings.enabled && !(err instanceof PdnsError && err.status === 0)) throw err;
  }
}

/**
 * Publication rule D1 for one zone row (records.publicationOf on the live
 * account / domain state). The own zone of an unverified domain may be served
 * as a pending zone (pendingZone.ts: SOA + NS only, guarded).
 */
async function publicationFor(zone: ZoneRow, ctx: DnsContext): Promise<ReturnType<typeof publicationOf>> {
  const account = zone.account_id !== null
    ? await db('hosting_accounts').where({ id: zone.account_id }).first('status') as { status: string } | undefined
    : undefined;
  const verified = await zoneVerified(zone);
  let pendingZone: { allowed: boolean; refusal: string | null } | undefined;
  if (!verified && zone.account_id !== null && zone.domain_id && zone.kind === 'hosted' && ctx.settings.enabled && account?.status !== 'deleting') {
    const d = await pendingZoneDecisionForZone(zone, ctx, account?.status ?? null);
    pendingZone = { allowed: d.allowed, refusal: pendingZoneRefusalLabel(d.reason) };
  }
  return publicationOf({
    kind: zone.kind,
    accountId: zone.account_id,
    accountStatus: account?.status ?? null,
    verified,
    dnsEnabled: ctx.settings.enabled,
    pendingZone,
  });
}

async function syncZoneInner(zoneId: number, reason: string, ctxIn?: DnsContext): Promise<ZoneSyncResult> {
  const zone = await zoneById(zoneId);
  if (!zone) return { ok: true, published: false, changed: false, error: null };
  const ctx = ctxIn ?? await loadContext();
  const autoChanged = await regenerateAuto(zone, ctx);
  const pub = await publicationFor(zone, ctx);

  if (!pub.publish) {
    if (zone.dnssec && zone.kind === 'hosted' && zone.status === 'active') {
      // PowerDNS drops the keys with the zone: the next publication creates new ones (new DS at the registrar).
      logger.warn({ zone: zone.name, cause: pub.message }, 'dns: unpublishing a DNSSEC zone, its keys are destroyed (the DS must be updated after republication)');
    }
    try {
      await unpublish(zone.name, ctx);
    } catch (err) {
      return failZone(zone, err, reason);
    }
    const wasServed = (zone.served ?? null) !== null;
    const changed = await setStatus(zone, pub.status ?? 'pending', pub.message, wasServed ? { served: null } : {});
    if (changed || autoChanged || wasServed) emitZone(zone);
    if (wasServed) logger.info({ zone: zone.name, reason, cause: pub.message }, 'dns: zone removed from PowerDNS');
    return { ok: true, published: false, changed: changed || wasServed, error: null };
  }

  // Pending zone (domain not verified yet): SOA + apex NS only, never signed.
  const pending = pub.mode === 'pending';
  try {
    const client = await pdns();
    const records = await zoneRecords(zone.id);
    const render = (serial: number): Rrset[] => buildRrsets({
      zone: zone.name,
      serial,
      mname: soaPrimary(ctx, zone.name),
      rname: soaRname(ctx.settings.hostmasterEmail, zone.name),
      nameservers: ctx.settings.nameservers,
      defaultTtl: zone.default_ttl,
      records: records.map((r) => ({ ...r, expiresAt: r.expires_at })),
      pending,
    });
    const dbSerial = Number(zone.serial);
    const current = await client.getZone(zone.name);
    let changed = false;
    if (!current) {
      const serial = nextSerial(dbSerial);
      await client.createZone({ name: zone.name, kind: pdnsKind(ctx), rrsets: render(serial) });
      await db('dns_zones').where({ id: zone.id }).update({ serial });
      changed = true;
    } else {
      const served = soaSerialOf(current.rrsets);
      const diff = diffRrsets(current.rrsets, render(dbSerial));
      if (diff.replace.length || diff.remove.length) {
        const serial = nextSerial(Math.max(dbSerial, served));
        // Serial compared here: the bumped SOA must travel with the changes
        // (the detection diff above ignores it on purpose).
        const final = diffRrsets(current.rrsets, render(serial), { compareSerial: true });
        await client.patchRrsets(zone.name, final.replace, final.remove);
        await db('dns_zones').where({ id: zone.id }).update({ serial });
        changed = true;
      } else if (served !== dbSerial) {
        // Content identical but the served serial and the stored one diverge
        // (e.g. a zone patched before the SOA travelled with the changes):
        // converge on the higher one, never going back.
        const serial = Math.max(dbSerial, served);
        if (served < serial) {
          const final = diffRrsets(current.rrsets, render(serial), { compareSerial: true });
          await client.patchRrsets(zone.name, final.replace, final.remove);
          changed = true;
        }
        if (dbSerial < serial) await db('dns_zones').where({ id: zone.id }).update({ serial });
      }
      const kind = pdnsKind(ctx);
      if (current.kind && current.kind !== kind) await client.setKind(zone.name, kind);
    }
    const metaChanged = await syncMetadata(client, zone.name, ctx);
    // DNSSEC keys only for a full zone: the pending one is never signed (the
    // keys of the full zone are created once the domain is verified).
    const keysChanged = await syncDnssec(client, zone.name, !pending && !!zone.dnssec);
    if (keysChanged) await client.rectify(zone.name);
    // A zone just created (published after its verification) or changed:
    // answers cached before (REFUSED, NXDOMAIN, old rrsets) are dropped now.
    if (changed || keysChanged || metaChanged) await flushZoneCache(client, zone.name);
    if ((changed || metaChanged) && ctx.settings.alsoNotify.length) {
      await client.notify(zone.name).catch((err) => logger.warn({ zone: zone.name, err: errText(err) }, 'dns: NOTIFY failed'));
    }
    const served = pending ? 'pending' : 'full';
    const servedChanged = (zone.served ?? null) !== served;
    const statusChanged = pending
      ? await setStatus(zone, 'pending', pub.message, { last_synced_at: db.fn.now(), served })
      : await setStatus(zone, 'active', null, { last_synced_at: db.fn.now(), served });
    if (statusChanged || servedChanged || changed || autoChanged || keysChanged) emitZone(zone);
    if (changed) logger.info({ zone: zone.name, reason, served }, pending ? 'dns: pending zone (SOA + NS) pushed to PowerDNS' : 'dns: zone pushed to PowerDNS');
    return { ok: true, published: true, changed: changed || keysChanged || metaChanged, error: null };
  } catch (err) {
    return failZone(zone, err, reason);
  }
}

async function failZone(zone: ZoneRow, err: unknown, reason: string): Promise<ZoneSyncResult> {
  const cause = errText(err);
  const label = err instanceof PdnsError && err.status === 0 ? UNREACHABLE_LABEL : SYNC_LABEL;
  const message = `${label} : ${cause}`.slice(0, 1000);
  logger.warn({ zone: zone.name, reason, err: cause }, 'dns: zone sync failed');
  try {
    const wasError = zone.status === 'error';
    await setStatus(zone, 'error', message);
    emitZone(zone);
    if (!wasError) {
      notify('dns.syncFailed', {
        tenantId: zone.tenant_id,
        accountId: zone.account_id,
        key: `dns:sync:${zone.id}`,
        title: `Zone DNS ${zone.name} : échec de synchronisation`,
        message: `La zone ${zone.name} n'a pas pu être publiée sur le serveur DNS.\n${message}`,
        severity: 'warning',
        platform: true,
        link: `/dns/zones/${zone.id}`,
      });
    }
  } catch (e) {
    logger.error({ zone: zone.name, err: errText(e) }, 'dns: could not record the sync failure');
  }
  return { ok: false, published: false, changed: false, error: cause };
}

/** Syncs one zone now (serialized per zone). Never throws: the result carries the error. */
export async function syncZone(zoneId: number, reason: string, ctx?: DnsContext): Promise<ZoneSyncResult> {
  return withLock(zoneLockKey(zoneId), async () => {
    try {
      return await syncZoneInner(zoneId, reason, ctx);
    } catch (err) {
      logger.error({ zoneId, reason, err: errText(err) }, 'dns: zone sync crashed');
      return { ok: false, published: false, changed: false, error: errText(err) };
    }
  });
}

/**
 * Full pass: every zone, then the PowerDNS zones the panel does not serve
 * (deleted rows, cascaded account deletions) are removed. Never throws.
 */
export async function syncAll(reason: string): Promise<{ ok: boolean; error: string | null }> {
  let firstError: string | null = null;
  try {
    const ctx = await loadContext();
    try {
      // Recovery of lost domainDeleted hooks (in-memory queue): zones nothing covers anymore.
      await dropUncoveredZones({});
    } catch (err) {
      firstError ??= errText(err);
    }
    const ids = (await db('dns_zones').orderBy('id').select('id') as Array<{ id: number }>).map((r) => r.id);
    for (const id of ids) {
      const r = await syncZone(id, reason, ctx);
      if (!r.ok && !firstError) firstError = r.error;
    }
    if (ctx.settings.enabled) {
      try {
        const client = await pdns();
        for (const z of await client.listZones()) {
          // Decided per zone AFTER listZones, under the zone lock (serialized with any direct
          // syncZone of it: ACME, DNSSEC). A zone D1 publishes stays served even when its last
          // sync failed (status 'error': deleting it would take the domain down and destroy its
          // DNSSEC keys); only names without a row, or rows D1 does not publish, are removed.
          if (await shouldServe(z.name, ctx)) continue;
          logger.info({ zone: z.name }, 'dns: removing a zone the panel does not serve');
          if (await client.deleteZone(z.name)) await flushZoneCache(client, z.name);
        }
      } catch (err) {
        firstError ??= errText(err);
      }
    }
  } catch (err) {
    firstError ??= errText(err);
    logger.error({ reason, err: firstError }, 'dns: full sync failed');
  }
  syncState.lastSyncAt = new Date();
  syncState.lastSyncError = firstError;
  return { ok: !firstError, error: firstError };
}

/** Whether PowerDNS must keep serving `pdnsName` (trailing dot) according to the panel DB (rule D1). */
async function shouldServe(pdnsName: string, ctx: DnsContext): Promise<boolean> {
  const name = pdnsName.toLowerCase().replace(/\.$/, '');
  const row = await db('dns_zones').where({ name }).first('id') as { id: number } | undefined;
  if (!row) return false;
  return withLock(zoneLockKey(row.id), async () => {
    const zone = await zoneById(row.id);
    if (!zone) return false;
    return (await publicationFor(zone, ctx)).publish;
  });
}

/**
 * Account zones that no domain of their account covers anymore (domain
 * deleted or reclaimed, hook lost in a restart or not yet run): the row is
 * removed (it would block the name with zoneExists) and the zone dropped
 * from PowerDNS. `below`: only that name and the names under it;
 * `accountId`: only that account.
 */
async function dropUncoveredZones(opts: { accountId?: number; below?: string }): Promise<number> {
  const zq = db('dns_zones').whereNotNull('account_id').whereNull('domain_id').select('id', 'name', 'account_id', 'tenant_id');
  if (opts.accountId !== undefined) zq.where({ account_id: opts.accountId });
  const zones = (await zq as Array<{ id: number; name: string; account_id: number; tenant_id: number }>)
    .filter((z) => !opts.below || inZone(z.name, opts.below));
  if (!zones.length) return 0;
  const accountIds = [...new Set(zones.map((z) => z.account_id))];
  const domains = await db('domains').whereIn('account_id', accountIds).select('name', 'account_id') as Array<{ name: string; account_id: number }>;
  let dropped = 0;
  for (const z of zones) {
    if (domains.some((d) => d.account_id === z.account_id && inZone(z.name, d.name.toLowerCase()))) continue;
    const n = await db('dns_zones').where({ id: z.id, account_id: z.account_id }).whereNull('domain_id').delete();
    if (!n) continue;
    queue.remove(z.name);
    emitZone({ id: z.id, domain_id: null, account_id: z.account_id, tenant_id: z.tenant_id });
    logger.info({ zone: z.name }, 'dns: zone removed, no domain of its account covers it anymore');
    dropped++;
  }
  return dropped;
}

/** Deletes expired system records (ACME / ownership challenges); returns the zones touched. */
export async function purgeExpired(): Promise<number[]> {
  const rows = await db('dns_records').where({ origin: 'system' }).andWhere('expires_at', '<', db.fn.now()).select('id', 'zone_id') as Array<{ id: number; zone_id: number }>;
  if (!rows.length) return [];
  await db('dns_records').whereIn('id', rows.map((r) => r.id)).delete();
  return [...new Set(rows.map((r) => r.zone_id))];
}

// ── domain hooks ─────────────────────────────────────────────────────────────

/** Zone of the account under which a `subdomain` domain lives (closest parent), if any. */
async function parentZoneOf(name: string, accountId: number): Promise<ZoneRow | null> {
  const parent = name.split('.').slice(1).join('.');
  if (!parent.includes('.')) return null;
  return zoneForName(parent, accountId);
}

/**
 * Zones of the account involved by a change of domain `name`: its own zone,
 * its parents (records of the name) and the zones below it (D1 of a manual
 * child zone follows its covering domain, store.zoneVerified).
 */
async function zonesInvolving(name: string, accountId: number): Promise<number[]> {
  const rows = await db('dns_zones').where({ account_id: accountId }).select('id', 'name') as Array<{ id: number; name: string }>;
  return rows.filter((z) => inZone(name, z.name) || inZone(z.name, name)).map((z) => z.id);
}

/**
 * Zones of OTHER accounts related to `name` (the name, its parents, the names
 * below it): the pending zone guard of each depends on this account's domains
 * (pendingZone.ts), so they are re-synced when one of them appears, changes
 * verification or goes — not only at the next full pass.
 */
async function foreignZonesRelatedTo(name: string, accountId: number): Promise<number[]> {
  const n = name.toLowerCase();
  const labels = n.split('.');
  const names: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) names.push(labels.slice(i).join('.'));
  const rows = await db('dns_zones')
    .where((b) => { b.whereIn('name', names).orWhere('name', 'like', `%.${n.replace(/[\\%_]/g, (c) => `\\${c}`)}`); })
    .whereNotNull('account_id').whereNot('account_id', accountId)
    .select('id', 'name') as Array<{ id: number; name: string }>;
  return rows.filter((z) => inZone(n, z.name) || inZone(z.name, n)).map((z) => z.id);
}

async function queueForeignRelated(name: string, accountId: number, reason: string): Promise<void> {
  try {
    for (const id of await foreignZonesRelatedTo(name, accountId)) queue.zone(id, `related:${reason}`);
  } catch (err) {
    logger.warn({ name, err: errText(err) }, 'dns: related zones lookup failed (the next full pass catches up)');
  }
}

export async function handleDomainCreated(domainId: number, wanted: DnsZoneKind | 'none' | undefined): Promise<void> {
  const domain = await domainRow(domainId);
  if (!domain) return;
  await queueForeignRelated(domain.name, domain.account_id, 'domain-created');
  if (domain.kind === 'subdomain' || wanted === 'none') {
    const parent = await parentZoneOf(domain.name, domain.account_id);
    if (parent) { queue.zone(parent.id, 'subdomain-created'); return; }
    if (wanted === 'none') return;
  }
  const existing = await db('dns_zones').where({ name: domain.name }).first('id', 'account_id', 'domain_id') as
    { id: number; account_id: number | null; domain_id: number | null } | undefined;
  if (existing) {
    if (existing.account_id === domain.account_id && existing.domain_id === null) {
      await db('dns_zones').where({ id: existing.id }).update({ domain_id: domain.id, updated_at: db.fn.now() });
      queue.zone(existing.id, 'domain-linked');
    } else {
      logger.warn({ domain: domain.name }, 'dns: a zone with this name already exists elsewhere: no zone created');
    }
    return;
  }
  const ctx = await loadContext();
  const kind: DnsZoneKind = wanted === 'external' || !ctx.settings.enabled ? 'external' : 'hosted';
  const zone = await db.transaction((trx) => insertZone(trx, {
    tenantId: domain.tenant_id, accountId: domain.account_id, domainId: domain.id, name: domain.name, kind, templateId: null,
  }, ctx));
  logger.info({ zone: zone.name, kind }, 'dns: zone created for a new domain');
  emitZone(zone);
  // Subdomains already attached to a parent zone now belong to this one.
  for (const id of await zonesInvolving(domain.name, domain.account_id)) queue.zone(id, 'domain-created');
}

export async function handleDomainChanged(domainId: number, reason: string): Promise<void> {
  const domain = await domainRow(domainId);
  if (!domain) return;
  for (const id of await zonesInvolving(domain.name, domain.account_id)) queue.zone(id, `domain:${reason}`);
  await queueForeignRelated(domain.name, domain.account_id, `domain:${reason}`);
}

export async function handleDomainDeleted(d: { id: number; name: string; accountId: number; tenantId: number }): Promise<void> {
  const name = d.name.toLowerCase();
  const zone = await db('dns_zones').where({ name, account_id: d.accountId }).first('id', 'domain_id', 'tenant_id', 'account_id') as
    { id: number; domain_id: number | null; tenant_id: number; account_id: number } | undefined;
  if (zone && (zone.domain_id === null || zone.domain_id === d.id)) {
    await db('dns_zones').where({ id: zone.id }).delete();
    queue.remove(name);
    emitZone({ id: zone.id, domain_id: null, account_id: zone.account_id, tenant_id: zone.tenant_id });
    logger.info({ zone: name }, 'dns: zone of a deleted domain removed');
  }
  // Child zones (shop.example.com) that no other domain of the account covers go too:
  // otherwise they would keep shadowing a new holder of the name and block it with zoneExists.
  await dropUncoveredZones({ accountId: d.accountId, below: name });
  for (const id of await zonesInvolving(name, d.accountId)) queue.zone(id, 'domain-deleted');
  await queueForeignRelated(name, d.accountId, 'domain-deleted');
}

/** The account changed status (suspension, 'deleting', back from error): its zones follow D1. */
export async function handleAccountChanged(accountId: number, reason: string): Promise<void> {
  const rows = await db('dns_zones').where({ account_id: accountId }).select('id') as Array<{ id: number }>;
  for (const r of rows) queue.zone(r.id, `account:${reason}`);
}

// ── queue ────────────────────────────────────────────────────────────────────

type Job = () => Promise<void>;

const q = {
  jobs: [] as Job[],
  zones: new Map<number, string>(),
  removals: new Set<string>(),
  all: null as string | null,
  timer: null as NodeJS.Timeout | null,
  running: null as Promise<void> | null,
  again: false,
  active: false,
};

function schedule(): void {
  if (!q.active || q.timer) return;
  q.timer = setTimeout(() => {
    q.timer = null;
    void flush();
  }, DEBOUNCE_MS);
  q.timer.unref?.();
}

async function runOnce(): Promise<void> {
  const jobs = q.jobs.splice(0);
  for (const job of jobs) {
    try { await job(); } catch (err) { logger.warn({ err: errText(err) }, 'dns: queued job failed'); }
  }
  const removals = [...q.removals];
  q.removals.clear();
  for (const name of removals) {
    // A zone recreated meanwhile under the same name is served again by its own sync.
    const back = await db('dns_zones').where({ name }).first('id').catch(() => undefined);
    if (back) continue;
    try {
      const client = await pdns();
      if (await client.deleteZone(name)) await flushZoneCache(client, name);
    } catch (err) {
      if (!(err instanceof PdnsError && err.status === 0)) logger.warn({ zone: name, err: errText(err) }, 'dns: zone removal failed');
    }
  }
  const all = q.all;
  q.all = null;
  if (all) {
    q.zones.clear();
    await syncAll(all);
    return;
  }
  const zones = [...q.zones.entries()];
  q.zones.clear();
  if (!zones.length) return;
  const ctx = await loadContext();
  for (const [id, reason] of zones) await syncZone(id, reason, ctx);
}

/** Processes everything queued (serialized; a call during a run makes the run loop once more). */
export function flush(): Promise<void> {
  if (q.running) {
    q.again = true;
    return q.running;
  }
  q.running = (async () => {
    do {
      q.again = false;
      try { await runOnce(); } catch (err) { logger.error({ err: errText(err) }, 'dns: queue run failed'); }
    } while (q.again || q.jobs.length || q.zones.size || q.removals.size || q.all);
  })().finally(() => { q.running = null; });
  return q.running;
}

export const queue = {
  job(job: Job): void { q.jobs.push(job); schedule(); },
  zone(zoneId: number, reason: string): void { if (Number.isInteger(zoneId) && zoneId > 0) { q.zones.set(zoneId, reason); schedule(); } },
  all(reason: string): void { q.all = reason; schedule(); },
  remove(name: string): void { q.removals.add(name); schedule(); },
  /** Worker started: queued work is processed (debounced). */
  activate(): void { q.active = true; if (q.jobs.length || q.zones.size || q.removals.size || q.all) schedule(); },
  deactivate(): void {
    q.active = false;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
  },
  /** Tests: process everything queued now, whatever the worker state. */
  async drain(): Promise<void> {
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    await flush();
  },
  pending(): number { return q.jobs.length + q.zones.size + q.removals.size + (q.all ? 1 : 0); },
  /** Worker started and work queued or running (dnsService.settle). */
  busy(): boolean { return q.active && (!!q.running || queue.pending() > 0); },
};
