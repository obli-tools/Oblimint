import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Boxes, ChevronsDownUp, ChevronsUpDown, Globe, Network, Package, Server, UserRound,
} from 'lucide-react';
import type { CwpAccount, CwpDomainKind, CwpInventory } from '@oblimint/shared';
import { MasterDetail } from '@/components/common/MasterDetail';
import { TableScroll } from '@/components/common/TableScroll';
import { MailSearch } from '@/components/mail/MailListParts';
import { EmptyState, InfoRow, Pill, headerBtnCls, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, matches, severityCounts, sortWarnings } from '../migrationFormat';
import { SeverityCounts, WarningList, useByteUnits } from '../migrationUi';
import { cwpKindLabel } from './discoveryLabels';
import {
  CertificatesTable, CronsTable, DatabasesTable, DbUsersTable, DomainNode, FtpTable, MailDomainNode, OutsideList, ZoneNode,
} from './InventoryParts';
import { Node, TreeProvider, useTreeController } from './treeState';

const KIND_ORDER: CwpDomainKind[] = ['main', 'addon', 'parked', 'subdomain'];

function SectionHead({ icon, label, count }: { icon: ReactNode; label: string; count?: number }) {
  return (
    <span className="inline-flex items-center gap-2 font-medium">
      <span className="text-accent">{icon}</span>{label}
      {count != null && <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{count}</span>}
    </span>
  );
}

