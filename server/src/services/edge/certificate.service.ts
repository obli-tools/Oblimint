import type { Knex } from 'knex';
import type {
  CertificateDetail, CertificateLogLine, HostingAccount, PlatformCertificateItem, PlatformCertificatesView, PlatformHostRole,
} from '@oblimint/shared';
import { HostingSocketEvents, MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { dns01Provider, type Dns01Provider } from '../dns/acmeChallenge';
import { localNodeId } from '../docker/engine';
import { emitHosting } from '../hosting/events';
import { wildcardCoversPlatform } from '../hosting/hostingValidation.service';
import { EDGE_CONTAINER, previewHost } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { iso, json, toCertificateSummary, type CertificateRow } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { notify } from '../usage/notifications.service';
import {
  defaultAcmeClientFactory, httpSelfTest, isHttp01Failure, isPublicAcmeName, issueCertificate, removeCertificateFiles, type AcmeClientFactory,
} from './acmeIssuer';
import {
  certificateLogView, certificateSummaryView, clientCertificateError, type CertificateViewer, type StoredCertificateLogLine,
} from './certificateMessages';
import { certFilesExist, edgeService, loadPlatformHosts } from './edge.service';
import { announceCertificateInstalled, collectCertificateWishes } from './contributors';
import { isValidServerName } from './nginxConfig';
import {
  backoffEndsAt, inBackoff, isUsable, issuerFor, issuerOutdated, MANUAL_COOLDOWN_MS, needsIssuance, nextAttemptAt, planRenewals,
  PLATFORM_RETRY_COOLDOWN_MS, sameNames, type CertIssuer, type ScheduleRow,
} from './renewal';
import { isReservedPlatformName, platformHostNames, SERVED_ACCOUNT_STATUSES, type PlatformHosts } from './vhostPlan';

// ─────────────────────────────────────────────────────────────────────────────
// Let's Encrypt certificates of the edge (docs/P1-PLAN.md §11, P2-PLAN §9.2).
// OWNED BY MODULE `edge-ownership` (P2). The ACME protocol itself is in
// acmeIssuer.ts (persistent account key, dates read from the certificate,
// staging option, HTTP-01 + DNS-01); this file owns the `certificates` rows,
// the issuance queue and the renewal worker.
//
// Three kinds of certificates (one row each, primary_name unique):
//   domain    domain_id set — names = [name] (+ www.name when include_www);
//             a wildcard domain: [name, *.name] by DNS-01 (www is covered by
//             *.name — Let's Encrypt refuses a name redundant with a wildcard
//             of the same order); ONLY for a VERIFIED domain (invariant D1:
//             an unverified domain is never queued, an explicit request is
//             refused with 409 domainNotVerified);
//   preview   site_id set, domain_id null — previewHost(site, preview domain);
//             none when the preview domain is not configured;
//   platform  both null — the panel, the DB admin host, the IP probe hosts,
//             and the optional wildcard [previewDomain, *.previewDomain]
//             (DNS-01, settings preview.wildcardCertificate) which then
//             replaces the per-preview rows. Never issued to a tenant.
// Rows no longer wanted (P1 previews under .preview.<panel>, a host name
// removed from the settings, a preview removed) are swept by the renewal pass.
// Issuances run ONE AT A TIME (queue), a name already queued is not queued
// twice. A renewal of a still-valid certificate never downgrades the row: it
// stays 'valid' (the edge keeps serving it) and only last_error / log /
// failure_count record the failed attempt, with an alert (audit
// `certificate.renewal_failed` + log + socket event). The row's `names` are
// what the certificate on disk COVERS: on a still-valid row they only change
// when the new certificate is installed (a failed www addition keeps the old
// names, so the renewal pass retries it after the backoff).
// Manual requests (POST renew) are rate limited: MANUAL_COOLDOWN_MS between
// two attempts, and for clients the failure backoff applies and `force` on a
// certificate that does not need renewal is refused (shared queue + shared
// Let's Encrypt account limits).
// Retries: a failed attempt arms a timer at the end of its backoff (renewal.ts;
// short first retries for a platform host name never issued), so the retry
// does not wait for the next 12-hourly pass; the pass re-arms them after a
// restart. Platform host names (Settings): listPlatform() shows each one's
// state, retryPlatform() (staff « retry now ») resets the backoff of one; an
// issuance for such a name first waits for the pending DNS push (its A / AAAA
// record, set with the host name), and their first failure / their
// certificate notify the platform channels (certificate.failed / issued).
// ─────────────────────────────────────────────────────────────────────────────

const LOG_CAP = 200;
const RENEWAL_FIRST_DELAY_MS = 2 * 60_000;
const RENEWAL_INTERVAL_MS = 12 * 3600_000;
/** Overall deadline of ONE issuance: the queue is serial, a hung one would block every tenant's renewals. */
const ISSUANCE_DEADLINE_MS = 10 * 60_000;

type CertKind = 'domain' | 'preview' | 'platform';

interface CertTarget {
  kind: CertKind;
  domainId: number | null;
  siteId: number | null;
  /** names[0] = primary_name (never a wildcard). */
  names: string[];
  /** Solve by DNS-01 (wildcard orders). */
  preferDns01: boolean;
  /** Audit / socket scope. */
  tenantId: number;
  accountId: number | null;
  /** One of the platform's OWN host names (panel, client space, DB admin, probes, mail / webmail host, preview wildcard). */
  platformOwn?: boolean;
}

/** Injectable for tests (fake ACME client, fake DNS-01 solver, no network). */
const deps: {
  createClient: AcmeClientFactory;
  selfTest: ReturnType<typeof httpSelfTest> | undefined;
  createCertificateKey: (() => Promise<Buffer | string>) | undefined;
  deadlineMs: number;
  dns01: Dns01Provider;
  /** Waits for the pending DNS pushes (bounded, never throws): dnsService.settle. */
  settleDns: () => Promise<void>;
} = {
  createClient: defaultAcmeClientFactory,
  selfTest: httpSelfTest(EDGE_CONTAINER),
  createCertificateKey: undefined,
  deadlineMs: ISSUANCE_DEADLINE_MS,
  dns01: dns01Provider,
  settleDns: async () => {
    try { await (await import('../dns/dns.service')).dnsService.settle(); } catch { /* DNS module unavailable: issue anyway */ }
  },
};

const queue: { chain: Promise<unknown>; byTarget: Map<string, Promise<void>> } = { chain: Promise.resolve(), byTarget: new Map() };

/**
 * Queue identity of a target: its row (domain / preview site), never its
 * primary name alone — two rows may share a name across a reclaim (holder's
 * issuance in flight, claimer's queued after it, each with its own row).
 */
function queueKey(t: Pick<CertTarget, 'kind' | 'domainId' | 'siteId' | 'names'>): string {
  if (t.kind === 'domain') return `domain:${t.domainId}`;
  if (t.kind === 'preview') return `preview:${t.siteId}`;
  return `platform:${t.names[0]}`;
}

const timers: { first: NodeJS.Timeout | null; interval: NodeJS.Timeout | null } = { first: null, interval: null };
/** One timer per failing certificate row: the retry at the end of its backoff (worker started only). */
const retryTimers = new Map<number, NodeJS.Timeout>();
/** Slack after the backoff end (the attempt must find the row out of its backoff). */
const RETRY_SLACK_MS = 5_000;
let warnedNonPublicPanel = false;

/**
 * Arms the retry of a failing row at `at` (epoch ms): a domain row goes
 * through ensureForDomain, a platform / preview row through ensureAuxiliary
 * (the wanted targets are recomputed: a host name removed meanwhile is not
 * retried). Each path re-checks needsIssuance, so a stale timer is harmless.
 */
function armRetry(row: Pick<CertificateRow, 'id' | 'domain_id'>, at: number): void {
  if (!timers.interval) return; // worker not started (tests, setup mode)
  const prev = retryTimers.get(row.id);
  if (prev) clearTimeout(prev);
  const delay = Math.max(1_000, at - Date.now() + RETRY_SLACK_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(row.id);
    if (row.domain_id !== null) certificateService.ensureForDomain(row.domain_id);
    else certificateService.ensureAuxiliary();
  }, delay);
  timer.unref?.();
  retryTimers.set(row.id, timer);
}

