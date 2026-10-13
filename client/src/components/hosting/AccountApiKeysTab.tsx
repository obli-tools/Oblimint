import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Bot, Check, Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ApiKey, ApiKeyCreate, ApiKeyCreated, ApiKeyScope, ApiKeySiteScope, Site } from '@oblimint/shared';
import { API_KEY_SCOPES } from '@oblimint/shared';
import { apiKeysApi } from '@/api/apiKeys.api';
import { sitesApi } from '@/api/sites.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';
import { Card, EmptyState, Pill, inputCls, labelCls, toastHostingError } from './hostingUi';

// « Clés d'accès » of an account: keys for scripts, CI and AI agents (API
// /api/v1, MCP server /mcp). The secret is shown once, with the commands to
// plug it into Claude Code or curl.

const SCOPE_FALLBACK: Record<ApiKeyScope, [string, string]> = {
  'files.read': ['Read files', 'List and read the files of its sites (code and data).'],
  'files.write': ['Write files', 'Create, replace, move, delete, extract archives in its sites.'],
  'releases.publish': ['Publish', 'Publish the code as a new release (live) and roll back.'],
  'sites.manage': ['Site settings', 'Change the settings of its sites (runtime, docroot…).'],
  'sites.create': ['Create sites', 'Create sites in the account: they join the key automatically.'],
  'logs.read': ['Read logs', 'Access / error / application logs of its sites.'],
};

const EXPIRY_OPTIONS = [
  { id: 'never', days: null },
  { id: '7', days: 7 },
  { id: '30', days: 30 },
  { id: '90', days: 90 },
  { id: '365', days: 365 },
] as const;

function panelOrigin(): string {
  return window.location.origin;
}