/** Everything of one CWP account (domains by kind, databases, users, mail, DKIM, FTP, crons, certificates, zones). */
function AccountDetail({ inv, account, q }: { inv: CwpInventory; account: CwpAccount; q: string }) {
  const { t } = useTranslation();
  const units = useByteUnits();
  const u = account.username;
  const own = <T extends { account: string | null }>(list: T[]) => list.filter((x) => x.account === u);
  const domains = inv.domains.filter((d) => d.account === u && matches(q, d.fqdn, d.docroot, d.proxy?.host));
  const dbs = own(inv.databases).filter((d) => matches(q, d.name));
  const dbUsers = own(inv.dbUsers).filter((d) => matches(q, d.user, d.host));
  const mailDomains = own(inv.mailDomains);
  const mailboxes = inv.mailboxes.filter((m) => m.account === u || mailDomains.some((md) => md.name === m.domain));
  const aliases = inv.mailAliases.filter((a) => a.account === u || mailDomains.some((md) => md.name === a.domain));
  const dkim = inv.dkimKeys.filter((k) => k.account === u || mailDomains.some((md) => md.name === k.domain));
  const shownMailDomains = mailDomains.filter((md) => matches(q, md.name) || mailboxes.some((m) => m.domain === md.name && matches(q, m.address)));
  const ftp = own(inv.ftpUsers).filter((f) => matches(q, f.login));
  const crons = own(inv.crons).filter((c) => matches(q, c.command));
  const certs = own(inv.certificates).filter((c) => matches(q, c.fqdn, ...c.names));
  const zones = inv.dnsZones.filter((z) => z.account === u && matches(q, z.name));
  const warnings = sortWarnings(inv.warnings.filter((w) => w.scope.account === u));
  const id = `acct:${u}`;

  return (
    <div className="space-y-2">
      <div className="rounded-xl bg-bg-secondary p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-base font-semibold text-text-primary">{u}</h3>
          {account.suspended && <Pill tone="amber">{t('migration.inventory.suspended') || 'suspended'}</Pill>}
          {account.reseller && <Pill tone="blue">{t('migration.inventory.reseller') || 'reseller'}: {account.reseller}</Pill>}
          {account.sshAccess && <Pill tone="amber">SSH{account.authorizedKeys ? ` · ${account.authorizedKeys} ${t('migration.inventory.keys') || 'keys'}` : ''}</Pill>}
          {warnings.length > 0 && <SeverityCounts counts={severityCounts(warnings)} />}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <InfoRow label={t('migration.inventory.mainDomain') || 'Main domain'} mono>{account.mainDomain}</InfoRow>
          <InfoRow label={t('migration.inventory.package') || 'Package'}>{account.packageName ?? '—'}</InfoRow>
          <InfoRow label="UID / GID" mono>{account.uid ?? '—'} / {account.gid ?? '—'}</InfoRow>
          <InfoRow label={t('migration.inventory.contact') || 'Contact'}>{account.contactEmail ?? '—'}</InfoRow>
          <InfoRow label={t('migration.inventory.home') || 'Files'} mono>{formatBytes(account.homeBytes, units)}</InfoRow>
          <InfoRow label={t('migration.inventory.mailSize') || 'Mail'} mono>{formatBytes(account.mailBytes, units)}</InfoRow>
          <InfoRow label={t('migration.inventory.dbSize') || 'Databases'} mono>{formatBytes(account.dbBytes, units)}</InfoRow>
          <InfoRow label="IP" mono>{account.ipAddress ?? '—'}</InfoRow>
          {account.fpmPools.length > 0 && <InfoRow label={t('migration.inventory.fpmPools') || 'PHP-FPM pools'} mono>{account.fpmPools.join(', ')}</InfoRow>}
          {account.phpIniFiles.length > 0 && <InfoRow label="php.ini" mono>{account.phpIniFiles.join(', ')}</InfoRow>}
          {account.extraDirs.length > 0 && <InfoRow label={t('migration.inventory.extraDirs') || 'Other directories'} mono>{account.extraDirs.join(', ')}</InfoRow>}
          <InfoRow label={t('migration.inventory.setupDate') || 'Created'} mono>{account.setupDate ?? '—'}</InfoRow>
        </div>
      </div>

      <div className="rounded-xl bg-bg-secondary p-2">
        <Node id={`${id}:domains`} defaultOpen title={<SectionHead icon={<Globe size={14} />} label={t('migration.inventory.domains') || 'Domains'} count={domains.length} />}>
          {KIND_ORDER.map((k) => {
            const list = domains.filter((d) => d.kind === k);
            if (!list.length) return null;
            return (
              <div key={k} className="space-y-0.5">
                <div className="px-1.5 pt-1 text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{cwpKindLabel(t, k)} · {list.length}</div>
                {list.map((d) => <DomainNode key={d.fqdn} d={d} idPrefix={id} />)}
              </div>
            );
          })}
        </Node>
        {(dbs.length > 0 || dbUsers.length > 0) && (
          <Node id={`${id}:db`} title={<SectionHead icon={<Boxes size={14} />} label={t('migration.inventory.databases') || 'Databases'} count={dbs.length} />}>
            {dbs.length > 0 && <DatabasesTable databases={dbs} />}
            {dbUsers.length > 0 && (
              <>
                <div className="px-1.5 pt-2 text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('migration.inventory.dbUsers') || 'Database users'} · {dbUsers.length}</div>
                <DbUsersTable users={dbUsers} />
              </>
            )}
          </Node>
        )}
        {shownMailDomains.length > 0 && (
          <Node id={`${id}:mail`} title={<SectionHead icon={<UserRound size={14} />} label={t('migration.inventory.mail') || 'Mail'} count={mailboxes.length} />}>
            {shownMailDomains.map((md) => (
              <MailDomainNode
                key={md.name}
                md={md}
                idPrefix={id}
                mailboxes={mailboxes.filter((m) => m.domain === md.name)}
                aliases={aliases.filter((a) => a.domain === md.name)}
                dkim={dkim.filter((k) => k.domain === md.name)}
              />
            ))}
          </Node>
        )}
        {zones.length > 0 && (
          <Node id={`${id}:zones`} title={<SectionHead icon={<Network size={14} />} label={t('migration.inventory.zones') || 'DNS zones'} count={zones.length} />}>
            {zones.map((z) => <ZoneNode key={z.name} z={z} idPrefix={id} />)}
          </Node>
        )}
        {ftp.length > 0 && (
          <Node id={`${id}:ftp`} title={<SectionHead icon={<Server size={14} />} label={t('migration.inventory.ftp') || 'FTP users'} count={ftp.length} />}>
            <FtpTable users={ftp} />
          </Node>
        )}
        {crons.length > 0 && (
          <Node id={`${id}:cron`} title={<SectionHead icon={<Server size={14} />} label={t('migration.inventory.crons') || 'Crons'} count={crons.length} />}>
            <CronsTable crons={crons} />
          </Node>
        )}
        {certs.length > 0 && (
          <Node id={`${id}:certs`} title={<SectionHead icon={<Server size={14} />} label={t('migration.inventory.certificates') || 'Certificates'} count={certs.length} />}>
            <CertificatesTable certs={certs} />
          </Node>
        )}
        {warnings.length > 0 && (
          <Node id={`${id}:warnings`} title={<SectionHead icon={<AlertTriangle size={14} />} label={t('migration.inventory.warnings') || 'Inventory warnings'} count={warnings.length} />}>
            <WarningList warnings={warnings} />
          </Node>
        )}
      </div>
    </div>
  );
}