function disarmRetry(rowId: number): void {
  const prev = retryTimers.get(rowId);
  if (prev) clearTimeout(prev);
  retryTimers.delete(rowId);
}

/** A platform row (no domain, no site: platform host names, mail certificates of the mail domains) never issued yet: short first retries (renewal.ts fast_start). */
function fastStart(r: Pick<CertificateRow, 'domain_id' | 'site_id' | 'not_after'>): boolean {
  return r.domain_id === null && r.site_id === null && r.not_after === null;
}

/** The detail as `viewer` may read it (A6: a client never gets the raw error text, certificateMessages.ts). */
function toDetail(r: CertificateRow, viewer: CertificateViewer = 'staff'): CertificateDetail {
  return {
    ...certificateSummaryView(toCertificateSummary(r), viewer),
    domainId: r.domain_id,
    log: certificateLogView(json<StoredCertificateLogLine[]>(r.log, []), viewer),
  };
}

function scheduleRow(r: CertificateRow): ScheduleRow {
  return {
    id: r.id, status: r.status, issuer: r.issuer, names: json<string[]>(r.names, []),
    not_after: r.not_after, failure_count: Number(r.failure_count) || 0, last_attempt_at: r.last_attempt_at,
    fast_start: fastStart(r),
  };
}

function emitCert(target: CertTarget, status: string, certificateId: number | null = null): void {
  emitHosting(HostingSocketEvents.CERTIFICATE_UPDATED, { domainId: target.domainId, siteId: target.siteId, certificateId, status },
    { tenantId: target.tenantId, accountId: target.accountId });
}

/** UTC label of a date for the notifications ('2026-10-29 14:05 UTC'). */
function utcLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

async function acmeEmail(): Promise<string | null> {
  return (await appConfigService.get('acme_email'))?.trim() || null;
}

async function expectedIssuer(): Promise<CertIssuer> {
  return issuerFor(await edgeService.acmeDirectory());
}

/** Platform host names; on a settings read error: the panel only (never used to delete rows). */
async function platformHostsOrPanel(): Promise<PlatformHosts> {
  try {
    return await loadPlatformHosts();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'certificate: platform settings unreadable, panel host name only');
    const panel = (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
    return { panel: panel && isValidServerName(panel) ? panel : null, previewDomain: null, dbAdmin: null, probeV4: null, probeV6: null };
  }
}

/** Why a domain gets no certificate (each one has its own API error code). */
type SkipReason = 'domain not found' | 'TLS disabled for this domain' | 'account deleting' | 'account not served' | 'reserved platform name'
  | 'name not public' | 'domain not verified';

/** The API error of a skip reason (explicit requests: POST renew). */
export function skipError(reason: SkipReason): AppError {
  switch (reason) {
    case 'domain not found': return new AppError(404, 'Domain not found', 'notFound');
    case 'TLS disabled for this domain': return new AppError(409, 'TLS is disabled for this domain', 'tlsDisabled');
    case 'account deleting': return new AppError(409, 'The hosting account is being deleted', 'accountDeleting');
    case 'reserved platform name': return new AppError(409, 'This name belongs to the panel', 'domainReserved');
    case 'name not public': return new AppError(409, "Let's Encrypt does not issue certificates for reserved or private names (.test, .local, .internal…)", 'certificateNameNotPublic');
    case 'domain not verified': return new AppError(409, 'The ownership of this domain is not verified yet: no certificate before the verification', 'domainNotVerified');
    case 'account not served':
    default: return new AppError(409, 'The hosting account is not online yet (provisioning or in error)', 'accountNotServed');
  }
}

/**
 * Names of a domain certificate: a wildcard domain whose zone our PowerDNS
 * can answer DNS-01 for gets [name, *.name]; otherwise (or without wildcard)
 * [name] (+ www.name). The wildcard falls back to the plain names while the
 * zone is not hosted / active (the renewal pass upgrades it later).
 */
export async function domainCertificateNames(
  d: { name: string; include_www: boolean; wildcard?: boolean | null },
  platform: PlatformHosts,
  dns01: Pick<Dns01Provider, 'canSolve'> = deps.dns01,
): Promise<{ names: string[]; preferDns01: boolean }> {
  const name = d.name.toLowerCase();
  if (d.wildcard && !wildcardCoversPlatform(name, platformHostNames(platform))) {
    let solvable = false;
    try { solvable = await dns01.canSolve(`*.${name}`); } catch { solvable = false; }
    if (solvable) return { names: [name, `*.${name}`], preferDns01: true };
  }
  return { names: d.include_www ? [name, `www.${name}`] : [name], preferDns01: false };
}

