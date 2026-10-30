import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, BookOpen, KeyRound, Pencil, Plug, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import type { ApiKey, ApiKeyCreated, ApiKeyKind, ApiKeyScope, Domain, Site } from '@oblimint/shared';
import { apiKeysApi } from '@/api/apiKeys.api';
import { sitesApi } from '@/api/sites.api';
import { domainsApi } from '@/api/domains.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, EmptyState, Pill, toastHostingError } from './hostingUi';
import { ApiGuideModal, CreatedKeyModal, KeyModal, SCOPE_FALLBACK } from './KeyModal';

// « Clés d'accès » of an account: keys for scripts, CI and AI agents (API
// /api/v1, MCP server /mcp). The secret is shown once, with the commands to
// plug it into Claude Code or curl. The API / agent guide (shared/src/apiGuide.ts)
// is readable here and downloadable as .md, to hand to an agent.
// A « Connecteur Claude » (kind 'connector') is the same thing for claude.ai:
// no bearer secret but an OAuth client id / secret pasted in the custom
// connector; the user then approves it in the panel (OAuthAuthorizePage).

export function AccountApiKeysTab({ accountId, siteId, presetSiteIds, openNew = false, onNewClosed }: {
  accountId: number;
  /** Site page: only the keys covering this site; a new key starts with it ticked. */
  siteId?: number;
  /** New key: sites ticked from the start (deep link ?section=keys&site=<id>&new=1). */
  presetSiteIds?: number[];
  /** Open the new-key form at once (deep link &new=1). */
  openNew?: boolean;
  /** The key form closed (saved or cancelled): the caller drops its deep link (&new=1). */
  onNewClosed?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [editing, setEditing] = useState<ApiKey | ApiKeyKind | null>(openNew ? 'key' : null);
  const newSiteIds = siteId != null ? [siteId] : presetSiteIds;
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [k, s] = await Promise.all([apiKeysApi.list(accountId), sitesApi.list({ accountId })]);
      setKeys(k);
      setSites(s);
      // Domains of the account (to give to a key): none listed without the right to see them.
      setDomains(await domainsApi.list({ accountId }).catch(() => []));
    } catch (err) {
      toastHostingError(t, err, t('apiKeys.loadFailed') || 'The keys could not be loaded');
      setKeys([]);
    }
  }, [accountId, t]);

  useEffect(() => { void load(); }, [load]);

  // Site page: the keys reaching the site (every site of the account, or this one listed).
  const shown = keys && siteId != null ? keys.filter((k) => k.siteScope === 'all' || k.siteIds.includes(siteId)) : keys;
  const scopeLabel = (s: ApiKeyScope) => t(`apiKeys.scopes.${s}.label`) || SCOPE_FALLBACK[s][0];
  const siteName = (id: number) => { const s = sites.find((x) => x.id === id); return s ? (s.primaryDomain || s.name) : `#${id}`; };
  const domainName = (id: number) => domains.find((d) => d.id === id)?.name ?? `#${id}`;
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

  const rotate = async (k: ApiKey) => {
    if (!(await confirm({
      title: t('apiKeys.connector.rotateTitle') || 'New client secret',
      message: t('apiKeys.connector.rotateConfirm', { name: k.name, defaultValue: 'Generate a new client secret for "{{name}}"? The current one stops at once (to paste again in Claude if it reconnects); live connections stay.' }),
      confirmLabel: t('apiKeys.connector.rotate') || 'New secret',
    }))) return;
    try {
      setCreated(await apiKeysApi.rotateSecret(accountId, k.id));
      await load();
    } catch (err) { toastHostingError(t, err, t('apiKeys.saveFailed') || 'The key could not be saved'); }
  };

  const disconnect = async (k: ApiKey, connectionId?: string) => {
    if (!(await confirm({
      title: t('apiKeys.connector.disconnectTitle') || 'Disconnect',
      message: connectionId
        ? (t('apiKeys.connector.disconnectOne') || 'End this connection? Claude loses access until it is authorized again.')
        : t('apiKeys.connector.disconnectAll', { name: k.name, defaultValue: 'End every connection of "{{name}}"? Claude loses access until it is authorized again.' }),
      danger: true,
      confirmLabel: t('apiKeys.connector.disconnect') || 'Disconnect',
    }))) return;
    try {
      await apiKeysApi.disconnect(accountId, k.id, connectionId);
      toast.success(t('apiKeys.connector.disconnected') || 'Disconnected');
      await load();
    } catch (err) { toastHostingError(t, err, t('apiKeys.saveFailed') || 'The key could not be saved'); }
  };

  return (
    <div className="space-y-4">
      <Card
        icon={<KeyRound size={14} className="text-accent" />}
        title={siteId != null ? (t('apiKeys.siteTitle') || 'Access keys covering this site') : (t('apiKeys.title') || 'Access keys')}
        actions={(
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setGuideOpen(true)}><BookOpen className="mr-1 h-3.5 w-3.5" />{t('apiKeys.guide') || 'API & AI agent guide'}</Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing('connector')}><Plug className="mr-1 h-3.5 w-3.5" />{t('apiKeys.connector.create') || 'Claude connector'}</Button>
            <Button size="sm" onClick={() => setEditing('key')}><Plus className="mr-1 h-3.5 w-3.5" />{siteId != null ? (t('apiKeys.giveAccess') || 'Give access to an agent / a CI') : (t('apiKeys.create') || 'New key')}</Button>
          </div>
        )}
      >
        {siteId != null && (
          <p className="mb-1.5 text-xs text-text-muted">{t('apiKeys.siteIntro') || 'The keys of the account that reach this site (every site, or this one among others). They are managed with the other keys of the account.'}</p>
        )}
        <p className="text-xs text-text-muted">
          {t('apiKeys.intro') || 'Give a script, a CI or an AI agent (Claude…) access to this account only, limited to the sites and rights you choose. A key never exceeds your own rights and stops working if you lose them.'}
        </p>
        <p className="mt-1.5 text-xs text-text-muted">
          {t('apiKeys.connector.intro') || 'Claude connector: plug this account into Claude (claude.ai, Claude Desktop, mobile) as a custom connector, without pasting a key — you approve the connection here, and can end it at any time.'}
        </p>
      </Card>

      {shown === null ? <div className="flex justify-center p-8"><LoadingSpinner /></div>
        : !shown.length ? <EmptyState icon={<KeyRound />} text={siteId != null ? (t('apiKeys.siteEmpty') || 'No access key covers this site.') : (t('apiKeys.empty') || 'No access key yet.')} />
          : (
            <div className="space-y-2">
              {shown.map((k) => {
                const expired = k.expiresAt !== null && new Date(k.expiresAt).getTime() < Date.now();
                return (
                  <div key={k.id} className="rounded-xl bg-bg-secondary p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-text-primary">{k.name}</span>
                          {k.kind === 'connector'
                            ? <><Pill tone="accent"><Plug className="mr-1 inline h-3 w-3" />{t('apiKeys.connector.badge') || 'Claude connector'}</Pill><code className="font-mono text-[11px] text-text-muted">{k.oauthClientId}</code></>
                            : <code className="font-mono text-[11px] text-text-muted">{k.prefix}…</code>}
                          {expired && <Pill tone="muted">{t('apiKeys.expired') || 'expired'}</Pill>}
                          {k.ipMissing
                            ? <Pill tone="red" title={t('keySecurity.key.ipMissingHint') || 'An IP address is mandatory on the keys of this workspace: this key is refused until you restrict it.'}>{t('keySecurity.key.ipMissing') || 'to restrict'}</Pill>
                            : k.open && !expired && <Pill tone="amber" title={t('keySecurity.key.openHint') || 'This open key (no allowed address) keeps the strict IP mode off for the whole platform.'}>{t('keySecurity.key.open') || 'any IP'}</Pill>}
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
                        {(k.domainScope === 'all' || k.domainIds.length > 0) && (
                          <div className="mt-1 text-xs text-text-secondary">
                            {k.domainScope === 'all'
                              ? (t('apiKeys.allDomains') || 'Every domain of the account')
                              : <>{t('apiKeys.domainsPrefix') || 'Domains:'} {k.domainIds.map((id) => <span key={id} className="mr-1.5 font-mono">{domainName(id)}</span>)}</>}
                          </div>
                        )}
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
                          {k.kind === 'connector' && (k.connectorRanges?.length ?? 0) > 0 && (
                            <span title={t('keySecurity.key.connectorRangesHint') || 'Added automatically: the outbound addresses of the connectors (Anthropic).'}>
                              {t('keySecurity.key.connectorRanges') || '+ connectors'} {k.connectorRanges!.join(', ')}
                            </span>
                          )}
                        </div>
                        {k.kind === 'connector' && (
                          <div className="mt-2 space-y-1">
                            {!k.connections.length
                              ? <p className="text-[11px] text-text-muted">{t('apiKeys.connector.noConnection') || 'Not connected yet: add it in Claude, then approve it here.'}</p>
                              : k.connections.map((c) => (
                                <div key={c.id} className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                                  <span className="h-1.5 w-1.5 rounded-full bg-status-up" />
                                  <span>{t('apiKeys.connector.connectedBy', { name: c.userName ?? '—', defaultValue: 'Connected by {{name}}' })} · {fmt(c.connectedAt)}</span>
                                  <span className="font-mono text-text-muted">{t('apiKeys.lastUsed') || 'last used'} {fmt(c.lastUsedAt)}</span>
                                  <button type="button" onClick={() => void disconnect(k, c.id)} className="text-red-400 hover:underline">{t('apiKeys.connector.disconnect') || 'Disconnect'}</button>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        {k.kind === 'connector' && (
                          <>
                            <IconButton label={t('apiKeys.connector.rotate') || 'New secret'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => void rotate(k)} />
                            {k.connections.length > 0 && <IconButton label={t('apiKeys.connector.disconnectAllShort') || 'Disconnect everywhere'} icon={<Unplug className="h-4 w-4" />} onClick={() => void disconnect(k)} />}
                          </>
                        )}
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
          domains={domains}
          kind={typeof editing === 'string' ? editing : editing.kind}
          initial={typeof editing === 'string' ? null : editing}
          initialSiteIds={typeof editing === 'string' ? newSiteIds : undefined}
          onClose={() => { setEditing(null); onNewClosed?.(); }}
          onSaved={(k) => { setEditing(null); onNewClosed?.(); if ('clientSecret' in k) setCreated(k as ApiKeyCreated); void load(); }}
        />
      )}
      {created && <CreatedKeyModal created={created} onClose={() => setCreated(null)} onGuide={() => setGuideOpen(true)} />}
      {guideOpen && <ApiGuideModal onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
