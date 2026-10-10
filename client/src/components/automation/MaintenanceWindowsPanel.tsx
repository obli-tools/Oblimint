import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CalendarClock, Pencil, Star, Trash2 } from 'lucide-react';
import {
  HostingSocketEvents, type AppMaintenanceWindow, type AppMaintenanceWindowInput, type MonitoringUpdatedPayload,
} from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { isStepUpHandled } from '@/api/client';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { browserTimezone, listTimezones } from '@/components/maintenance/maintenanceFormat';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import { WEEK_ORDER, formatDateTime, isHhMm, weekdayShort, windowEnd } from '@/components/apps/appsFormat';
import type { AutomationPanelProps } from './WorkflowsPanel';
import { describeWindow } from './automationUi';

/** Maintenance windows of the automatic app updates (days, start, duration, time zone, default window). */
export function MaintenanceWindowsPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: AutomationPanelProps) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [items, setItems] = useState<AppMaintenanceWindow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AppMaintenanceWindow | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await automationApi.listWindows({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('automation.windows.loadFailed') || 'Failed to load the maintenance windows', 'automation'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); }, (_e, p) => (p as MonitoringUpdatedPayload | null)?.entity === 'maintenanceWindow', 1000);

  const remove = async (w: AppMaintenanceWindow) => {
    if (!(await confirm({
      title: t('automation.windows.deleteTitle') || 'Delete the window',
      message: t('automation.windows.deleteConfirm', { name: w.name, defaultValue: 'Delete the window {{name}}? Applications using it fall back to the default window.' }),
      danger: true,
    }))) return;
    try {
      await automationApi.deleteWindow(w.id);
      toast.success(t('automation.windows.deleted') || 'Window deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('automation.windows.deleteFailed') || 'Failed to delete the window', 'automation');
    }
  };

  return (
    <>
      <p className="text-sm text-text-muted">{t('automation.windows.description') || 'Automatic updates of an application only run inside its window (or the default window of the account, then of the workspace). Without any window they may run at any time.'}</p>
      {items === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : items.length === 0 ? <EmptyState icon={<CalendarClock />} text={error ?? (t('automation.windows.empty') || 'No maintenance window.')} />
          : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {items.map((w) => (
                <div key={w.id} className={cn('min-w-0 rounded-xl bg-bg-secondary p-4', !w.enabled && 'opacity-60')}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium text-text-primary">{w.name}</span>
                        {w.isDefault && <Pill tone="accent"><Star size={9} />{t('automation.windows.default') || 'default'}</Pill>}
                        {!w.enabled && <Pill tone="muted">{t('automation.windows.disabled') || 'disabled'}</Pill>}
                        {w.enabled && w.openNow && <Pill tone="green">{t('automation.windows.openNow') || 'Open now'}</Pill>}
                        {isStaff && <TenantBadge tenantId={w.tenantId} />}
                      </div>
                      {showAccount && <div className="font-mono text-[11px] text-text-muted">{w.accountId == null ? (t('automation.windows.workspace') || 'workspace') : (accounts.find((a) => a.id === w.accountId)?.username ?? `#${w.accountId}`)}</div>}
                    </div>
                    {can('monitoring.manage', w.accountId) && (
                      <ActionMenu items={[
                        { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(w) },
                        { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(w); }, danger: true, separator: true },
                      ]} />
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {WEEK_ORDER.map((d) => (
                      <span key={d} className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] uppercase', w.schedule.days.includes(d) ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-muted')}>{weekdayShort(d, i18n.language)}</span>
                    ))}
                  </div>
                  <div className="mt-2 font-mono text-xs text-text-secondary">{describeWindow(w.schedule, i18n.language)}</div>
                  {w.enabled && !w.openNow && w.nextOpenAt && (
                    <div className="mt-1 text-[11px] text-text-muted">{t('automation.windows.nextOpen', { date: formatDateTime(w.nextOpenAt, i18n.language), defaultValue: 'Next opening: {{date}}' })}</div>
                  )}
                </div>
              ))}
            </div>
          )}
      {(creating || editing) && (
        <WindowModal
          window={editing}
          accountId={accountId}
          accounts={accounts.filter((a) => can('monitoring.manage', a.id))}
          onClose={() => { setEditing(null); onCreatingChange(false); }}
          onSaved={() => { setEditing(null); onCreatingChange(false); void load(); }}
        />
      )}
    </>
  );
}