/** Domain → target, or a reason why it has no certificate. */
async function domainTarget(domainId: number, platform?: PlatformHosts): Promise<CertTarget | { skip: SkipReason }> {
  const d = await db('domains as d')
    .join('hosting_accounts as a', 'a.id', 'd.account_id')
    .where('d.id', domainId)
    .first('d.id', 'd.tenant_id', 'd.account_id', 'd.name', 'd.include_www', 'd.tls_mode', 'd.wildcard', 'd.verification_status',
      'a.status as account_status') as
    { id: number; tenant_id: number; account_id: number; name: string; include_www: boolean; tls_mode: string; wildcard: boolean | null;
      verification_status: string | null; account_status: HostingAccount['status'] } | undefined;
  if (!d) return { skip: 'domain not found' };
  if (d.tls_mode !== 'letsencrypt') return { skip: 'TLS disabled for this domain' };
  if (d.account_status === 'deleting') return { skip: 'account deleting' };
  if (!SERVED_ACCOUNT_STATUSES.includes(d.account_status)) return { skip: 'account not served' };
  // D1: no certificate before the ownership proof.
  if (d.verification_status !== 'verified') return { skip: 'domain not verified' };
  const name = d.name.toLowerCase();
  const hosts = platform ?? await platformHostsOrPanel();
  // The panel / preview / DB admin / probe host names belong to the platform (never issued for a tenant).
  if (isReservedPlatformName(name, hosts)) return { skip: 'reserved platform name' };
  // Special-use / private names: the public CA would refuse the order (never sent).
  if (!isPublicAcmeName(name)) return { skip: 'name not public' };
  const { names, preferDns01 } = await domainCertificateNames(d, hosts);
  return { kind: 'domain', domainId: d.id, siteId: null, names, preferDns01, tenantId: d.tenant_id, accountId: d.account_id };
}

/**
 * Wanted platform + preview certificates of the local node: the panel, the DB
 * admin host, the probe hosts (each when public), the wildcard
 * *.previewDomain (settings preview.wildcardCertificate, DNS-01 solvable or a
 * usable row already there) and, until that wildcard is usable with its
 * files, one certificate per served preview.
 */
async function auxiliaryTargets(platform: PlatformHosts): Promise<{
  platform: Map<string, CertTarget>; previews: Map<number, CertTarget>;
  /** A contributor failed this pass: its wishes are unknown, platform rows must not be swept. */
  contributorsFailed: boolean;
}> {
  const out = { platform: new Map<string, CertTarget>(), previews: new Map<number, CertTarget>(), contributorsFailed: false };
  const add = (names: string[], preferDns01 = false) => {
    if (!names.every(isPublicAcmeName) || out.platform.has(names[0])) return;
    out.platform.set(names[0], {
      kind: 'platform', domainId: null, siteId: null, names, preferDns01, tenantId: MASTER_TENANT_ID, accountId: null, platformOwn: true,
    });
  };
  if (platform.panel) {
    if (isPublicAcmeName(platform.panel)) add([platform.panel]);
    else if (!warnedNonPublicPanel) {
      // Lab / internal install (panel.oblimint.test…): the edge serves its default certificate, Let's Encrypt is never asked.
      warnedNonPublicPanel = true;
      logger.warn({ panel: platform.panel }, "certificate: panel_hostname is a reserved / private name: no Let's Encrypt certificate for the panel");
    }
  }
  for (const h of [platform.clientPanel, platform.dbAdmin, platform.probeV4, platform.probeV6]) if (h) add([h]);
  // P4 (architect): mail host name + platform webmail host, then the contributed
  // wishes (mail certificates of the mail domains, edge/contributors.ts) — platform rows.
  for (const h of platform.extra ?? []) if (h) add([h]);
  const contributed = await collectCertificateWishes(platform);
  out.contributorsFailed = contributed.failed.length > 0;
  for (const w of contributed.wishes) {
    const names = [...new Set(w.names.map((n) => String(n).trim().toLowerCase()))];
    if (names.length === 0 || out.platform.has(names[0])) continue;
    if (!names.every((n) => isValidServerName(n.startsWith('*.') ? n.slice(2) : n) && isPublicAcmeName(n))) continue;
    out.platform.set(names[0], {
      kind: 'platform', domainId: null, siteId: null, names, preferDns01: !!w.preferDns01, tenantId: w.tenantId, accountId: w.accountId,
    });
  }

  const previewDomain = platform.previewDomain;
  if (!previewDomain || !isPublicAcmeName(previewDomain)) return out;
  const preview = await platformSettings.section('preview');
  if (preview.wildcardCertificate) {
    let solvable = false;
    try { solvable = await deps.dns01.canSolve(`*.${previewDomain}`); } catch { solvable = false; }
    const existing = await db('certificates').where({ primary_name: previewDomain }).whereNull('domain_id').whereNull('site_id')
      .first() as CertificateRow | undefined;
    const usableWildcard = !!existing && isUsable(existing, Date.now())
      && json<string[]>(existing.names, []).includes(`*.${previewDomain}`) && certFilesExist(existing.primary_name);
    // A usable wildcard row survives a zone momentarily not active (no churn of every preview certificate).
    if (solvable || usableWildcard) {
      add([previewDomain, `*.${previewDomain}`], true);
      // The per-preview certificates are only dropped once the wildcard is
      // actually served: until then (issuance queued, DNS-01 failing and
      // backing off) they stay wanted, so the renewal pass never sweeps them
      // and new previews still get one (the vhost prefers its own cert anyway).
      if (usableWildcard) return out;
    }
  }
  const nodeId = await localNodeId();
  const sites = await db('sites as s')
    .join('hosting_accounts as a', 'a.id', 's.account_id')
    .where('a.node_id', nodeId)
    .whereIn('a.status', [...SERVED_ACCOUNT_STATUSES])
    .whereNotNull('s.preview_base')
    .select('s.id', 's.slug', 's.tenant_id', 's.account_id') as Array<{ id: number; slug: string; tenant_id: number; account_id: number }>;
  for (const s of sites) {
    const host = previewHost(s, previewDomain);
    if (!isValidServerName(host) || !isPublicAcmeName(host)) continue;
    out.previews.set(s.id, { kind: 'preview', domainId: null, siteId: s.id, names: [host], preferDns01: false, tenantId: s.tenant_id, accountId: s.account_id });
  }
  return out;
}

/** The row of this target, by kind: a tenant domain row is never taken for a platform / preview one. */
async function findRow(target: Pick<CertTarget, 'kind' | 'domainId' | 'siteId' | 'names'>): Promise<CertificateRow | undefined> {
  if (target.kind === 'domain') return await db('certificates').where({ domain_id: target.domainId }).first() as CertificateRow | undefined;
  const q = db('certificates').where({ primary_name: target.names[0] }).whereNull('domain_id');
  if (target.kind === 'preview') q.where({ site_id: target.siteId });
  else q.whereNull('site_id');
  return await q.first() as CertificateRow | undefined;
}

