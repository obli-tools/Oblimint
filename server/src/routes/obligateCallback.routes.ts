import { Router } from 'express';
import type { Request } from 'express';
import crypto from 'crypto';
import { APP_COLOR, MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../db';
import { regenerateSession, stampCredentialVersion } from '../utils/session';
import {
  obligateService, applyObligatePreferences, type ObligateRoster, type ObligateUserAssertion,
} from '../services/obligate.service';
import { tenantService, refuseSignInWithoutTenant } from '../services/tenant.service';
import { appConfigService } from '../services/appConfig.service';
import { permissionSetService } from '../services/permissionSet.service';
import { CLIENT_MEMBERSHIP_ROLE } from '../services/permission.service';
import { auditService } from '../services/audit.service';
import { dashboardService } from '../services/dashboard.service';
import { forgetSessionUser } from '../middleware/sessionUserGuard';
import { clientAddress } from '../utils/clientIp';
import { logger } from '../utils/logger';
import { requestPanelRole, type PanelHostRole } from '../services/panelHosts';

// Ported from Obliance's obligateCallback.routes.ts (same paths, same
// shapes), without the desktop SSO flow, the SSO re-authentication (lot O),
// device links and teams. Mounted on /auth (browser redirects) and on
// /api/auth (JSON + Obligate → app calls). Accounts of kind 'client' never
// take part: getLinkedLocalUserId ignores them, provisioning only ever
// creates staff og_ accounts.

const router = Router({ caseSensitive: true }); // like every router of /auth and /api (app.ts)

/** Public origin of the OAuth redirect_uri — only one this app is really published under. */
async function resolvePublicOrigin(req: Request): Promise<string | null> {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return null;
  const origin = await obligateService.verifyPublicOrigin(`${protocol}://${host}`);
  if (!origin) {
    logger.warn({ protocol, host },
      'Obligate SSO: request origin is not a public URL of this app (APP_URL, CLIENT_ORIGIN, panel hostname or its base URL in Obligate)');
  }
  return origin;
}

/**
 * Tenant memberships of an SSO identity as Obligate grants them (verified
 * assertion at sign-in, Obligate's roster on a confirmed sync). With `prune`
 * (og_ accounts, whose access Obligate owns) also removes what Obligate no
 * longer grants. Returns true when a tenant row was removed.
 */
async function applySsoMemberships(
  localUserId: number,
  grant: { tenants: unknown },
  platformRole: 'admin' | 'user',
  prune: boolean,
): Promise<boolean> {
  const tenants = Array.isArray(grant.tenants) ? grant.tenants as Array<{ slug?: unknown; role?: unknown }> : [];
  const keep = new Set<number>();
  for (const t of tenants) {
    if (!t || typeof t.slug !== 'string') continue;
    const tenant = await db('tenants').where({ slug: t.slug }).first('id') as { id: number } | undefined;
    if (!tenant) continue;
    keep.add(tenant.id);
    // Raw permission-set slug from Obligate; an unknown slug gives no capability.
    const roleSlug = typeof t.role === 'string' && t.role.length > 0 && t.role.length <= 64 ? t.role : 'user';
    await db('user_tenants')
      .insert({ user_id: localUserId, tenant_id: tenant.id, role: roleSlug })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role: roleSlug });
  }
  // All-tenants admin → master-tenant membership (deterministic landing tenant).
  if (platformRole === 'admin') {
    keep.add(MASTER_TENANT_ID);
    await db('user_tenants')
      .insert({ user_id: localUserId, tenant_id: MASTER_TENANT_ID, role: 'admin' })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role: 'admin' });
  }
  if (!prune) return false;
  const keepIds = [...keep];
  const staleTenants = await db('user_tenants')
    .where({ user_id: localUserId })
    .modify((q) => { if (keepIds.length) q.whereNotIn('tenant_id', keepIds); })
    .pluck('tenant_id') as number[];
  if (staleTenants.length > 0) {
    await db('user_tenants').where({ user_id: localUserId }).whereIn('tenant_id', staleTenants).del();
    logger.info({ localUserId, tenantIds: staleTenants }, 'Obligate SSO: tenant access no longer granted by Obligate — removed');
    return true;
  }
  return false;
}

