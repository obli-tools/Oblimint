import { registerMigrationStepProvider, type MigrationStepProvider } from '../../contracts/execution';
import { runAliasStep, runDkimStep, runMailboxStep, runMailDomainStep } from './mail';
import { runMaildirStep } from './maildir';
import { mailDnsSteps, parseMailDnsStepKey } from './steps';
import { runZoneStep } from './zone';

// ─────────────────────────────────────────────────────────────────────────────
// Step provider 'mail-dns' (docs/P5-PLAN.md §9.4): DNS zones (records of the
// plan, IPs already rewritten by the planner), mail domains, DKIM import (same
// selector), mailboxes with the SOURCE hash, maildirs (rsync as the vmail uid,
// uidlist kept), aliases / forwarders. OWNED BY MODULE `executor-mail-dns`.
//
// Step keys / labels (i18n migration.steps.<code>):
//   dns:zone:<zone>          35  steps.dnsZone    { zone }
//   mail:domain:<domain>     90  steps.mailDomain { domain }
//   mail:dkim:<domain>       92  steps.dkim       { domain }
//   mail:mailbox:<address>   94  steps.mailbox    { address }
//   mail:maildir:<address>   96  steps.maildir    { address }
//   mail:alias:<address>     98  steps.alias      { address }
// Idempotency (MG5): object map kinds zone / mailDomain / dkimKey / mailbox /
// alias (keys name / address / <domain>/<selector>), upsert only, never a delete.
// ─────────────────────────────────────────────────────────────────────────────

export const mailDnsProvider: MigrationStepProvider = {
  id: 'mail-dns',
  steps(input) {
    return mailDnsSteps(input);
  },
  async run(step, ctx) {
    const parsed = parseMailDnsStepKey(step.key);
    if (!parsed) throw new Error(`Unknown mail-dns step ${step.key}`);
    switch (parsed.kind) {
      case 'zone': return runZoneStep(ctx, parsed.name);
      case 'mailDomain': return runMailDomainStep(ctx, parsed.name);
      case 'dkim': return runDkimStep(ctx, parsed.name);
      case 'mailbox': return runMailboxStep(ctx, parsed.name);
      case 'maildir': return runMaildirStep(ctx, parsed.name);
      case 'alias': return runAliasStep(ctx, parsed.name);
      default: throw new Error(`Unknown mail-dns step ${step.key}`);
    }
  },
};

registerMigrationStepProvider(mailDnsProvider);
