import type { EdgeCertificateWish, EdgeContributor, EdgeContributorContext } from '../../edge/contributors';
import { isPublicAcmeName } from '../../edge/acmeIssuer';
import { edgeCertPaths, type EdgeLocation, type EdgeVhost } from '../../edge/nginxConfig';
import { certCovers, isReservedPlatformName, type PlanCertificate, type PlatformHosts } from '../../edge/vhostPlan';
import { logger } from '../../../utils/logger';
import { loadMailPlatformContext, mailDomainViews, optionsOf, tenantDomainNames, type MailDomainView, type MailPlatformContext } from '../dns/domains';
import { mailHostNames } from '../dns/records';

// ─────────────────────────────────────────────────────────────────────────────
// Edge contributor 'mail' (docs/P4-PLAN.md §7, §9.4) — module mail-dns-tls,
// registered by mailDnsService.start():
//   - vhost `mail-host` on the node mail host H: ACME HTTP-01 only (no
//     location: everything else 404), TLS when its certificate is usable;
//   - vhost `m-<mailDomainId>` per ACTIVE mail domain (engine with mailboxes)
//     on mail.<d>, autoconfig.<d> / autodiscover.<d> (autoconfig on),
//     mta-sts.<d> (MTA-STS on): EXACT locations to the panel for the
//     autoconfig / autodiscover / MTA-STS paths, the rest 404;
//   - one certificate wish per active mail domain: mail.<d> + the names above
//     (+ webmail.<d> when served), DNS-01 first when the zone is solvable here;
//   - onCertificateInstalled: copy into mail/certs/ + engine TLS reload (tls/mailTls.service).
// Never a name that is a tenant domain row, a platform name, or already served
// (D1 / MA10: unverified, disabled or suspended-for-deletion domains get nothing).
// ─────────────────────────────────────────────────────────────────────────────

/** Public paths of the mail autoconfiguration (routes/mailPublic.routes.ts), exact locations. */
export const MAIL_PUBLIC_PATHS: readonly string[] = [
  '/mail/config-v1.1.xml',
  '/.well-known/autoconfig/mail/config-v1.1.xml',
  '/autodiscover/autodiscover.xml',
  '/Autodiscover/Autodiscover.xml',
  '/.well-known/mta-sts.txt',
];

export const MAIL_VHOST_HEADERS: Record<string, string> = { 'X-Robots-Tag': 'noindex, nofollow' };

export interface MailEdgeDomain {
  id: number;
  tenantId: number;
  accountId: number;
  name: string;
  autoconfig: boolean;
  mtaSts: boolean;
  webmail: boolean;
}

export interface MailEdgeInput {
  host: string | null;
  domains: MailEdgeDomain[];
  /** Names that are tenant domain rows. */
  taken: ReadonlySet<string>;
  platform: PlatformHosts;
}

function usable(name: string, input: Pick<MailEdgeInput, 'taken' | 'platform'>): boolean {
  return !input.taken.has(name) && !isReservedPlatformName(name, input.platform);
}

/** Names of the `m-<id>` vhost of a mail domain (before the "already served" filter). */
export function mailVhostNames(d: MailEdgeDomain, input: Pick<MailEdgeInput, 'taken' | 'platform'>): string[] {
  const n = mailHostNames(d.name, { autoconfig: d.autoconfig, mtaSts: d.mtaSts ? 'testing' : 'off', webmail: false });
  return [n.mail, n.autoconfig, n.autodiscover, n.mtaSts].filter((x): x is string => !!x && usable(x, input));
}

/** Names of the certificate of a mail domain: the vhost names + webmail.<d> when served. */
export function mailCertificateNames(d: MailEdgeDomain, input: Pick<MailEdgeInput, 'taken' | 'platform'>): string[] {
  const names = mailVhostNames(d, input);
  const webmail = `webmail.${d.name}`;
  if (d.webmail && usable(webmail, input)) names.push(webmail);
  return names.filter(isPublicAcmeName);
}

function certNames(c: PlanCertificate): string[] {
  let v: unknown = c.names;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  return Array.isArray(v) ? v.map((n) => String(n).toLowerCase()) : [c.primary_name.toLowerCase()];
}

/**
 * TLS of a vhost: a VALID certificate whose files exist and that covers every
 * server name (the preferred primary first), else null (HTTP only; ACME works).
 */