function WindowModal({ window: win, accountId, accounts, onClose, onSaved }: {
  window: AppMaintenanceWindow | null;
  accountId: number | null;
  accounts: AutomationPanelProps['accounts'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { isStaff, can } = useP4bAccess();
  const [account, setAccount] = useState<string>(win ? (win.accountId == null ? 'workspace' : String(win.accountId)) : accountId != null ? String(accountId) : accounts.length === 1 ? String(accounts[0].id) : '');
  const [name, setName] = useState(win?.name ?? '');
  const [days, setDays] = useState<number[]>(win?.schedule.days ?? [0]);
  const [start, setStart] = useState(win?.schedule.start ?? '03:00');
  const [duration, setDuration] = useState(String(win?.schedule.durationMinutes ?? 120));
  const [timezone, setTimezone] = useState(win?.schedule.timezone ?? browserTimezone());
  const [enabled, setEnabled] = useState(win?.enabled ?? true);
  const [isDefault, setIsDefault] = useState(win?.isDefault ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const zones = useMemo(() => listTimezones(timezone), [timezone]);
  const end = windowEnd({ start, durationMinutes: Number(duration) || 0 });

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  const submit = async () => {
    setError('');
    if (!win && !account) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    const dur = Number(duration);
    if (days.length === 0 || !isHhMm(start) || !Number.isInteger(dur) || dur < 15 || dur > 1440) { setError(t('automation.errors.invalidSchedule') || 'Invalid schedule.'); return; }
    const body = { name: name.trim(), schedule: { days, start, durationMinutes: dur, timezone }, enabled, isDefault };
    setSaving(true);
    try {
      if (win) await automationApi.updateWindow(win.id, body);
      else await automationApi.createWindow({ ...body, accountId: account === 'workspace' ? null : Number(account) } as AppMaintenanceWindowInput);
      toast.success(t('automation.windows.saved') || 'Window saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('automation.windows.saveFailed') || 'Failed to save the window', 'automation'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<CalendarClock className="h-4 w-4 text-accent" />}
      title={win ? t('automation.windows.editTitle', { name: win.name, defaultValue: 'Edit {{name}}' }) : (t('automation.windows.createTitle') || 'New maintenance window')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{win ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {!win && accountId == null && (
          <div>
            <label className={labelCls} htmlFor="win-account">{t('apps.list.account') || 'Account'}</label>
            <select id="win-account" value={account} onChange={(e) => setAccount(e.target.value)} className={selectCls}>
              <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
              {isStaff && can('monitoring.manage') && <option value="workspace">{t('automation.windows.workspaceOption') || 'Whole workspace (default of every account)'}</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="win-name">{t('automation.form.name') || 'Name'}</label>
          <input id="win-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
        </div>
        <div>
          <div className={labelCls}>{t('automation.windows.days') || 'Days'}</div>
          <div className="flex flex-wrap gap-1.5">
            {WEEK_ORDER.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days.includes(d)}
                onClick={() => toggleDay(d)}
                className={cn('min-w-[3rem] rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors coarse:min-h-10', days.includes(d) ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30')}
              >
                {weekdayShort(d, i18n.language)}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="win-start">{t('automation.windows.start') || 'Start'}</label>
            <input id="win-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="win-duration">{t('automation.windows.duration') || 'Duration (min)'}</label>
            <input id="win-duration" type="number" min="15" max="1440" step="15" value={duration} onChange={(e) => setDuration(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
        </div>
        <p className="font-mono text-xs text-text-muted">{t('automation.windows.until', { end: end.end, defaultValue: 'until {{end}}' })}{end.nextDay ? ` ${t('automation.windows.nextDay') || '(next day)'}` : ''}</p>
        <div>
          <label className={labelCls} htmlFor="win-tz">{t('maintenance.schedule.timezone') || 'Time zone'}</label>
          <select id="win-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} className={selectCls}>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('automation.form.enabled') || 'Active'} />
          <ToggleSwitch checked={isDefault} onChange={setIsDefault} label={t('automation.windows.isDefault') || 'Default window'} description={t('automation.windows.isDefaultHint') || 'Used by the applications without an explicit window.'} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
