import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, FileStack, Pencil, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import type { DnsTemplate } from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';
import { DnsTemplateModal } from './DnsTemplateModal';
import { dnsErrorMessage, toastDnsError } from './dnsErrors';

/** Templates tab of « Domains & DNS » (staff with dns.manage). */
export function DnsTemplatesTab() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [templates, setTemplates] = useState<DnsTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DnsTemplate | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setTemplates(await dnsApi.listTemplates());
      setLoadError(null);
    } catch (err) {
      setTemplates([]);
      setLoadError(dnsErrorMessage(t, err, t('dns.templates.loadFailed') || 'Failed to load the templates'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);

  const remove = async (tp: DnsTemplate) => {
    if (!(await confirm({
      title: t('dns.templates.deleteTitle') || 'Delete the template',
      message: t('dns.templates.deleteConfirm', { name: tp.name, defaultValue: 'Delete the template « {{name}} »? Existing zones keep their records.' }),
      danger: true,
    }))) return;
    try {
      await dnsApi.deleteTemplate(tp.id);
      setTemplates((cur) => cur.filter((x) => x.id !== tp.id));
      toast.success(t('dns.templates.deleted') || 'Template deleted');
    } catch (err) {
      toastDnsError(t, err, t('dns.templates.deleteFailed') || 'Failed to delete the template');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-text-muted">
          {t('dns.templates.hint') || 'Records added to new zones of the workspace (the default template) or applied to a zone on demand.'}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('dns.templates.create') || 'New template'}</button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : templates.length === 0 ? (
        <EmptyState icon={<FileStack />} text={t('dns.templates.empty') || 'No template yet.'} />
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {templates.map((tp) => (
            <li key={tp.id} className="rounded-xl bg-bg-secondary p-4">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">{tp.name}</span>
                    {tp.isDefault && <Pill tone="accent"><Star size={10} />{t('dns.templates.default') || 'default'}</Pill>}
                    {isMaster && <TenantBadge tenantId={tp.tenantId} />}
                  </div>
                  {tp.description && <p className="mt-0.5 text-xs text-text-muted">{tp.description}</p>}
                </div>
                <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={14} />} onClick={() => setEditing(tp)} />
                <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} variant="danger" onClick={() => { void remove(tp); }} />
              </div>
              <ul className="mt-3 space-y-1 rounded-lg bg-bg-primary p-2 font-mono text-[12px]">
                {tp.records.length === 0 && <li className="text-text-muted">{t('dns.templates.noRecord') || 'No record.'}</li>}
                {tp.records.map((r, i) => (
                  <li key={i} className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 truncate text-text-secondary">{r.name}</span>
                    <span className="w-12 shrink-0 text-accent">{r.type}</span>
                    <span className="min-w-0 break-all text-text-primary">{r.priority != null ? `${r.priority} ` : ''}{r.content}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <DnsTemplateModal
        open={editing !== null}
        template={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          toast.success(t('dns.templates.saved') || 'Template saved');
          void load(); // another template may have lost its default flag
        }}
      />
    </div>
  );
}