export function AccountApiKeysTab({ accountId }: { accountId: number }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [editing, setEditing] = useState<ApiKey | 'new' | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([apiKeysApi.list(accountId), sitesApi.list({ accountId })]);
      setKeys(k);
      setSites(s);
    } catch (err) {
      toastHostingError(t, err, t('apiKeys.loadFailed') || 'The keys could not be loaded');
      setKeys([]);
    }
  }, [accountId, t]);

  useEffect(() => { void load(); }, [load]);

  const scopeLabel = (s: ApiKeyScope) => t(`apiKeys.scopes.${s}.label`) || SCOPE_FALLBACK[s][0];
  const siteName = (id: number) => { const s = sites.find((x) => x.id === id); return s ? (s.primaryDomain || s.name) : `#${id}`; };
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');

  const remove = async (k: ApiKey) => {
    if (!(await confirm({
      title: t('apiKeys.deleteTitle') || 'Revoke the key',
      message: t('apiKeys.deleteConfirm', { name: k.name, defaultValue: 'Revoke "{{name}}"? Every script or agent using it loses access at once.' }),
      danger: true,
      confirmLabel: t('apiKeys.revoke') || 'Revoke',
    }))) return;
    try {
      await apiKeysApi.remove(accountId, k.id);
      toast.success(t('apiKeys.deleted') || 'Key revoked');
      await load();
    } catch (err) { toastHostingError(t, err, t('apiKeys.deleteFailed') || 'The key could not be revoked'); }
  };

  return (
    <div className="space-y-4">
      <Card
        icon={<KeyRound size={14} className="text-accent" />}
        title={t('apiKeys.title') || 'Access keys'}
        actions={<Button size="sm" onClick={() => setEditing('new')}><Plus className="mr-1 h-3.5 w-3.5" />{t('apiKeys.create') || 'New key'}</Button>}
      >
        <p className="text-xs text-text-muted">
          {t('apiKeys.intro') || 'Give a script, a CI or an AI agent (Claude…) access to this account only, limited to the sites and rights you choose. A key never exceeds your own rights and stops working if you lose them.'}
        </p>
      </Card>

      {keys === null ? <div className="flex justify-center p-8"><LoadingSpinner /></div>
        : !keys.length ? <EmptyState icon={<KeyRound />} text={t('apiKeys.empty') || 'No access key yet.'} />
          : (
            <div className="space-y-2">
              {keys.map((k) => {
                const expired = k.expiresAt !== null && new Date(k.expiresAt).getTime() < Date.now();
                return (
                  <div key={k.id} className="rounded-xl bg-bg-secondary p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-text-primary">{k.name}</span>
                          <code className="font-mono text-[11px] text-text-muted">{k.prefix}…</code>
                          {expired && <Pill tone="red">{t('apiKeys.expired') || 'expired'}</Pill>}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {k.scopes.length ? k.scopes.map((s) => (
                            <Pill key={s} tone={k.inactiveScopes.includes(s) ? 'amber' : 'accent'} title={k.inactiveScopes.includes(s) ? (t('apiKeys.inactiveScope') || 'Inactive: you no longer hold this right') : undefined}>
                              {scopeLabel(s)}
                            </Pill>
                          )) : <Pill>{t('apiKeys.readOnly') || 'read-only'}</Pill>}
                        </div>
                        <div className="mt-2 text-xs text-text-secondary">
                          {k.siteScope === 'all'
                            ? (t('apiKeys.allSites') || 'Every site of the account')
                            : k.siteIds.length
                              ? <>{t('apiKeys.sitesPrefix') || 'Sites:'} {k.siteIds.map((id) => <span key={id} className="mr-1.5 font-mono">{siteName(id)}{k.createdSiteIds.includes(id) ? '*' : ''}</span>)}</>
                              : (t('apiKeys.noSiteYet') || 'No site yet (only the ones it will create)')}
                        </div>
                        {k.inactiveScopes.length > 0 && (
                          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-400">
                            <AlertTriangle className="h-3 w-3" />{t('apiKeys.inactiveHint') || 'Some rights are inactive: the key creator no longer holds them.'}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-text-muted">
                          <span>{t('apiKeys.createdBy', { name: k.createdByName ?? '—', defaultValue: 'by {{name}}' })} · {fmt(k.createdAt)}</span>
                          <span>{t('apiKeys.lastUsed') || 'last used'} {fmt(k.lastUsedAt)}{k.lastUsedIp ? ` (${k.lastUsedIp})` : ''}</span>
                          <span>{t('apiKeys.expires') || 'expires'} {k.expiresAt ? fmt(k.expiresAt) : (t('apiKeys.never') || 'never')}</span>
                          {k.allowedIps.length > 0 && <span>IP {k.allowedIps.join(', ')}</span>}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(k)} />
                        <IconButton variant="danger" label={t('apiKeys.revoke') || 'Revoke'} icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove(k)} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

      {editing && (
        <KeyModal
          accountId={accountId}
          sites={sites}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(k) => { setEditing(null); if ('key' in k) setCreated(k as ApiKeyCreated); void load(); }}
        />
      )}
      {created && <CreatedModal created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function KeyModal({ accountId, sites, initial, onClose, onSaved }: {
  accountId: number;
  sites: Site[];
  initial: ApiKey | null;
  onClose: () => void;
  onSaved: (k: ApiKey | ApiKeyCreated) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(initial?.scopes ?? ['files.read', 'files.write', 'releases.publish', 'logs.read']));
  const [siteScope, setSiteScope] = useState<ApiKeySiteScope>(initial?.siteScope ?? 'selected');
  const [siteIds, setSiteIds] = useState<Set<number>>(new Set(initial?.siteIds ?? []));
  const [expiry, setExpiry] = useState<string>(initial ? 'keep' : '90');
  const [ips, setIps] = useState((initial?.allowedIps ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(set: Set<T>, v: T) => { const s = new Set(set); if (s.has(v)) s.delete(v); else s.add(v); return s; };

  const save = async () => {
    const days = EXPIRY_OPTIONS.find((o) => o.id === expiry)?.days;
    const body: ApiKeyCreate = {
      name: name.trim(),
      scopes: API_KEY_SCOPES.filter((s) => scopes.has(s)),
      siteScope,
      siteIds: siteScope === 'selected' ? [...siteIds] : [],
      allowedIps: ips.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    };
    if (expiry !== 'keep') body.expiresAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
    setBusy(true);
    try {
      onSaved(initial ? await apiKeysApi.update(accountId, initial.id, body) : await apiKeysApi.create(accountId, body));
    } catch (err) {
      toastHostingError(t, err, t('apiKeys.saveFailed') || 'The key could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon={<KeyRound className="h-4 w-4 text-accent" />}
      title={initial ? (t('apiKeys.editTitle', { name: initial.name, defaultValue: 'Key {{name}}' })) : (t('apiKeys.createTitle') || 'New access key')}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>{initial ? (t('common.save') || 'Save') : (t('apiKeys.create') || 'Create the key')}</Button>
        </div>
      )}>
      <div className="space-y-4">
        <div>
          <label className={labelCls}>{t('apiKeys.name') || 'Name'}</label>
          <input className={inputCls} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Claude — blog" />
        </div>
        <div>
          <label className={labelCls}>{t('apiKeys.rights') || 'Rights'}</label>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {API_KEY_SCOPES.map((s) => (
              <label key={s} className={cn('flex cursor-pointer gap-2 rounded-lg p-2 ring-1', scopes.has(s) ? 'bg-accent/10 ring-accent/40' : 'bg-bg-tertiary/50 ring-transparent')}>
                <input type="checkbox" checked={scopes.has(s)} onChange={() => setScopes(toggle(scopes, s))} className="mt-0.5 accent-[rgb(var(--c-accent))]" />
                <span>
                  <span className="block text-sm text-text-primary">{t(`apiKeys.scopes.${s}.label`) || SCOPE_FALLBACK[s][0]}</span>
                  <span className="block text-[11px] text-text-muted">{t(`apiKeys.scopes.${s}.hint`) || SCOPE_FALLBACK[s][1]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-text-muted">{t('apiKeys.neverHint') || 'Never granted to a key: deleting a site, domains, other accounts, users.'}</p>
        </div>
        <div>
          <label className={labelCls}>{t('apiKeys.sites') || 'Sites'}</label>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" checked={siteScope === 'selected'} onChange={() => setSiteScope('selected')} className="accent-[rgb(var(--c-accent))]" />{t('apiKeys.selectedSites') || 'Only the sites below (+ the ones it creates)'}</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={siteScope === 'all'} onChange={() => setSiteScope('all')} className="accent-[rgb(var(--c-accent))]" />{t('apiKeys.allSites') || 'Every site of the account'}</label>
          </div>
          {siteScope === 'selected' && (
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-bg-tertiary/40 p-2">
              {!sites.length && <p className="text-xs text-text-muted">{t('apiKeys.noSites') || 'No site yet.'}</p>}
              {sites.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={siteIds.has(s.id)} disabled={initial?.createdSiteIds.includes(s.id)} onChange={() => setSiteIds(toggle(siteIds, s.id))} className="accent-[rgb(var(--c-accent))]" />
                  <span className="text-text-primary">{s.primaryDomain || s.name}</span>
                  <span className="font-mono text-[11px] text-text-muted">{s.slug}</span>
                  {initial?.createdSiteIds.includes(s.id) && <Pill tone="blue">{t('apiKeys.createdByKey') || 'created by the key'}</Pill>}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>{t('apiKeys.expiry') || 'Expiry'}</label>
            <select className={inputCls} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {initial && <option value="keep">{t('apiKeys.keepExpiry') || 'Unchanged'}</option>}
              <option value="7">{t('apiKeys.days', { count: 7, defaultValue: '{{count}} days' })}</option>
              <option value="30">{t('apiKeys.days', { count: 30, defaultValue: '{{count}} days' })}</option>
              <option value="90">{t('apiKeys.days', { count: 90, defaultValue: '{{count}} days' })}</option>
              <option value="365">{t('apiKeys.oneYear') || '1 year'}</option>
              <option value="never">{t('apiKeys.never') || 'never'}</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('apiKeys.allowedIps') || 'Allowed addresses (optional)'}</label>
            <textarea className={cn(inputCls, 'h-[38px] min-h-[38px] resize-y font-mono text-xs')} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.0/24" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <div>
      <div className="mb-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="flex items-start gap-2 rounded-lg bg-bg-primary p-2.5">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] text-text-primary">{text}</code>
        <IconButton size="sm" label={t('common.copy') || 'Copy'} icon={done ? <Check className="h-4 w-4 text-status-up" /> : <Copy className="h-4 w-4" />}
          onClick={() => { void copyText(text).then((ok) => { if (ok) { setDone(true); setTimeout(() => setDone(false), 1500); } }); }} />
      </div>
    </div>
  );
}

function CreatedModal({ created, onClose }: { created: ApiKeyCreated; onClose: () => void }) {
  const { t } = useTranslation();
  const origin = panelOrigin();
  const mcp = `claude mcp add --transport http oblimint ${origin}/mcp --header "Authorization: Bearer ${created.key}"`;
  const curl = `curl -H "Authorization: Bearer ${created.key}" ${origin}/api/v1/sites`;
  return (
    <Modal open onClose={onClose} size="lg" closeOnBackdrop={false} icon={<Bot className="h-4 w-4 text-accent" />}
      title={t('apiKeys.createdTitle', { name: created.name, defaultValue: 'Key "{{name}}" created' })}
      footer={<div className="flex justify-end"><Button onClick={onClose}>{t('apiKeys.savedIt') || 'I saved it'}</Button></div>}>
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-2.5 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t('apiKeys.shownOnce') || 'This key is shown only now: copy it somewhere safe. It cannot be displayed again (revoke it and create another one if lost).'}
        </p>
        <CopyBlock label={t('apiKeys.theKey') || 'Key'} text={created.key} />
        <CopyBlock label={t('apiKeys.claudeCode') || 'Claude Code (MCP)'} text={mcp} />
        <CopyBlock label="curl" text={curl} />
        <p className="text-[11px] text-text-muted">
          {t('apiKeys.docHint') || 'API: /api/v1 (sites, files, publish, releases, logs). MCP: the same tools for an AI agent. Every action is logged in the audit log with the key name.'}
        </p>
      </div>
    </Modal>
  );
}
