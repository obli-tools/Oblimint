import type { WebmailKind } from '@oblimint/shared';
import { db } from '../../../db';
import { appConfigService } from '../../appConfig.service';
import { platformSettings } from '../../platformSettings';
import { edgeCertPaths, isValidServerName, type EdgeVhost } from '../../edge/nginxConfig';
import { certCovers, SERVED_ACCOUNT_STATUSES, type PlanCertificate } from '../../edge/vhostPlan';
import type { EdgeContributor, EdgeContributorContext } from '../../edge/contributors';
import { config } from '../../../config';
import { PANEL_ALIAS, WEBMAIL_CONTAINER, WEBMAIL_PORT } from '../../hosting/naming';
import { activeMailDriver } from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// Edge vhosts of the shared webmail (docs/P4-PLAN.md §9.4 / §9.7, MA13, P1'):
//   webmail       settings mail.webmailHostname — NEVER when it is the panel
//                 host or a name under it (P1': the webmail must not share the
//                 panel's cookie scope); the refusal is reported in status;
//   w-<mailDomId> webmail.<d> for every ACTIVE mail domain (enabled, domain
//                 verified — D1 —, account served) when webmailPerDomain.
// A vhost WITH TLS: location / → http://oblimint-webmail:8080 (kind
// 'webmail'), or for the Oblimint webmail (settings kind 'oblimint') the
// panel's webmail listener http://oblimint-panel:<webmailPort>; HTTPS forced. TLS only with a valid PLATFORM certificate
// covering the name (the platform webmail host via PlatformHosts.extra,
// webmail.<d> via the mail.<d> certificate of module mail-dns-tls). No
// self-signed fallback: the edge reserves it for the panel / dbadmin / probe
// vhosts. WITHOUT a certificate (issuance pending / failed, mail.<d>
// certificate not covering webmail.<d>) the vhost has NO location: only the
// ACME HTTP-01 location (served by every vhost on port 80) and a 404 — the
// login form (mailbox password) and the SSO token never travel in clear.
// Every vhost: X-Robots-Tag noindex + Referrer-Policy no-referrer (the SSO
// token travels in the first URL), body limit = platform message size +
// 10 MiB. planWebmailVhosts is pure (edgeContributor.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const WEBMAIL_HEADERS: Record<string, string> = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
export const WEBMAIL_UPSTREAM = `http://${WEBMAIL_CONTAINER}:${WEBMAIL_PORT}`;

/** Upstream of the Oblimint webmail (kind 'oblimint'): the panel's webmail listener, null when disabled (port 0). */
export function oblimintWebmailUpstream(port: number = config.hosting.webmailPort): string | null {
  return Number.isInteger(port) && port > 0 && port <= 65535 ? `http://${PANEL_ALIAS}:${port}` : null;
}
/** Margin over the message size for the multipart overhead of an upload. */
export const WEBMAIL_BODY_MARGIN_MB = 10;

export interface WebmailDomainRow {
  /** mail_domains.id */
  id: number;
  accountId: number;
  tenantId: number;
  /** Mail domain name (lower case). */
  name: string;
  accountStatus: string;
}

export interface WebmailPlanInput {
  kind: WebmailKind;
  /** settings mail.webmailHostname */
  platformHost: string | null;
  /** app_config panel_hostname */
  panelHost: string | null;
  perDomain: boolean;
  /** ACTIVE mail domains (loadActiveWebmailDomains). */
  domains: WebmailDomainRow[];
  maxMessageSizeMb: number;
  /** Kind 'oblimint': the panel's webmail listener (oblimintWebmailUpstream()); null = not served (no location). */
  oblimintUpstream?: string | null;
  certificates: PlanCertificate[];
  certFilesExist: (primaryName: string) => boolean;
  /** Names already served by planVhosts / earlier contributors. */
  claimed: ReadonlySet<string>;
}

export interface WebmailPlan {
  vhosts: EdgeVhost[];
  /** Why the platform webmail host is not served (status detail), null = served or not set. */
  platformRefusal: string | null;
}

function host(v: string | null | undefined): string | null {
  const h = (v ?? '').trim().toLowerCase().replace(/\.$/, '');
  return h && isValidServerName(h) ? h : null;
}

/** P1': the panel host itself or any name under it. */
export function isUnderPanel(name: string, panelHost: string | null): boolean {
  const panel = host(panelHost);
  if (!panel) return false;
  const n = name.trim().toLowerCase();
  return n === panel || n.endsWith(`.${panel}`);
}

/** Reason the platform webmail host cannot be served, null when fine (or not set). */
export function webmailHostRefusal(platformHost: string | null, panelHost: string | null): string | null {
  if (!platformHost) return null;
  const h = host(platformHost);
  if (!h) return `mail.webmailHostname ${JSON.stringify(platformHost.slice(0, 80))} is not a valid host name`;
  if (isUnderPanel(h, panelHost)) return `mail.webmailHostname ${h} is the panel host or under it: not served (P1')`;
  return null;
}

function certNames(c: PlanCertificate): string[] {
  let v: unknown = c.names;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v.map((n) => String(n).toLowerCase()) : [];
}

/**
 * TLS of a webmail name: a VALID platform certificate (no domain, no site)
 * whose files exist and that covers the name — its own row first (platform
 * webmail host), else any covering one (mail.<d> certificate with
 * webmail.<d>). null = no TLS: the vhost is ACME-only.
 */
