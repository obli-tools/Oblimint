import type { CertificateDetail, CertificateLogLine, HostingAccount } from '@oblimint/shared';
import { HostingSocketEvents, MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { localNodeId } from '../docker/engine';
import { emitHosting } from '../hosting/events';
import { EDGE_CONTAINER, previewHostname } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { json, toCertificateSummary, type CertificateRow } from '../hosting/rows';
import {
  defaultAcmeClientFactory, httpSelfTest, isPublicAcmeName, issueCertificate, removeCertificateFiles, type AcmeClientFactory,
} from './acmeIssuer';
import {
  certificateLogView, certificateSummaryView, clientCertificateError, type CertificateViewer, type StoredCertificateLogLine,
} from './certificateMessages';
import { certFilesExist, edgeService } from './edge.service';
import { isValidServerName } from './nginxConfig';
import {
  inBackoff, isUsable, issuerFor, issuerOutdated, MANUAL_COOLDOWN_MS, needsIssuance, planRenewals, sameNames, type CertIssuer, type ScheduleRow,
} from './renewal';
import { isReservedPlatformName, SERVED_ACCOUNT_STATUSES } from './vhostPlan';

// ─────────────────────────────────────────────────────────────────────────────
// Let's Encrypt certificates of the edge (docs/P1-PLAN.md §11). OWNED BY
// MODULE `edge`. The ACME protocol itself is in acmeIssuer.ts (persistent
// account key, dates read from the certificate, staging option); this file
// owns the `certificates` rows, the issuance queue and the renewal worker.
//
// Three kinds of certificates (one row each, primary_name unique):
//   domain   domain_id set — names = [name] (+ www.name when include_www);
//   preview  site_id set, domain_id null — previewHostname(site, panel_hostname);
//   panel    both null — panel_hostname.
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
// ─────────────────────────────────────────────────────────────────────────────

const LOG_CAP = 200;
const RENEWAL_FIRST_DELAY_MS = 2 * 60_000;
const RENEWAL_INTERVAL_MS = 12 * 3600_000;
/** Overall deadline of ONE issuance: the queue is serial, a hung one would block every tenant's renewals. */
const ISSUANCE_DEADLINE_MS = 10 * 60_000;

type CertKind = 'domain' | 'preview' | 'panel';

interface CertTarget {
  kind: CertKind;
  domainId: number | null;
  siteId: number | null;
  /** names[0] = primary_name. */
  names: string[];
  /** Audit / socket scope. */
  tenantId: number;
  accountId: number | null;
}

/** Injectable for tests (fake ACME client, no network). */
const deps: {
  createClient: AcmeClientFactory;
  selfTest: ReturnType<typeof httpSelfTest> | undefined;
  createCertificateKey: (() => Promise<Buffer | string>) | undefined;
  deadlineMs: number;
} = {
  createClient: defaultAcmeClientFactory,
  selfTest: httpSelfTest(EDGE_CONTAINER),
  createCertificateKey: undefined,
  deadlineMs: ISSUANCE_DEADLINE_MS,
};

const queue: { chain: Promise<unknown>; byName: Map<string, Promise<void>> } = { chain: Promise.resolve(), byName: new Map() };
const timers: { first: NodeJS.Timeout | null; interval: NodeJS.Timeout | null } = { first: null, interval: null };
let warnedNonPublicPanel = false;

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
  };
}

function emitCert(target: CertTarget, status: string): void {
  emitHosting(HostingSocketEvents.CERTIFICATE_UPDATED, { domainId: target.domainId, siteId: target.siteId, status },
    { tenantId: target.tenantId, accountId: target.accountId });
}

async function acmeEmail(): Promise<string | null> {
  return (await appConfigService.get('acme_email'))?.trim() || null;
}

async function expectedIssuer(): Promise<CertIssuer> {
  return issuerFor(await edgeService.acmeDirectory());
}