/**
 * Provision or sync a staff user from a verified Obligate assertion, then
 * open the session (new id). Returns the local user id. Obligate owns the
 * platform role of SSO accounts ('admin' = All-tenants admin there).
 */
/**
 * How the user authenticated at Obligate (RFC 8176 amr, newer Obligate
 * builds): 'otp' present → a TOTP is enrolled there; a non-empty amr without
 * it → none. Absent (older Obligate): unknown, left as it is. Read by the
 * sensitive actions (an SSO approver needs a TOTP at Obligate).
 */
async function noteSsoTotpFromAmr(localUserId: number, amr: unknown): Promise<void> {
  if (!Array.isArray(amr) || amr.length === 0) return;
  try {
    await db('users').where({ id: localUserId, foreign_source: 'obligate' }).update({ sso_totp_enabled: amr.includes('otp') });
  } catch { /* informational */ }
}

async function provisionObligateUser(assertion: ObligateUserAssertion, req: Request): Promise<number> {
  const platformRole = assertion.role === 'admin' ? 'admin' : 'user';
  const obligateUserId = assertion.obligateUserId;
  if (!Number.isSafeInteger(obligateUserId) || obligateUserId <= 0
    || typeof assertion.username !== 'string' || assertion.username.length === 0 || assertion.username.length > 96) {
    throw new Error('SSO sign-in refused: malformed assertion (obligateUserId / username)');
  }

  // Which local account? From OUR records only (never linkedLocalUserId).
  let localUserId = (await obligateService.getLinkedLocalUserId(obligateUserId)) ?? 0;
  const claimedLocalUserId = assertion.linkedLocalUserId ?? null;
  if (claimedLocalUserId && claimedLocalUserId !== localUserId) {
    logger.warn({ obligateUserId, claimedLocalUserId, linkedLocalUserId: localUserId || null },
      'Obligate SSO: linkedLocalUserId does not match our link records — ignored');
    void auditService.log({
      tenantId: MASTER_TENANT_ID,
      action: 'sso.link_mismatch_ignored',
      resourceType: 'user',
      resourcePath: localUserId ? String(localUserId) : undefined,
      ipAddress: clientAddress(req).ip || undefined,
      details: { obligateUserId, claimedLocalUserId, linkedLocalUserId: localUserId || null, username: assertion.username },
    });
  }

  let ssoOwned = false;
  let demoted = false;
  if (localUserId) {
    const existing = await db('users').where({ id: localUserId })
      .first('foreign_source', 'is_active', 'role', 'kind') as { foreign_source: string | null; is_active: boolean; role: string; kind: string } | undefined;
    if (existing?.kind === 'client') throw new Error('SSO sign-in refused: client accounts never use SSO');
    ssoOwned = existing?.foreign_source === 'obligate';
    demoted = existing?.role === 'admin' && platformRole !== 'admin';
    if (existing && existing.is_active === false && existing.foreign_source !== 'obligate') {
      throw Object.assign(new Error(`SSO sign-in refused: linked local user #${localUserId} is disabled`), { ssoErrorCode: 'account_disabled' });
    }
    const update: Record<string, unknown> = {
      email: assertion.email,
      display_name: assertion.displayName,
      role: platformRole,
      updated_at: new Date(),
    };
    const reactivated = existing?.foreign_source === 'obligate' && existing.is_active === false;
    if (reactivated) update.is_active = true;
    await db('users').where({ id: localUserId }).update(update);
    forgetSessionUser(localUserId);
    if (reactivated) {
      void auditService.log({
        tenantId: MASTER_TENANT_ID, action: 'sso.account_reactivated', resourceType: 'user',
        resourcePath: String(localUserId), ipAddress: clientAddress(req).ip || undefined, details: { obligateUserId },
      });
    }
    await db('sso_foreign_users')
      .insert({ foreign_source: 'obligate', foreign_user_id: obligateUserId, local_user_id: localUserId })
      .onConflict(['foreign_source', 'foreign_user_id'])
      .merge({ local_user_id: localUserId });
    if (claimedLocalUserId !== localUserId) obligateService.reportProvision(obligateUserId, localUserId).catch(() => {});
  } else {
    const [newUser] = await db('users')
      .insert({
        username: `og_${assertion.username}`,
        display_name: assertion.displayName || assertion.username,
        email: assertion.email,
        role: platformRole,
        kind: 'staff',
        is_active: true,
        foreign_source: 'obligate',
        foreign_id: obligateUserId,
      })
      .returning('id') as Array<{ id: number }>;
    localUserId = newUser.id;
    ssoOwned = true;
    await db('sso_foreign_users')
      .insert({ foreign_source: 'obligate', foreign_user_id: obligateUserId, local_user_id: localUserId })
      .onConflict(['foreign_source', 'foreign_user_id'])
      .merge({ local_user_id: localUserId });
    obligateService.reportProvision(obligateUserId, localUserId).catch(() => {});
  }

  const tenantRemoved = await applySsoMemberships(localUserId, { tenants: assertion.tenants }, platformRole, ssoOwned);
  if (demoted || tenantRemoved) {
    const { killSessionsForUser } = await import('../services/userSessions.service');
    await killSessionsForUser(localUserId, demoted ? 'role_demoted' : 'tenant_access_removed');
  }

  if (assertion.preferences) await applyObligatePreferences(localUserId, assertion.preferences);

  const firstTenantId = await tenantService.sessionTenantFor(localUserId, platformRole);
  if (firstTenantId === null) {
    await refuseSignInWithoutTenant(req, { id: localUserId, username: assertion.username }, 'sso');
    throw Object.assign(new Error(`SSO sign-in refused: local user #${localUserId} belongs to no tenant`), { ssoErrorCode: 'no_tenant' });
  }

  // New session id (session fixation); only the cross-app tenant hint survives.
  await regenerateSession(req, ['requestedTenantSlug']);
  req.session.userId = localUserId;
  const user = await db('users').where({ id: localUserId }).first('username') as { username: string } | undefined;
  if (user) {
    req.session.username = user.username;
    req.session.role = platformRole;
  }

  let resolvedTenantId: number | null = null;
  const requestedSlug = req.session.requestedTenantSlug;
  if (requestedSlug) {
    const match = platformRole === 'admin'
      ? await db('tenants').where({ slug: requestedSlug }).first('id') as { id: number } | undefined
      : await db('tenants as t')
        .join('user_tenants as ut', 'ut.tenant_id', 't.id')
        .where({ 't.slug': requestedSlug, 'ut.user_id': localUserId })
        .first('t.id') as { id: number } | undefined;
    if (match) resolvedTenantId = match.id;
    delete req.session.requestedTenantSlug;
  }
  req.session.currentTenantId = resolvedTenantId ?? firstTenantId;
  await stampCredentialVersion(req);
  await noteSsoTotpFromAmr(localUserId, assertion.amr);

  void auditService.log({
    tenantId: req.session.currentTenantId,
    userId: localUserId,
    action: 'auth.login',
    resourceType: 'user',
    resourcePath: String(localUserId),
    details: { username: user?.username, via: 'sso' },
    ipAddress: clientAddress(req).ip || undefined,
  });
  return localUserId;
}

