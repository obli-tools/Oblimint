import { isValidServerName } from '../../edge/nginxConfig';
import { panelHostRole, panelHosts } from '../../panelHosts';
import { mailCoreDeps } from '../deps';
import { activeMailDomainByName, loadMailPlatformContext, optionsOf, type MailDomainView, type MailPlatformContext } from '../dns/domains';
import { buildMailClientDiscovery } from './mailClientDiscovery';
import { autodiscoverRequestEmail, emailDomain, mtaStsPolicyText, normalizeEmail, outlookXml, thunderbirdXml } from './xml';

// ─────────────────────────────────────────────────────────────────────────────
// Public mail autoconfiguration (docs/P4-PLAN.md §6.4) — module mail-dns-tls.
// Answers ONLY for a Host that is autoconfig.<d> / autodiscover.<d> /
// mta-sts.<d> of an ACTIVE mail domain (enabled, verified — D1 / MA10 —
// account served) of an engine with mailboxes, with the feature on, and (XML)
// for an address of THAT domain; anything else: null → 404 with an empty body
// (no information about the platform, MA11). The answers never depend on a
// mailbox existing. Pure builders in xml.ts; no session, rate limited by the
// route.
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicAnswer {
  contentType: string;
  body: string;
  /** Cache-Control max-age (s). */
  maxAge: number;
  /** Access-Control-Allow-Origin: * (the discovery document, read by any client). */
  cors?: boolean;
}

const XML_MAX_AGE = 3600;
/** « Se connecter à Mint » discovery document (O2, §7.1). */
const DISCOVERY_MAX_AGE = 300;
const MTA_STS_CACHE = 3600;

type Prefix = 'autoconfig' | 'autodiscover' | 'mta-sts';

/** Host → the active mail domain it serves for `prefix`, with the platform context. */
async function resolveHost(rawHost: string, prefix: Prefix): Promise<{ v: MailDomainView; ctx: MailPlatformContext & { host: string } } | null> {
  const host = String(rawHost ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!isValidServerName(host) || !host.startsWith(`${prefix}.`)) return null;
  const domain = host.slice(prefix.length + 1);
  if (!domain.includes('.')) return null;
  const ctx = await loadMailPlatformContext();
  if (!ctx.hasMailboxes || !ctx.host) return null;
  const v = await activeMailDomainByName(domain);
  if (!v) return null;
  const o = optionsOf(v, ctx);
  if (prefix === 'mta-sts' ? o.mtaSts === 'off' : !o.autoconfig) return null;
  return { v, ctx: { ...ctx, host: ctx.host } };
}

export const autoconfigService = {
  /** Thunderbird: GET /mail/config-v1.1.xml?emailaddress=… (also /.well-known/autoconfig/mail/config-v1.1.xml). */
  async thunderbird(host: string, email: string | null): Promise<PublicAnswer | null> {
    // Older Thunderbird versions fetch the well-known path without ?emailaddress=: answer for the
    // domain of the Host (nothing beyond what DNS publishes, MA11). A given address must match it.
    const address = email === null || email.trim() === '' ? null : normalizeEmail(email);
    if (email !== null && email.trim() !== '' && !address) return null;
    const r = await resolveHost(host, 'autoconfig');
    if (!r || (address !== null && emailDomain(address) !== r.v.name)) return null;
    return { contentType: 'application/xml; charset=utf-8', body: thunderbirdXml({ domain: r.v.name, host: r.ctx.host }), maxAge: XML_MAX_AGE };
  },

  /** Outlook: POST (or GET) /autodiscover/autodiscover.xml, XML request body ≤ 16 KiB (EMailAddress). */
  async autodiscover(host: string, body: string | null): Promise<PublicAnswer | null> {
    const address = autodiscoverRequestEmail(body);
    if (!address) return null;
    const r = await resolveHost(host, 'autodiscover');
    if (!r || emailDomain(address) !== r.v.name) return null;
    return { contentType: 'application/xml; charset=utf-8', body: outlookXml({ domain: r.v.name, host: r.ctx.host, email: address }), maxAge: XML_MAX_AGE };
  },

  /**
   * « Se connecter à Mint » (O2): GET /.well-known/oblimint/mail-client.
   * On autoconfig.<d>: same conditions as the Thunderbird autoconfig (active
   * mail domain of an engine with mailboxes, autoconfig on), the domain part
   * included — the domain's certificate is what ties an address to this
   * server. On a configured panel host (panel / client space): the same
   * document without the domain part, when the platform autoconfig is on.
   * Anything else: null (404, empty body). Never names the engine (P6).
   */
  async mailClient(host: string): Promise<PublicAnswer | null> {
    const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!isValidServerName(h)) return null;
    const hosts = await panelHosts();
    let domain: string | null = null;
    let ctx: MailPlatformContext & { host: string };
    if (h.startsWith('autoconfig.')) {
      const r = await resolveHost(h, 'autoconfig');
      if (!r) return null;
      domain = r.v.name;
      ctx = r.ctx;
    } else {
      if (!panelHostRole(h, hosts)) return null;
      const c = await loadMailPlatformContext();
      if (!c.hasMailboxes || !c.host || !c.settings.autoconfig) return null;
      ctx = { ...c, host: c.host };
    }
    const s = ctx.settings;
    const webmailUrl = domain ? await mailCoreDeps().webmailUrl(domain).catch(() => null) : null;
    const doc = buildMailClientDiscovery({
      host: ctx.host,
      domain,
      panelHost: hosts.admin,
      clientHost: hosts.client,
      desktopClients: s.desktopClients !== false,
      maxMessageSizeMb: s.maxMessageSizeMb,
      authBan: { threshold: s.authBanThreshold, windowMinutes: s.authBanWindowMinutes, durationMinutes: s.authBanDurationMinutes, revokedAllowance: s.authBanRevokedAllowance !== false },
      webmailUrl,
    });
    return { contentType: 'application/json; charset=utf-8', body: JSON.stringify(doc), maxAge: DISCOVERY_MAX_AGE, cors: true };
  },

  /** GET /.well-known/mta-sts.txt on mta-sts.<d> (mode from the domain / settings; 404 when off). */
  async mtaStsPolicy(host: string): Promise<PublicAnswer | null> {
    const r = await resolveHost(host, 'mta-sts');
    if (!r) return null;
    const mode = optionsOf(r.v, r.ctx).mtaSts;
    if (mode === 'off') return null;
    return { contentType: 'text/plain; charset=utf-8', body: mtaStsPolicyText(mode, r.ctx.host), maxAge: MTA_STS_CACHE };
  },
};
