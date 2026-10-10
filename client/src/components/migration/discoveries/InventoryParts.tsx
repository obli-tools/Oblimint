import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CwpCertificate, CwpCronEntry, CwpDatabase, CwpDbUser, CwpDkimKey, CwpDnsZone, CwpDomain, CwpFtpUser, CwpMailAlias,
  CwpMailbox, CwpMailDomain, CwpOutsideItem,
} from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { Pill, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, formatDateTime, paramEntries } from '../migrationFormat';
import { SuggestionPill, codeText, useByteUnits } from '../migrationUi';
import { SERVING_TONE, cwpKindLabel, servingLabel } from './discoveryLabels';
import { Node } from './treeState';

const tableCls = 'w-full text-sm';
const smallTd = 'px-3 py-2 align-top text-xs';
const smallTh = 'px-3 py-2 font-medium';

function Yes({ on, label, tone = 'muted' }: { on: boolean; label: string; tone?: 'muted' | 'amber' | 'red' | 'green' | 'blue' | 'accent' }) {
  return on ? <Pill tone={tone}>{label}</Pill> : null;
}

// ── Domains ─────────────────────────────────────────────────────────────────

export function DomainDetails({ d }: { d: CwpDomain }) {
  const { t } = useTranslation();
  const units = useByteUnits();
  return (
    <div className="grid gap-x-6 gap-y-1.5 rounded-md bg-bg-primary px-3 py-2 text-xs sm:grid-cols-2">
      <div className="min-w-0">
        <span className="text-text-muted">{t('migration.inventory.docroot') || 'Docroot'} </span>
        <code className="break-all font-mono text-text-secondary">{d.docroot ?? '—'}</code>
        {d.docrootNonStandard && <Pill tone="amber" className="ml-1.5">{t('migration.inventory.nonStandard') || 'non-standard'}</Pill>}
        {d.docrootFromDb && d.docrootFromDb !== d.docroot && <div className="text-[11px] text-text-muted">{t('migration.inventory.docrootDb') || 'In the CWP database'}: <code className="font-mono">{d.docrootFromDb}</code></div>}
      </div>
      <div className="min-w-0">
        <span className="text-text-muted">PHP </span>
        {d.php ? (
          <>
            <span className="font-mono text-text-primary">{d.php.version ?? '—'}</span>
            <span className="ml-1.5 font-mono text-text-muted">{d.php.handler} · {t(`migration.phpSources.${d.php.source}`, { defaultValue: d.php.source })}</span>
            {d.php.htaccessOverrides.length > 0 && (
              <div className="mt-0.5 text-[11px] text-amber-400">
                {t('migration.inventory.phpOverrides') || '.htaccess overrides'}: {d.php.htaccessOverrides.map((o) => `${o.path} → ${o.version}`).join(', ')}
              </div>
            )}
          </>
        ) : <span className="text-text-muted">—</span>}
      </div>
      {d.proxy && (
        <div className="min-w-0">
          <span className="text-text-muted">{t('migration.inventory.proxyTarget') || 'Proxy target'} </span>
          <code className="font-mono text-text-primary">{d.proxy.scheme}://{d.proxy.host}:{d.proxy.port}</code>
          <span className="ml-1.5 inline-flex gap-1">
            <Yes on={d.proxy.isPrivate} label={t('migration.inventory.private') || 'private'} tone="amber" />
            <Yes on={d.proxy.websocket} label="websocket" tone="blue" />
            <Pill>{d.proxy.via}</Pill>
          </span>
        </div>
      )}
      {d.redirectTo && <div className="min-w-0"><span className="text-text-muted">{t('migration.inventory.redirectTo') || 'Redirects to'} </span><code className="break-all font-mono">{d.redirectTo}</code></div>}
      {d.app && (d.app.profile || d.app.markers.length > 0 || d.app.wordpress) && (
        <div className="min-w-0">
          <span className="text-text-muted">{t('migration.inventory.app') || 'Application'} </span>
          <span className="text-text-primary">{d.app.profile ?? '—'}</span>
          {d.app.wordpress?.version && <span className="ml-1 font-mono text-text-muted">WP {d.app.wordpress.version}</span>}
          {d.app.wordpress?.database && <span className="ml-1 font-mono text-text-muted">db={d.app.wordpress.database}</span>}
          <span className="ml-1.5 inline-flex flex-wrap gap-1">
            <Yes on={d.app.hasGit} label=".git" />
            <Yes on={d.app.hasPackageJson} label="package.json" />
            <Yes on={d.app.hasComposerJson} label="composer.json" />
            <Yes on={d.app.htaccess} label=".htaccess" />
            <Yes on={d.app.userIni} label=".user.ini" />
          </span>
        </div>
      )}
      <div className="min-w-0">
        <span className="text-text-muted">SSL </span>
        {d.ssl ? <Pill tone="green">{d.certificate ?? 'vhost'}</Pill> : <span className="text-text-muted">—</span>}
        <span className="ml-3 text-text-muted">{t('migration.inventory.zone') || 'Zone'} </span>
        <span className="font-mono text-text-secondary">{d.dnsZone ?? (t('migration.inventory.external') || 'external')}</span>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1">
        <Yes on={d.varnish} label="varnish" tone="blue" />
        <Yes on={d.customTemplate} label={t('migration.inventory.customTemplate') || 'custom template'} tone="amber" />
        <Yes on={d.wwwAlias} label="www" />
        {d.duplicateOf && <Pill tone="amber">{t('migration.inventory.duplicateOf', { kind: cwpKindLabel(t, d.duplicateOf), defaultValue: 'duplicate of {{kind}}' })}</Pill>}
        {d.nginxTemplate && <Pill>nginx: {d.nginxTemplate}</Pill>}
        {d.apacheTemplate && <Pill>apache: {d.apacheTemplate}</Pill>}
        {d.docrootBytes != null && <span className="font-mono text-[11px] text-text-muted">{formatBytes(d.docrootBytes, units)}</span>}
      </div>
    </div>
  );
}

