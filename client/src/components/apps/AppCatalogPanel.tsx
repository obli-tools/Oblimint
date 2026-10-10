import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { BookOpen, LayoutGrid, Lock, Pencil, Plus, Power, PowerOff, Search, Trash2 } from 'lucide-react';
import {
  APP_TEMPLATE_CATEGORIES, HostingSocketEvents, type AppTemplate, type AppTemplateCategory, type AppUpdatedPayload,
} from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, headerBtnCls, inputCls, sectionTitleCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { cn } from '@/utils/cn';
import { useP4bAccess } from './appsAccess';
import { appsErrorMessage, toastAppsError } from './appsErrors';
import { CatalogIcon } from './CatalogIcon';
import { TemplateEditorModal } from './TemplateEditorModal';
import { categoryLabel } from './AppBadges';


/** Catalog tab of /apps: template cards by category → creation form (/apps/new?source=catalog&template=<slug>). */
export function AppCatalogPanel({ accountId }: { accountId: number | null }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can, isStaff, isPlatformAdmin } = useP4bAccess();
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<AppTemplateCategory | null>(null);
  const [editing, setEditing] = useState<AppTemplate | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await appsApi.listCatalog());
      setError(null);
    } catch (err) {
      setError(appsErrorMessage(t, err, t('apps.catalog.loadFailed') || 'Failed to load the catalog'));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.APP_UPDATED], () => { void load(); }, (_e, p) => (p as AppUpdatedPayload | null)?.entity === 'template', 800);

  const manageTemplates = isStaff && can('apps.manage');
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((tpl) => (manageTemplates || tpl.enabled)
      && (!category || tpl.category === category)
      && (!q || tpl.name.toLowerCase().includes(q) || tpl.slug.includes(q) || tpl.description.toLowerCase().includes(q)));
  }, [templates, search, category, manageTemplates]);
  const groups = useMemo(() => APP_TEMPLATE_CATEGORIES
    .map((c) => ({ category: c, items: shown.filter((tpl) => tpl.category === c) }))
    .filter((g) => g.items.length > 0), [shown]);
  const present = useMemo(() => new Set(templates.map((tpl) => tpl.category)), [templates]);

  const open = (tpl: AppTemplate) => {
    if (!tpl.enabled) return;
    const q = new URLSearchParams({ source: 'catalog', template: tpl.slug });
    if (accountId != null) q.set('account', String(accountId));
    navigate(`/apps/new?${q.toString()}`);
  };

  const remove = async (tpl: AppTemplate) => {
    if (!(await confirm({
      title: t('apps.catalog.deleteTitle') || 'Delete the template',
      message: t('apps.catalog.deleteConfirm', { name: tpl.name, defaultValue: 'Delete the template {{name}}? Applications already created from it keep running.' }),
      danger: true,
    }))) return;
    try {
      await appsApi.deleteTemplate(tpl.id);
      toast.success(t('apps.catalog.deleted') || 'Template deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('apps.catalog.deleteFailed') || 'Failed to delete the template');
    }
  };

  /** Built-ins are read-only except their availability (platform admin only, server catalog.service). */
  const toggleBuiltin = async (tpl: AppTemplate) => {
    try {
      await appsApi.updateTemplate(tpl.id, { enabled: !tpl.enabled });
      toast.success(tpl.enabled ? (t('apps.catalog.disabledToast') || 'Template disabled') : (t('apps.catalog.enabledToast') || 'Template enabled'));
      void load();
    } catch (err) {
      toastAppsError(t, err, t('apps.catalog.saveFailed') || 'Failed to save the template');
    }
  };

  if (loading) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  if (error && templates.length === 0) return <EmptyState icon={<LayoutGrid />} text={error} />;

  const chip = (active: boolean) => cn(
    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-3',
    active ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-secondary text-text-muted hover:border-accent/30',
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('apps.catalog.search') || 'Search the catalog…'} className={cn(inputCls, 'bg-bg-secondary pl-8')} />
        </div>
        {manageTemplates && (
          <button type="button" onClick={() => setEditing('new')} className={cn(headerBtnCls, 'sm:ml-auto')}><Plus size={14} />{t('apps.catalog.newTemplate') || 'New template'}</button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={chip(category === null)} onClick={() => setCategory(null)}>{t('apps.catalog.allCategories') || 'All'}</button>
        {APP_TEMPLATE_CATEGORIES.filter((c) => present.has(c)).map((c) => (
          <button key={c} type="button" className={chip(category === c)} onClick={() => setCategory(category === c ? null : c)}>{categoryLabel(t, c)}</button>
        ))}
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={<LayoutGrid />} text={templates.length === 0 ? (t('apps.catalog.empty') || 'The catalog is empty.') : (t('apps.catalog.noMatch') || 'No template matches.')} />
      ) : groups.map((g) => (
        <section key={g.category}>
          <h2 className={cn(sectionTitleCls, 'mb-2')}>{categoryLabel(t, g.category)}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((tpl) => (
              <div
                key={tpl.id}
                role="button"
                tabIndex={tpl.enabled ? 0 : -1}
                aria-disabled={!tpl.enabled}
                onClick={() => open(tpl)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(tpl); } }}
                className={cn(
                  'group flex min-w-0 flex-col gap-2 rounded-xl border-2 border-transparent bg-bg-secondary p-4 text-left transition-colors',
                  tpl.enabled ? 'cursor-pointer hover:border-accent/30 focus-visible:border-accent focus-visible:outline-none' : 'opacity-60',
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <CatalogIcon icon={tpl.icon} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold text-text-primary">{tpl.name}</span>
                      <span className="font-mono text-[11px] text-text-muted">{tpl.version}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {tpl.builtin && <Pill tone="muted"><Lock size={9} />{t('apps.catalog.builtin') || 'built-in'}</Pill>}
                      {tpl.tenantId != null && <TenantBadge tenantId={tpl.tenantId} />}
                      {!tpl.enabled && <Pill tone="amber">{t('apps.catalog.disabled') || 'disabled'}</Pill>}
                      {tpl.minMemoryMb != null && (
                        <Pill tone="blue">{t('apps.catalog.minMemory', { value: formatMb(tpl.minMemoryMb, { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' }), defaultValue: '≥ {{value}}' })}</Pill>
                      )}
                    </div>
                  </div>
                  {manageTemplates && tpl.builtin && isPlatformAdmin && (
                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <ActionMenu items={[
                        tpl.enabled
                          ? { key: 'disable', icon: <PowerOff size={14} />, label: t('apps.catalog.disable') || 'Disable', onClick: () => { void toggleBuiltin(tpl); } }
                          : { key: 'enable', icon: <Power size={14} />, label: t('apps.catalog.enable') || 'Enable', onClick: () => { void toggleBuiltin(tpl); } },
                      ]} />
                    </div>
                  )}
                  {manageTemplates && !tpl.builtin && (
                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <ActionMenu items={[
                        { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(tpl) },
                        { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(tpl); }, danger: true, separator: true },
                      ]} />
                    </div>
                  )}
                </div>
                <p className="line-clamp-3 text-sm text-text-secondary">{tpl.description}</p>
                {tpl.docsUrl && (
                  <a href={tpl.docsUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="mt-auto inline-flex items-center gap-1 self-start text-xs text-accent hover:underline">
                    <BookOpen size={12} />{t('apps.catalog.docs') || 'Documentation'}
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}

      {editing && (
        <TemplateEditorModal
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}
