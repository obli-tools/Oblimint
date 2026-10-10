import type { CwpInventory, MigrationDiscoveryPhase } from '@oblimint/shared';
import type { SourceSession } from '../contracts/source';
import { DiscoveryContext, emptyState, type DiscoveryState } from './collect/context';
import { phaseConnect, phaseServer } from './collect/server';
import { phaseAccounts, phaseCwpDb } from './collect/accounts';
import { phaseVhosts } from './collect/web';
import { phaseDocroots } from './collect/docroots';
import { phaseDns } from './collect/dns';
import { phaseDatabases } from './collect/databases';
import { phaseDkim, phaseMail } from './collect/mail';
import { phaseCertificates, phaseCron, phaseFtp } from './collect/misc';
import { phaseOutside } from './collect/outside';
import { computeCounts, phaseSizes } from './collect/sizes';
import { assertNoSecrets, scrubDeep } from './scrub';
import { annotatePublicDns, type PublicDnsLookup } from './publicDns';

// ─────────────────────────────────────────────────────────────────────────────
// collectInventory: pure orchestration of a discovery over a SourceSession
// (phase 'discovery': read templates only, MG1). Phases of P5-PLAN §7.1, each
// reported through onPhase; abortable between (and inside) phases. The result
// holds NO secret (MG2): collectors never read one, and a final scrub +
// assertion guards the persisted inventory.
// ─────────────────────────────────────────────────────────────────────────────

export const DISCOVERY_PHASES: readonly MigrationDiscoveryPhase[] = [
  'connect', 'server', 'cwp-db', 'accounts', 'vhosts', 'docroots', 'dns', 'databases', 'mail', 'dkim', 'ftp', 'cron',
  'certificates', 'outside', 'sizes', 'finalize',
];

export interface CollectOptions {
  signal?: AbortSignal;
  onPhase?: (phase: MigrationDiscoveryPhase, done: number, total: number) => void;
  /** Reference time for certificate expiry (tests). */
  now?: Date;
  /**
   * Public DNS lookup of each domain (D1: proof the domain is served by the source before a forced
   * verification). Absent = not checked (the planner then defaults to TXT verification).
   */
  publicDns?: PublicDnsLookup;
}

type PhaseFn = (ctx: DiscoveryContext) => Promise<void>;

const STEPS: Record<Exclude<MigrationDiscoveryPhase, 'finalize'>, PhaseFn> = {
  connect: phaseConnect,
  server: phaseServer,
  'cwp-db': phaseCwpDb,
  accounts: phaseAccounts,
  vhosts: phaseVhosts,
  docroots: phaseDocroots,
  dns: phaseDns,
  databases: phaseDatabases,
  mail: phaseMail,
  dkim: phaseDkim,
  ftp: phaseFtp,
  cron: phaseCron,
  certificates: phaseCertificates,
  outside: phaseOutside,
  sizes: phaseSizes,
};

export function buildInventory(state: DiscoveryState, ctx: DiscoveryContext): CwpInventory {
  const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b));
  const body: Omit<CwpInventory, 'counts'> = {
    schemaVersion: 1,
    collectedAt: state.now.toISOString(),
    server: state.server,
    packages: [...state.packages].sort((a, b) => a.id - b.id),
    accounts: [...state.accounts].sort(byKey((a) => a.username)),
    domains: state.domains,
    dnsZones: [...state.dnsZones].sort(byKey((z) => z.name)),
    databases: state.databases,
    dbUsers: state.dbUsers,
    mailDomains: state.mailDomains,
    mailboxes: state.mailboxes,
    mailAliases: state.mailAliases,
    dkimKeys: state.dkimKeys,
    ftpUsers: state.ftpUsers,
    crons: state.crons,
    certificates: [...state.certificates].sort(byKey((c) => c.fqdn)),
    outside: [...state.outside].sort(byKey((o) => `${o.kind}:${o.key}`)),
    warnings: ctx.warnings,
  };
  const inventory: CwpInventory = { ...body, counts: computeCounts(body) };
  const scrubbed = scrubDeep(inventory);
  if (scrubbed.hits > 0) {
    scrubbed.value.warnings.push({ code: 'secretRedacted', severity: 'warning', scope: { kind: 'server', key: 'inventory', account: null }, params: { count: scrubbed.hits } });
  }
  assertNoSecrets(scrubbed.value);
  return scrubbed.value;
}

export async function collectInventory(session: SourceSession, opts: CollectOptions = {}): Promise<CwpInventory> {
  if (session.phase !== 'discovery') throw new Error('collectInventory requires a discovery session');
  const state = emptyState(opts.now ?? new Date());
  const ctx = new DiscoveryContext(session, state, opts.signal);
  const total = DISCOVERY_PHASES.length;
  let i = 0;
  for (const phase of DISCOVERY_PHASES) {
    ctx.checkAbort();
    opts.onPhase?.(phase, i, total);
    if (phase !== 'finalize') await STEPS[phase](ctx);
    if (phase === 'dns' && opts.publicDns) await annotatePublicDns(state.domains, opts.publicDns, { checkAbort: () => ctx.checkAbort() });
    i += 1;
  }
  const inventory = buildInventory(state, ctx);
  opts.onPhase?.('finalize', total, total);
  return inventory;
}
