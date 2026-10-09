import { appConfigService } from '../appConfig.service';
import { platformSettings } from '../platformSettings';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// P4 cross-module contracts (docs/P4-PLAN.md §7) — ARCHITECT FILE (frozen).
//
// Who calls whom (every arrow goes through a signature posed by the architect
// in the callee's own file; hooks never throw, other methods throw AppError /
// MailDriverError / notImplementedError until implemented):
//
//   mail-core      ─► registry.activeMailDriver() (driver.ts interface)
//                  ─► mail/dns/dkim.service      dkimService.ensureForDomain, signingKeys, domainRemoved
//                  ─► mail/dns/mailDns.service   mailDnsService.domainChanged (hook)
//                  ─► mail/tls/mailTls.service   mailTlsService.certificates
//                  ─► mail/webmail/webmail.service webmailService.appPasswords, mailboxChanged (hook)
//                  ─► mail/outbound/outbound.service outboundService.sendPolicy, relayTrust, mailDomainsChanged (hook)
//   mail-dns-tls   ─► mail.service mailService.requestSync (hook), contracts.mailHostname
//                  ─► dns (P2) dnsService.domainChanged / requestSyncAll, dns/contributors.ts
//                  ─► edge (P1/P2) edge/contributors.ts, edgeService.scheduleSync
//   outbound-sec.  ─► mail.service requestSync, registry.activeMailDriver (logs, queue, relayTarget)
//                  ─► mail/network.ts ensureMailNetwork, mailNetworkSubnets
//                  ─► hostd setMailFirewall, docker (relay container), usage notify
//   webmail        ─► mail.service requestSync, registry.activeMailDriver (imap/submission/sieve endpoints)
//                  ─► mail/network.ts, edge/contributors.ts
//   engine-*       ─► mail/network.ts ensureMailNetwork, docker helpers (P1/P2)
//   ui-mail        ─► REST API §6
// ─────────────────────────────────────────────────────────────────────────────

/** Node mail host name: settings mail.hostname, else app_config panel_hostname (lower case), else null. */
export async function mailHostname(): Promise<string | null> {
  try {
    const s = await platformSettings.section('mail');
    if (s.hostname) return s.hostname.toLowerCase();
  } catch { /* fall back to the panel host name */ }
  const panel = (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
  return panel;
}

/**
 * PUT /system/hosting-settings with a `mail` section: every P4 module reacts
 * (engine config, DNS records, edge vhosts / certificates, relay, webmail).
 * Never throws.
 */
export async function notifyMailSettingsChanged(): Promise<void> {
  const hooks: Array<[string, () => Promise<void>]> = [
    ['mail', async () => (await import('./mail.service')).mailService.settingsChanged()],
    ['mail-dns', async () => (await import('./dns/mailDns.service')).mailDnsService.settingsChanged()],
    ['outbound', async () => (await import('./outbound/outbound.service')).outboundService.settingsChanged()],
    ['webmail', async () => (await import('./webmail/webmail.service')).webmailService.settingsChanged()],
    ['edge', async () => (await import('../edge/edge.service')).edgeService.scheduleSync('mail settings')],
    ['dns', async () => (await import('../dns/dns.service')).dnsService.requestSyncAll('mail settings')],
  ];
  for (const [name, run] of hooks) {
    try {
      await run();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, hook: name }, 'mail settings change hook failed');
    }
  }
}
