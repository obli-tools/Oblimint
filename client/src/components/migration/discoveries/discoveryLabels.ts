import type { TFunction } from 'i18next';
import type { CwpDomainKind, CwpServing, MigrationDiscoveryPhase } from '@oblimint/shared';

// Labels of the discovery (phases, CWP domain kinds, serving). OWNED BY MODULE `ui-migration`.

export const DISCOVERY_PHASES: readonly MigrationDiscoveryPhase[] = [
  'connect', 'server', 'cwp-db', 'accounts', 'vhosts', 'docroots', 'dns', 'databases', 'mail', 'dkim',
  'ftp', 'cron', 'certificates', 'outside', 'sizes', 'finalize',
];

const PHASE_KEY: Record<MigrationDiscoveryPhase, string> = {
  connect: 'connect', server: 'server', 'cwp-db': 'cwpDb', accounts: 'accounts', vhosts: 'vhosts', docroots: 'docroots',
  dns: 'dns', databases: 'databases', mail: 'mail', dkim: 'dkim', ftp: 'ftp', cron: 'cron', certificates: 'certificates',
  outside: 'outside', sizes: 'sizes', finalize: 'finalize',
};
const PHASE_FALLBACK: Record<MigrationDiscoveryPhase, string> = {
  connect: 'Connection', server: 'Server', 'cwp-db': 'CWP database', accounts: 'Accounts', vhosts: 'Virtual hosts',
  docroots: 'Document roots', dns: 'DNS', databases: 'Databases', mail: 'Mail', dkim: 'DKIM', ftp: 'FTP', cron: 'Crons',
  certificates: 'Certificates', outside: 'Outside CWP', sizes: 'Sizes', finalize: 'Finalisation',
};

export function discoveryPhaseLabel(t: TFunction, p: MigrationDiscoveryPhase): string {
  return t(`migration.discovery.phases.${PHASE_KEY[p]}`, { defaultValue: PHASE_FALLBACK[p] ?? p });
}

const KIND_FALLBACK: Record<CwpDomainKind, string> = { main: 'Main', addon: 'Addon', parked: 'Parked', subdomain: 'Subdomain' };
export function cwpKindLabel(t: TFunction, k: CwpDomainKind): string {
  return t(`migration.cwpKinds.${k}`, { defaultValue: KIND_FALLBACK[k] ?? k });
}

const SERVING_FALLBACK: Record<CwpServing, string> = { site: 'site', proxy: 'proxy', redirect: 'redirect', disabled: 'disabled', unknown: 'unknown' };
export function servingLabel(t: TFunction, s: CwpServing): string {
  return t(`migration.serving.${s}`, { defaultValue: SERVING_FALLBACK[s] ?? s });
}
export const SERVING_TONE: Record<CwpServing, 'green' | 'blue' | 'muted' | 'amber' | 'red'> = {
  site: 'green', proxy: 'blue', redirect: 'amber', disabled: 'muted', unknown: 'red',
};
