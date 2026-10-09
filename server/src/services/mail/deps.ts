import type Docker from 'dockerode';
import type { InfraComponentStatus, MailOutboundState, MailPtrCheck } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import type { HostingActor } from '../hosting/access';
import type { DesiredAppPassword, DesiredDkimKey, DesiredRelayTrust, DesiredTlsCertificate } from './driver';
import type { AccountSendPolicy } from './outbound/outbound.service';

// ─────────────────────────────────────────────────────────────────────────────
// Calls of mail-core into the other P4 modules and P1/P2 services
// (docs/P4-PLAN.md §2.1, §7), behind one seam so the tests replace them with
// fakes (setMailCoreDepsForTests). Lazy imports: those modules import
// mail.service (requestSync) — no import cycle at load time.
//
// Providers (async) may throw: the callers decide (desired state: empty part +
// log; DKIM at domain creation: the creation is rolled back). Hooks never
// throw (fire-and-forget, failures logged).
// ─────────────────────────────────────────────────────────────────────────────

export interface MailCoreDeps {
  // ── providers ──
  ensureDkim(mailDomainId: number): Promise<void>;
  dkimSigningKeys(): Promise<DesiredDkimKey[]>;
  tlsCertificates(): Promise<DesiredTlsCertificate[]>;
  appPasswords(): Promise<DesiredAppPassword[]>;
  sendPolicy(): Promise<Map<number, AccountSendPolicy>>;
  relayTrust(): Promise<DesiredRelayTrust>;
  ptrStatus(): Promise<{ ipv4: MailPtrCheck | null; ipv6: MailPtrCheck | null }>;
  activeBanCount(): Promise<number>;
  webmailUrl(domain: string): Promise<string | null>;
  outboundInfo(actor: HostingActor, accountId: number): Promise<MailOutboundState>;
  relayStatus(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus>;
  webmailStatus(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus>;
  // ── hooks (never throw) ──
  domainChanged(mailDomainId: number | null, domainId: number, reason: string): void;
  mailDomainsChanged(accountId: number): void;
  mailboxChanged(mailboxId: number, reason: 'disabled' | 'password' | 'deleted'): void;
  dnsSyncAll(reason: string): void;
  edgeSync(reason: string): void;
}

/** Fire-and-forget: a hook that throws (synchronously or not) is logged, never propagated. */
function hook(name: string, run: () => Promise<void>): void {
  try {
    run().catch((err) => logger.warn({ err: (err as Error)?.message ?? String(err), hook: name }, 'mail-core: hook failed'));
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? String(err), hook: name }, 'mail-core: hook failed');
  }
}

const real: MailCoreDeps = {
  async ensureDkim(id) { await (await import('./dns/dkim.service')).dkimService.ensureForDomain(id); },
  async dkimSigningKeys() { return (await import('./dns/dkim.service')).dkimService.signingKeys(); },
  async tlsCertificates() { return (await import('./tls/mailTls.service')).mailTlsService.certificates(); },
  async appPasswords() { return (await import('./webmail/webmail.service')).webmailService.appPasswords(); },
  async sendPolicy() { return (await import('./outbound/outbound.service')).outboundService.sendPolicy(); },
  async relayTrust() { return (await import('./outbound/outbound.service')).outboundService.relayTrust(); },
  async ptrStatus() { return (await import('./dns/mailDns.service')).mailDnsService.ptrStatus(); },
  async activeBanCount() { return (await import('./security/mailSecurity.service')).mailSecurityService.activeBanCount(); },
  async webmailUrl(domain) { return (await import('./webmail/webmail.service')).webmailService.urlFor(domain); },
  async outboundInfo(actor, accountId) { return (await import('./outbound/outbound.service')).outboundService.info(actor, accountId); },
  async relayStatus(docker, err) { return (await import('./outbound/relayInfra')).mailRelayInfraComponent.status(docker, err); },
  async webmailStatus(docker, err) { return (await import('./webmail/webmailInfra')).webmailInfraComponent.status(docker, err); },
  domainChanged(mailDomainId, domainId, reason) {
    hook('mailDns.domainChanged', async () => (await import('./dns/mailDns.service')).mailDnsService.domainChanged(mailDomainId, domainId, reason));
  },
  mailDomainsChanged(accountId) {
    hook('outbound.mailDomainsChanged', async () => (await import('./outbound/outbound.service')).outboundService.mailDomainsChanged(accountId));
  },
  mailboxChanged(mailboxId, reason) {
    hook('webmail.mailboxChanged', async () => (await import('./webmail/webmail.service')).webmailService.mailboxChanged(mailboxId, reason));
  },
  dnsSyncAll(reason) {
    hook('dns.requestSyncAll', async () => (await import('../dns/dns.service')).dnsService.requestSyncAll(reason));
  },
  edgeSync(reason) {
    hook('edge.scheduleSync', async () => (await import('../edge/edge.service')).edgeService.scheduleSync(reason));
  },
};

let override: Partial<MailCoreDeps> | null = null;

/** The cross-module calls (real ones, or the test fakes over them). */
export function mailCoreDeps(): MailCoreDeps {
  return override ? { ...real, ...override } : real;
}

/** Tests: replace some of the cross-module calls; null restores the real ones. */
export function setMailCoreDepsForTests(fakes: Partial<MailCoreDeps> | null): void {
  override = fakes;
}
