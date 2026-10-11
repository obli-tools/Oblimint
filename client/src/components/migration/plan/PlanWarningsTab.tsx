import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { MigrationScopeKind, MigrationSeverity, MigrationWarning } from '@oblimint/shared';
import { Card, EmptyState, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { planWarnings, severityCounts, sortWarnings } from '../migrationFormat';
import { FollowUpList, SeverityPill, WarningList, checkboxCls, severityLabel } from '../migrationUi';
import type { PlanEditor } from './usePlanEditor';

/**
 * Warnings (plan + accounts) and manual follow-ups, with filters and counts. Only the selected accounts by default:
 * the unselected ones are not executed (a partial migration would drown in their warnings).
 */
export function PlanWarningsTab({ editor }: { editor: PlanEditor }) {
  const { t } = useTranslation();
  const r = editor.plan.result;
  const [severity, setSeverity] = useState<MigrationSeverity | ''>('');
  const [scope, setScope] = useState<MigrationScopeKind | ''>('');
  const [account, setAccount] = useState('');
  const [everyAccount, setEveryAccount] = useState(false);
  const all = useMemo<MigrationWarning[]>(() => {
    if (!r) return [];
    const seen = new Set<string>();
    return sortWarnings(planWarnings(r, everyAccount).warnings.filter((w) => {
      const k = `${w.severity}|${w.code}|${w.scope.kind}|${w.scope.key}|${w.scope.account ?? ''}|${JSON.stringify(w.params ?? {})}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }));
  }, [r, everyAccount]);
  const followUps = useMemo(() => (r ? planWarnings(r, everyAccount).followUps : []), [r, everyAccount]);
  const unselected = r ? r.accounts.filter((a) => !a.selected).length : 0;
  if (!r) return <EmptyState icon={<AlertTriangle />} text={t('migration.overview.noResult') || 'No dry-run yet.'} />;

  const counts = severityCounts(all);
  const scopes = [...new Set(all.map((w) => w.scope.kind))].sort();
  const accounts = [...new Set(all.map((w) => w.scope.account).filter((a): a is string => !!a))].sort();
  const shown = all.filter((w) => (!severity || w.severity === severity) && (!scope || w.scope.kind === scope) && (!account || w.scope.account === account));
  const shownFollowUps = followUps.filter((f) => (!scope || f.scope.kind === scope) && (!account || f.scope.account === account));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(['blocking', 'warning', 'info'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSeverity(severity === s ? '' : s)} aria-pressed={severity === s} className={cn('rounded-full transition-opacity', severity && severity !== s && 'opacity-50')}>
            <SeverityPill severity={s} count={counts[s]} />
          </button>
        ))}
        <select aria-label={t('migration.warnings.scope') || 'Object'} value={scope} onChange={(e) => setScope(e.target.value as MigrationScopeKind | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-44')}>
          <option value="">{t('migration.warnings.allScopes') || 'Every object'}</option>
          {scopes.map((s) => <option key={s} value={s}>{t(`migration.scopes.${s}`, { defaultValue: s })}</option>)}
        </select>
        <select aria-label={t('migration.runs.account') || 'CWP account'} value={account} onChange={(e) => setAccount(e.target.value)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-44')}>
          <option value="">{t('migration.warnings.allAccounts') || 'Every account'}</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        {severity && <span className="text-xs text-text-muted">{severityLabel(t, severity)}</span>}
        {unselected > 0 && (
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-xs text-text-muted">
            <input type="checkbox" checked={everyAccount} onChange={(e) => { setEveryAccount(e.target.checked); setAccount(''); }} className={checkboxCls} />
            {t('migration.warnings.includeUnselected', { count: unselected, defaultValue: 'Include the unselected accounts ({{count}})' })}
          </label>
        )}
      </div>
      <Card title={t('migration.warnings.title', { count: shown.length, defaultValue: 'Warnings ({{count}})' })}>
        <WarningList warnings={shown} empty={t('migration.inventory.noWarning') || 'No warning.'} />
      </Card>
      <Card title={t('migration.warnings.followUps', { count: shownFollowUps.length, defaultValue: 'Manual follow-ups ({{count}})' })}>
        <FollowUpList followUps={shownFollowUps} empty={t('migration.warnings.noFollowUp') || 'No manual follow-up.'} />
      </Card>
    </div>
  );
}
