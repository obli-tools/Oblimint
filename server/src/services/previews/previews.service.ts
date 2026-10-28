import crypto from 'crypto';
import type { Request } from 'express';
import {
  PREVIEW_CLAIM_PATH, PREVIEW_FETCH_DEFAULT_BYTES, PREVIEW_FETCH_MAX_BYTES, PREVIEW_FETCH_MIN_BYTES, PREVIEW_KEY_HEADER,
  PREVIEW_DB_CLONE_MAX_DATABASES, PREVIEW_MAX_LIFETIME_MS, PREVIEW_OPEN_LINK_TTL_MS, PREVIEW_SHARE_LINK_TTL_MS, PREVIEW_TTL_MINUTES, PREVIEWABLE_RELEASE_STATUSES,
  type PreviewFetchResult, type PreviewLink, type PreviewOptions, type PreviewStartResult, type PreviewTarget, type PreviewWarningCode,
  type PreviewDatabaseCandidate, type PreviewDbCloneDatabase, type ScanSummary, type SitePreview,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { open as openSecret, seal } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import { platformSettings } from '../platformSettings';
import { actorCan, assertReadsCode, loadSite, type HostingActor } from '../hosting/access';
import { siteDeletions } from '../hosting/deletions';
import { releasePreviewContainer, releasePreviewHost, siteContainer } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { json, type SiteRow } from '../hosting/rows';
import { siteHasSecretEnv } from '../hosting/siteEnv.service';
import { commitExists, scanStaging } from '../releases/repo';
import { healthcheckHost } from '../releases/release.service';
import { previewBuilder } from './previewBuild';
import {
  ACTIVE, activePreviewOfSite, emitPreview, failPreview, previewOptions, previewQuery, stopInternal, toPreview, type PreviewRow,
} from './previewCore';
import { cloneCandidates, initialClone, liveDbExposed, resolveCloneSelection, type DbReach } from './previewDbClone';
import { readClone } from './previewDbEnv';
import { previewDeps } from './previewDeps';
import { validatePreviewPath } from './previewFetch';
import { setPreviewClaimDomain } from './previewClaimHost';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — release / staging previews (shared/src/previews.ts). Rights
// (A5): a release needs code.read; the staging code.read + releases.publish;
// on a site in 'approval' mode, unapproved code (staging, or a release
// awaiting_approval | rejected | failed) also needs releases.approve (staff:
// sites.manage) — an access key never has it. compare and the options that
// weaken the isolation need sites.manage (allowBlockedScan: staff only).
// Share links (decision 9): clients with sites.manage, or staff.
// Database clone (option database: 'clone'): it exposes live data, so starting
// one, and opening / sharing / fetching / the key of a clone preview, also
// need databases.manage on the account (staff: the matching right; a key: the
// databases.manage scope and every cloned database within its reach).
// No preview at all while a live database is reachable through a published
// port (external access on an instance of the account, or anywhere on the
// node with the egress filter off): liveDbExposed.
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewStartInput {
  target: PreviewTarget;
  releaseId?: number | null;
  ttlMinutes?: number | null;
  options?: Partial<PreviewOptions> | null;
  /** database 'clone': the databases to copy (default: the ones the site's environment references). */
  databaseIds?: number[] | null;
}

export interface PreviewVia {
  /** Access key acting (null: session). */
  keyId?: number | null;
  /** Keys only: return the gate header + value (audited preview.key). */
  includeKey?: boolean;
  /** Keys only: return a share link when the actor may create one. */
  withLink?: boolean;
  /** Keys only: databases the key reaches (scope databases.manage); absent = no database clone for a key. */
  dbReach?: DbReach;
}

const err = (status: number, message: string, code: string, details?: unknown) => new AppError(status, message, code, details);
const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_SHARE_LINKS = 20;
const FETCH_PER_SITE = 2;
const fetchSlots = new Map<number, number>();

function siteTarget(site: Pick<SiteRow, 'tenant_id' | 'account_id'>) {
  return { tenantId: site.tenant_id, accountId: site.account_id };
}

async function userId(actor: HostingActor): Promise<number | null> {
  return Number.isInteger(actor.userId) && actor.userId > 0 ? actor.userId : null;
}

/** Share links: a client needs sites.manage (decision 9), staff code.read (checked before). */
function canShare(actor: HostingActor, site: SiteRow): boolean {
  return actor.kind === 'staff' || actorCan(actor, 'sites.manage', siteTarget(site));
}

/**
 * A preview with a database clone shows production data: databases.manage on
 * the account (staff: the matching right), and for a key every cloned
 * database within its reach. Throws 403 previewDatabaseForbidden.
 */
function assertCloneAccess(actor: HostingActor, site: SiteRow, row: Pick<PreviewRow, 'options' | 'db_clone'>, reach?: DbReach): void {
  if (previewOptions(row.options).database !== 'clone') return;
  if (!actorCan(actor, 'databases.manage', siteTarget(site))) {
    throw err(403, 'This preview holds a copy of the database: it needs the right to manage the databases', 'previewDatabaseForbidden');
  }
  if (reach && reach !== 'all') {
    const out = (readClone(row.db_clone)?.databases ?? []).filter((d) => !reach.has(d.id));
    if (out.length) throw err(403, 'This preview holds a copy of a database the key cannot reach', 'previewDatabaseForbidden', { databaseIds: out.map((d) => d.id) });
  }
}

/** The ACME wildcard *.previewDomain exists and is valid. */
async function previewWildcardValid(previewDomain: string): Promise<boolean> {
  const row = await db('certificates').whereNull('domain_id').whereNull('site_id').where({ primary_name: previewDomain, status: 'valid' })
    .first('names') as { names: unknown } | undefined;
  const names = json<unknown>(row?.names ?? null, null);
  return Array.isArray(names) && names.map((n) => String(n).toLowerCase()).includes(`*.${previewDomain}`);
}

/** The account's networks are filtered by the segmentation (P4b); a legacy account → warning notSegmented. */
async function accountSegmented(accountId: number): Promise<boolean> {
  try {
    const mode = (await platformSettings.section('network')).mode;
    if (mode !== 'enforce') return false;
    const row = await db('hosting_accounts').where({ id: accountId }).first('network_model') as { network_model?: string } | undefined;
    return row?.network_model === 'segmented';
  } catch {
    return false;
  }
}

async function rowsOfSite(siteId: number, limit: number): Promise<SitePreview[]> {
  const rows = await previewQuery().where('p.site_id', siteId).orderBy('p.id', 'desc').limit(limit) as Array<PreviewRow & { creator_name: string | null; key_name: string | null }>;
  return rows.map(toPreview);
}

async function onePreview(id: number): Promise<SitePreview> {
  const r = await previewQuery().where('p.id', id).first() as (PreviewRow & { creator_name: string | null; key_name: string | null }) | undefined;
  if (!r) throw err(404, 'Preview not found', 'notFound');
  return toPreview(r);
}

/** Inserts a one-shot claim link; returns the raw token (never stored, never logged). */
async function createLink(preview: PreviewRow, kind: 'open' | 'share', actor: HostingActor, keyId: number | null): Promise<{ token: string; expiresAt: Date }> {
  const now = previewDeps().now();
  if (kind === 'share') {
    const active = await db('site_preview_links').where({ preview_id: preview.id, kind: 'share' }).whereNull('used_at')
      .where('expires_at', '>', new Date(now)).count<{ n: string }[]>({ n: '*' });
    if (Number(active[0]?.n ?? 0) >= MAX_ACTIVE_SHARE_LINKS) throw err(429, 'Too many share links for this preview', 'previewLinkLimit');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + (kind === 'share' ? PREVIEW_SHARE_LINK_TTL_MS : PREVIEW_OPEN_LINK_TTL_MS));
  await db('site_preview_links').insert({
    preview_id: preview.id, kind, token_hash: tokenHash(token), created_by: await userId(actor), created_by_key: keyId, expires_at: expiresAt,
  });
  return { token, expiresAt };
}

const claimUrl = (host: string, token: string) => `https://${host}${PREVIEW_CLAIM_PATH}?t=${token}`;

async function activeOrThrow(siteId: number, statuses: string[] = ACTIVE): Promise<PreviewRow> {
  const row = await activePreviewOfSite(siteId);
  if (!row || !statuses.includes(row.status)) throw err(409, 'No preview is running for this site', 'previewNotRunning');
  return row;
}

export const previewService = {
  /** The latest preview of the site (any status), null when none. */
  async get(actor: HostingActor, siteId: number): Promise<SitePreview | null> {
    const site = await loadSite(actor, siteId, 'read');
    return (await rowsOfSite(site.id, 1))[0] ?? null;
  },

  async history(actor: HostingActor, siteId: number, limit = 20): Promise<SitePreview[]> {
    const site = await loadSite(actor, siteId, 'read');
    return rowsOfSite(site.id, Math.min(50, Math.max(1, Math.trunc(limit) || 20)));
  },

  async start(req: Request, actor: HostingActor, siteId: number, input: PreviewStartInput, via: PreviewVia = {}): Promise<PreviewStartResult> {
    const deps = previewDeps();
    // 1. Site + code.read.
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    const target = siteTarget(site);
    const keyId = via.keyId ?? null;

    // Target row first (its status decides the approval rule).
    let release: { id: number; number: number; commit_sha: string | null; status: string; scan: unknown } | null = null;
    if (input.target === 'release') {
      const rid = Number(input.releaseId);
      if (!Number.isInteger(rid) || rid <= 0) throw err(400, 'releaseId is required for a release preview', 'validation');
      release = await db('releases').where({ id: rid, site_id: site.id }).first('id', 'number', 'commit_sha', 'status', 'scan') ?? null;
      if (!release) throw err(404, 'Release not found', 'notFound');
    } else if (input.target !== 'staging') {
      throw err(400, 'target must be release or staging', 'validation');
    }

    // 2. Rights of the target (A5).
    if (input.target === 'staging' && !actorCan(actor, 'releases.publish', target)) {
      throw err(403, 'Previewing the staging needs the right to publish', 'previewStagingForbidden');
    }
    const unapproved = input.target === 'staging' || ['awaiting_approval', 'rejected', 'failed'].includes(release!.status);
    if (site.publish_mode === 'approval' && unapproved && !actorCan(actor, 'releases.approve', target)) {
      throw err(403, 'This site publishes after approval: only an approver can preview code that was not approved', 'previewApprovalRequired');
    }

    // 3. Options weakening the isolation.
    const options: PreviewOptions = {
      env: input.options?.env === 'all' ? 'all' : 'public', allowBlockedScan: input.options?.allowBlockedScan === true,
      database: input.options?.database === 'clone' ? 'clone' : 'none',
    };
    const clone = options.database === 'clone';
    if (clone && (!actorCan(actor, 'databases.manage', target) || (keyId !== null && !via.dbReach))) {
      throw err(403, 'A database clone needs the right to manage the databases', 'previewDatabaseForbidden');
    }
    if (!clone && input.databaseIds && input.databaseIds.length) throw err(400, 'databaseIds needs options.database = clone', 'validation');
    if (options.env === 'all' && !actorCan(actor, 'sites.manage', target)) throw err(403, 'Every environment variable needs the right to manage the site', 'previewOptionForbidden');
    if (options.allowBlockedScan && !(actor.kind === 'staff' && actorCan(actor, 'sites.manage', target))) {
      throw err(403, 'Only the platform staff can preview code blocked by the analysis', 'previewOptionForbidden');
    }

    // 4. Settings and state.
    const settings = await platformSettings.get();
    const rp = settings.releasePreviews;
    if (!rp.enabled) throw err(409, 'Previews are disabled on this platform', 'previewsDisabled');
    const previewDomain = settings.preview.previewDomain;
    if (!previewDomain) throw err(409, 'No preview domain is configured on this platform', 'previewDomainMissing');
    setPreviewClaimDomain(previewDomain);
    const account = await db('hosting_accounts').where({ id: site.account_id }).first('status', 'tenant_id', 'node_id') as { status: string; tenant_id: number; node_id: number } | undefined;
    if (!account || account.status !== 'active') throw err(409, 'The account is not active', 'accountNotActive');
    // A preview must never reach a live database: a published port (external access) answers on the
    // host's public address, and with the egress filter off on every host address — no preview then.
    if (await liveDbExposed(settings.access.egressFilter, Number(account.node_id), site.account_id)) {
      throw err(409, 'A database server is reachable through a published port (external access): a preview could reach it', 'previewDbExposed');
    }
    if (clone && rp.dbCloneMaxMb <= 0) throw err(409, 'Database clones are disabled on this platform', 'previewDbCloneDisabled');
    if (site.status === 'stopped') throw err(409, 'The site is stopped', 'siteStopped');
    if (siteDeletions.has(site.id)) throw err(409, 'The site is being deleted', 'siteDeleting');
    if (rp.minIntervalSeconds > 0) {
      const last = await db('site_previews').where({ site_id: site.id }).orderBy('id', 'desc').first('created_at') as { created_at: Date | string } | undefined;
      const wait = last ? new Date(last.created_at).getTime() + rp.minIntervalSeconds * 1000 - deps.now() : 0;
      if (wait > 0) throw err(429, 'A preview of this site was started a moment ago', 'previewTooSoon', { retryAfterSeconds: Math.ceil(wait / 1000) });
    }

    // 5. Target checks.
    const repo = localPaths.repo(site.account_id, site.id);
    let scan: ScanSummary | null = null;
    if (release) {
      if (!release.commit_sha || !(await commitExists(repo, release.commit_sha).catch(() => false))) {
        throw err(409, 'This release has no commit to preview', 'releaseNotReady');
      }
      if (!(PREVIEWABLE_RELEASE_STATUSES as readonly string[]).includes(release.status)) throw err(409, 'This release cannot be previewed in its state', 'releaseNotReady');
      scan = json<ScanSummary | null>(release.scan, null);
      if (scan && (scan.blocked || scan.verdict === 'infected') && !options.allowBlockedScan) {
        throw err(409, 'The analysis blocked this release', 'scanBlocked');
      }
    } else {
      const dataPaths = (await db('site_data_paths').where({ site_id: site.id }).pluck('path')) as string[];
      const st = scanStaging(localPaths.siteStaging(site.account_id, site.slug), dataPaths);
      if (st.truncated) throw err(413, 'The staging holds too many files to be previewed', 'stagingTooLarge');
      if (st.fileCount === 0) throw err(409, 'The staging is empty', 'stagingEmpty');
    }

    // Database clone: which databases (explicit, else the env-referenced ones), within the size cap.
    let cloneDbs: PreviewDbCloneDatabase[] | null = null;
    if (clone) {
      cloneDbs = await resolveCloneSelection(site, input.databaseIds ?? null, via.dbReach ?? 'all', PREVIEW_DB_CLONE_MAX_DATABASES);
      const known = cloneDbs.reduce((a, d) => a + (d.sizeBytes ?? 0), 0);
      if (known > rp.dbCloneMaxMb * 1048576) {
        throw err(413, 'The databases are too large to be cloned', 'previewDbCloneTooLarge', { sizeBytes: known, maxMb: rp.dbCloneMaxMb });
      }
    }

    // 6. TTL.
    const ttl = input.ttlMinutes === undefined || input.ttlMinutes === null ? rp.defaultTtlMinutes : Number(input.ttlMinutes);
    const maxTtl = Math.min(rp.maxTtlMinutes, 1440);
    if (!Number.isInteger(ttl) || ttl < PREVIEW_TTL_MINUTES.min || ttl > maxTtl) {
      throw err(400, `ttlMinutes must be between ${PREVIEW_TTL_MINUTES.min} and ${maxTtl}`, 'validation', { min: PREVIEW_TTL_MINUTES.min, max: maxTtl });
    }
    const host = releasePreviewHost(site, release ? { kind: 'release', number: release.number } : { kind: 'staging' }, previewDomain);
    if (!host) throw err(409, 'No valid preview host name for this site', 'previewHostInvalid');

    // Warnings known before the build.
    const warnings = new Set<PreviewWarningCode>([clone ? 'dbCloneProductionData' : 'noDatabase', 'noMail']);
    if (await db('site_data_paths').where({ site_id: site.id }).first('id')) warnings.add('dataReadOnly');
    if (options.env === 'public' && await siteHasSecretEnv(site.id)) warnings.add('secretsHidden');
    if (settings.access.egressFilter !== 'strict') warnings.add('egressAllowed');
    if (!(await previewWildcardValid(previewDomain))) warnings.add('selfSignedCertificate');
    if (!(await accountSegmented(site.account_id))) warnings.add('notSegmented');
    if (scan && (scan.verdict !== 'clean' || scan.findings.length > 0)) warnings.add('scanWarnings');

    // 7. Transaction: caps, replacement, insert.
    const secret = crypto.randomBytes(32).toString('base64url');
    const now = deps.now();
    let created: PreviewRow;
    let replaced = null as PreviewRow | null;
    try {
      created = await db.transaction(async (trx) => {
        await trx('hosting_accounts').where({ id: site.account_id }).forUpdate().first('id');
        const old = await activePreviewOfSite(site.id, trx);
        const perAccount = Number((await trx('site_previews').where({ account_id: site.account_id }).whereIn('status', ACTIVE).count<{ n: string }[]>({ n: '*' }))[0]?.n ?? 0);
        const total = Number((await trx('site_previews').whereIn('status', ACTIVE).count<{ n: string }[]>({ n: '*' }))[0]?.n ?? 0);
        const freed = old ? 1 : 0;
        if (perAccount - freed >= rp.maxPerAccount) throw err(409, 'Too many previews running for this account', 'previewLimit', { max: rp.maxPerAccount });
        if (total - freed >= rp.maxTotal) throw err(409, 'The platform runs too many previews', 'previewCapacity');
        if (old) {
          await trx('site_previews').where({ id: old.id }).update({ status: 'stopping', stop_reason: 'replaced', updated_at: trx.fn.now() });
          replaced = old;
        }
        const [row] = await trx('site_previews').insert({
          site_id: site.id, account_id: site.account_id, tenant_id: site.tenant_id, target: input.target,
          release_id: release?.id ?? null, release_number: release?.number ?? null, commit_sha: release?.commit_sha ?? null,
          base: site.base, status: 'building', host, access_secret_sealed: seal('site-preview', secret),
          options: JSON.stringify(options), scan: scan ? JSON.stringify(scan) : null, warnings: JSON.stringify([...warnings].sort()),
          db_clone: cloneDbs ? JSON.stringify(initialClone(cloneDbs)) : null,
          created_by: await userId(actor), created_by_key: keyId, expires_at: new Date(now + ttl * 60_000),
        }).returning('*') as PreviewRow[];
        return row;
      });
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') throw err(409, 'Another preview of this site is starting', 'previewBusy');
      throw e;
    }

    // 8. After the commit.
    if (replaced) {
      emitPreview(replaced, 'stopping');
      previewBuilder.cancel((replaced as PreviewRow).id);
      void stopInternal((replaced as PreviewRow).id, 'replaced').catch((e) => logger.warn({ err: (e as Error).message }, 'preview: replaced one not stopped'));
    }
    previewBuilder.enqueue(created.id, site.id);
    await auditService.logReqAs(req, site.tenant_id, 'preview.start', {
      resourceType: 'site', resourcePath: String(site.id),
      details: {
        previewId: created.id, target: input.target, releaseId: release?.id ?? null, releaseNumber: release?.number ?? null, ttlMinutes: ttl, options,
        ...(cloneDbs ? { databaseIds: cloneDbs.map((d) => d.id) } : {}),
      },
    });
    emitPreview(created, 'building');

    // 9. Result.
    const result: PreviewStartResult = { preview: await onePreview(created.id), link: null };
    if (via.withLink && canShare(actor, site)) {
      const l = await createLink(created, 'share', actor, keyId);
      result.link = { url: claimUrl(created.host, l.token), expiresAt: l.expiresAt.toISOString(), kind: 'share' };
    }
    if (via.includeKey) {
      result.key = { header: PREVIEW_KEY_HEADER, value: secret };
      await auditService.logReqAs(req, site.tenant_id, 'preview.key', { resourceType: 'site', resourcePath: String(site.id), details: { previewId: created.id } });
    }
    return result;
  },

  /** The gate key of the running preview (keys: include_key on a preview already started). */
  async key(req: Request, actor: HostingActor, siteId: number, reach?: DbReach): Promise<{ header: string; value: string }> {
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    const row = await activeOrThrow(site.id);
    assertCloneAccess(actor, site, row, reach);
    await auditService.logReqAs(req, site.tenant_id, 'preview.key', { resourceType: 'site', resourcePath: String(site.id), details: { previewId: row.id } });
    return { header: PREVIEW_KEY_HEADER, value: openSecret('site-preview', row.access_secret_sealed) };
  },

  async stop(req: Request, actor: HostingActor, siteId: number): Promise<{ stopped: true }> {
    const site = await loadSite(actor, siteId, 'read');
    const target = siteTarget(site);
    if (!actorCan(actor, 'code.read', target) && !(actor.kind === 'staff' && actorCan(actor, 'sites.manage', target))) {
      assertReadsCode(actor, site);
    }
    const row = await activePreviewOfSite(site.id);
    if (!row) return { stopped: true };
    previewBuilder.cancel(row.id);
    await db('site_previews').where({ id: row.id }).whereIn('status', ACTIVE).update({ stop_reason: 'user', updated_at: db.fn.now() });
    await stopInternal(row.id, 'user');
    await auditService.logReqAs(req, site.tenant_id, 'preview.stop', { resourceType: 'site', resourcePath: String(site.id), details: { previewId: row.id } });
    return { stopped: true };
  },

  async extend(req: Request, actor: HostingActor, siteId: number, ttlMinutes: number): Promise<SitePreview> {
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    const rp = await platformSettings.section('releasePreviews');
    const maxTtl = Math.min(rp.maxTtlMinutes, 1440);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < PREVIEW_TTL_MINUTES.min || ttlMinutes > maxTtl) {
      throw err(400, `ttlMinutes must be between ${PREVIEW_TTL_MINUTES.min} and ${maxTtl}`, 'validation', { min: PREVIEW_TTL_MINUTES.min, max: maxTtl });
    }
    const row = await activeOrThrow(site.id, ['starting', 'running']);
    const cap = new Date(row.created_at).getTime() + PREVIEW_MAX_LIFETIME_MS;
    const expires = new Date(Math.min(previewDeps().now() + ttlMinutes * 60_000, cap));
    await db('site_previews').where({ id: row.id }).update({ expires_at: expires, updated_at: db.fn.now() });
    await auditService.logReqAs(req, site.tenant_id, 'preview.extend', {
      resourceType: 'site', resourcePath: String(site.id), details: { previewId: row.id, ttlMinutes, expiresAt: expires.toISOString() },
    });
    emitPreview(row, row.status);
    return onePreview(row.id);
  },

  /** One-shot share link (interstitial page + POST, 10 min). Clients: sites.manage (decision 9). */
  async shareLink(req: Request, actor: HostingActor, siteId: number, keyId: number | null = null, reach?: DbReach): Promise<PreviewLink> {
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    if (!canShare(actor, site)) throw err(403, 'Share links need the right to manage the site', 'previewShareForbidden');
    const row = await activeOrThrow(site.id);
    assertCloneAccess(actor, site, row, reach);
    const l = await createLink(row, 'share', actor, keyId);
    await auditService.logReqAs(req, site.tenant_id, 'preview.link', { resourceType: 'site', resourcePath: String(site.id), details: { previewId: row.id, kind: 'share' } });
    return { url: claimUrl(row.host, l.token), expiresAt: l.expiresAt.toISOString(), kind: 'share' };
  },

  /** Panel "Open": URL of a 60 s claim link consumed by its GET (never logged by the panel). */
  async openLink(req: Request, actor: HostingActor, siteId: number): Promise<string> {
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    const row = await activeOrThrow(site.id, ['starting', 'running']);
    assertCloneAccess(actor, site, row);
    const l = await createLink(row, 'open', actor, null);
    await auditService.logReqAs(req, site.tenant_id, 'preview.link', { resourceType: 'site', resourcePath: String(site.id), details: { previewId: row.id, kind: 'open' } });
    return claimUrl(row.host, l.token);
  },

  /** GET/HEAD of one path of the running preview (compare: + the live primary container, sites.manage). */
  async fetch(actor: HostingActor, siteId: number, q: {
    path: unknown; compare?: boolean; host?: 'preview' | 'live' | null; maxBytes?: number | null; method?: 'GET' | 'HEAD' | null;
  }, reach?: DbReach): Promise<PreviewFetchResult> {
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    const path = validatePreviewPath(q.path);
    if (!path) throw err(400, 'path must be an absolute path (/…, printable ASCII, no #)', 'validation');
    if (q.compare && !actorCan(actor, 'sites.manage', siteTarget(site))) throw err(403, 'Comparing with the live site needs the right to manage the site', 'previewCompareForbidden');
    const row = await activePreviewOfSite(site.id);
    if (!row || row.status !== 'running') throw err(409, 'No preview is running for this site', 'previewNotRunning');
    assertCloneAccess(actor, site, row, reach);
    const maxBytes = q.maxBytes === undefined || q.maxBytes === null ? PREVIEW_FETCH_DEFAULT_BYTES : Number(q.maxBytes);
    if (!Number.isInteger(maxBytes) || maxBytes < PREVIEW_FETCH_MIN_BYTES || maxBytes > PREVIEW_FETCH_MAX_BYTES) {
      throw err(400, `maxBytes must be between ${PREVIEW_FETCH_MIN_BYTES} and ${PREVIEW_FETCH_MAX_BYTES}`, 'validation');
    }
    const method = q.method === 'HEAD' ? 'HEAD' : 'GET';
    const which = q.host ?? (q.compare ? 'live' : 'preview');
    const host = which === 'live' ? await healthcheckHost(site.id) : row.host;
    const used = fetchSlots.get(site.id) ?? 0;
    if (used >= FETCH_PER_SITE) throw err(429, 'Two fetches already run for this preview', 'previewFetchBusy');
    fetchSlots.set(site.id, used + 1);
    try {
      const deps = previewDeps();
      const [preview, live] = await Promise.all([
        deps.fetch(releasePreviewContainer(site.id, row.id), path, { host, method, maxBytes }),
        q.compare ? deps.fetch(siteContainer(site.id), path, { host, method, maxBytes }) : Promise.resolve(undefined),
      ]);
      logger.debug({ siteId: site.id, previewId: row.id, path, compare: !!q.compare }, 'preview fetch');
      const out: PreviewFetchResult = { path, host, preview };
      if (live) {
        out.live = live;
        out.sameStatus = live.status === preview.status;
        out.sameBody = live.sha256 !== null && live.sha256 === preview.sha256;
      }
      return out;
    } finally {
      const n = (fetchSlots.get(site.id) ?? 1) - 1;
      if (n <= 0) fetchSlots.delete(site.id); else fetchSlots.set(site.id, n);
    }
  },

  /** Databases a clone of this site may copy (databases.manage; a key: within its reach), env-referenced ones flagged. */
  async databaseCandidates(actor: HostingActor, siteId: number, reach: DbReach = 'all'): Promise<PreviewDatabaseCandidate[]> {
    const site = await loadSite(actor, siteId, 'read');
    if (!actorCan(actor, 'databases.manage', siteTarget(site))) throw err(403, 'A database clone needs the right to manage the databases', 'previewDatabaseForbidden');
    return cloneCandidates(site, reach);
  },

  /**
   * Worker / hooks: an active preview that could reach a live database through a published port
   * (liveDbExposed) is failed (dbIsolationLost). Never throws.
   */
  async enforceDbIsolation(): Promise<number> {
    try {
      const egress = (await platformSettings.section('access')).egressFilter;
      const rows = await db('site_previews as p').join('hosting_accounts as a', 'a.id', 'p.account_id')
        .whereIn('p.status', ACTIVE).select('p.id', 'p.account_id', 'a.node_id') as Array<{ id: number; account_id: number; node_id: number }>;
      let n = 0;
      for (const r of rows) {
        if (!(await liveDbExposed(egress, Number(r.node_id), Number(r.account_id)))) continue;
        previewBuilder.cancel(r.id);
        await failPreview(r.id, 'dbIsolationLost', 'Un serveur de base est joignable par un port publié (accès externe) : aperçu arrêté').catch(() => undefined);
        n++;
      }
      return n;
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'preview: database isolation not checked');
      return 0;
    }
  },

  /** B9: the previews of an access key are stopped BEFORE it is deleted / disabled. Never throws. */
  async stopForKey(keyId: number): Promise<number> {
    try {
      const rows = await db('site_previews').where({ created_by_key: keyId }).whereIn('status', ACTIVE).select('id') as Array<{ id: number }>;
      for (const r of rows) {
        previewBuilder.cancel(r.id);
        await db('site_previews').where({ id: r.id }).whereIn('status', ACTIVE).update({ status: 'stopping', stop_reason: 'key', updated_at: db.fn.now() });
        await stopInternal(r.id, 'key').catch((e) => logger.warn({ err: (e as Error).message, previewId: r.id }, 'preview: key stop failed'));
      }
      return rows.length;
    } catch (e) {
      logger.warn({ err: (e as Error).message, keyId }, 'preview: previews of a key not stopped');
      return 0;
    }
  },

  /** Site / account deletion (after lockForTeardown): cancels and waits the builds, stops and cleans (siteDeleted). */
  async teardownSite(siteId: number): Promise<void> {
    await previewBuilder.cancelSite(siteId, 30_000);
    const rows = await db('site_previews').where({ site_id: siteId }).whereNull('cleaned_at').select('id') as Array<{ id: number }>;
    for (const r of rows) {
      await db('site_previews').where({ id: r.id }).whereIn('status', ACTIVE).update({ status: 'stopping', stop_reason: 'siteDeleted', updated_at: db.fn.now() });
      await stopInternal(r.id, 'siteDeleted').catch((e) => logger.warn({ err: (e as Error).message, previewId: r.id }, 'preview: teardown stop failed'));
    }
  },

  /** Boot: interrupted builds fail, stopping ones are finished, expired ones stopped BEFORE the first edge sync. */
  async recoverAtBoot(): Promise<void> {
    try {
      const d = (await platformSettings.section('preview')).previewDomain;
      setPreviewClaimDomain(d);
    } catch { /* settings unreadable: claim posts refused until the worker reads them */ }
    const now = new Date(previewDeps().now());
    // Synchronous DB marks first: the edge serves starting | running rows only, so an expired
    // preview is out of the first sync whatever the cleanup below takes.
    await db('site_previews').whereIn('status', ['starting', 'running']).where('expires_at', '<=', now)
      .update({ status: 'stopping', stop_reason: 'expired', updated_at: db.fn.now() });
    // building AND starting: only the in-process builder moves a row on (starting → running after
    // the readiness check), and it died with the panel; a starting row would stay starting until
    // it expires (the worker leaves a row with a running container alone).
    await db('site_previews').whereIn('status', ['building', 'starting'])
      .update({ status: 'failed', error_code: 'interrupted', error: 'Construction interrompue (redémarrage du panel)', stop_reason: 'failed', updated_at: db.fn.now() });
    const toClean = await db('site_previews').whereIn('status', ['stopping', 'failed']).whereNull('cleaned_at').pluck('id') as number[];
    void (async () => {
      for (const id of toClean) await stopInternal(id, 'expired').catch(() => undefined);
      // Clone servers / private networks left by a preview that no longer needs them.
      const { sweepClones } = await import('./previewExpiry');
      await sweepClones();
    })();
  },

  // ── claim (public, no session: previewClaim.routes.ts) ──

  /** GET with an 'open' token: consumed atomically. null = unknown / used / expired / wrong host / stopped. */
  async consumeClaim(kind: 'open' | 'share', token: string, host: string): Promise<{ previewId: number; secret: string; tenantId: number; siteId: number } | null> {
    if (!TOKEN_RE.test(token)) return null;
    const r = await db.raw(`
      UPDATE site_preview_links l SET used_at = now()
      FROM site_previews p
      WHERE l.preview_id = p.id AND l.token_hash = ? AND l.kind = ? AND l.used_at IS NULL AND l.expires_at > now()
        AND p.host = ? AND p.status IN ('starting','running') AND p.expires_at > now()
      RETURNING p.id, p.access_secret_sealed, p.tenant_id, p.site_id`, [tokenHash(token), kind, host.toLowerCase()]);
    const row = (r.rows ?? r)[0] as { id: number; access_secret_sealed: string; tenant_id: number; site_id: number } | undefined;
    if (!row) return null;
    try {
      return { previewId: row.id, secret: openSecret('site-preview', row.access_secret_sealed), tenantId: row.tenant_id, siteId: row.site_id };
    } catch {
      return null;
    }
  },

  /** Kind of an unconsumed, valid link (GET: an 'open' link is consumed, a 'share' one shows the interstitial). */
  async linkKind(token: string, host: string): Promise<'open' | 'share' | null> {
    if (!TOKEN_RE.test(token)) return null;
    const row = await db('site_preview_links as l').join('site_previews as p', 'p.id', 'l.preview_id')
      .where({ 'l.token_hash': tokenHash(token), 'p.host': host.toLowerCase() }).whereNull('l.used_at')
      .first('l.kind') as { kind: 'open' | 'share' } | undefined;
    return row?.kind ?? null;
  },
};

export type PreviewService = typeof previewService;