/** Creates the row (pending) or updates its names. A primary name owned by another row → error. */
async function upsertRow(target: CertTarget): Promise<CertificateRow> {
  const existing = await findRow(target);
  const primary = target.names[0];
  if (existing) {
    if (existing.primary_name !== primary) {
      // Domain names are immutable; a different primary means a stale row: start over.
      removeCertificateFiles(localPaths.edgeCerts(), existing.primary_name);
      await db('certificates').where({ id: existing.id }).update({ primary_name: primary, status: 'pending', not_before: null, not_after: null, updated_at: db.fn.now() });
    }
    return await db('certificates').where({ id: existing.id }).first() as CertificateRow;
  }
  const clash = await db('certificates').where({ primary_name: primary }).first('id') as { id: number } | undefined;
  if (clash) throw new AppError(409, `${primary} is already covered by another certificate`, 'certificateNameTaken');
  const [row] = await db('certificates').insert({
    domain_id: target.domainId,
    site_id: target.siteId,
    primary_name: primary,
    names: JSON.stringify(target.names),
    status: 'pending',
    issuer: await expectedIssuer(),
    log: JSON.stringify([]),
  }).returning('*') as CertificateRow[];
  return row;
}

/** A valid, unexpired certificate covering exactly these names, from the right directory, with its files. */
function usableNow(row: CertificateRow | undefined, names: string[], expected: CertIssuer): boolean {
  return !!row && isUsable(row, Date.now()) && sameNames(json<string[]>(row.names, []), names)
    && !issuerOutdated(row.issuer, expected) && certFilesExist(row.primary_name);
}

const ROLE_ORDER: readonly PlatformHostRole[] = ['panel', 'clientPanel', 'webmail', 'mail', 'dbAdmin', 'previewWildcard', 'probeV4', 'probeV6'];

const settingHost = (v: string | null | undefined): string | null => {
  const h = (v ?? '').trim().toLowerCase().replace(/\.$/, '');
  return h && isValidServerName(h) ? h : null;
};

/**
 * State of the certificate of every platform host name set in the settings
 * (listPlatform / retryPlatform) + the wanted targets by primary name.
 * Contributed wishes (mail.<domain> of the mail domains…) are not listed:
 * only the platform's own names.
 */
async function platformCertificateState(): Promise<{ items: PlatformCertificateItem[]; targets: Map<string, CertTarget> }> {
  const now = Date.now();
  const [hosts, settings, email] = await Promise.all([loadPlatformHosts(), platformSettings.get(), acmeEmail()]);
  const wanted = await auxiliaryTargets(hosts);
  const roles = new Map<string, { roles: PlatformHostRole[]; names: string[] }>();
  const addRole = (h: string | null | undefined, role: PlatformHostRole, names?: string[]) => {
    if (!h) return;
    const entry = roles.get(h) ?? { roles: [], names: names ?? [h] };
    if (!entry.roles.includes(role)) entry.roles.push(role);
    roles.set(h, entry);
  };
  addRole(hosts.panel, 'panel');
  addRole(hosts.clientPanel ?? null, 'clientPanel');
  addRole(settingHost(settings.mail.webmailHostname), 'webmail');
  addRole(settingHost(settings.mail.hostname), 'mail');
  addRole(hosts.dbAdmin, 'dbAdmin');
  if (hosts.previewDomain && settings.preview.wildcardCertificate) {
    addRole(hosts.previewDomain, 'previewWildcard', [hosts.previewDomain, `*.${hosts.previewDomain}`]);
  }
  addRole(hosts.probeV4, 'probeV4');
  addRole(hosts.probeV6, 'probeV6');

  const primaries = [...roles.keys()];
  const rows = primaries.length
    ? await db('certificates').whereIn('primary_name', primaries).whereNull('domain_id').whereNull('site_id').select('*') as CertificateRow[]
    : [];
  const byName = new Map(rows.map((r) => [r.primary_name, r]));
  const items: PlatformCertificateItem[] = [];
  for (const [host, entry] of roles) {
    const target = wanted.platform.get(host);
    const row = byName.get(host);
    const names = target?.names ?? entry.names;
    const blocked: PlatformCertificateItem['blocked'] = !names.every(isPublicAcmeName) ? 'notPublic'
      : entry.roles.includes('previewWildcard') && !target ? 'dns01Unavailable'
        : !email ? 'acmeEmailMissing' : null;
    const sched = row ? scheduleRow(row) : null;
    const issuing = !!target && queue.byTarget.has(queueKey(target));
    const usable = !!row && isUsable(row, now) && certFilesExist(row.primary_name);
    const next = blocked || issuing || !sched ? null : nextAttemptAt(sched, now);
    const last = row?.last_attempt_at ? new Date(row.last_attempt_at).getTime() : NaN;
    const cooldownEnd = Number.isFinite(last) ? last + PLATFORM_RETRY_COOLDOWN_MS : NaN;
    items.push({
      host,
      roles: [...entry.roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)),
      names,
      certificateId: row?.id ?? null,
      status: row?.status ?? null,
      usable,
      issuing,
      issuer: row?.issuer ?? null,
      notBefore: iso(row?.not_before),
      notAfter: iso(row?.not_after),
      lastError: row?.last_error ?? null,
      failureCount: sched?.failure_count ?? 0,
      lastAttemptAt: iso(row?.last_attempt_at),
      nextAttemptAt: next === null ? null : new Date(next).toISOString(),
      retryAvailableAt: Number.isFinite(cooldownEnd) && cooldownEnd > now ? new Date(cooldownEnd).toISOString() : null,
      blocked,
      updatedAt: iso(row?.updated_at),
    });
  }
  items.sort((a, b) => ROLE_ORDER.indexOf(a.roles[0]) - ROLE_ORDER.indexOf(b.roles[0]));
  return { items, targets: wanted.platform };
}

function auditResource(target: CertTarget): { resourceType?: string; resourcePath?: string } {
  if (target.kind === 'domain') return { resourceType: 'domain', resourcePath: String(target.domainId) };
  if (target.kind === 'preview') return { resourceType: 'site', resourcePath: String(target.siteId) };
  return {};
}

/** Can our PowerDNS answer DNS-01 for every name (fallback when HTTP-01 is impossible)? */
async function dns01SolvesAll(names: string[]): Promise<boolean> {
  for (const n of names) {
    try { if (!(await deps.dns01.canSolve(n))) return false; } catch { return false; }
  }
  return names.length > 0;
}

