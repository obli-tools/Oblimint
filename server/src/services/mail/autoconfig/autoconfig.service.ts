import { isValidServerName } from '../../edge/nginxConfig';
import { activeMailDomainByName, loadMailPlatformContext, optionsOf, type MailDomainView, type MailPlatformContext } from '../dns/domains';
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
}

const XML_MAX_AGE = 3600;
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

  /** GET /.well-known/mta-sts.txt on mta-sts.<d> (mode from the domain / settings; 404 when off). */
  async mtaStsPolicy(host: string): Promise<PublicAnswer | null> {
    const r = await resolveHost(host, 'mta-sts');
    if (!r) return null;
    const mode = optionsOf(r.v, r.ctx).mtaSts;
    if (mode === 'off') return null;
    return { contentType: 'text/plain; charset=utf-8', body: mtaStsPolicyText(mode, r.ctx.host), maxAge: MTA_STS_CACHE };
  },
};