export function webmailTls(name: string, certificates: PlanCertificate[], certFilesExist: (primary: string) => boolean): EdgeVhost['tls'] {
  const usable = certificates.filter((c) => c.domain_id === null && c.site_id === null && c.status === 'valid' && certFilesExist(c.primary_name));
  const own = usable.find((c) => c.primary_name === name);
  const pick = own ?? usable.find((c) => certCovers(certNames(c), name));
  if (!pick) return null;
  return edgeCertPaths(pick.primary_name);
}

export function webmailBodyLimitMb(maxMessageSizeMb: number): number {
  const m = Number.isFinite(maxMessageSizeMb) && maxMessageSizeMb > 0 ? Math.ceil(maxMessageSizeMb) : 50;
  return m + WEBMAIL_BODY_MARGIN_MB;
}

export function planWebmailVhosts(input: WebmailPlanInput, tlsPaths: typeof webmailTls = webmailTls): WebmailPlan {
  const out: WebmailPlan = { vhosts: [], platformRefusal: null };
  if (input.kind === 'none') return out;
  const claimed = new Set(input.claimed);
  const body = webmailBodyLimitMb(input.maxMessageSizeMb);
  // roundcube / snappymail: the shared container; oblimint: the panel's webmail listener.
  const upstream = input.kind === 'oblimint' ? (input.oblimintUpstream ?? null) : WEBMAIL_UPSTREAM;
  const vhost = (id: string, name: string, owner: { accountId: number; tenantId: number; suspended: boolean } | null): void => {
    if (claimed.has(name)) return;
    claimed.add(name);
    const tls = tlsPaths(name, input.certificates, input.certFilesExist);
    out.vhosts.push({
      id,
      kind: 'webmail',
      serverNames: [name],
      tls,
      forceHttps: !!tls,
      suspended: owner?.suspended ?? false,
      // No certificate: ACME only (no proxy to the webmail over plain HTTP).
      locations: tls && upstream ? [{ pathPrefix: '/', upstream, kind: 'webmail', siteId: null }] : [],
      extraHeaders: { ...WEBMAIL_HEADERS },
      clientMaxBodyMb: body,
      accountId: owner?.accountId ?? null,
      tenantId: owner?.tenantId ?? null,
    });
  };

  // ── platform webmail host ──
  out.platformRefusal = webmailHostRefusal(input.platformHost, input.panelHost);
  const platform = host(input.platformHost);
  if (platform && !out.platformRefusal) vhost('webmail', platform, null);

  // ── webmail.<d> of the active mail domains ──
  if (input.perDomain) {
    for (const d of [...input.domains].sort((a, b) => a.id - b.id)) {
      if (!(SERVED_ACCOUNT_STATUSES as readonly string[]).includes(d.accountStatus)) continue;
      const name = `webmail.${d.name.toLowerCase()}`;
      if (!isValidServerName(name) || isUnderPanel(name, input.panelHost)) continue;
      vhost(`w-${d.id}`, name, { accountId: d.accountId, tenantId: d.tenantId, suspended: d.accountStatus === 'suspended' });
    }
  }
  return out;
}

// ── database side ────────────────────────────────────────────────────────────

/** Active mail domains: enabled, domain VERIFIED (D1), account served. */
export async function loadActiveWebmailDomains(): Promise<WebmailDomainRow[]> {
  const rows = await db('mail_domains as md')
    .join('domains as d', 'd.id', 'md.domain_id')
    .join('hosting_accounts as a', 'a.id', 'md.account_id')
    .where('md.enabled', true)
    .where('d.verification_status', 'verified')
    .whereIn('a.status', [...SERVED_ACCOUNT_STATUSES])
    .orderBy('md.id')
    .select('md.id', 'md.account_id', 'md.tenant_id', 'md.name', 'a.status as account_status') as
    Array<{ id: number; account_id: number; tenant_id: number; name: string; account_status: string }>;
  return rows.map((r) => ({ id: Number(r.id), accountId: Number(r.account_id), tenantId: Number(r.tenant_id), name: String(r.name).toLowerCase(), accountStatus: r.account_status }));
}

/** Does the active engine have mailboxes at all (external: no webmail)? Never throws. */
export async function engineHasMailboxes(): Promise<boolean> {
  try {
    const d = await activeMailDriver();
    return !!d.capabilities.mailboxes && !!d.capabilities.supported;
  } catch {
    return false;
  }
}

/** Builds the plan from the settings + DB for an edge pass. */
export async function webmailPlanFor(ctx: Pick<EdgeContributorContext, 'certificates' | 'certFilesExist' | 'claimed'>): Promise<WebmailPlan> {
  const s = await platformSettings.section('mail');
  if (s.webmail === 'none' || !(await engineHasMailboxes())) return { vhosts: [], platformRefusal: null };
  // The Oblimint webmail speaks JMAP: Stalwart only.
  if (s.webmail === 'oblimint' && (await activeMailDriver().then((d) => d.engine, () => null)) !== 'stalwart') return { vhosts: [], platformRefusal: null };
  const panelHost = (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
  return planWebmailVhosts({
    kind: s.webmail,
    platformHost: s.webmailHostname,
    panelHost,
    perDomain: s.webmailPerDomain,
    domains: s.webmailPerDomain ? await loadActiveWebmailDomains() : [],
    maxMessageSizeMb: s.maxMessageSizeMb,
    oblimintUpstream: oblimintWebmailUpstream(),
    certificates: ctx.certificates,
    certFilesExist: ctx.certFilesExist,
    claimed: ctx.claimed,
  });
}

/** Registered by webmailService.start(). */
export const webmailEdgeContributor: EdgeContributor = {
  id: 'webmail',
  async vhosts(ctx: EdgeContributorContext): Promise<EdgeVhost[]> {
    return (await webmailPlanFor(ctx)).vhosts;
  },
};
