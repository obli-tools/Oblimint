import type { HostingActor, HostingNeed } from '../hosting/access';
import { loadOwned, type OwnedRow } from '../hosting/p4bAccess';

// Access to the proxy objects (docs/P4b-PLAN.md §12). OWNED BY MODULE `proxy-hosts` (implemented by the
// architect on hosting/p4bAccess.ts; loadProxyHost is consumed by monitoring-automation and honeypot-bans:
// contract frozen — 404 invisible, 403 without the need).

export interface ProxyHostRow extends OwnedRow {
  account_id: number;
  name: string;
  enabled: boolean;
}

export async function loadProxyHost(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<ProxyHostRow> {
  return loadOwned<ProxyHostRow>(actor, 'proxy_hosts', id, need, 'Proxy host');
}

export async function loadRedirection(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<OwnedRow> {
  return loadOwned(actor, 'proxy_redirections', id, need, 'Redirection');
}

export async function loadDeadHost(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<OwnedRow> {
  return loadOwned(actor, 'proxy_dead_hosts', id, need, 'Dead host');
}

export async function loadAccessList(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<OwnedRow> {
  return loadOwned(actor, 'access_lists', id, need, 'Access list');
}

export async function loadAuthProvider(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<OwnedRow> {
  return loadOwned(actor, 'auth_providers', id, need, 'Auth provider');
}