export function tlsFor(
  names: string[],
  preferred: string | null,
  certificates: PlanCertificate[],
  filesExist: (primary: string) => boolean,
): EdgeVhost['tls'] {
  const fits = certificates
    .filter((c) => c.status === 'valid' && names.every((n) => certCovers(certNames(c), n)) && filesExist(c.primary_name))
    .sort((a, b) => Number(b.primary_name === preferred) - Number(a.primary_name === preferred) || a.primary_name.localeCompare(b.primary_name));
  return fits[0] ? edgeCertPaths(fits[0].primary_name) : null;
}

/** Vhosts of the mail service (pure). */
export function planMailVhosts(input: MailEdgeInput, ctx: Omit<EdgeContributorContext, 'platform'>): EdgeVhost[] {
  const out: EdgeVhost[] = [];
  const host = input.host;
  if (host && !ctx.claimed.has(host)) {
    out.push({
      id: 'mail-host', kind: 'mail', serverNames: [host],
      tls: tlsFor([host], host, ctx.certificates, ctx.certFilesExist),
      forceHttps: false, suspended: false, locations: [], extraHeaders: { ...MAIL_VHOST_HEADERS }, clientMaxBodyMb: 1,
      accountId: null, tenantId: null,
    });
  }
  for (const d of input.domains) {
    const names = mailVhostNames(d, input).filter((n) => !ctx.claimed.has(n));
    if (names.length === 0) continue;
    const primary = mailCertificateNames(d, input)[0] ?? null;
    const locations: EdgeLocation[] = MAIL_PUBLIC_PATHS.map((p) => ({ pathPrefix: p, upstream: ctx.panelUpstream, kind: 'mail', siteId: null, exact: true }));
    out.push({
      id: `m-${d.id}`, kind: 'mail', serverNames: names,
      tls: tlsFor(names, primary, ctx.certificates, ctx.certFilesExist),
      forceHttps: false, suspended: false, locations, extraHeaders: { ...MAIL_VHOST_HEADERS }, clientMaxBodyMb: 1,
      accountId: d.accountId, tenantId: d.tenantId,
    });
  }
  return out;
}

/** Certificate wishes (pure; preferDns01 decided by `dns01`). The mail host H is already a platform name (PlatformHosts.extra). */
export function planMailCertificateWishes(input: MailEdgeInput, dns01: (primary: string) => boolean): EdgeCertificateWish[] {
  const out: EdgeCertificateWish[] = [];
  for (const d of input.domains) {
    const names = mailCertificateNames(d, input);
    if (names.length === 0) continue;
    out.push({ names, preferDns01: dns01(names[0]), tenantId: d.tenantId, accountId: d.accountId });
  }
  return out;
}

/** Active mail domains of an engine with mailboxes, as the edge sees them. */
export async function loadMailEdgeInput(platform: PlatformHosts, ctx?: MailPlatformContext): Promise<MailEdgeInput> {
  const c = ctx ?? await loadMailPlatformContext();
  if (!c.hasMailboxes) return { host: null, domains: [], taken: new Set(), platform };
  const views: MailDomainView[] = (await mailDomainViews()).filter((v) => v.active);
  const domains: MailEdgeDomain[] = views.map((v) => {
    const o = optionsOf(v, c);
    return { id: v.id, tenantId: v.tenantId, accountId: v.accountId, name: v.name, autoconfig: o.autoconfig, mtaSts: o.mtaSts !== 'off', webmail: o.webmail };
  });
  const candidates = domains.flatMap((d) => ['mail', 'autoconfig', 'autodiscover', 'mta-sts', 'webmail'].map((p) => `${p}.${d.name}`));
  return { host: c.host, domains, taken: await tenantDomainNames(candidates), platform };
}

export const mailEdgeContributor: EdgeContributor = {
  id: 'mail',
  async vhosts(ctx: EdgeContributorContext): Promise<EdgeVhost[]> {
    return planMailVhosts(await loadMailEdgeInput(ctx.platform), ctx);
  },
  async certificates(platform: PlatformHosts): Promise<EdgeCertificateWish[]> {
    const input = await loadMailEdgeInput(platform);
    const { dns01Provider } = await import('../../dns/acmeChallenge');
    const solvable = new Map<string, boolean>();
    for (const d of input.domains) {
      const primary = mailCertificateNames(d, input)[0];
      if (primary) solvable.set(primary, await dns01Provider.canSolve(primary));
    }
    return planMailCertificateWishes(input, (p) => solvable.get(p) === true);
  },
  onCertificateInstalled(primaryName: string, names: string[]): void {
    import('./mailTls.service')
      .then(({ certificateInstalled }) => certificateInstalled(primaryName, names))
      .catch((err) => logger.warn({ err: (err as Error)?.message, certificate: primaryName }, 'mail tls: certificate installation hook failed'));
  },
};