/** The issuance itself (runs inside the queue). Never throws: the outcome is in the row. */
async function runIssuance(target: CertTarget): Promise<void> {
  let row: CertificateRow;
  try {
    row = await upsertRow(target);
  } catch (err) {
    logger.warn({ names: target.names, err: (err as Error).message }, 'certificate: cannot prepare the row');
    return;
  }
  const certId = row.id;
  // A renewal of a still-usable certificate keeps it served while we try
  // (even when it does not cover a newly added name: it still covers the
  // others). Its names stay those of the certificate until the new one is in.
  const keepValid = isUsable(row, Date.now()) && certFilesExist(row.primary_name);
  const wasIssued = row.not_after !== null;
  const lines: StoredCertificateLogLine[] = [];
  // `message` is client-safe (tenant-visible); `detail` is the raw text (staff + server log only, A6).
  const log = async (level: CertificateLogLine['level'], message: string, detail?: string) => {
    if (level === 'info') logger.info({ certId, names: target.names, detail }, `certificate: ${message}`);
    else logger.warn({ certId, names: target.names, detail }, `certificate: ${message}`);
    lines.push({ at: new Date().toISOString(), level, message, ...(detail ? { detail: detail.slice(0, 2000) } : {}) });
    if (lines.length > LOG_CAP) lines.splice(0, lines.length - LOG_CAP);
    try { await db('certificates').where({ id: certId }).update({ log: JSON.stringify(lines) }); } catch { /* best effort */ }
  };

  await db('certificates').where({ id: certId }).update({
    ...(keepValid ? {} : { names: JSON.stringify(target.names) }),
    status: keepValid ? 'valid' : 'pending',
    last_attempt_at: db.fn.now(),
    log: JSON.stringify([]),
    updated_at: db.fn.now(),
  });
  emitCert(target, keepValid ? 'valid' : 'pending', certId);

  // Overall deadline: when it fires, the pending step is abandoned (the ACME
  // calls race the signal), a failure is recorded and the queue moves on.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new Error(`certificate issuance timed out after ${Math.round(deps.deadlineMs / 60_000) || 1} min`));
  }, deps.deadlineMs);
  deadlineTimer.unref?.();
  const bounded = <T>(p: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (deadline.signal.aborted) { p.catch(() => {}); reject(deadline.signal.reason); return; }
    const onAbort = () => reject(deadline.signal.reason);
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => deadline.signal.removeEventListener('abort', onAbort));
  });

  try {
    const email = await acmeEmail();
    if (!email) throw new Error('ACME contact email is not configured (settings: acme_email)');
    const directory = await edgeService.acmeDirectory();
    await log('info', `Requesting a certificate for ${target.names.join(', ')} (${directory} directory)`);

    // The edge must serve the ACME location for these names before Let's Encrypt calls.
    const sync = await bounded(edgeService.syncNow({ force: false }));
    // The raw nginx output covers the WHOLE edge (other tenants' vhosts): it
    // stays in the server log / admin EdgeStatus, never in this tenant-visible log.
    if (!sync.ok) {
      logger.warn({ certId, names: target.names, error: sync.error }, 'certificate: edge sync before validation failed');
      await log('warn', 'The edge configuration could not be fully applied before validation; the challenge may fail (details in the platform logs)');
    }
    // A platform host name set a moment ago (Settings): its A / AAAA record in a
    // platform zone hosted here is pushed by the DNS queue — wait for it (bounded)
    // rather than let Let's Encrypt resolve a name that does not exist yet.
    if (target.kind === 'platform') await bounded(deps.settleDns());

    const issueWith = (preferDns01: boolean) => bounded(issueCertificate({ names: target.names, email, directory, preferDns01 }, {
      edgeDir: localPaths.edge(),
      acmeWebroot: localPaths.edgeAcme(),
      certsDir: localPaths.edgeCerts(),
      createClient: deps.createClient,
      selfTest: deps.selfTest,
      createCertificateKey: deps.createCertificateKey,
      dns01: deps.dns01,
      signal: deadline.signal,
      log,
    }));
    let issued: Awaited<ReturnType<typeof issueCertificate>>;
    try {
      issued = await issueWith(target.preferDns01);
    } catch (err) {
      // HTTP-01 impossible (port 80 unreachable: NAT, firewall, v6-only path)
      // but every name in a zone our PowerDNS answers for: ONE new order solved
      // by DNS-01 (the failed authorization cannot be retried in place).
      if (target.preferDns01 || deadline.signal.aborted || !isHttp01Failure(err) || !(await dns01SolvesAll(target.names))) throw err;
      await log('warn', 'HTTP-01 validation failed: retrying with DNS-01 (zone hosted on this platform)');
      issued = await issueWith(true);
    }
    clearTimeout(deadlineTimer);

    await db('certificates').where({ id: certId }).update({
      status: 'valid',
      issuer: issued.issuer,
      names: JSON.stringify(issued.names),
      not_before: issued.notBefore,
      not_after: issued.notAfter,
      last_error: null,
      failure_count: 0,
      updated_at: db.fn.now(),
    });
    // Removed while we were issuing (domain deleted → row cascaded): drop the files.
    if (!(await db('certificates').where({ id: certId }).first('id'))) {
      removeCertificateFiles(localPaths.edgeCerts(), target.names[0]);
      return;
    }
    emitCert(target, 'valid', certId);
    disarmRetry(certId);
    edgeService.scheduleSync('certificate issued');
    // P4 (architect): the mail service copies the files it serves and reloads TLS.
    announceCertificateInstalled(target.names[0], issued.names);
    await auditService.log({
      tenantId: target.tenantId,
      action: 'certificate.issued',
      ...auditResource(target),
      details: { names: issued.names, issuer: issued.issuer, notAfter: issued.notAfter.toISOString() },
    });
    // A platform host name that had no served certificate (first one, or back after failures):
    // the platform channels hear it (a routine renewal of a served one does not notify).
    if (target.platformOwn && !keepValid) {
      notify('certificate.issued', {
        tenantId: MASTER_TENANT_ID,
        accountId: null,
        key: `cert-issued:${target.names[0]}:${issued.notAfter.toISOString()}`,
        title: `Certificat délivré pour ${target.names[0]}`,
        message: `Let's Encrypt a délivré le certificat de ${issued.names.join(', ')} (valide jusqu'au ${issued.notAfter.toISOString().slice(0, 10)}). `
          + "L'edge le sert désormais à la place de son certificat par défaut.",
        severity: 'info',
        platform: true,
        link: '/settings#settings-platform-certificates',
      });
    }
  } catch (err) {
    clearTimeout(deadlineTimer);
    const message = (err as Error)?.message || String(err);
    await log('error', `FAILED: ${clientCertificateError(message)}`, message);
    const now = Date.now();
    const current = await db('certificates').where({ id: certId }).first() as CertificateRow | undefined;
    if (!current) return;
    // Re-read, not only the `keepValid` captured at the start: a certificate installed meanwhile (P5 import of
    // the CWP certificate while this issuance fails on DNS still pointing at CWP) is usable and stays served.
    const stillValid = isUsable(current, now) && (keepValid || certFilesExist(current.primary_name));
    const status = stillValid ? 'valid' : wasIssued && current.not_after && new Date(current.not_after).getTime() <= now ? 'expired' : 'failed';
    const failureCount = (Number(current.failure_count) || 0) + 1;
    await db('certificates').where({ id: certId }).update({
      status,
      last_error: message.slice(0, 2000),
      failure_count: failureCount,
      updated_at: db.fn.now(),
    });
    emitCert(target, status, certId);
    // The retry at the end of the backoff (not at the next 12-hourly pass).
    const retryAt = backoffEndsAt({ failure_count: failureCount, last_attempt_at: current.last_attempt_at, fast_start: fastStart(current) });
    if (retryAt !== null) armRetry(current, retryAt);
    if (target.platformOwn && failureCount === 1) {
      // First failure of a streak only (the short retries would flood the channels).
      notify('certificate.failed', {
        tenantId: MASTER_TENANT_ID,
        accountId: null,
        key: `cert-failed:${target.names[0]}:${certId}`,
        title: `Échec du certificat de ${target.names[0]}`,
        message: `La demande de certificat Let's Encrypt pour ${target.names.join(', ')} a échoué : ${message.slice(0, 500)}\n`
          + (stillValid ? 'Le certificat actuel reste servi. ' : "L'edge sert son certificat par défaut (non reconnu par les navigateurs). ")
          + (retryAt !== null ? `Nouvelle tentative automatique vers ${utcLabel(retryAt)}. ` : '')
          + 'Vérifiez que le nom pointe vers ce serveur (A / AAAA) et que le port 80 est ouvert, puis « Réessayer » dans Réglages.',
        severity: 'warning',
        platform: true,
        link: '/settings#settings-platform-certificates',
      });
    }
    if (wasIssued) {
      // Renewal failure alert (audit in the tenant of the object + log + socket above).
      logger.warn({ certId, names: target.names, error: message }, 'certificate renewal failed');
      await auditService.log({
        tenantId: target.tenantId,
        action: 'certificate.renewal_failed',
        ...auditResource(target),
        details: { names: target.names, error: message.slice(0, 500), notAfter: current.not_after ? new Date(current.not_after).toISOString() : null },
      });
    }
    if (status !== 'valid') edgeService.scheduleSync('certificate unusable');
  }
}