async function panelHostname(): Promise<string | null> {
  const h = (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
  return h && isValidServerName(h) ? h : null;
}

/** Why a domain gets no certificate (each one has its own API error code). */
type SkipReason = 'domain not found' | 'TLS disabled for this domain' | 'account deleting' | 'account not served' | 'reserved platform name' | 'name not public';

/** The API error of a skip reason (explicit requests: POST renew). */
export function skipError(reason: SkipReason): AppError {
  switch (reason) {
    case 'domain not found': return new AppError(404, 'Domain not found', 'notFound');
    case 'TLS disabled for this domain': return new AppError(409, 'TLS is disabled for this domain', 'tlsDisabled');
    case 'account deleting': return new AppError(409, 'The hosting account is being deleted', 'accountDeleting');
    case 'reserved platform name': return new AppError(409, 'This name belongs to the panel', 'domainReserved');
    case 'name not public': return new AppError(409, "Let's Encrypt does not issue certificates for reserved or private names (.test, .local, .internal…)", 'certificateNameNotPublic');
    case 'account not served':
    default: return new AppError(409, 'The hosting account is not online yet (provisioning or in error)', 'accountNotServed');
  }
}

/** Domain → target, or a reason why it has no certificate. */
async function domainTarget(domainId: number): Promise<CertTarget | { skip: SkipReason }> {
  const d = await db('domains as d')
    .join('hosting_accounts as a', 'a.id', 'd.account_id')
    .where('d.id', domainId)
    .first('d.id', 'd.tenant_id', 'd.account_id', 'd.name', 'd.include_www', 'd.tls_mode', 'a.status as account_status') as
    { id: number; tenant_id: number; account_id: number; name: string; include_www: boolean; tls_mode: string; account_status: HostingAccount['status'] } | undefined;
  if (!d) return { skip: 'domain not found' };
  if (d.tls_mode !== 'letsencrypt') return { skip: 'TLS disabled for this domain' };
  if (d.account_status === 'deleting') return { skip: 'account deleting' };
  if (!SERVED_ACCOUNT_STATUSES.includes(d.account_status)) return { skip: 'account not served' };
  const name = d.name.toLowerCase();
  // The panel / preview host names belong to the platform (never served for a tenant).
  if (isReservedPlatformName(name, await panelHostname())) return { skip: 'reserved platform name' };
  // Special-use / private names: the public CA would refuse the order (never sent).
  if (!isPublicAcmeName(name)) return { skip: 'name not public' };
  return {
    kind: 'domain', domainId: d.id, siteId: null, names: d.include_www ? [name, `www.${name}`] : [name],
    tenantId: d.tenant_id, accountId: d.account_id,
  };
}

/** The row of this target, by kind: a tenant domain row is never taken for a panel / preview one. */
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
  emitCert(target, keepValid ? 'valid' : 'pending');

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

    const issued = await bounded(issueCertificate({ names: target.names, email, directory }, {
      edgeDir: localPaths.edge(),
      acmeWebroot: localPaths.edgeAcme(),
      certsDir: localPaths.edgeCerts(),
      createClient: deps.createClient,
      selfTest: deps.selfTest,
      createCertificateKey: deps.createCertificateKey,
      signal: deadline.signal,
      log,
    }));
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
    emitCert(target, 'valid');
    edgeService.scheduleSync('certificate issued');
    await auditService.log({
      tenantId: target.tenantId,
      action: 'certificate.issued',
      resourceType: target.kind === 'domain' ? 'domain' : target.kind === 'preview' ? 'site' : undefined,
      resourcePath: target.domainId ? String(target.domainId) : target.siteId ? String(target.siteId) : undefined,
      details: { names: issued.names, issuer: issued.issuer, notAfter: issued.notAfter.toISOString() },
    });
  } catch (err) {
    clearTimeout(deadlineTimer);
    const message = (err as Error)?.message || String(err);
    await log('error', `FAILED: ${clientCertificateError(message)}`, message);
    const now = Date.now();
    const current = await db('certificates').where({ id: certId }).first() as CertificateRow | undefined;
    if (!current) return;
    const stillValid = keepValid && isUsable(current, now);
    const status = stillValid ? 'valid' : wasIssued && current.not_after && new Date(current.not_after).getTime() <= now ? 'expired' : 'failed';
    await db('certificates').where({ id: certId }).update({
      status,
      last_error: message.slice(0, 2000),
      failure_count: (Number(current.failure_count) || 0) + 1,
      updated_at: db.fn.now(),
    });
    emitCert(target, status);
    if (wasIssued) {
      // Renewal failure alert (audit in the tenant of the object + log + socket above).
      logger.warn({ certId, names: target.names, error: message }, 'certificate renewal failed');
      await auditService.log({
        tenantId: target.tenantId,
        action: 'certificate.renewal_failed',
        resourceType: target.kind === 'domain' ? 'domain' : target.kind === 'preview' ? 'site' : undefined,
        resourcePath: target.domainId ? String(target.domainId) : target.siteId ? String(target.siteId) : undefined,
        details: { names: target.names, error: message.slice(0, 500), notAfter: current.not_after ? new Date(current.not_after).toISOString() : null },
      });
    }
    if (status !== 'valid') edgeService.scheduleSync('certificate unusable');
  }
}

