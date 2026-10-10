import type { MigrationStepPlanningInput, MigrationStepSpec } from '../../contracts/execution';
import { MIGRATION_PHASES } from '../../contracts/execution';
import { lower } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// Step list of the mail-dns provider (docs/P5-PLAN.md §9.4) — PURE.
//
//   initial      dns:zone:<zone>          (35)  one per PlannedZone
//                mail:domain:<domain>     (90)  one per PlannedMailDomain
//                mail:dkim:<domain>       (92)  one per domain with a PlannedDkimKey
//                mail:mailbox:<address>   (94)  one per PlannedMailbox
//                mail:maildir:<address>   (96)  one per PlannedMailbox
//                mail:alias:<address>     (98)  one per PlannedAlias ('@domain' = catch-all)
//   resync       mail:mailbox:* (hash refresh) + mail:maildir:* only when parts ∋ maildirs (no parts = everything):
//                a files / data / databases resync never touches the mailboxes' credentials or state
//   final-sync   mail:mailbox:* + mail:maildir:*
// The mailbox refresh itself never overwrites a value changed on the target, nor once the domain is switched.
//
// The include flags of the plan (dns / mail) are already applied by the
// planner: an account without zones / mail gets none. A plan whose target mail
// engine is external (warning mailEngineExternal) gets no mail step at all;
// the engine is checked again when a step runs (it may change meanwhile).
// Keys are stable across runs of the account (persisted steps, resume).
// ─────────────────────────────────────────────────────────────────────────────

export const MAIL_DNS_STEP = {
  zone: 'dns:zone:',
  mailDomain: 'mail:domain:',
  dkim: 'mail:dkim:',
  mailbox: 'mail:mailbox:',
  maildir: 'mail:maildir:',
  alias: 'mail:alias:',
} as const;

export type MailDnsStepKind = keyof typeof MAIL_DNS_STEP;

const MIB = 1024 * 1024;
const MAX_KEY = 200;

function spec(key: string, phase: number, code: string, params: Record<string, string>, weight?: number): MigrationStepSpec | null {
  if (key.length > MAX_KEY) return null;
  return { key, provider: 'mail-dns', phase, label: { code: `steps.${code}`, params }, ...(weight !== undefined ? { weight } : {}) };
}

/** Kind + natural key of one of OUR step keys, null for another provider's key. */
export function parseMailDnsStepKey(key: string): { kind: MailDnsStepKind; name: string } | null {
  for (const [kind, prefix] of Object.entries(MAIL_DNS_STEP) as Array<[MailDnsStepKind, string]>) {
    if (key.startsWith(prefix) && key.length > prefix.length) return { kind, name: key.slice(prefix.length) };
  }
  return null;
}

function mailEngineExternal(input: MigrationStepPlanningInput): boolean {
  return input.account.warnings.some((w) => w.code === 'mailEngineExternal')
    || input.plan.warnings.some((w) => w.code === 'mailEngineExternal');
}

export function mailDnsSteps(input: MigrationStepPlanningInput): MigrationStepSpec[] {
  const { run, account } = input;
  const out: Array<MigrationStepSpec | null> = [];
  const mail = !mailEngineExternal(input);
  const maildirWeight = (bytes: number | null) => Math.max(1, Math.ceil((bytes ?? 0) / MIB));

  const mailboxSteps = (withMaildirs: boolean) => {
    for (const mb of account.mailboxes) {
      const address = lower(mb.address);
      out.push(spec(`${MAIL_DNS_STEP.mailbox}${address}`, MIGRATION_PHASES.mailboxes, 'mailbox', { address }));
      if (withMaildirs) {
        out.push(spec(`${MAIL_DNS_STEP.maildir}${address}`, MIGRATION_PHASES.maildirs, 'maildir', { address }, maildirWeight(mb.sizeBytes)));
      }
    }
  };

  if (run.kind === 'initial') {
    for (const z of account.zones) {
      const zone = lower(z.name);
      out.push(spec(`${MAIL_DNS_STEP.zone}${zone}`, MIGRATION_PHASES.dnsZones, 'dnsZone', { zone }));
    }
    if (mail) {
      for (const md of account.mailDomains) {
        const domain = lower(md.name);
        out.push(spec(`${MAIL_DNS_STEP.mailDomain}${domain}`, MIGRATION_PHASES.mailDomains, 'mailDomain', { domain }));
      }
      for (const domain of [...new Set(account.dkim.map((k) => lower(k.domain)))]) {
        out.push(spec(`${MAIL_DNS_STEP.dkim}${domain}`, MIGRATION_PHASES.dkim, 'dkim', { domain }));
      }
      mailboxSteps(true);
      for (const al of account.aliases) {
        const address = lower(al.address);
        out.push(spec(`${MAIL_DNS_STEP.alias}${address}`, MIGRATION_PHASES.aliases, 'alias', { address }));
      }
    }
  } else if (mail) {
    const parts = run.parts ?? [];
    const maildirs = run.kind === 'final-sync' || parts.length === 0 || parts.includes('maildirs');
    if (maildirs) mailboxSteps(true);
  }

  // Duplicates (same key twice in the plan) are kept once.
  const seen = new Set<string>();
  return out.filter((s): s is MigrationStepSpec => {
    if (!s || seen.has(s.key)) return false;
    seen.add(s.key);
    return true;
  });
}
