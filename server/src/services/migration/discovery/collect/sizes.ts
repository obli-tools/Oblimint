import type { CwpInventory, CwpInventoryCounts } from '@oblimint/shared';
import { DiscoveryContext, stripSlash } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phases sizes + finalize: du of the homes, docroots and maildirs (generous
// timeouts), database sizes from information_schema, mail from du (quota2 as
// fallback); then the counts and the sorted, frozen CwpInventory.
// ─────────────────────────────────────────────────────────────────────────────

export async function phaseSizes(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const homes = await ctx.du('home sizes', st.accounts.map((a) => a.homeDir));
  // Served docroots only: a proxy / redirect domain keeps its DB path as docroot (contract) but nothing is copied from it.
  const served = (d: (typeof st.domains)[number]) => (d.serving === 'proxy' || d.serving === 'redirect' ? null : d.docroot);
  const docroots = await ctx.du('docroot sizes', [...new Set(st.domains.map(served).filter((x): x is string => !!x).map(stripSlash))]);
  const maildirs = await ctx.du('maildir sizes', st.mailboxes.map((m) => stripSlash(m.maildirPath)));

  for (const d of st.domains) { const r = served(d); d.docrootBytes = r ? docroots.get(stripSlash(r)) ?? null : null; }
  for (const m of st.mailboxes) m.maildirBytes = maildirs.get(stripSlash(m.maildirPath)) ?? null;
  for (const a of st.accounts) {
    a.homeBytes = homes.get(a.homeDir) ?? null;
    const boxes = st.mailboxes.filter((m) => m.account === a.username);
    a.mailBytes = boxes.length > 0 ? boxes.reduce((s, m) => s + (m.maildirBytes ?? m.usedBytes ?? 0), 0) : 0;
    const dbs = st.databases.filter((d) => d.account === a.username);
    a.dbBytes = dbs.reduce((s, d) => s + d.sizeBytes, 0);
  }
}

export function computeCounts(inv: Omit<CwpInventory, 'counts'>): CwpInventoryCounts {
  const kinds = (k: string) => inv.domains.filter((d) => d.kind === k).length;
  return {
    accounts: inv.accounts.length,
    suspendedAccounts: inv.accounts.filter((a) => a.suspended).length,
    packages: inv.packages.length,
    domains: inv.domains.length,
    mainDomains: kinds('main'),
    addonDomains: kinds('addon'),
    parkedDomains: kinds('parked'),
    subDomains: kinds('subdomain'),
    proxyDomains: inv.domains.filter((d) => d.serving === 'proxy').length,
    dnsZones: inv.dnsZones.length,
    databases: inv.databases.length,
    dbUsers: inv.dbUsers.length,
    mailDomains: inv.mailDomains.length,
    mailboxes: inv.mailboxes.length,
    mailAliases: inv.mailAliases.length,
    dkimKeys: inv.dkimKeys.length,
    ftpUsers: inv.ftpUsers.length,
    crons: inv.crons.length,
    certificates: inv.certificates.length,
    outside: inv.outside.length,
    filesBytes: inv.accounts.reduce((s, a) => s + (a.homeBytes ?? 0), 0),
    dbBytes: inv.databases.reduce((s, d) => s + d.sizeBytes, 0),
    mailBytes: inv.mailboxes.reduce((s, m) => s + (m.maildirBytes ?? m.usedBytes ?? 0), 0),
  };
}