/** Queues an issuance (one at a time; a name already queued is not queued twice). */
function enqueue(target: CertTarget): Promise<void> {
  // Never an order the public CA must refuse (reserved / private names: the
  // panel or preview host names of a lab install, rows created before this
  // rule): no load on the platform's shared ACME account, no internal name
  // sent to the CA. The edge keeps serving its default certificate.
  if (!target.names.every(isPublicAcmeName)) {
    logger.info({ names: target.names }, "certificate: non-public name, no Let's Encrypt request");
    return Promise.resolve();
  }
  const key = target.names[0];
  const existing = queue.byName.get(key);
  if (existing) return existing;
  const p = queue.chain.then(() => runIssuance(target), () => runIssuance(target)).finally(() => {
    queue.byName.delete(key);
  });
  queue.byName.set(key, p);
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
  /** Queue an issuance when tls_mode = letsencrypt and no valid cert covers the names. Never throws. */
  ensureForDomain(domainId: number): void {
    void (async () => {
      const t = await domainTarget(domainId);
      if ('skip' in t) return;
      await ensureTarget(t);
    })().catch((err) => logger.warn({ domainId, err: (err as Error).message }, 'certificate ensureForDomain failed'));
  },

  /**
   * Preview / panel host names. siteId set = preview of that site (row
   * site_id), null = the panel. Never throws.
   */
  ensureForHost(host: string, opts: { siteId: number | null; tenantId: number; accountId: number | null }): void {
    void (async () => {
      const name = host.trim().toLowerCase();
      if (!isValidServerName(name) || !isPublicAcmeName(name)) return;
      await ensureTarget({
        kind: opts.siteId ? 'preview' : 'panel', domainId: null, siteId: opts.siteId, names: [name],
        tenantId: opts.tenantId, accountId: opts.accountId,
      });
    })().catch((err) => logger.warn({ host, err: (err as Error).message }, 'certificate ensureForHost failed'));
  },

  /** Panel + preview host names of the local node (edge start, renewal pass). Never throws. */
  ensureAuxiliary(): void {
    void (async () => {
      const panel = await panelHostname();
      if (!panel) return;
      if (!isPublicAcmeName(panel)) {
        // Lab / internal install (panel.oblimint.test…): the panel and every preview
        // host name below it are not publicly resolvable — the edge serves its
        // default certificate, Let's Encrypt is never asked.
        if (!warnedNonPublicPanel) {
          warnedNonPublicPanel = true;
          logger.warn({ panel }, "certificate: panel_hostname is a reserved / private name: no Let's Encrypt certificate for the panel and preview hosts");
        }
        return;
      }
      certificateService.ensureForHost(panel, { siteId: null, tenantId: MASTER_TENANT_ID, accountId: null });
      const nodeId = await localNodeId();
      const sites = await db('sites as s')
        .join('hosting_accounts as a', 'a.id', 's.account_id')
        .where('a.node_id', nodeId)
        .whereIn('a.status', [...SERVED_ACCOUNT_STATUSES])
        .whereNotNull('s.preview_base')
        .select('s.id', 's.slug', 's.tenant_id', 's.account_id') as Array<{ id: number; slug: string; tenant_id: number; account_id: number }>;
      for (const s of sites) certificateService.ensureForHost(previewHostname(s, panel), { siteId: s.id, tenantId: s.tenant_id, accountId: s.account_id });
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
   * Rate limited (one shared queue, one shared Let's Encrypt account):
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
    if (queue.byName.has(target.names[0])) return toDetail(row, viewer); // already queued / running
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

  /** Deletes the cert row + files of a domain (called BEFORE the domain row is deleted). */
  async removeForDomain(domainId: number): Promise<void> {
    const row = await db('certificates').where({ domain_id: domainId }).first() as CertificateRow | undefined;
    if (!row) return;
    removeCertificateFiles(localPaths.edgeCerts(), row.primary_name);
    await db('certificates').where({ id: row.id }).del();
    edgeService.scheduleSync('certificate removed');
  },

  /** viewer 'client' (a client user of the account): raw error text replaced (A6). */
  async getForDomain(domainId: number, viewer: CertificateViewer = 'staff'): Promise<CertificateDetail | null> {
    const row = await db('certificates').where({ domain_id: domainId }).first() as CertificateRow | undefined;
    return row ? toDetail(row, viewer) : null;
  },

  /**
   * Renewal pass: valid certs expiring in < 30 days are renewed, past ones
   * marked expired; failed / expired ones retried after their backoff;
   * letsencrypt domains without any row get one; stale preview / panel rows
   * (host name no longer served) are removed. Staging certificates are
   * replaced once the platform is on production (also run right after that
   * switch, PUT /system/edge/settings); domain rows missing a name (www added,
   * attempt failed) are retried after their backoff.
   */
  async checkRenewals(): Promise<void> {
    const now = Date.now();
    const panel = await panelHostname();
    const all = await db('certificates').select('*') as CertificateRow[];

    // Tenant domain rows on a platform host name (panel_hostname set or
    // changed after the domain was added): removed, the platform issues its own.
    const rows: CertificateRow[] = [];
    for (const r of all) {
      if (r.domain_id !== null && isReservedPlatformName(r.primary_name, panel)) await certificateService.removeRow(r);
      else rows.push(r);
    }

    // Names each domain row SHOULD cover (www toggled, earlier attempt failed).
    const desiredByDomain = new Map<number, string[]>();
    const domainIds = rows.filter((r) => r.domain_id !== null).map((r) => r.domain_id as number);
    if (domainIds.length) {
      const ds = await db('domains').whereIn('id', domainIds).where('tls_mode', 'letsencrypt')
        .select('id', 'name', 'include_www') as Array<{ id: number; name: string; include_www: boolean }>;
      for (const d of ds) {
        const n = d.name.toLowerCase();
        desiredByDomain.set(d.id, d.include_www ? [n, `www.${n}`] : [n]);
      }
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const plan = planRenewals(rows.map(scheduleRow), now, {
      expectedIssuer: await expectedIssuer(),
      desiredNames: (id) => {
        const r = byId.get(id);
        return r?.domain_id ? desiredByDomain.get(r.domain_id) : undefined;
      },
    });

    if (plan.expire.length) {
      await db('certificates').whereIn('id', plan.expire).update({ status: 'expired', updated_at: db.fn.now() });
      edgeService.scheduleSync('certificate expired');
    }

    const jobs: Array<Promise<void>> = [];
    for (const id of plan.renew) {
      const r = byId.get(id)!;
      if (r.domain_id) {
        const t = await domainTarget(r.domain_id);
        if (!('skip' in t)) jobs.push(enqueue(t));
        continue;
      }
      if (r.site_id) {
        const s = await db('sites').where({ id: r.site_id }).first('id', 'slug', 'tenant_id', 'account_id', 'preview_base') as
          { id: number; slug: string; tenant_id: number; account_id: number; preview_base: string | null } | undefined;
        if (!s || !s.preview_base || !panel || previewHostname(s, panel) !== r.primary_name) {
          await certificateService.removeRow(r);
          continue;
        }
        jobs.push(enqueue({ kind: 'preview', domainId: null, siteId: s.id, names: [r.primary_name], tenantId: s.tenant_id, accountId: s.account_id }));
        continue;
      }
      if (!panel || panel !== r.primary_name) {
        await certificateService.removeRow(r);
        continue;
      }
      jobs.push(enqueue({ kind: 'panel', domainId: null, siteId: null, names: [panel], tenantId: MASTER_TENANT_ID, accountId: null }));
    }

    // Domains that never got a row (missed event, panel restarted mid-way).
    const orphans = await db('domains as d')
      .leftJoin('certificates as c', 'c.domain_id', 'd.id')
      .where('d.tls_mode', 'letsencrypt')
      .whereNull('c.id')
      .select('d.id') as Array<{ id: number }>;
    for (const d of orphans) certificateService.ensureForDomain(d.id);
    certificateService.ensureAuxiliary();
    await Promise.allSettled(jobs);
  },

  /** Removes a row and its files (stale preview / panel names). */
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
  },

  /** Tests only: replace the ACME client factory / self-test. */
  _setDeps(d: Partial<typeof deps>): void {
    Object.assign(deps, d);
  },
};
