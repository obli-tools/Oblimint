import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowUpCircle, CheckCircle2, RefreshCw, RotateCcw } from 'lucide-react';
import type { AppDeployment, AppStackDetail, AppUpdateCheck } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { toastAppsError } from '../appsErrors';
import { formatDateTime, shortDigest } from '../appsFormat';

/**
 * Image updates by digest: check now (1 / min / stack), apply (all or the
 * selected services), exclude a service, go back to the previous image
 * (docs/P4b-PLAN.md §5.5).
 */
export function AppUpdatesTab({ stack, canManage, onStarted, onChanged }: {
  stack: AppStackDetail;
  canManage: boolean;
  onStarted: (d: AppDeployment) => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [check, setCheck] = useState<AppUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = stack.services.map((s) => {
    const c = check?.services.find((x) => x.service === s.name);
    return {
      ...s,
      latestDigest: c ? c.latestDigest : s.latestDigest,
      updateAvailable: c ? c.updateAvailable : s.updateAvailable,
      checkError: c?.error ?? null,
    };
  });
  const updatable = rows.filter((r) => r.updateAvailable && !r.excludedFromUpdates);

  const runCheck = async () => {
    setChecking(true);
    try {
      const r = await appsApi.checkUpdates(stack.id);
      setCheck(r);
      const n = r.services.filter((s) => s.updateAvailable).length;
      toast.success(n ? t('apps.updates.found', { count: n, defaultValue: '{{count}} update(s) available' }) : (t('apps.updates.upToDate') || 'Everything is up to date'));
    } catch (err) {
      toastAppsError(t, err, t('apps.updates.checkFailed') || 'The check failed');
    } finally {
      setChecking(false);
    }
  };

  const apply = async (services?: string[]) => {
    if (!(await confirm({
      title: t('apps.updates.applyTitle') || 'Apply the updates',
      message: services?.length
        ? t('apps.updates.applySome', { list: services.join(', '), defaultValue: 'Pull the new images and recreate {{list}}? If a service does not become healthy, its previous image is restored.' })
        : (t('apps.updates.applyAll') || 'Pull the new images and recreate the updated services? If a service does not become healthy, its previous image is restored.'),
      confirmLabel: t('apps.updates.apply') || 'Update',
    }))) return;
    setBusy('apply');
    try {
      onStarted(await appsApi.applyUpdates(stack.id, services?.length ? { services } : {}));
      setSelected(new Set());
      toast.success(t('apps.updates.applyStarted') || 'Update started');
    } catch (err) {
      toastAppsError(t, err, t('apps.updates.applyFailed') || 'The update failed');
    } finally {
      setBusy(null);
    }
  };

  const rollbackImage = async (service: string, digest: string | null) => {
    if (!(await confirm({
      title: t('apps.updates.rollbackTitle') || 'Previous image',
      message: t('apps.updates.rollbackConfirm', { service, digest: shortDigest(digest), defaultValue: 'Recreate {{service}} with its previous image ({{digest}})?' }),
      confirmLabel: t('apps.history.rollback') || 'Roll back',
    }))) return;
    setBusy(`rb-${service}`);
    try {
      onStarted(await appsApi.rollbackImage(stack.id, { service }));
      toast.success(t('apps.history.rollbackStarted') || 'Rollback started');
    } catch (err) {
      toastAppsError(t, err, t('apps.history.rollbackFailed') || 'The rollback failed');
    } finally {
      setBusy(null);
    }
  };

  const setExcluded = async (service: string, excluded: boolean) => {
    setBusy(`ex-${service}`);
    try {
      await appsApi.updateService(stack.id, service, { excludedFromUpdates: excluded });
      onChanged();
    } catch (err) {
      toastAppsError(t, err, t('apps.updates.excludeFailed') || 'Failed to change the service');
    } finally {
      setBusy(null);
    }
  };

  if (stack.services.length === 0) return <EmptyState icon={<ArrowUpCircle />} text={t('apps.overview.noServices') || 'No service deployed yet.'} />;

  const toggle = (name: string) => setSelected((s) => { const n = new Set(s); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-text-muted">
          {check
            ? t('apps.updates.checkedAt', { date: formatDateTime(check.checkedAt, i18n.language), defaultValue: 'Checked on {{date}}.' })
            : t('apps.updates.policy', { minutes: stack.updatePolicy.checkIntervalMin, defaultValue: 'The registries are checked every {{minutes}} min.' })}
          {' '}{stack.updatePolicy.autoUpdate ? (t('apps.updates.autoOn') || 'Updates are applied automatically (inside the maintenance window).') : (t('apps.updates.autoOff') || 'Updates are applied manually.')}
        </p>
        {canManage && (
          <>
            <Button size="sm" variant="secondary" loading={checking} onClick={() => { void runCheck(); }}><RefreshCw size={14} className="mr-1.5" />{t('apps.updates.check') || 'Check now'}</Button>
            <Button size="sm" loading={busy === 'apply'} disabled={updatable.length === 0 || busy !== null || stack.status === 'deploying'} onClick={() => { void apply(selected.size ? [...selected] : undefined); }}>
              <ArrowUpCircle size={14} className="mr-1.5" />
              {selected.size ? t('apps.updates.applySelected', { count: selected.size, defaultValue: 'Update {{count}} service(s)' }) : (t('apps.updates.applyAllButton') || 'Update all')}
            </Button>
          </>
        )}
      </div>
      <TableScroll className="bg-bg-secondary" stickyFirstCol>
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className={theadRowCls}>
              <th className={thCls}>{t('apps.effective.service') || 'Service'}</th>
              <th className={thCls}>{t('apps.effective.image') || 'Image'}</th>
              <th className={thCls}>{t('apps.updates.current') || 'Current'}</th>
              <th className={thCls}>{t('apps.updates.latest') || 'Latest'}</th>
              <th className={thCls}>{t('apps.list.status') || 'Status'}</th>
              <th className={thCls}>{t('apps.updates.excluded') || 'Excluded'}</th>
              <th className={cn(thCls, 'text-right')}><span className="sr-only">{t('apps.list.actions') || 'Actions'}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-border/40">
                <td className="px-4 py-3">
                  <label className="flex items-center gap-2">
                    {canManage && r.updateAvailable && !r.excludedFromUpdates && (
                      <input type="checkbox" checked={selected.has(r.name)} onChange={() => toggle(r.name)} className="accent-accent" aria-label={r.name} />
                    )}
                    <span className="font-mono text-[13px] text-text-primary">{r.name}</span>
                  </label>
                </td>
                <td className="px-4 py-3 break-all font-mono text-xs text-text-secondary">{r.image ?? (t('apps.effective.build') || 'built from source')}</td>
                <td className="px-4 py-3 font-mono text-xs text-text-secondary" title={r.currentDigest ?? undefined}>{shortDigest(r.currentDigest)}</td>
                <td className="px-4 py-3 font-mono text-xs text-text-secondary" title={r.latestDigest ?? undefined}>{shortDigest(r.latestDigest)}</td>
                <td className="px-4 py-3">
                  {r.checkError ? <Pill tone="red" title={r.checkError}>{t('apps.updates.checkError') || 'check failed'}</Pill>
                    : r.image == null ? <Pill tone="muted">{t('apps.updates.notApplicable') || 'n/a'}</Pill>
                      : r.updateAvailable ? <Pill tone="blue"><ArrowUpCircle size={10} />{t('apps.status.updateAvailable') || 'Update'}</Pill>
                        : <Pill tone="green"><CheckCircle2 size={10} />{t('apps.updates.upToDateShort') || 'up to date'}</Pill>}
                </td>
                <td className="px-4 py-3">
                  <ToggleSwitch size="sm" checked={r.excludedFromUpdates} disabled={!canManage || busy === `ex-${r.name}`} onChange={(c) => { void setExcluded(r.name, c); }} ariaLabel={t('apps.updates.excluded') || 'Excluded'} />
                </td>
                <td className="px-4 py-2 text-right">
                  {canManage && r.previousDigest && (
                    <Button size="sm" variant="ghost" loading={busy === `rb-${r.name}`} disabled={busy !== null} onClick={() => { void rollbackImage(r.name, r.previousDigest); }} title={shortDigest(r.previousDigest)}>
                      <RotateCcw size={13} className="mr-1" />{t('apps.updates.previous') || 'Previous image'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}