export function DomainNode({ d, idPrefix }: { d: CwpDomain; idPrefix: string }) {
  const { t } = useTranslation();
  return (
    <Node
      id={`${idPrefix}:dom:${d.fqdn}`}
      level={1}
      title={<span className="font-mono text-[13px]">{d.fqdn}</span>}
      badges={
        <span className="inline-flex flex-wrap gap-1">
          <Pill tone={SERVING_TONE[d.serving]}>{servingLabel(t, d.serving)}</Pill>
          {d.php?.version && <Pill tone={d.php.version.startsWith('5') ? 'red' : 'muted'}>PHP {d.php.version}</Pill>}
          {d.docrootNonStandard && <Pill tone="amber">{t('migration.inventory.nonStandard') || 'non-standard'}</Pill>}
          {d.proxy?.isPrivate && <Pill tone="amber">{t('migration.inventory.private') || 'private'}</Pill>}
          {d.app?.profile && <Pill tone="accent">{d.app.profile}</Pill>}
        </span>
      }
    >
      <DomainDetails d={d} />
    </Node>
  );
}

// ── Databases ───────────────────────────────────────────────────────────────

export function DatabasesTable({ databases }: { databases: CwpDatabase[] }) {
  const { t } = useTranslation();
  const units = useByteUnits();
  return (
    <TableScroll>
      <table className={cn(tableCls, 'min-w-[720px]')}>
        <thead><tr className={theadRowCls}>
          <th className={smallTh}>{t('migration.inventory.database') || 'Database'}</th>
          <th className={smallTh}>{t('migration.inventory.size') || 'Size'}</th>
          <th className={smallTh}>{t('migration.inventory.tables') || 'Tables'}</th>
          <th className={smallTh}>{t('migration.inventory.engines') || 'Engines'}</th>
          <th className={smallTh}>{t('migration.inventory.collation') || 'Collation'}</th>
          <th className={smallTh}>{t('migration.inventory.objects') || 'Objects (DEFINER)'}</th>
        </tr></thead>
        <tbody>
          {databases.map((db) => (
            <tr key={db.name} className="border-t border-white/[0.04]">
              <td className={smallTd}>
                <code className="font-mono text-text-primary">{db.name}</code>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {db.memoryTables.length > 0 && <Pill tone="amber" title={db.memoryTables.join(', ')}>MEMORY ×{db.memoryTables.length}</Pill>}
                  {db.latin1Tables > 0 && <Pill tone="amber">latin1 ×{db.latin1Tables}</Pill>}
                  {db.account == null && <Pill tone="red">{t('migration.inventory.orphan') || 'orphan'}</Pill>}
                </div>
              </td>
              <td className={`${smallTd} font-mono text-text-muted`}>{formatBytes(db.sizeBytes, units)}</td>
              <td className={`${smallTd} font-mono text-text-muted`}>{db.tables}</td>
              <td className={`${smallTd} font-mono text-text-muted`}>{Object.entries(db.engines).map(([e, n]) => `${e}×${n}`).join(' ')}</td>
              <td className={`${smallTd} font-mono text-text-muted`}>{db.collation ?? '—'}</td>
              <td className={smallTd}>
                {db.objects.length === 0 ? <span className="text-text-muted">—</span> : (
                  <ul className="space-y-0.5">
                    {db.objects.slice(0, 8).map((o) => (
                      <li key={`${o.kind}-${o.name}`} className="font-mono text-[11px] text-text-secondary">
                        <span className="text-text-muted">{t(`migration.dbObjectKinds.${o.kind}`, { defaultValue: o.kind })}</span> {o.name} <span className="text-text-muted">DEFINER=</span>{o.definer}
                      </li>
                    ))}
                    {db.objects.length > 8 && <li className="text-[11px] text-text-muted">+{db.objects.length - 8}</li>}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function DbUsersTable({ users }: { users: CwpDbUser[] }) {
  const { t } = useTranslation();
  return (
    <TableScroll>
      <table className={cn(tableCls, 'min-w-[680px]')}>
        <thead><tr className={theadRowCls}>
          <th className={smallTh}>{t('migration.inventory.dbUser') || 'User'}</th>
          <th className={smallTh}>{t('migration.inventory.hashKind') || 'Hash'}</th>
          <th className={smallTh}>{t('migration.inventory.grants') || 'Grants'}</th>
        </tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={`${u.user}@${u.host}`} className="border-t border-white/[0.04]">
              <td className={smallTd}>
                <code className="font-mono text-text-primary">{u.user}</code><span className="font-mono text-text-muted">@{u.host}</span>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {u.remote && <Pill tone="amber">{t('migration.inventory.remote') || 'remote'}</Pill>}
                  {u.orphan && <Pill tone="red">{t('migration.inventory.orphan') || 'orphan'}</Pill>}
                  {u.plugin && u.plugin !== 'mysql_native_password' && <Pill>{u.plugin}</Pill>}
                </div>
              </td>
              <td className={smallTd}><Pill tone={u.hashKind === 'native' ? 'green' : u.hashKind === 'none' ? 'red' : 'amber'}>{t(`migration.hashKinds.${u.hashKind === 'old-password' ? 'oldPassword' : u.hashKind}`, { defaultValue: u.hashKind })}</Pill></td>
              <td className={smallTd}>
                {u.grants.length === 0 ? <span className="text-text-muted">—</span> : (
                  <ul className="space-y-0.5">
                    {u.grants.map((g) => (
                      <li key={g.dbPattern} className="font-mono text-[11px] text-text-secondary">
                        <span className="text-text-primary">{g.dbPattern}</span>
                        {g.wildcard && <span className="ml-1 text-amber-400">*</span>}
                        <span className="ml-1 text-text-muted">{g.privileges.length >= 10 ? 'ALL' : g.privileges.join(',')}{g.withGrantOption ? ' +GRANT' : ''}</span>
                        {g.wildcard && g.matches.length > 0 && <span className="ml-1 text-text-muted">→ {g.matches.join(', ')}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ── Mail ────────────────────────────────────────────────────────────────────

export function MailDomainNode({ md, mailboxes, aliases, dkim, idPrefix }: {
  md: CwpMailDomain;
  mailboxes: CwpMailbox[];
  aliases: CwpMailAlias[];
  dkim: CwpDkimKey[];
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const units = useByteUnits();
  return (
    <Node
      id={`${idPrefix}:mail:${md.name}`}
      level={1}
      title={<span className="font-mono text-[13px]">{md.name}</span>}
      meta={`${md.mailboxes} / ${md.aliases}`}
      badges={
        <span className="inline-flex flex-wrap gap-1">
          {!md.active && <Pill tone="amber">{t('migration.inventory.inactive') || 'inactive'}</Pill>}
          {md.backupMx && <Pill>backup MX</Pill>}
          {dkim.map((k) => <Pill key={k.selector} tone={(k.bits ?? 0) >= 2048 ? 'green' : 'amber'}>DKIM {k.selector} {k.bits ?? '?'}b</Pill>)}
        </span>
      }
    >
      {mailboxes.length > 0 && (
        <TableScroll>
          <table className={cn(tableCls, 'min-w-[640px]')}>
            <thead><tr className={theadRowCls}>
              <th className={smallTh}>{t('migration.inventory.mailbox') || 'Mailbox'}</th>
              <th className={smallTh}>{t('migration.inventory.usedQuota') || 'Used / quota'}</th>
              <th className={smallTh}>{t('migration.inventory.scheme') || 'Hash scheme'}</th>
              <th className={smallTh}>{t('migration.inventory.maildir') || 'Maildir'}</th>
            </tr></thead>
            <tbody>
              {mailboxes.map((m) => (
                <tr key={m.address} className="border-t border-white/[0.04]">
                  <td className={smallTd}>
                    <code className="font-mono text-text-primary">{m.address}</code>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {!m.active && <Pill tone="amber">{t('migration.inventory.inactive') || 'inactive'}</Pill>}
                      {m.hasSieve && <Pill tone="blue">sieve</Pill>}
                    </div>
                  </td>
                  <td className={`${smallTd} font-mono text-text-muted`}>{formatBytes(m.usedBytes ?? m.maildirBytes, units)} / {m.quotaBytes == null ? '∞' : formatBytes(m.quotaBytes, units)}{m.messages != null ? ` · ${m.messages} msg` : ''}</td>
                  <td className={smallTd}>{m.hashScheme ? <Pill tone={m.hashScheme === 'SHA512-CRYPT' || m.hashScheme === 'BLF-CRYPT' ? 'green' : 'amber'}>{m.hashScheme}{m.hashPrefixed ? '' : '*'}</Pill> : <Pill tone="red">{t('migration.inventory.noHash') || 'unknown'}</Pill>}</td>
                  <td className={`${smallTd} font-mono text-[11px] text-text-muted`}>{m.maildirPath}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {aliases.length > 0 && (
        <ul className="mt-2 space-y-0.5 px-1">
          {aliases.map((a) => (
            <li key={a.address} className="font-mono text-[11px] text-text-secondary">
              <Pill tone={a.kind === 'catch-all' ? 'amber' : 'muted'} className="mr-1.5">{t(`migration.aliasKinds.${a.kind === 'catch-all' ? 'catchAll' : a.kind}`, { defaultValue: a.kind })}</Pill>
              {a.address} → {a.targets.join(', ')}{!a.active && <span className="ml-1 text-amber-400">({t('migration.inventory.inactive') || 'inactive'})</span>}
            </li>
          ))}
        </ul>
      )}
    </Node>
  );
}

// ── FTP / cron / certificates ───────────────────────────────────────────────

export function FtpTable({ users }: { users: CwpFtpUser[] }) {
  const { t } = useTranslation();
  return (
    <TableScroll>
      <table className={cn(tableCls, 'min-w-[520px]')}>
        <thead><tr className={theadRowCls}>
          <th className={smallTh}>{t('migration.inventory.login') || 'Login'}</th>
          <th className={smallTh}>{t('migration.inventory.directory') || 'Directory'}</th>
          <th className={smallTh}>{t('migration.inventory.scheme') || 'Hash scheme'}</th>
        </tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.login} className="border-t border-white/[0.04]">
              <td className={`${smallTd} font-mono text-text-primary`}>{u.login}</td>
              <td className={`${smallTd} font-mono text-text-muted`}>{u.directory}{u.chroot && <Pill className="ml-1.5">chroot</Pill>}</td>
              <td className={smallTd}><Pill tone={u.hashScheme === 'bcrypt' ? 'green' : 'amber'}>{u.hashScheme}</Pill></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function CronsTable({ crons }: { crons: CwpCronEntry[] }) {
  const { t } = useTranslation();
  return (
    <TableScroll>
      <table className={cn(tableCls, 'min-w-[640px]')}>
        <thead><tr className={theadRowCls}>
          <th className={smallTh}>{t('migration.inventory.schedule') || 'Schedule'}</th>
          <th className={smallTh}>{t('migration.inventory.command') || 'Command'}</th>
          <th className={smallTh}>{t('migration.inventory.owner') || 'Owner'}</th>
        </tr></thead>
        <tbody>
          {crons.map((c) => (
            <tr key={c.key} className={cn('border-t border-white/[0.04]', c.disabled && 'opacity-60')}>
              <td className={`${smallTd} whitespace-nowrap font-mono text-text-primary`}>{c.schedule}</td>
              <td className={smallTd}>
                <code className="break-all font-mono text-[11px] text-text-secondary">{c.command}</code>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {c.phpVersion && <Pill tone={c.phpVersion.startsWith('5') || c.phpVersion.startsWith('7.0') ? 'amber' : 'muted'}>PHP {c.phpVersion}</Pill>}
                  {c.disabled && <Pill>{t('migration.inventory.commented') || 'commented out'}</Pill>}
                  {c.system && <Pill tone="amber">{t('migration.inventory.system') || 'system'}</Pill>}
                </div>
              </td>
              <td className={`${smallTd} font-mono text-text-muted`}>{c.owner}:{c.lineNo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function CertificatesTable({ certs }: { certs: CwpCertificate[] }) {
  const { t, i18n } = useTranslation();
  return (
    <TableScroll>
      <table className={cn(tableCls, 'min-w-[640px]')}>
        <thead><tr className={theadRowCls}>
          <th className={smallTh}>{t('migration.inventory.certificate') || 'Certificate'}</th>
          <th className={smallTh}>{t('migration.inventory.names') || 'Names'}</th>
          <th className={smallTh}>{t('migration.inventory.notAfter') || 'Expires'}</th>
          <th className={smallTh}>{t('migration.inventory.issuer') || 'Issuer'}</th>
        </tr></thead>
        <tbody>
          {certs.map((c) => (
            <tr key={c.fqdn} className="border-t border-white/[0.04]">
              <td className={smallTd}>
                <code className="font-mono text-text-primary">{c.fqdn}</code>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {c.expired && <Pill tone="red">{t('migration.inventory.expired') || 'expired'}</Pill>}
                  {c.selfSigned && <Pill tone="amber">{t('migration.inventory.selfSigned') || 'self-signed'}</Pill>}
                  {c.autossl && <Pill tone="blue">AutoSSL</Pill>}
                  <Pill>{c.keyType}</Pill>
                </div>
              </td>
              <td className={`${smallTd} font-mono text-[11px] text-text-muted`}>{c.names.join(', ')}</td>
              <td className={`${smallTd} font-mono text-[11px] text-text-muted`}>{formatDateTime(c.notAfter, i18n.language)}</td>
              <td className={`${smallTd} text-[11px] text-text-muted`}>{c.issuer ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ── DNS zones ───────────────────────────────────────────────────────────────

export function ZoneNode({ z, idPrefix }: { z: CwpDnsZone; idPrefix: string }) {
  const { t } = useTranslation();
  return (
    <Node
      id={`${idPrefix}:zone:${z.name}`}
      level={1}
      title={<span className="font-mono text-[13px]">{z.name}</span>}
      meta={t('migration.inventory.recordsCount', { count: z.records.length, defaultValue: '{{count}} records' })}
      badges={
        <span className="inline-flex flex-wrap gap-1">
          {z.dynamic && <Pill tone="amber">{t('migration.inventory.dynamic') || 'dynamic'}</Pill>}
          {z.journal && <Pill tone="blue">.jnl</Pill>}
          <Pill>{t(`migration.readVia.${z.readVia}`, { defaultValue: z.readVia })}</Pill>
          {!z.declared && <Pill tone="red">{t('migration.inventory.orphan') || 'orphan'}</Pill>}
        </span>
      }
    >
      <div className="mb-1 px-1 font-mono text-[11px] text-text-muted">
        NS: {z.nameservers.join(', ') || '—'} · serial {z.serial ?? '—'} · TTL {z.defaultTtl ?? '—'}{z.file ? ` · ${z.file}` : ''}
      </div>
      <RecordsTable records={z.records} />
    </Node>
  );
}

export function RecordsTable({ records, extra }: {
  records: Array<{ name: string; type: string; ttl: number; content: string; priority: number | null }>;
  extra?: (index: number) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <TableScroll>
      <table className={cn(tableCls, 'min-w-[560px]')}>
        <thead><tr className={theadRowCls}>
          <th className={smallTh}>{t('migration.inventory.recordName') || 'Name'}</th>
          <th className={smallTh}>{t('migration.inventory.recordType') || 'Type'}</th>
          <th className={smallTh}>TTL</th>
          <th className={smallTh}>{t('migration.inventory.recordContent') || 'Content'}</th>
          {extra && <th className={smallTh} />}
        </tr></thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={`${r.name}-${r.type}-${r.content}-${i}`} className="border-t border-white/[0.04]">
              <td className={`${smallTd} font-mono text-text-secondary`}>{r.name}</td>
              <td className={`${smallTd} font-mono text-text-primary`}>{r.type}</td>
              <td className={`${smallTd} font-mono text-text-muted`}>{r.ttl}</td>
              <td className={`${smallTd} break-all font-mono text-[11px] text-text-secondary`}>{r.priority != null ? `${r.priority} ` : ''}{r.content}</td>
              {extra && <td className={smallTd}>{extra(i)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ── Outside CWP ─────────────────────────────────────────────────────────────

export function OutsideList({ items }: { items: CwpOutsideItem[] }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1.5">
      {items.map((o) => (
        <li key={`${o.kind}-${o.key}`} className="rounded-md bg-bg-primary px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{t(`migration.outsideKinds.${o.kind}`, { defaultValue: o.kind })}</Pill>
            <code className="font-mono text-text-primary">{o.key}</code>
            {o.account && <span className="font-mono text-text-muted">@{o.account}</span>}
            <span className="ml-auto"><SuggestionPill suggestion={o.suggestion} /></span>
          </div>
          <p className="mt-1 text-text-secondary">{codeText(t, 'outside', o.code, o.params)}</p>
          {o.suggestion === 'docker-app' && <p className="mt-0.5 text-[11px] text-accent">{t('migration.outsideHints.dockerApp') || 'Docker application (P4b): recreate it as an app of the account, then route its domain to it.'}</p>}
          {paramEntries(o.details).length > 0 && (
            <dl className="mt-1 grid gap-x-3 gap-y-0.5 font-mono text-[11px] sm:grid-cols-[max-content_1fr]">
              {paramEntries(o.details).map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-text-muted">{k}</dt><dd className="break-all text-text-secondary">{v}</dd></div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