/** GET /auth/callback?code=&state= — Obligate's redirect after authentication. */
router.get('/callback', async (req, res) => {
  try {
    // Client space: never through Obligate (clients are local accounts).
    if ((await requestPanelRole(req)).role === 'client') { res.redirect('/login?error=wrong_panel_host'); return; }
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || typeof code !== 'string') {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }
    const expectedState = req.session?.oauthState;
    if (!expectedState || typeof state !== 'string' || state.length !== expectedState.length
      || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
      logger.warn({ hasExpected: !!expectedState }, 'Obligate callback: state mismatch — possible CSRF');
      res.redirect('/login?error=sso_failed');
      return;
    }
    delete (req.session as any).oauthState;

    const storedRedirectUri = req.session.oauthRedirectUri;
    delete req.session.oauthRedirectUri;
    let redirectUri: string;
    if (typeof storedRedirectUri === 'string' && storedRedirectUri) {
      redirectUri = storedRedirectUri;
    } else {
      const origin = await resolvePublicOrigin(req);
      if (!origin) { res.redirect('/login?error=sso_failed'); return; }
      redirectUri = `${origin}/auth/callback`;
    }

    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: exchange returned null — code invalid/expired or redirect_uri mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }

    const localUserId = await provisionObligateUser(assertion, req);
    logger.info(`Obligate SSO: user ${assertion.username} (obligate #${assertion.obligateUserId}) → local #${localUserId}`);

    req.session.save((err) => {
      if (err) { logger.error(err, 'Session save failed'); res.redirect('/login?error=sso_failed'); return; }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #30363d;border-top-color:${APP_COLOR};border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"><div class="d"></div><div>Signing in...</div></div></body></html>`);
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    const ssoErrorCode = (err as { ssoErrorCode?: string } | null)?.ssoErrorCode;
    const code = ssoErrorCode === 'account_disabled' || ssoErrorCode === 'no_tenant' ? ssoErrorCode : 'sso_failed';
    res.redirect(`/login?error=${code}`);
  }
});

