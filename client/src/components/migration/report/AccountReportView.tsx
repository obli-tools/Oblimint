import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MigrationAccountReport, MigrationObjectKind } from '@oblimint/shared';
import { Card, Pill } from '@/components/hosting/hostingUi';
import { formatDateTime } from '../migrationFormat';
import { FollowUpList, MessageText, RunStatusPill, WarningList, runKindLabel, scopeLabel } from '../migrationUi';

const OBJECT_LINK: Partial<Record<MigrationObjectKind, (id: number) => string>> = {
  account: (id) => `/accounts/${id}`,
  site: (id) => `/sites/${id}`,
  dbInstance: (id) => `/databases/${id}`,
  zone: (id) => `/dns/zones/${id}`,
  mailDomain: (id) => `/mail/domains/${id}`,
  mailbox: (id) => `/mail/mailboxes/${id}`,
  proxyHost: (id) => `/proxy/hosts/${id}`,
};

/** Report of one account: runs, migrated objects by kind (links), skipped items, warnings, follow-ups. */
export function AccountReportView({ report, compact = false }: { report: MigrationAccountReport; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const byKind = new Map<MigrationObjectKind, MigrationAccountReport['migrated']>();
  for (const m of report.migrated) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className="font-mono text-sm text-text-primary">{report.cwpUsername}</span>
          <span>→</span>
          {report.targetAccountId != null
            ? <Link to={`/accounts/${report.targetAccountId}`} className="font-mono text-accent hover:underline">{report.targetUsername ?? `#${report.targetAccountId}`}</Link>
            : <span className="font-mono">{report.targetUsername ?? '—'}</span>}
          <span>· {formatDateTime(report.generatedAt, i18n.language)}</span>
        </div>
      )}
      {report.runs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {report.runs.map((r) => (
            <Link key={r.id} to={`/manage/migration/runs/${r.id}`} className="inline-flex items-center gap-1.5 rounded-md bg-bg-primary px-2 py-1 text-[11px] hover:bg-bg-hover">
              <span className="font-mono text-accent">#{r.id}</span>{runKindLabel(t, r.kind)}<RunStatusPill status={r.status} />
            </Link>
          ))}
        </div>
      )}
      <Card title={t('migration.report.migrated', { count: report.migrated.length, defaultValue: 'Migrated objects ({{count}})' })}>
        {report.migrated.length === 0 ? <p className="text-xs text-text-muted">—</p> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...byKind.entries()].map(([kind, list]) => (
              <div key={kind}>
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
                  {t(`migration.objectKinds.${kind}`, { defaultValue: kind })}<span className="rounded-full bg-accent/15 px-1.5 text-accent">{list.length}</span>
                </div>
                <ul className="space-y-0.5">
                  {list.map((m) => {
                    const link = OBJECT_LINK[kind]?.(m.targetId);
                    return (
                      <li key={`${m.sourceKey}-${m.targetId}`} className="truncate text-xs text-text-secondary" title={`${m.sourceKey} → ${m.label}`}>
                        {link ? <Link to={link} className="text-accent hover:underline">{m.label}</Link> : <span>{m.label}</span>}
                        {m.label !== m.sourceKey && <span className="ml-1 font-mono text-[10px] text-text-muted">← {m.sourceKey}</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
      {report.skipped.length > 0 && (
        <Card title={t('migration.report.skipped', { count: report.skipped.length, defaultValue: 'Skipped ({{count}})' })}>
          <ul className="space-y-1">
            {report.skipped.map((s, i) => (
              <li key={`${s.scope.kind}-${s.scope.key}-${i}`} className="flex flex-wrap items-center gap-2 text-xs">
                <Pill>{scopeLabel(t, s.scope)}</Pill>
                <span className="text-text-secondary"><MessageText message={s.reason} /></span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={t('migration.report.warnings', { count: report.warnings.length, defaultValue: 'Warnings ({{count}})' })}>
        <WarningList warnings={report.warnings} empty={t('migration.inventory.noWarning') || 'No warning.'} />
      </Card>
      <Card title={t('migration.warnings.followUps', { count: report.followUps.length, defaultValue: 'Manual follow-ups ({{count}})' })}>
        <FollowUpList followUps={report.followUps} empty={t('migration.warnings.noFollowUp') || 'No manual follow-up.'} />
      </Card>
    </div>
  );
}
