import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ExternalLink, LayoutTemplate, Pencil, Trash2 } from 'lucide-react';
import {
  HostingSocketEvents, type HostingAccount, type MonitoringUpdatedPayload, type StatusPage, type StatusPageInput, type UptimeMonitor,
} from '@oblimint/shared';
import { uptimeApi } from '@/api/uptime.api';
import { isStepUpHandled } from '@/api/client';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CopyButton, EmptyState, Pill, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import { STATUS_SLUG_RE } from '@/components/apps/appsFormat';
import { CodeEditor } from '@/components/apps/CodeEditor';
import { UptimeStatusPill } from '@/components/apps/AppBadges';

const CSS_MAX = 16 * 1024;

function publicUrl(slug: string): string {
  return `${window.location.origin}/status/${slug}`;
}

/** Status pages: list (public link, published state), create / edit (slug, monitors, CSS, publish). */
export function StatusPagesPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: {
  accountId: number | null;
  tenantId: number | undefined;
  accounts: HostingAccount[];
  showAccount: boolean;
  creating: boolean;
  onCreatingChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [pages, setPages] = useState<StatusPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StatusPage | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await uptimeApi.listStatusPages({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setPages(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setPages((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('uptime.pages.loadFailed') || 'Failed to load the status pages', 'uptime'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); }, (_e, p) => (p as MonitoringUpdatedPayload | null)?.entity === 'statusPage', 1000);

  const remove = async (p: StatusPage) => {
    if (!(await confirm({
      title: t('uptime.pages.deleteTitle') || 'Delete the status page',
      message: t('uptime.pages.deleteConfirm', { title: p.title, defaultValue: 'Delete {{title}}? Its public address stops working.' }),
      danger: true,
    }))) return;
    try {
      await uptimeApi.deleteStatusPage(p.id);
      toast.success(t('uptime.pages.deleted') || 'Status page deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('uptime.pages.deleteFailed') || 'Failed to delete the status page', 'uptime');
    }
  };

  const manageable = accounts.filter((a) => can('monitoring.manage', a.id));

  return (
    <div className="flex flex-col gap-3">
      {pages === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : pages.length === 0 ? <EmptyState icon={<LayoutTemplate />} text={error ?? (t('uptime.pages.empty') || 'No status page yet.')} />
          : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {pages.map((p) => {
                const manage = can('monitoring.manage', p.accountId);
                return (
                  <div key={p.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-bg-secondary p-4">
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate font-semibold text-text-primary">{p.title}</span>
                          {p.published ? <Pill tone="green">{t('uptime.pages.published') || 'published'}</Pill> : <Pill tone="muted">{t('uptime.pages.draft') || 'draft'}</Pill>}
                          {isStaff && <TenantBadge tenantId={p.tenantId} />}
                        </div>
                        {showAccount && <div className="font-mono text-[11px] text-text-muted">{p.accountId == null ? (t('uptime.platformShort') || 'platform') : (accounts.find((a) => a.id === p.accountId)?.username ?? `#${p.accountId}`)}</div>}
                      </div>
                      {manage && (
                        <ActionMenu items={[
                          { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(p) },
                          { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(p); }, danger: true, separator: true },
                        ]} />
                      )}
                    </div>
                    {p.description && <p className="line-clamp-2 text-sm text-text-secondary">{p.description}</p>}
                    <div className="mt-auto flex min-w-0 items-center gap-1 rounded-lg bg-bg-primary px-2 py-1.5">
                      <a href={publicUrl(p.slug)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-accent hover:underline">/status/{p.slug}</a>
                      <CopyButton text={publicUrl(p.slug)} />
                      <a href={publicUrl(p.slug)} target="_blank" rel="noopener noreferrer" className="p-1 text-text-muted hover:text-accent" aria-label={t('uptime.pages.open') || 'Open'}><ExternalLink size={13} /></a>
                    </div>
                    <div className="text-[11px] text-text-muted">{t('uptime.pages.monitorCount', { count: p.monitorIds.length, defaultValue: '{{count}} monitor(s)' })}</div>
                  </div>
                );
              })}
            </div>
          )}
      {(creating || editing) && (
        <StatusPageModal
          page={editing}
          accountId={accountId}
          accounts={manageable}
          onClose={() => { setEditing(null); onCreatingChange(false); }}
          onSaved={() => { setEditing(null); onCreatingChange(false); void load(); }}
        />
      )}
    </div>
  );
}

function StatusPageModal({ page, accountId, accounts, onClose, onSaved }: {
  page: StatusPage | null;
  accountId: number | null;
  accounts: HostingAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { isStaff, can } = useP4bAccess();
  const [account, setAccount] = useState<string>(page ? (page.accountId == null ? 'platform' : String(page.accountId)) : accountId != null ? String(accountId) : accounts.length === 1 ? String(accounts[0].id) : '');
  const [slug, setSlug] = useState(page?.slug ?? '');
  const [title, setTitle] = useState(page?.title ?? '');
  const [description, setDescription] = useState(page?.description ?? '');
  const [monitorIds, setMonitorIds] = useState<number[]>(page?.monitorIds ?? []);
  const [css, setCss] = useState(page?.customCss ?? '');
  const [published, setPublished] = useState(page?.published ?? false);
  const [monitors, setMonitors] = useState<UptimeMonitor[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Monitors of the same account (platform pages: platform monitors).
  useEffect(() => {
    if (!account) { setMonitors(null); return; }
    let cancelled = false;
    setMonitors(null);
    uptimeApi.listMonitors(account === 'platform' ? {} : { accountId: Number(account) })
      .then((l) => { if (!cancelled) setMonitors(l.filter((m) => (account === 'platform' ? m.accountId == null : m.accountId === Number(account)))); })
      .catch(() => { if (!cancelled) setMonitors([]); });
    return () => { cancelled = true; };
  }, [account]);

  const toggle = (id: number) => setMonitorIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async () => {
    setError('');
    if (!page && !account) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!STATUS_SLUG_RE.test(slug)) { setError(t('uptime.pages.slugInvalid') || 'Address: 3 to 63 lower case letters, digits and dashes.'); return; }
    if (!title.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (new TextEncoder().encode(css).length > CSS_MAX) { setError(t('uptime.pages.cssTooLong') || 'The CSS is limited to 16 KiB.'); return; }
    const body = { slug, title: title.trim(), description: description.trim() || null, monitorIds, customCss: css.trim() || null, published };
    setSaving(true);
    try {
      if (page) await uptimeApi.updateStatusPage(page.id, body);
      else await uptimeApi.createStatusPage({ ...body, accountId: account === 'platform' ? null : Number(account) } as StatusPageInput);
      toast.success(t('uptime.pages.saved') || 'Status page saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('uptime.pages.saveFailed') || 'Failed to save the status page', 'uptime'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      closeOnEscape={false}
      icon={<LayoutTemplate className="h-4 w-4 text-accent" />}
      title={page ? t('uptime.pages.editTitle', { title: page.title, defaultValue: 'Edit {{title}}' }) : (t('uptime.pages.createTitle') || 'New status page')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{page ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!page && accountId == null && (
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="sp-account">{t('apps.list.account') || 'Account'}</label>
              <select id="sp-account" value={account} onChange={(e) => { setAccount(e.target.value); setMonitorIds([]); }} className={selectCls}>
                <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
                {isStaff && can('monitoring.manage') && <option value="platform">{t('uptime.platform') || 'Platform (no account)'}</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="sp-title">{t('uptime.pages.titleField') || 'Title'}</label>
            <input id="sp-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} maxLength={100} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sp-slug">{t('uptime.pages.slug') || 'Public address'}</label>
            <div className="flex items-center gap-1">
              <span className="shrink-0 font-mono text-xs text-text-muted">/status/</span>
              <input id="sp-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className={cn(inputCls, 'font-mono', slug && !STATUS_SLUG_RE.test(slug) && 'ring-1 ring-status-down')} maxLength={63} autoCapitalize="off" spellCheck={false} />
            </div>
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="sp-desc">{t('uptime.pages.descriptionField') || 'Description'}</label>
          <textarea id="sp-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputCls, 'resize-y')} maxLength={1000} />
        </div>
        <div>
          <div className={labelCls}>{t('uptime.pages.monitors') || 'Monitors shown'}</div>
          {!account ? <p className="text-xs text-text-muted">{t('apps.scope.pickAccount') || 'Choose an account…'}</p>
            : monitors === null ? <LoadingSpinner size="sm" />
              : monitors.length === 0 ? <p className="text-xs text-text-muted">{t('uptime.pages.noMonitor') || 'This account has no monitor yet.'}</p>
                : (
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg bg-bg-primary p-2">
                    {monitors.map((m) => (
                      <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-bg-hover coarse:min-h-10">
                        <input type="checkbox" checked={monitorIds.includes(m.id)} onChange={() => toggle(m.id)} className="accent-accent" />
                        <span className="min-w-0 flex-1 truncate text-text-primary">{m.name}</span>
                        <UptimeStatusPill status={m.enabled ? m.status : 'paused'} />
                      </label>
                    ))}
                  </div>
                )}
          <p className="mt-1 text-[11px] text-text-muted">{t('uptime.pages.privacy') || 'The public page shows only the names, statuses and uptime of the monitors: never their address nor their errors.'}</p>
        </div>
        <div>
          <div className={labelCls}>{t('uptime.pages.css') || 'Custom CSS (optional)'}</div>
          <CodeEditor value={css} onChange={setCss} language="text" minHeight="100px" maxHeight="260px" placeholder=".om-status-header { background: #0b1021; }" ariaLabel="CSS" />
          <p className="mt-1 text-[11px] text-text-muted">{t('uptime.pages.cssHint') || '16 KiB at most. @import, url() and expression() are removed by the server.'}</p>
        </div>
        <ToggleSwitch checked={published} onChange={setPublished} label={t('uptime.pages.publish') || 'Published'} description={t('uptime.pages.publishHint') || 'An unpublished page answers 404 to everyone.'} />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