/** Queues an issuance (one at a time; a target already queued / running is not queued twice). */
function enqueue(target: CertTarget): Promise<void> {
  // Never an order the public CA must refuse (reserved / private names: the
  // panel or preview host names of a lab install, rows created before this
  // rule): no load on the platform's shared ACME account, no internal name
  // sent to the CA. The edge keeps serving its default certificate.
  if (!target.names.every(isPublicAcmeName)) {
    logger.info({ names: target.names }, "certificate: non-public name, no Let's Encrypt request");
    return Promise.resolve();
  }
  const key = queueKey(target);
  const existing = queue.byTarget.get(key);
  if (existing) return existing;
  const p = queue.chain.then(() => runIssuance(target), () => runIssuance(target)).finally(() => {
    queue.byTarget.delete(key);
  });
  queue.byTarget.set(key, p);
  queue.chain = p.catch(() => undefined);
  return p;
}

/** Throws AppError when a domain cannot get a certificate right now (explicit requests). */
async function requireDomainTarget(domainId: number): Promise<CertTarget> {
  const t = await domainTarget(domainId);
  if ('skip' in t) {
    throw skipError(t.skip);
  }
  if (!(await acmeEmail())) throw new AppError(409, 'ACME contact email is not configured', 'acmeEmailMissing');
  return t;
}

async function ensureTarget(target: CertTarget): Promise<void> {
  if (!(await acmeEmail())) return;
  const row = await findRow(target);
  const rowNames = row ? json<string[]>(row.names, []) : [];
  if (row && !certFilesExist(row.primary_name) && row.status === 'valid') {
    // Files lost (restored backup, manual cleanup): reissue regardless of dates.
    void enqueue(target);
    return;
  }
  if (needsIssuance(row ? { ...scheduleRow(row), names: rowNames } : null, target.names, Date.now(), await expectedIssuer())) void enqueue(target);
}