/** GET /auth/sso-redirect — server-side redirect to Obligate /authorize. */
router.get('/sso-redirect', async (req, res) => {
  try {
    if ((await requestPanelRole(req)).role === 'client') { res.redirect('/login'); return; }
    const requestedTenant = req.query.tenant;
    const tenantSlug = typeof requestedTenant === 'string' && /^[a-z0-9-]{1,64}$/.test(requestedTenant) ? requestedTenant : null;

    const raw = await appConfigService.getObligateRaw();
    const enabled = (await appConfigService.get('obligate_enabled')) === 'true';
    const clientId = obligateService.authorizeClientId(raw);
    if (!enabled || !raw.url || !clientId) { res.redirect('/login'); return; }
    try {
      const healthRes = await fetch(`${raw.url}/health`, { signal: AbortSignal.timeout(2000) });
      if (!healthRes.ok) { res.redirect('/login?error=sso_failed'); return; }
    } catch {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const selfUrl = await resolvePublicOrigin(req);
    if (!selfUrl) {
      const retried = req.query.canon === '1';
      const canonical = retried ? null : await obligateService.getCanonicalOrigin();
      if (canonical) {
        const target = new URL('/auth/sso-redirect', canonical);
        target.searchParams.set('canon', '1');
        if (tenantSlug) target.searchParams.set('tenant', tenantSlug);
        res.redirect(target.toString());
        return;
      }
      res.redirect('/login?error=sso_failed');
      return;
    }
    if (tenantSlug) req.session.requestedTenantSlug = tenantSlug;
    if (raw.url.replace(/\/$/, '') === selfUrl) {
      logger.error({ obligateUrl: raw.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent loop');
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;
    req.session.oauthRedirectUri = redirectUri;
    const obligateUrl = `${raw.url}/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    req.session.save((err) => {
      if (err) { logger.error(err, 'sso-redirect: session save failed'); res.redirect('/login?error=sso_failed'); return; }
      res.redirect(obligateUrl);
    });
  } catch {
    res.redirect('/login');
  }
});

/** GET /api/auth/app-info — Obligate (Bearer) reads tenants + permission sets for its mapping UI. */
router.get('/app-info', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }
    const tenants = await db('tenants').select('name', 'slug').orderBy('name') as Array<{ name: string; slug: string }>;
    // SSO identities are staff: the client set (client logins only, M12) is not offered.
    const permissionSets = (await permissionSetService.getAll()).filter((p) => p.slug !== CLIENT_MEMBERSHIP_ROLE)
      .map((p) => ({ slug: p.slug, name: p.name, isDefault: p.isDefault }));
    res.json({
      success: true,
      data: { roles: ['admin', 'user'], teams: [], tenants: tenants.map((t) => ({ slug: t.slug, name: t.name })), permissionSets },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed to fetch app info' });
  }
});

/** GET /api/auth/dashboard-stats — counters shown on Obligate's dashboard (Bearer). */
router.get('/dashboard-stats', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }
    const s = await dashboardService.platformCounters();
    res.json({ success: true, data: { stats: [
      { label: 'Accounts', value: s.accounts, color: APP_COLOR },
      { label: 'Sites', value: s.sites, color: '#58a6ff' },
      { label: 'Workspaces', value: s.tenants, color: '#d29922' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-config — public, for the login page. Also tells which
 * address this is (panelRole: 'client' = client space, no SSO there) and the
 * client space address, if any.
 */
router.get('/sso-config', async (req, res) => {
  let host: { panelRole: PanelHostRole | null; clientPanelUrl: string | null; passwordResetAvailable: boolean } = { panelRole: null, clientPanelUrl: null, passwordResetAvailable: false };
  try {
    const { role, hosts } = await requestPanelRole(req);
    // "Forgot your password?" is offered when the platform can e-mail a link (local accounts only).
    const { transactionalMailReady } = await import('../services/mail/transactional');
    host = { panelRole: role, clientPanelUrl: hosts.client ? `https://${hosts.client}` : null, passwordResetAvailable: !!(hosts.admin || hosts.client) && await transactionalMailReady() };
  } catch { /* host names unreadable: plain panel */ }
  if (host.panelRole === 'client') {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false, ...host } });
    return;
  }
  try {
    res.json({ success: true, data: { ...(await obligateService.getSsoConfig()), ...host } });
  } catch {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false, ...host } });
  }
});

