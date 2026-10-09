import type { InfraComponentStatus, MailEngine } from '@oblimint/shared';
import type { MailDriver } from '../driver';
import { MailDriverError } from '../driver';

// ─────────────────────────────────────────────────────────────────────────────
// docker-mailserver / maddy (docs/P4-PLAN.md §5.5) — DRIVER SKELETONS behind
// the common interface, architect implementation, OWNED BY MODULE `mail-core`.
// capabilities.supported = false: the setup wizard shows them as "not yet
// supported", the server refuses them (400 mailEngineNotSupported); an
// install that somehow has one configured gets clear errors, never a crash.
//
// Notes for a later phase:
//   docker-mailserver: generated files under config/ (postfix-accounts.cf with
//     {SHA512-CRYPT} hashes, postfix-virtual.cf, dovecot-quotas.cf,
//     opendkim / rspamd keys) + `setup` CLI through docker exec;
//   maddy: maddy.conf + `maddy creds` / `maddy imap-acct` through docker exec,
//     table.sql_query on a generated SQLite for aliases.
// ─────────────────────────────────────────────────────────────────────────────

const LABELS: Record<string, string> = { 'docker-mailserver': 'docker-mailserver', maddy: 'Maddy' };

export function unsupportedDriver(engine: Extract<MailEngine, 'docker-mailserver' | 'maddy'>): MailDriver {
  const label = LABELS[engine] ?? engine;
  const fail = (): never => {
    throw new MailDriverError('notSupported', `The ${label} mail engine is not supported yet`);
  };
  const status: InfraComponentStatus = {
    id: 'mail', deployed: false, running: false, image: null, version: null, detail: `${label}: not supported yet`,
  };
  return {
    engine,
    capabilities: {
      supported: false,
      mailboxes: true,
      sieve: false,
      appPasswordNets: false,
      quotaUsage: false,
      queue: false,
      clamav: false,
      greylisting: false,
      passwordSchemes: [],
    },
    async ensure() { fail(); },
    async status() { return [{ ...status }]; },
    async version() { return null; },
    async remove() { /* never deployed */ },
    async sync() { return fail(); },
    async reloadTls() { /* nothing */ },
    async purge() { fail(); },
    async usage() { return []; },
    async queue() { return []; },
    async queueAction() { fail(); },
    logContainers() { return []; },
    parseLogLine() { return null; },
    imapEndpoint() { return null; },
    submissionEndpoint() { return null; },
    sieveEndpoint() { return null; },
    relayTarget() { return null; },
  };
}