export const certificateService = {
  /**
   * Queue an issuance when tls_mode = letsencrypt, the domain is VERIFIED (D1)
   * and no valid cert covers the names. Never throws.
   */
  ensureForDomain(domainId: number): void {
    void (async () => {
      const t = await domainTarget(domainId);
      if ('skip' in t) return;
      await ensureTarget(t);
    })().catch((err) => logger.warn({ domainId, err: (err as Error).message }, 'certificate ensureForDomain failed'));
  },

  /**
   * One platform / preview host name. siteId set = preview of that site (row
   * site_id), null = a platform host (panel, DB admin, probe). Never throws.
   */
  ensureForHost(host: string, opts: { siteId: number | null; tenantId: number; accountId: number | null }): void {
    void (async () => {
      const name = host.trim().toLowerCase();
      if (!isValidServerName(name) || !isPublicAcmeName(name)) return;
      await ensureTarget({
        kind: opts.siteId ? 'preview' : 'platform', domainId: null, siteId: opts.siteId, names: [name], preferDns01: false,
        tenantId: opts.tenantId, accountId: opts.accountId,
      });
    })().catch((err) => logger.warn({ host, err: (err as Error).message }, 'certificate ensureForHost failed'));
  },

  /** Platform host names + previews of the local node (edge start, vhost changes, renewal pass). Never throws. */
  ensureAuxiliary(): void {
    void (async () => {
      const targets = await auxiliaryTargets(await platformHostsOrPanel());
      for (const t of [...targets.platform.values(), ...targets.previews.values()]) await ensureTarget(t);
    })().catch((err) => logger.warn({ err: (err as Error).message }, 'certificate ensureAuxiliary failed'));
  },

  /** Issue / renew now (force = even if valid). Resolves when the attempt is finished. */
  async request(domainId: number, opts: { force?: boolean } = {}): Promise<CertificateDetail> {
    const target = await requireDomainTarget(domainId);
    const row = await findRow(target);
    const expected = await expectedIssuer();
    if (opts.force || !usableNow(row, target.names, expected) || needsIssuance(row ? scheduleRow(row) : null, target.names, Date.now(), expected)) {
      await enqueue(target);
    }
    const after = await findRow(target);
    if (!after) throw new AppError(500, 'Certificate request failed');
    return toDetail(after);
  },

  /**
   * POST /domains/:id/certificate/renew: validates, creates / prepares the row
   * and starts the issuance in the background; returns the current detail.
   * 409 domainNotVerified before the ownership proof (D1). Rate limited (one
   * shared queue, one shared Let's Encrypt account):
   *   - 429 certificateRateLimited: last attempt < MANUAL_COOLDOWN_MS ago
   *     (everyone), or failure backoff running (clients only);
   *   - 409 certificateNotDue: client `force` on a certificate that is valid,
   *     covers the names, comes from the right directory and is outside the
   *     renewal window.
   * `staff` = staff actor (may force, ignores the failure backoff).
   */
  async startRequest(domainId: number, opts: { force?: boolean; staff?: boolean } = {}): Promise<CertificateDetail> {
    const target = await requireDomainTarget(domainId);
    let row = await findRow(target);
    if (!row) row = await upsertRow(target);
    const viewer: CertificateViewer = opts.staff ? 'staff' : 'client';
    if (queue.byTarget.has(queueKey(target))) return toDetail(row, viewer); // already queued / running
    const now = Date.now();
    const sched = scheduleRow(row);
    const last = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : NaN;
    if (Number.isFinite(last) && now - last < MANUAL_COOLDOWN_MS) {
      throw new AppError(429, 'A certificate request was made a few minutes ago, please wait before retrying', 'certificateRateLimited');
    }
    if (!opts.staff && inBackoff(sched, now)) {
      throw new AppError(429, 'The last attempts failed; the next one is delayed (automatic retry)', 'certificateRateLimited');
    }
    const expected = await expectedIssuer();
    const needed = !usableNow(row, target.names, expected) || needsIssuance(sched, target.names, now, expected);
    if (!needed && opts.force && !opts.staff) {
      throw new AppError(409, 'The certificate is valid and does not need renewal yet', 'certificateNotDue');
    }
    if (needed || opts.force) void enqueue(target);
    return toDetail(row, viewer);
  },

  /**
   * Deletes the cert row + files of a domain (called BEFORE the domain row is
   * deleted). With `trx` (domain reclaim): the row goes in that transaction
   * and the files only once it committed.
   */
  async removeForDomain(domainId: number, opts: { trx?: Knex.Transaction } = {}): Promise<void> {
    const conn = opts.trx ?? db;
    const row = await conn('certificates').where({ domain_id: domainId }).first() as CertificateRow | undefined;
    if (!row) return;
    await conn('certificates').where({ id: row.id }).del();
    const cleanup = () => {
      removeCertificateFiles(localPaths.edgeCerts(), row.primary_name);
      edgeService.scheduleSync('certificate removed');
    };
    if (opts.trx) {
      opts.trx.executionPromise.then(cleanup, () => { /* rolled back: row and files kept */ })
        .catch((err) => logger.warn({ domainId, err: (err as Error).message }, 'certificate: file removal after commit failed'));
    } else {
      cleanup();
    }
  },

  /** viewer 'client' (a client user of the account): raw error text replaced (A6). */
  async getForDomain(domainId: number, viewer: CertificateViewer = 'staff'): Promise<CertificateDetail | null> {
    const row = await db('certificates').where({ domain_id: domainId }).first() as CertificateRow | undefined;
    return row ? toDetail(row, viewer) : null;
  },

  /**
   * Renewal pass: rows no longer wanted are removed first (P1 previews under
   * .preview.<panel>, platform host names removed from the settings, previews
   * gone, per-preview rows replaced by the preview wildcard, tenant rows on a
   * platform name); then valid certs expiring in < 30 days are renewed, past
   * ones marked expired; failed / expired ones retried after their backoff;
   * verified letsencrypt domains without any row get one. Staging
   * certificates are replaced once the platform is on production (also run
   * right after that switch, PUT /system/edge/settings); domain rows missing
   * a name (www / wildcard added, attempt failed) are retried after their backoff.
   */
  async checkRenewals(): Promise<void> {
    const now = Date.now();
    let platform: PlatformHosts | null = null;
    try {
      platform = await loadPlatformHosts();
    } catch (err) {
      // Never sweep rows on a transient settings error: renew what exists, decide the rest next pass.
      logger.warn({ err: (err as Error).message }, 'certificate renewal: platform settings unreadable, stale-row sweep skipped');
    }
    const hosts = platform ?? await platformHostsOrPanel();
    const wanted = platform ? await auxiliaryTargets(platform) : null;
    if (wanted?.contributorsFailed) {
      // A transient contributor error (DB blip in the mail module…) must never
      // delete the certificates it wished for (rows AND files, then reissued
      // from ACME against its rate limits): platform rows kept this pass.
      logger.warn('certificate renewal: a certificate contributor failed, platform stale-row sweep skipped');
    }
    const all = await db('certificates').select('*') as CertificateRow[];

    const rows: CertificateRow[] = [];
    for (const r of all) {
      let stale = false;
      // Tenant domain rows on a platform host name (set or changed after the domain was added).
      if (r.domain_id !== null) stale = isReservedPlatformName(r.primary_name, hosts);
      else if (wanted && r.site_id !== null) stale = wanted.previews.get(r.site_id)?.names[0] !== r.primary_name;
      else if (wanted && !wanted.contributorsFailed) stale = !wanted.platform.has(r.primary_name);
      if (stale) await certificateService.removeRow(r);
      else rows.push(r);
    }

    // Names each domain row SHOULD cover (www / wildcard toggled, earlier attempt failed).
    const desiredByDomain = new Map<number, string[]>();
    const domainIds = rows.filter((r) => r.domain_id !== null).map((r) => r.domain_id as number);
    if (domainIds.length) {
      const ds = await db('domains').whereIn('id', domainIds).where('tls_mode', 'letsencrypt').where('verification_status', 'verified')
        .select('id', 'name', 'include_www', 'wildcard') as Array<{ id: number; name: string; include_www: boolean; wildcard: boolean }>;
      for (const d of ds) desiredByDomain.set(d.id, (await domainCertificateNames(d, hosts)).names);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const plan = planRenewals(rows.map(scheduleRow), now, {
      expectedIssuer: await expectedIssuer(),
      desiredNames: (id) => {
        const r = byId.get(id);
        if (r?.domain_id) return desiredByDomain.get(r.domain_id);
        if (r?.site_id) return wanted?.previews.get(r.site_id)?.names;
        return r ? wanted?.platform.get(r.primary_name)?.names : undefined;
      },
    });

    // Rows waiting out a failure backoff: their retry is armed at its end (after a
    // restart the timers are gone; a pass re-arms them instead of leaving the
    // retry to the next pass, up to 12 h later).
    const renewing = new Set(plan.renew);
    for (const r of rows) {
      if (renewing.has(r.id) || r.status === 'pending') continue;
      const end = backoffEndsAt(scheduleRow(r));
      if (end !== null && end > now) armRetry(r, end);
    }

    if (plan.expire.length) {
      await db('certificates').whereIn('id', plan.expire).update({ status: 'expired', updated_at: db.fn.now() });
      edgeService.scheduleSync('certificate expired');
    }

    const jobs: Array<Promise<void>> = [];
    for (const id of plan.renew) {
      const r = byId.get(id)!;
      if (r.domain_id) {
        const t = await domainTarget(r.domain_id, hosts);
        if (!('skip' in t)) jobs.push(enqueue(t));
        continue;
      }
      const t = r.site_id ? wanted?.previews.get(r.site_id) : wanted?.platform.get(r.primary_name);
      if (t) jobs.push(enqueue(t));
    }

    // Verified domains that never got a row (missed event, panel restarted mid-way, verified meanwhile).
    const orphans = await db('domains as d')
      .leftJoin('certificates as c', 'c.domain_id', 'd.id')
      .where('d.tls_mode', 'letsencrypt')
      .where('d.verification_status', 'verified')
      .whereNull('c.id')
      .select('d.id') as Array<{ id: number }>;
    for (const d of orphans) certificateService.ensureForDomain(d.id);
    certificateService.ensureAuxiliary();
    await Promise.allSettled(jobs);
  },

  /** Removes a row and its files (stale preview / platform names). */
  async removeRow(r: CertificateRow): Promise<void> {
    removeCertificateFiles(localPaths.edgeCerts(), r.primary_name);
    await db('certificates').where({ id: r.id }).del();
    logger.info({ certId: r.id, name: r.primary_name }, 'certificate: stale row removed');
    edgeService.scheduleSync('certificate removed');
  },

  /** Renewal worker (every 12 h + 2 min after boot). */
  start(): void {
    if (timers.first || timers.interval) return;
    const tick = () => {
      certificateService.checkRenewals().catch((err) => logger.error({ err: (err as Error).message }, 'certificate renewal pass failed'));
    };
    timers.first = setTimeout(() => { timers.first = null; tick(); }, RENEWAL_FIRST_DELAY_MS);
    timers.interval = setInterval(tick, RENEWAL_INTERVAL_MS);
    timers.first.unref?.();
    timers.interval.unref?.();
  },

  stop(): void {
    if (timers.first) clearTimeout(timers.first);
    if (timers.interval) clearInterval(timers.interval);
    timers.first = null;
    timers.interval = null;
    for (const id of [...retryTimers.keys()]) disarmRetry(id);
  },

  /** Settings → platform certificates (GET /system/edge/platform-certificates, platform admin). */
  async listPlatform(): Promise<PlatformCertificatesView> {
    const { items } = await platformCertificateState();
    return { acmeDirectory: await edgeService.acmeDirectory(), items };
  },

  /**
   * « Retry now » of a platform host name certificate (staff, Settings): resets
   * its failure backoff (failure_count = 0, the last error stays until the
   * attempt) and queues an attempt now. 404 notFound: not a platform host name
   * of this server; 409 certificateNameNotPublic / acmeEmailMissing /
   * certificateDns01Unavailable: Let's Encrypt cannot be asked; 429
   * certificateRateLimited: last attempt < PLATFORM_RETRY_COOLDOWN_MS ago;
   * 409 certificateNotDue: served, covers its names, outside the renewal window.
   * Already queued / running: answered as is. Returns the item after queuing.
   */
  async retryPlatform(rawHost: string): Promise<PlatformCertificateItem> {
    const host = String(rawHost ?? '').trim().toLowerCase().replace(/\.$/, '');
    const state = await platformCertificateState();
    const item = state.items.find((i) => i.host === host);
    if (!item) throw new AppError(404, 'Not a platform host name of this server', 'notFound');
    if (item.blocked === 'notPublic') throw skipError('name not public');
    if (item.blocked === 'acmeEmailMissing') throw new AppError(409, 'ACME contact email is not configured', 'acmeEmailMissing');
    if (item.blocked === 'dns01Unavailable') {
      throw new AppError(409, "The preview wildcard needs DNS-01: the zone of the preview domain must be hosted on this platform's DNS", 'certificateDns01Unavailable');
    }
    const target = state.targets.get(host);
    if (!target) throw new AppError(404, 'Not a platform host name of this server', 'notFound');
    if (item.issuing) return item;
    const row = await findRow(target);
    if (row) {
      const now = Date.now();
      const last = row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : NaN;
      if (Number.isFinite(last) && now - last < PLATFORM_RETRY_COOLDOWN_MS) {
        throw new AppError(429, 'A certificate attempt was made a moment ago, please wait before retrying', 'certificateRateLimited');
      }
      const expected = await expectedIssuer();
      // Due regardless of the backoff (that is what « retry now » lifts).
      const due = !usableNow(row, target.names, expected) || needsIssuance({ ...scheduleRow(row), failure_count: 0 }, target.names, now, expected);
      if (!due) throw new AppError(409, 'The certificate is valid and does not need renewal yet', 'certificateNotDue');
      await db('certificates').where({ id: row.id }).update({ failure_count: 0, updated_at: db.fn.now() });
      disarmRetry(row.id);
    }
    void enqueue(target);
    const after = (await platformCertificateState()).items.find((i) => i.host === host);
    return after ?? item;
  },

  /** Tests: resolves once the issuance queue is idle. */
  async _whenIdle(): Promise<void> {
    while (queue.byTarget.size > 0) await Promise.allSettled([...queue.byTarget.values()]);
  },

  /** Tests only: replace the ACME client factory / self-test / DNS-01 solver. */
  _setDeps(d: Partial<typeof deps>): void {
    Object.assign(deps, d);
  },
};
