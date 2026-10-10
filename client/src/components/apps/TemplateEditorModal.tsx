import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { LayoutGrid } from 'lucide-react';
import {
  APP_TEMPLATE_CATEGORIES, type AppTemplate, type AppTemplateCategory, type AppTemplateField, type AppTemplateInput,
} from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from './appsAccess';
import { appsErrorMessage } from './appsErrors';
import { isStepUpHandled } from '@/api/client';
import { CodeEditor } from './CodeEditor';
import { categoryLabel } from './AppBadges';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const FIELDS_EXAMPLE = `[
  {
    "key": "ADMIN_PASSWORD",
    "labelKey": null,
    "label": "Admin password",
    "description": null,
    "type": "password",
    "required": true,
    "default": null,
    "options": null,
    "generate": "password",
    "secret": true,
    "pattern": null
  }
]`;

/** Light shape check of the fields JSON (the server validates for real). */
function parseFields(text: string): AppTemplateField[] | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v)) return null;
    return v.every((f) => f && typeof f === 'object' && typeof (f as AppTemplateField).key === 'string' && typeof (f as AppTemplateField).label === 'string')
      ? (v as AppTemplateField[]) : null;
  } catch {
    return null;
  }
}

/** Create / edit a tenant or platform catalog template (staff; built-ins are read-only). */
export function TemplateEditorModal({ template, onClose, onSaved }: {
  template: AppTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { isPlatformAdmin } = useP4bAccess();
  const [loading, setLoading] = useState(template != null);
  const [slug, setSlug] = useState(template?.slug ?? '');
  const [name, setName] = useState(template?.name ?? '');
  const [icon, setIcon] = useState(template?.icon ?? 'boxes');
  const [category, setCategory] = useState<AppTemplateCategory>(template?.category ?? 'other');
  const [description, setDescription] = useState(template?.description ?? '');
  const [version, setVersion] = useState(template?.version ?? '1.0.0');
  const [docsUrl, setDocsUrl] = useState(template?.docsUrl ?? '');
  const [minMemory, setMinMemory] = useState(template?.minMemoryMb != null ? String(template.minMemoryMb) : '');
  const [proxyService, setProxyService] = useState(template?.defaultProxy?.service ?? '');
  const [proxyPort, setProxyPort] = useState(template?.defaultProxy ? String(template.defaultProxy.port) : '');
  const [enabled, setEnabled] = useState(template?.enabled ?? true);
  const [platform, setPlatform] = useState(template ? template.tenantId == null : false);
  const [compose, setCompose] = useState('');
  const [fieldsText, setFieldsText] = useState(template ? JSON.stringify(template.fields, null, 2) : '[]');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!template) return;
    let cancelled = false;
    appsApi.getTemplate(template.slug)
      .then((d) => { if (!cancelled) { setCompose(d.composeYaml); setFieldsText(JSON.stringify(d.fields, null, 2)); } })
      .catch((err) => { if (!cancelled) setError(appsErrorMessage(t, err, t('apps.catalog.loadFailed') || 'Failed to load the catalog')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [template, t]);

  const submit = async () => {
    const fields = parseFields(fieldsText);
    if (!SLUG_RE.test(slug)) { setError(t('apps.templateEditor.slugInvalid') || 'Slug: lower case letters, digits and dashes.'); return; }
    if (!name.trim() || !description.trim() || !version.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (!compose.trim()) { setError(t('apps.templateEditor.composeRequired') || 'The compose file is required.'); return; }
    if (!fields) { setError(t('apps.templateEditor.fieldsInvalid') || 'The fields must be a JSON array of objects with at least key and label.'); return; }
    const port = Number(proxyPort);
    if (proxyService.trim() && (!Number.isInteger(port) || port < 1 || port > 65535)) { setError(t('apps.templateEditor.portInvalid') || 'Invalid port.'); return; }
    const mem = minMemory.trim() ? Number(minMemory) : null;
    if (mem !== null && (!Number.isInteger(mem) || mem < 1)) { setError(t('apps.templateEditor.memoryInvalid') || 'Invalid memory.'); return; }
    const input: AppTemplateInput = {
      slug, name: name.trim(), icon: icon.trim() || 'boxes', category, description: description.trim(), docsUrl: docsUrl.trim() || null,
      version: version.trim(), composeYaml: compose, fields,
      defaultProxy: proxyService.trim() ? { service: proxyService.trim(), port } : null,
      minMemoryMb: mem, enabled,
      ...(isPlatformAdmin && platform ? { tenantId: null } : {}),
    };
    setSaving(true);
    setError('');
    try {
      if (template) await appsApi.updateTemplate(template.id, input);
      else await appsApi.createTemplate(input);
      toast.success(t('apps.templateEditor.saved') || 'Template saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('apps.templateEditor.saveFailed') || 'Failed to save the template'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      closeOnEscape={false}
      icon={<LayoutGrid className="h-4 w-4 text-accent" />}
      title={template ? t('apps.templateEditor.editTitle', { name: template.name, defaultValue: 'Edit the template {{name}}' }) : (t('apps.templateEditor.createTitle') || 'New catalog template')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={loading} onClick={() => { void submit(); }}>{template ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      {loading ? <div className="flex justify-center py-10"><LoadingSpinner /></div> : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="tpl-slug">{t('apps.templateEditor.slug') || 'Slug'}</label>
              <input id="tpl-slug" value={slug} disabled={template != null} onChange={(e) => setSlug(e.target.value.toLowerCase())} className={cn(inputCls, 'font-mono')} maxLength={63} />
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-name">{t('apps.templateEditor.name') || 'Name'}</label>
              <input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-version">{t('apps.templateEditor.version') || 'Version'}</label>
              <input id="tpl-version" value={version} onChange={(e) => setVersion(e.target.value)} className={cn(inputCls, 'font-mono')} maxLength={40} />
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-category">{t('apps.templateEditor.category') || 'Category'}</label>
              <select id="tpl-category" value={category} onChange={(e) => setCategory(e.target.value as AppTemplateCategory)} className={selectCls}>
                {APP_TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(t, c)}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-icon">{t('apps.templateEditor.icon') || 'Icon (lucide name)'}</label>
              <input id="tpl-icon" value={icon} onChange={(e) => setIcon(e.target.value)} className={cn(inputCls, 'font-mono')} maxLength={200} />
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-mem">{t('apps.templateEditor.minMemory') || 'Minimum memory (MB)'}</label>
              <input id="tpl-mem" type="number" min="1" value={minMemory} onChange={(e) => setMinMemory(e.target.value)} className={cn(inputCls, 'font-mono')} />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="tpl-desc">{t('apps.templateEditor.description') || 'Description'}</label>
            <textarea id="tpl-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={cn(inputCls, 'resize-y')} maxLength={1000} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <label className={labelCls} htmlFor="tpl-docs">{t('apps.templateEditor.docsUrl') || 'Documentation URL'}</label>
              <input id="tpl-docs" type="url" value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} className={inputCls} placeholder="https://" />
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-psvc">{t('apps.templateEditor.proxyService') || 'Proxy target: service'}</label>
              <input id="tpl-psvc" value={proxyService} onChange={(e) => setProxyService(e.target.value)} className={cn(inputCls, 'font-mono')} />
            </div>
            <div>
              <label className={labelCls} htmlFor="tpl-pport">{t('apps.templateEditor.proxyPort') || 'Proxy target: port'}</label>
              <input id="tpl-pport" type="number" min="1" max="65535" value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} className={cn(inputCls, 'font-mono')} />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('apps.templateEditor.enabled') || 'Enabled'} />
            {isPlatformAdmin && (
              <ToggleSwitch
                checked={platform}
                onChange={setPlatform}
                label={t('apps.templateEditor.platform') || 'Platform template'}
                description={t('apps.templateEditor.platformHint') || 'Visible to every workspace (otherwise to the current workspace only).'}
              />
            )}
          </div>
          <div>
            <div className={labelCls}>{t('apps.templateEditor.compose') || 'Compose (variables ${KEY} of the fields)'}</div>
            <CodeEditor value={compose} onChange={setCompose} minHeight="220px" maxHeight="420px" ariaLabel={t('apps.templateEditor.compose') || 'Compose'} />
          </div>
          <div>
            <div className={labelCls}>{t('apps.templateEditor.fields') || 'Form fields (JSON)'}</div>
            <CodeEditor value={fieldsText} onChange={setFieldsText} language="text" minHeight="140px" maxHeight="320px" placeholder={FIELDS_EXAMPLE} ariaLabel={t('apps.templateEditor.fields') || 'Fields'} />
            <p className="mt-1 text-[11px] text-text-muted">{t('apps.templateEditor.fieldsHint') || 'Each field: key, label, type (string, password, number, boolean, select, email, url, domain), required, default, options, generate (password, hex32, base64-32, uuid), secret, pattern.'}</p>
          </div>
          {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
