import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, FileCode2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  CUSTOM_PAGE_CODES, CUSTOM_PAGE_PLACEHOLDERS, HostingSocketEvents,
  type CustomPage, type CustomPageCode, type HostingAccount, type ProxyUpdatedPayload,
} from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { ListState, useProxyAccess } from './proxyUi';
import { proxyErrorCode, proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';

const MAX_HTML = 256 * 1024;

const STARTER_HTML = `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>{{CODE}}</title></head>
<body style="font-family:system-ui;text-align:center;padding:4rem">
  <h1>{{CODE}}</h1>
  <p>{{MESSAGE}}</p>
  <small>{{HOST}}</small>
</body>
</html>
`;

/**
 * Custom error / waking pages: the account's pages and the platform pages of
 * the tenant (read-only for a client, editable by the platform staff).
 */
export function CustomPagesPanel({ accountId, tenantId, accounts, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { canManage, isStaff } = useProxyAccess();
  const [items, setItems] = useState<CustomPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountDir = useAccountDirectory();
  const [editing, setEditing] = useState<CustomPage | 'new' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await proxyApi.listCustomPages({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.pages.loadFailed') || 'Failed to load the custom pages'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => (p as ProxyUpdatedPayload | null)?.entity === 'customPage', 800);

  // Platform pages (account null): staff of the row's tenant with proxy.manage (server assertOwnedAccess).
  const platformEditable = isStaff && canManage(null);
  const mayEdit = (p: CustomPage) => (p.accountId == null ? platformEditable : canManage(p.accountId));

  const remove = async (p: CustomPage) => {
    if (!(await confirm({
      title: t('proxy.pages.deleteTitle') || 'Delete the page',
      message: t('proxy.pages.deleteConfirm', { name: p.name, defaultValue: 'Delete the page {{name}}?' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteCustomPage(p.id);
      toast.success(t('proxy.pages.deleted') || 'Page deleted');
      setItems((cur) => cur.filter((x) => x.id !== p.id));
    } catch (err) {
      // No force delete for pages (server contract): detach it from its users first.
      if (proxyErrorCode(err) === 'customPageInUse') {
        toast.error(t('proxy.pages.inUse', { count: p.usedBy, defaultValue: 'This page is used by {{count}} object(s): choose another page on them first, then delete it.' }));
        return;
      }
      toastProxyError(t, err, t('proxy.pages.deleteFailed') || 'Failed to delete the page');
    }
  };

  const manageable = accounts.filter((a) => canManage(a.id));
  const canCreate = (canManage(accountId) && manageable.length > 0) || platformEditable;
  const createBtn = canCreate ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.pages.add') || 'New page'}</button> : null;
  const menu = (p: CustomPage) => (
    <ActionMenu
      items={[
        { key: 'edit', icon: mayEdit(p) ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />, label: mayEdit(p) ? (t('common.edit') || 'Edit') : (t('proxy.pages.view') || 'View'), onClick: () => setEditing(p) },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(p); }, danger: true, separator: true, hidden: !mayEdit(p) },
      ]}
    />
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('proxy.pages.description') || 'HTML pages served for the error codes of the proxy hosts, and waking pages shown while a sleeping application starts.'}</p>
        <div className="ml-auto">{createBtn}</div>
      </div>
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<FileCode2 />} emptyText={t('proxy.pages.empty') || 'No custom page yet: the built-in pages are used.'} emptyAction={createBtn ?? undefined}>
        <GroupedTable<CustomPage>
          storageKey="proxy-custom-pages"
          singleGroupFlat
          minWidth={680}
          defaultSort={{ column: 'name' }}
          groups={showAccount || isStaff
            ? groupRowsByAccount(items, accountDir, (p) => ({ id: p.accountId, username: accounts.find((a) => a.id === p.accountId)?.username }), (rows) => flatNodes(rows, (p) => p.id), t('proxy.platformGroup') || 'Platform')
            : [{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (p) => p.id) }]}
          columns={[
            {
              id: 'name', header: t('proxy.pages.name') || 'Page', sort: (p) => p.name,
              cell: (p) => (
                <>
                  <span className="font-medium text-text-primary">{p.name}</span>
                  {p.isWakingPage && <Pill tone="blue" className="ml-2">{t('proxy.pages.waking') || 'waking page'}</Pill>}
                  {p.description && <div className="mt-0.5 text-xs text-text-muted">{p.description}</div>}
                </>
              ),
            },
            {
              id: 'codes', header: t('proxy.pages.codes') || 'Codes', tdClassName: 'font-mono text-xs text-text-secondary', sort: (p) => (p.isWakingPage ? '' : p.codes.join(',')),
              cell: (p) => (p.isWakingPage ? '—' : (p.codes.length ? p.codes.join(', ') : (t('proxy.pages.allCodes') || 'all'))),
            },
            { id: 'usedBy', header: t('proxy.usedBy') || 'Used by', tdClassName: 'font-mono text-xs text-text-secondary', sort: (p) => p.usedBy, cell: (p) => p.usedBy },
            ...(showTenant && !(showAccount || isStaff) ? [{ id: 'tenant', header: t('proxy.tenant') || 'Workspace', cell: (p: CustomPage) => <TenantBadge tenantId={p.tenantId} /> }] : []),
            { id: 'actions', header: <span className="sr-only">{t('proxy.actions') || 'Actions'}</span>, thClassName: 'w-14', tdClassName: 'text-right', cell: (p) => menu(p) },
          ]}
        />
      </ListState>

      <CustomPageModal
        open={editing !== null}
        page={editing === 'new' ? null : editing}
        readOnly={editing !== null && editing !== 'new' && !mayEdit(editing)}
        accounts={manageable}
        allowPlatform={platformEditable}
        defaultAccountId={accountId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast.success(t('proxy.pages.saved') || 'Page saved'); void load(); }}
      />
    </div>
  );
}

function CustomPageModal({ open, page, readOnly, accounts, allowPlatform, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  page: CustomPage | null;
  readOnly: boolean;
  accounts: HostingAccount[];
  allowPlatform: boolean;
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [codes, setCodes] = useState<CustomPageCode[]>([]);
  const [theme, setTheme] = useState<CustomPage['theme']>('obli');
  const [waking, setWaking] = useState(false);
  const [html, setHtml] = useState('');
  const [previewCode, setPreviewCode] = useState(404);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const fallback = defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null);
    setOwner(page ? (page.accountId == null ? '' : String(page.accountId)) : fallback != null ? String(fallback) : '');
    setName(page?.name ?? '');
    setDescription(page?.description ?? '');
    setCodes(page?.codes ?? []);
    setTheme(page?.theme ?? 'obli');
    setWaking(page?.isWakingPage ?? false);
    setHtml(page?.html ?? STARTER_HTML);
    setPreview(null);
    setPreviewCode(page?.isWakingPage ? 503 : page?.codes[0] ?? 404);
    setError('');
  }, [open, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountId = owner ? Number(owner) : null;
  const htmlSize = new Blob([html]).size;
  const canSubmit = !readOnly && (accountId != null || allowPlatform) && name.trim().length > 0 && html.trim().length > 0 && htmlSize <= MAX_HTML;

  const toggleCode = (c: CustomPageCode) => setCodes((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c].sort((a, b) => a - b)));

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await proxyApi.previewCustomPage({ html, code: previewCode, host: 'www.example.com' }));
    } catch (err) {
      toastProxyError(t, err, t('proxy.pages.previewFailed') || 'Failed to render the preview');
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    const body = { name: name.trim(), description: description.trim() || null, codes: waking ? [] : codes, theme, isWakingPage: waking, html };
    try {
      if (page) await proxyApi.updateCustomPage(page.id, body);
      else await proxyApi.createCustomPage({ accountId, ...body });
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.pages.saveFailed') || 'Failed to save the page'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      closeOnEscape={false}
      title={page ? t('proxy.pages.editTitle', { name: page.name, defaultValue: 'Page {{name}}' }) : (t('proxy.pages.createTitle') || 'New page')}
      icon={<FileCode2 className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{readOnly ? (t('common.close') || 'Close') : (t('common.cancel') || 'Cancel')}</Button>
          {!readOnly && <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{page ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>}
        </>
      }
    >
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!page && (
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="cp-owner">{t('proxy.streams.owner') || 'Owner'}</label>
              <select id="cp-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={selectCls}>
                {allowPlatform ? <option value="">{t('proxy.pages.platformOwner') || 'Platform (every account of the workspace)'}</option> : <option value="">{t('proxy.chooseAccount') || 'Choose an account…'}</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="cp-name">{t('proxy.pages.name') || 'Page'}</label>
            <input id="cp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="cp-theme">{t('proxy.pages.theme') || 'Theme'}</label>
            <select id="cp-theme" value={theme} onChange={(e) => setTheme(e.target.value as CustomPage['theme'])} className={selectCls}>
              <option value="obli">Obli</option>
              <option value="light">{t('proxy.pages.themeLight') || 'Light'}</option>
              <option value="dark">{t('proxy.pages.themeDark') || 'Dark'}</option>
              <option value="custom">{t('proxy.pages.themeCustom') || 'Custom (HTML only)'}</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="cp-desc">{t('proxy.pages.descriptionField') || 'Description (optional)'}</label>
            <input id="cp-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={255} className={inputCls} />
          </div>
        </div>
        <ToggleSwitch checked={waking} onChange={setWaking} label={t('proxy.pages.isWaking') || 'Waking page'} description={t('proxy.pages.isWakingHint') || 'Shown while a sleeping application starts; it reloads by itself (placeholder WAKE_ETA_SEC = expected seconds).'} />
        {!waking && (
          <div>
            <span className={labelCls}>{t('proxy.pages.codes') || 'Codes'}</span>
            <div className="flex flex-wrap gap-1.5">
              {CUSTOM_PAGE_CODES.map((c) => (
                <button key={c} type="button" onClick={() => toggleCode(c)} aria-pressed={codes.includes(c)}
                  className={cn('rounded-md px-2.5 py-1 font-mono text-xs transition-colors coarse:min-h-9', codes.includes(c) ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-muted hover:text-text-primary')}>
                  {c}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-text-muted">{t('proxy.pages.codesHint') || 'None selected = every code.'}</p>
          </div>
        )}
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <label className="text-xs text-text-muted" htmlFor="cp-html">HTML</label>
            <span className={cn('ml-auto font-mono text-[11px]', htmlSize > MAX_HTML ? 'text-status-down' : 'text-text-muted')}>{Math.ceil(htmlSize / 1024)} / 256 KiB</span>
          </div>
          <textarea
            id="cp-html"
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            spellCheck={false}
            rows={14}
            className={cn(inputCls, 'min-h-[14rem] resize-y font-mono text-xs leading-relaxed')}
          />
          <p className="mt-1 text-[11px] text-text-muted">
            {t('proxy.pages.placeholders') || 'Placeholders (escaped):'} <span className="font-mono">{CUSTOM_PAGE_PLACEHOLDERS.join(' ')}</span>
          </p>
        </div>
      </fieldset>
      <div className="mt-4 space-y-2 rounded-lg bg-bg-primary p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary">{t('proxy.pages.preview') || 'Preview'}</span>
          <select aria-label={t('proxy.pages.previewCode') || 'Code'} value={previewCode} onChange={(e) => setPreviewCode(Number(e.target.value))} className={cn(selectCls, 'ml-auto w-24 font-mono')}>
            {CUSTOM_PAGE_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <Button size="sm" variant="secondary" loading={previewing} disabled={!html.trim()} onClick={() => { void runPreview(); }}>
            <Eye size={13} className="mr-1.5" />{t('proxy.pages.render') || 'Render'}
          </Button>
        </div>
        {preview != null && (
          // No script, no same-origin, no form: the page is rendered as a static document.
          <iframe title={t('proxy.pages.preview') || 'Preview'} sandbox="" srcDoc={preview} className="h-80 w-full rounded-md border border-bg-tertiary bg-white" />
        )}
      </div>
      {error && <p className="mt-3 whitespace-pre-line text-xs text-status-down">{error}</p>}
    </Modal>
  );
}