/** GET /api/auth/sso-logout-url — Obligate logout URL, back to a VERIFIED origin of ours. */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) { res.json({ success: true, data: null }); return; }
    const origin = (await resolvePublicOrigin(req)) ?? (await obligateService.getCanonicalOrigin());
    const redirect = origin ? `${origin}/login` : '/login';
    res.json({ success: true, data: `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirect)}` });
  } catch {
    res.json({ success: true, data: null });
  }
});

/** GET /api/auth/connected-apps — cross-app switcher (signed-in users). */
router.get('/connected-apps', async (req, res) => {
  try {
    if (!req.session?.userId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const row = await db('users').where({ id: req.session.userId }).first('foreign_source', 'foreign_id', 'kind', 'role') as
      { foreign_source: string | null; foreign_id: number | null; kind: string; role: string } | undefined;
    const obligateUserId = row?.foreign_source === 'obligate' && row.foreign_id ? row.foreign_id : null;
    // Without an Obligate identity the list is the operator's UNSCOPED app
    // list (names, internal base URLs): only a platform administrator sees
    // it, never a hosting client or a local staff member.
    if (!obligateUserId && !(row?.kind !== 'client' && row?.role === 'admin')) {
      res.json({ success: true, data: [] });
      return;
    }
    res.json({ success: true, data: await obligateService.getConnectedApps(obligateUserId) });
  } catch {
    res.json({ success: true, data: [] });
  }
});

// ── /api/auth/sso-user-sync ──────────────────────────────────────────────────

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const SYNC_ACTIONS = ['deactivate', 'reactivate', 'delete', 'update-role', 'credentials-changed'] as const;
type SyncAction = typeof SYNC_ACTIONS[number];
type SyncAudit = (outcome: string, details?: Record<string, unknown>) => Promise<void>;

function syncAuditFor(
  obligateId: number, pushedPointer: number | null, localId: number | null, action: SyncAction,
  ip: string | undefined, extra: Record<string, unknown> = {},
): SyncAudit {
  return (outcome, details = {}) => auditService.log({
    tenantId: MASTER_TENANT_ID,
    action: `sso_sync.${outcome}`,
    resourceType: 'user',
    resourcePath: localId !== null ? String(localId) : (pushedPointer !== null ? String(pushedPointer) : undefined),
    ipAddress: ip,
    details: {
      obligateUserId: obligateId, remoteUserId: pushedPointer, ...(localId !== null ? { localUserId: localId } : {}),
      requestedAction: action, ...extra, ...details,
    },
  });
}

type SyncUser = { id: number; username: string; role: string; is_active: boolean };

/** The og_ account OUR records link to this identity (never a local / client account). */
async function linkedSsoAccount(obligateId: number, expectedId?: number): Promise<{ user: SyncUser | null; reason: string; linkedId: number | null }> {
  const linkedId = await obligateService.getLinkedLocalUserId(obligateId);
  if (!linkedId) return { user: null, reason: 'not_linked', linkedId };
  if (expectedId !== undefined && linkedId !== expectedId) return { user: null, reason: 'relinked', linkedId };
  const row = await db('users').where({ id: linkedId })
    .first('id', 'username', 'role', 'is_active', 'foreign_source', 'foreign_id', 'kind') as
    (SyncUser & { foreign_source: string | null; foreign_id: number | null; kind: string }) | undefined;
  if (!row || row.kind === 'client' || row.foreign_source !== 'obligate' || Number(row.foreign_id) !== obligateId) {
    return { user: null, reason: 'not_an_sso_account', linkedId };
  }
  return { user: row, reason: '', linkedId };
}

type SyncResult = 'done' | { retry: 'still_on_roster' | 'identity_still_at_obligate' | 'epoch_unavailable' | 'roster_unavailable' | 'throttled' };

async function deactivateConfirmed(localId: number, wasActive: boolean): Promise<void> {
  if (wasActive) await db('users').where({ id: localId }).update({ is_active: false, updated_at: new Date() });
  const { killSessionsForUser } = await import('../services/userSessions.service');
  await killSessionsForUser(localId, 'user_disabled');
}

/**
 * Apply a sync action ONLY as far as Obligate itself (read by us) confirms it
 * (roster; for 'delete' also the mfa-epoch 404). 'reactivate' and promotions
 * are never applied by a push: the next SSO sign-in does it.
 */
async function applyConfirmedSync(
  obligateId: number, localId: number, action: SyncAction, roster: ObligateRoster, audit: SyncAudit,
): Promise<SyncResult> {
  const { user } = await linkedSsoAccount(obligateId, localId);
  if (!user) return 'done';
  const current = roster.get(obligateId);
  switch (action) {
    case 'deactivate': {
      if (current) { await audit('unconfirmed', { username: user.username }); return 'done'; }
      await deactivateConfirmed(localId, user.is_active !== false);
      await audit('deactivated', { username: user.username });
      return 'done';
    }
    case 'reactivate': {
      if (!current) { await audit('unconfirmed', { username: user.username }); return 'done'; }
      if (user.is_active === false) await audit('reactivation_deferred', { username: user.username });
      return 'done';
    }
    case 'delete': {
      if (current) return { retry: 'still_on_roster' };
      const e = await obligateService.mfaEpochForPush(obligateId);
      if (e.kind === 'throttled') return { retry: 'throttled' };
      if (e.kind === 'unavailable') return { retry: 'epoch_unavailable' };
      if (e.kind === 'ok') {
        if (user.is_active !== false) {
          await deactivateConfirmed(localId, true);
          await audit('deactivated', { username: user.username, deleteDeferred: true });
        }
        return { retry: 'identity_still_at_obligate' };
      }
      await db('sso_foreign_users').where({ local_user_id: localId }).del();
      await db('users').where({ id: localId }).del();
      const { killSessionsForUser } = await import('../services/userSessions.service');
      await killSessionsForUser(localId, 'user_deleted');
      await audit('deleted', { username: user.username });
      return 'done';
    }
    case 'credentials-changed':
      return applyCredentialsChanged(obligateId, localId, audit);
    case 'update-role': {
      if (current?.role === 'admin') {
        if (user.role !== 'admin') await audit('promotion_deferred', { username: user.username, currentRole: user.role });
        return 'done';
      }
      const wasAdmin = user.role === 'admin';
      if (wasAdmin) await db('users').where({ id: localId }).update({ role: 'user', updated_at: new Date() });
      forgetSessionUser(localId);
      const tenantRemoved = await applySsoMemberships(localId, { tenants: current?.tenants ?? [] }, 'user', true);
      if (wasAdmin || tenantRemoved) {
        const { killSessionsForUser } = await import('../services/userSessions.service');
        await killSessionsForUser(localId, wasAdmin ? 'role_demoted' : 'tenant_access_removed');
        await audit('demoted', {
          username: user.username, before: user.role, after: 'user', rosterRole: current?.role ?? null, tenantAccessRemoved: tenantRemoved,
        });
      }
      return 'done';
    }
  }
  return 'done';
}

/**
 * credentials-changed: the epoch is re-read from Obligate by us. Oblimint has
 * no phone keys: an identity still active changes nothing; one no longer
 * active here (active:false, or 404 + off the roster) is deactivated.
 */
async function applyCredentialsChanged(obligateId: number, localId: number, audit: SyncAudit): Promise<SyncResult> {
  const { user } = await linkedSsoAccount(obligateId, localId);
  if (!user) return 'done';
  const e = await obligateService.mfaEpochForPush(obligateId);
  if (e.kind === 'throttled') return { retry: 'throttled' };
  if (e.kind === 'unavailable') return { retry: 'epoch_unavailable' };
  if (e.kind === 'ok' && e.value.active) return 'done';
  if (e.kind === 'not_found') {
    const rr = await obligateService.rosterForPush();
    if (rr.kind === 'throttled') return { retry: 'throttled' };
    if (rr.kind === 'unavailable') return { retry: 'roster_unavailable' };
    if (rr.roster.has(obligateId)) {
      await audit('unconfirmed', { username: user.username, reason: 'epoch_not_found_but_listed' });
      return 'done';
    }
  }
  if (user.is_active !== false) {
    const reason = e.kind === 'ok' ? 'inactive_at_obligate' : 'gone_at_obligate';
    await deactivateConfirmed(localId, true);
    await audit('deactivated', { username: user.username, reason });
  }
  return 'done';
}

export const SYNC_RECHECK_DELAYS_MS: number[] = [15_000, 60_000, 180_000];
const pendingSyncRechecks = new Set<string>();

function scheduleSyncRecheck(obligateId: number, localId: number, action: SyncAction, audit: SyncAudit): void {
  const key = `${localId}:${action}`;
  if (pendingSyncRechecks.has(key)) return;
  pendingSyncRechecks.add(key);
  const attempt = (i: number): void => {
    if (i >= SYNC_RECHECK_DELAYS_MS.length) {
      pendingSyncRechecks.delete(key);
      void audit('recheck_expired');
      return;
    }
    setTimeout(async () => {
      let outcome: SyncResult = { retry: 'roster_unavailable' };
      try {
        const rr = await obligateService.rosterForPush();
        if (rr.kind === 'ok') outcome = await applyConfirmedSync(obligateId, localId, action, rr.roster, audit);
      } catch (err) {
        logger.error(err, 'SSO sync: re-check failed');
      }
      if (outcome === 'done') pendingSyncRechecks.delete(key);
      else attempt(i + 1);
    }, SYNC_RECHECK_DELAYS_MS[i]).unref();
  };
  attempt(0);
}

const SYNC_BURST_WINDOW_MS = 60_000;
const SYNC_BURST_THRESHOLD = 30;
let syncWindow = { start: 0, count: 0, reported: false };
function noteSyncCall(ip: string | undefined): void {
  const now = Date.now();
  if (now - syncWindow.start > SYNC_BURST_WINDOW_MS) syncWindow = { start: now, count: 0, reported: false };
  syncWindow.count++;
  if (syncWindow.count > SYNC_BURST_THRESHOLD && !syncWindow.reported) {
    syncWindow.reported = true;
    logger.warn({ count: syncWindow.count, ip }, 'SSO sync: burst of sso-user-sync calls — check who holds the Obligate API key');
    void auditService.log({ tenantId: MASTER_TENANT_ID, action: 'sso_sync.burst', ipAddress: ip, details: { count: syncWindow.count } });
  }
}

const SPARSE_AUDIT_MS = 5 * 60_000;
const sparseAudits = new Map<string, number>();
function sparseAudit(key: string): boolean {
  const now = Date.now();
  const last = sparseAudits.get(key);
  if (last !== undefined && now - last < SPARSE_AUDIT_MS) return false;
  if (sparseAudits.size >= 10_000) sparseAudits.clear();
  sparseAudits.set(key, now);
  return true;
}

const RETRY_ERRORS: Record<string, string> = {
  epoch_unavailable: 'Obligate MFA epoch unavailable',
  roster_unavailable: 'Obligate roster unavailable',
  throttled: 'Too many sync pushes, retry later',
};

/**
 * POST /api/auth/sso-user-sync — Obligate (Bearer) pushes a user change.
 * Body: { obligateUserId, obligateUsername, remoteUserId: number | null, action, role?, mfaEpoch? }
 * The Bearer may be public: the account is resolved from OUR records only,
 * remoteUserId is informational, and every action is applied only as far as
 * Obligate's roster (read by us) confirms it.
 */
router.post('/sso-user-sync', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const obligateId = positiveInt(body.obligateUserId);
    const action = SYNC_ACTIONS.find((a) => a === body.action) as SyncAction | undefined;
    const role = typeof body.role === 'string' ? body.role : undefined;
    const pointerSent = body.remoteUserId !== undefined && body.remoteUserId !== null;
    const pushedPointer = pointerSent ? positiveInt(body.remoteUserId) : null;
    if (!obligateId || !action || (pointerSent && !pushedPointer)) {
      res.status(400).json({ success: false, error: 'Missing fields' });
      return;
    }

    const ip = clientAddress(req).ip || undefined;
    noteSyncCall(ip);
    const { user, reason, linkedId } = await linkedSsoAccount(obligateId);
    const localId = user ? user.id : null;
    const pointerMismatch = pushedPointer !== null && linkedId !== null && pushedPointer !== linkedId;
    const audit = syncAuditFor(obligateId, pushedPointer, localId, action, ip, {
      ...(role !== undefined ? { role } : {}),
      ...(pointerMismatch ? { pointerMismatch: true, linkedLocalUserId: linkedId } : {}),
    });
    if (pointerMismatch) {
      logger.warn({ obligateUserId: obligateId, remoteUserId: pushedPointer, linkedLocalUserId: linkedId, action },
        'SSO sync: pushed remoteUserId differs from our link — ignored');
    }
    if (!user || localId === null) {
      await audit('ignored', { reason, linkedLocalUserId: linkedId });
      res.json({ success: true });
      return;
    }

    if (action === 'credentials-changed') {
      const r = await applyCredentialsChanged(obligateId, localId, audit);
      if (r !== 'done') {
        if (sparseAudit(`${localId}:${r.retry}`)) await audit(r.retry, { username: user.username });
        res.status(503).json({ success: false, error: RETRY_ERRORS[r.retry] ?? 'Retry later' });
        return;
      }
      res.json({ success: true });
      return;
    }

    const rr = await obligateService.rosterForPush();
    if (rr.kind !== 'ok') {
      scheduleSyncRecheck(obligateId, localId, action, audit);
      await audit('recheck_scheduled', { reason: rr.kind === 'throttled' ? 'throttled' : 'roster_unavailable', username: user.username });
      res.json({ success: true });
      return;
    }
    const r = await applyConfirmedSync(obligateId, localId, action, rr.roster, audit);
    if (r !== 'done') {
      scheduleSyncRecheck(obligateId, localId, action, audit);
      await audit('recheck_scheduled', { reason: r.retry, username: user.username });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