/** Inventory tree of a finished discovery (search, expand / collapse all, accounts in master-detail). */
export function InventoryTree({ inv }: { inv: CwpInventory }) {
  const { t } = useTranslation();
  const units = useByteUnits();
  const [search, setSearch] = useState('');
  const q = search.trim();
  const tree = useTreeController(q.length > 0);
  const [selected, setSelected] = useState<string | null>(null);

  const accountMatches = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const a of inv.accounts) {
      const u = a.username;
      m.set(u, !q || matches(q, u, a.mainDomain, a.contactEmail)
        || inv.domains.some((d) => d.account === u && matches(q, d.fqdn, d.docroot, d.proxy?.host))
        || inv.databases.some((d) => d.account === u && matches(q, d.name))
        || inv.dbUsers.some((d) => d.account === u && matches(q, d.user))
        || inv.mailboxes.some((d) => d.account === u && matches(q, d.address))
        || inv.dnsZones.some((d) => d.account === u && matches(q, d.name))
        || inv.crons.some((d) => d.account === u && matches(q, d.command))
        || inv.ftpUsers.some((d) => d.account === u && matches(q, d.login)));
    }
    return m;
  }, [inv, q]);
  const accounts = inv.accounts.filter((a) => accountMatches.get(a.username));
  const nameMatchesAccount = (a: CwpAccount) => matches(q, a.username, a.mainDomain, a.contactEmail);
  const current = accounts.find((a) => a.username === selected) ?? null;

  const unattached = {
    zones: inv.dnsZones.filter((z) => !z.account && matches(q, z.name)),
    databases: inv.databases.filter((d) => !d.account && matches(q, d.name)),
    dbUsers: inv.dbUsers.filter((d) => !d.account && matches(q, d.user)),
    crons: inv.crons.filter((c) => !c.account && matches(q, c.command, c.owner)),
    certs: inv.certificates.filter((c) => !c.account && matches(q, c.fqdn, ...c.names)),
  };
  const outside = inv.outside.filter((o) => matches(q, o.key, o.code, o.account));
  const serverWarnings = sortWarnings(inv.warnings.filter((w) => !w.scope.account));
  const s = inv.server;

  return (
    <TreeProvider value={tree.value}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <MailSearch value={search} onChange={setSearch} placeholder={t('migration.inventory.search') || 'Account, domain, database, mailbox…'} />
          <button type="button" className={headerBtnCls} onClick={tree.expandAll}><ChevronsUpDown size={14} />{t('migration.inventory.expandAll') || 'Expand all'}</button>
          <button type="button" className={headerBtnCls} onClick={tree.collapseAll}><ChevronsDownUp size={14} />{t('migration.inventory.collapseAll') || 'Collapse all'}</button>
        </div>

        <div className="rounded-xl bg-bg-secondary p-2">
          <Node id="server" defaultOpen title={<SectionHead icon={<Server size={14} />} label={t('migration.inventory.server') || 'Server'} />} meta={s.hostname ?? ''}>
            <div className="grid grid-cols-2 gap-3 p-2 sm:grid-cols-4">
              <InfoRow label={t('migration.sources.os') || 'OS'}>{s.osRelease ?? '—'}</InfoRow>
              <InfoRow label={t('migration.sources.cwpVersion') || 'CWP version'} mono>{s.cwpVersion ?? '—'}{s.cwpPro ? ' Pro' : ''}</InfoRow>
              <InfoRow label={t('migration.inventory.webserver') || 'Web servers'} mono>{s.webserverSetup ?? '—'}</InfoRow>
              <InfoRow label="MariaDB" mono>{s.mariadbVersion ?? '—'}</InfoRow>
              <InfoRow label={t('migration.inventory.publicIps') || 'Public IPs'} mono>{s.publicIps.join(', ') || '—'}</InfoRow>
              <InfoRow label={t('migration.inventory.privateIps') || 'Private IPs'} mono>{s.privateIps.join(', ') || '—'}</InfoRow>
              <InfoRow label={t('migration.inventory.phpDefault') || 'Default PHP'} mono>{s.phpDefault ?? '—'}</InfoRow>
              <InfoRow label="PHP-FPM" mono>{s.phpFpmVersions.join(', ') || '—'}</InfoRow>
              <InfoRow label={t('migration.inventory.nameservers') || 'Name servers'} mono>{s.nameservers.join(', ') || '—'}</InfoRow>
              {s.extraDbPrefixes.length > 0 && <InfoRow label={t('migration.inventory.dbPrefixes') || 'Extra DB prefixes'} mono>{s.extraDbPrefixes.join(', ')}</InfoRow>}
            </div>
            {Object.keys(s.packages).length > 0 && (
              <Node id="server:rpm" level={1} title={t('migration.inventory.rpm') || 'Tool versions'} meta={String(Object.keys(s.packages).length)}>
                <div className="flex flex-wrap gap-1 px-1">{Object.entries(s.packages).map(([n, v]) => <Pill key={n}>{n} {v}</Pill>)}</div>
              </Node>
            )}
          </Node>

          <Node id="packages" title={<SectionHead icon={<Package size={14} />} label={t('migration.inventory.packages') || 'CWP packages'} count={inv.packages.length} />}>
            <TableScroll>
              <table className="w-full min-w-[720px] text-sm">
                <thead><tr className={theadRowCls}>
                  <th className="px-3 py-2 font-medium">{t('migration.inventory.package') || 'Package'}</th>
                  <th className="px-3 py-2 font-medium">{t('migration.inventory.disk') || 'Disk'}</th>
                  <th className="px-3 py-2 font-medium">{t('migration.inventory.bandwidth') || 'Bandwidth'}</th>
                  <th className="px-3 py-2 font-medium">{t('migration.counts.mailboxes') || 'Mailboxes'}</th>
                  <th className="px-3 py-2 font-medium">{t('migration.counts.databases') || 'Databases'}</th>
                  <th className="px-3 py-2 font-medium">{t('migration.inventory.domainsLimits') || 'Addon / parked / sub'}</th>
                  <th className="px-3 py-2 font-medium">{t('migration.counts.accounts') || 'Accounts'}</th>
                </tr></thead>
                <tbody>
                  {inv.packages.map((p) => {
                    const lim = (n: number | null) => (n == null ? '∞' : String(n));
                    return (
                      <tr key={p.id} className="border-t border-white/[0.04] text-xs">
                        <td className="px-3 py-2">{p.name} <span className="font-mono text-text-muted">#{p.id}</span>{p.isReseller && <Pill tone="blue" className="ml-1.5">{t('migration.inventory.reseller') || 'reseller'}</Pill>}</td>
                        <td className="px-3 py-2 font-mono text-text-muted">{p.diskQuotaMb == null ? '∞' : formatBytes(p.diskQuotaMb * 1024 * 1024, units)}</td>
                        <td className="px-3 py-2 font-mono text-text-muted">{p.bandwidthMbPerMonth == null ? '∞' : formatBytes(p.bandwidthMbPerMonth * 1024 * 1024, units)}</td>
                        <td className="px-3 py-2 font-mono text-text-muted">{lim(p.emailAccounts)}</td>
                        <td className="px-3 py-2 font-mono text-text-muted">{lim(p.databases)}</td>
                        <td className="px-3 py-2 font-mono text-text-muted">{lim(p.addonDomains)} / {lim(p.parkedDomains)} / {lim(p.subDomains)}</td>
                        <td className="px-3 py-2 font-mono text-text-primary">{p.accountCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </Node>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 px-1"><SectionHead icon={<UserRound size={14} />} label={t('migration.inventory.accounts') || 'Accounts'} count={accounts.length} /></div>
          {accounts.length === 0 ? <EmptyState icon={<UserRound />} text={t('common.noMatch') || 'No match'} /> : (
            <MasterDetail
              narrowMode="drawer"
              masterClassName="lg:w-80 lg:shrink-0"
              hasDetail={current != null}
              onBack={() => setSelected(null)}
              detailTitle={current?.username}
              emptyDetail={<EmptyState icon={<UserRound />} text={t('migration.inventory.pickAccount') || 'Choose an account to see its domains, databases, mail, DNS, FTP, crons and certificates.'} />}
              master={
                <ul className="max-h-[70vh] space-y-1 overflow-y-auto rounded-xl bg-bg-secondary p-1.5">
                  {accounts.map((a) => {
                    const n = inv.domains.filter((d) => d.account === a.username).length;
                    const w = inv.warnings.filter((x) => x.scope.account === a.username);
                    const blocking = w.some((x) => x.severity === 'blocking');
                    return (
                      <li key={a.username}>
                        <button
                          type="button"
                          onClick={() => setSelected(a.username)}
                          aria-current={selected === a.username ? 'true' : undefined}
                          className={cn('w-full rounded-lg px-3 py-2 text-left transition-colors', selected === a.username ? 'bg-accent/10 ring-1 ring-accent/40' : 'hover:bg-bg-hover')}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm text-text-primary">{a.username}</span>
                            {a.suspended && <Pill tone="amber">{t('migration.inventory.suspended') || 'suspended'}</Pill>}
                            {blocking && <Pill tone="red">!</Pill>}
                            <span className="ml-auto font-mono text-[10px] text-text-muted">{n} {t('migration.counts.inline.domains') || 'domains'}</span>
                          </div>
                          <div className="truncate text-[11px] text-text-muted">{a.mainDomain} · {a.packageName ?? '—'} · {formatBytes((a.homeBytes ?? 0) + (a.mailBytes ?? 0) + (a.dbBytes ?? 0), units)}</div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              }
              detail={current ? <AccountDetail inv={inv} account={current} q={nameMatchesAccount(current) ? '' : q} /> : null}
            />
          )}
        </div>

        <div className="rounded-xl bg-bg-secondary p-2">
          <Node id="dns" title={<SectionHead icon={<Network size={14} />} label={t('migration.inventory.allZones') || 'All DNS zones'} count={inv.dnsZones.length} />}>
            {inv.dnsZones.filter((z) => matches(q, z.name)).map((z) => <ZoneNode key={z.name} z={z} idPrefix="dns" />)}
          </Node>
          {(unattached.zones.length + unattached.databases.length + unattached.dbUsers.length + unattached.crons.length + unattached.certs.length) > 0 && (
            <Node id="unattached" title={<SectionHead icon={<AlertTriangle size={14} />} label={t('migration.inventory.unattached') || 'Not attached to an account'} />}>
              {unattached.zones.map((z) => <ZoneNode key={z.name} z={z} idPrefix="unattached" />)}
              {unattached.databases.length > 0 && <DatabasesTable databases={unattached.databases} />}
              {unattached.dbUsers.length > 0 && <DbUsersTable users={unattached.dbUsers} />}
              {unattached.crons.length > 0 && <CronsTable crons={unattached.crons} />}
              {unattached.certs.length > 0 && <CertificatesTable certs={unattached.certs} />}
            </Node>
          )}
          <Node id="outside" defaultOpen={outside.length > 0} title={<SectionHead icon={<Boxes size={14} />} label={t('migration.inventory.outside') || 'Outside CWP (manual follow-ups)'} count={outside.length} />}>
            {outside.length ? <OutsideList items={outside} /> : <p className="px-2 py-1 text-xs text-text-muted">{t('migration.inventory.noOutside') || 'Nothing outside the CWP model.'}</p>}
          </Node>
          <Node id="warnings" defaultOpen={serverWarnings.length > 0} title={<SectionHead icon={<AlertTriangle size={14} />} label={t('migration.inventory.serverWarnings') || 'Server warnings'} count={serverWarnings.length} />}>
            <WarningList warnings={serverWarnings} empty={t('migration.inventory.noWarning') || 'No warning.'} />
          </Node>
        </div>
      </div>
    </TreeProvider>
  );
}
