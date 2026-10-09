import type { MailDriver, MailSyncResult } from '../driver';
import { MailDriverError } from '../driver';

// ─────────────────────────────────────────────────────────────────────────────
// Engine 'external' (docs/P4-PLAN.md §5.4) — architect implementation, OWNED BY
// MODULE `mail-core` afterwards. Customers use another mail provider: no
// container, no mailbox; the panel only manages / shows the DNS records of
// their mail domains (mail-dns-tls, mail_domains.external_dns). The site relay
// then delivers PHP mail() directly (relayTarget null, no DKIM).
// ─────────────────────────────────────────────────────────────────────────────

const noMailboxes = (): never => {
  throw new MailDriverError('notSupported', 'The mail engine is external: no mailbox is hosted on this platform');
};

export const externalDriver: MailDriver = {
  engine: 'external',
  capabilities: {
    supported: true,
    mailboxes: false,
    sieve: false,
    appPasswordNets: false,
    quotaUsage: false,
    queue: false,
    clamav: false,
    greylisting: false,
    passwordSchemes: [],
  },
  async ensure(log) { log('External mail engine: nothing to deploy'); },
  async status() { return []; },
  async version() { return null; },
  async remove() { /* nothing deployed */ },
  async sync(state): Promise<MailSyncResult> {
    return { ok: true, changed: false, domains: state.domains.length, mailboxes: 0, aliases: 0, domainErrors: {}, durationMs: 0 };
  },
  async reloadTls() { /* no TLS service */ },
  async purge() { /* no data */ },
  async usage() { return []; },
  async queue() { return []; },
  async queueAction() { noMailboxes(); },
  logContainers() { return []; },
  parseLogLine() { return null; },
  imapEndpoint() { return null; },
  submissionEndpoint() { return null; },
  sieveEndpoint() { return null; },
  relayTarget() { return null; },
};
