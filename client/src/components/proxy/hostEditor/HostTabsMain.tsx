import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDown, ArrowUp, Info, Plus, Trash2 } from 'lucide-react';
import type { HostingAccount, ProxyHostSsl, ProxyRouteAccessMode, ProxyRouteAuthMode } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Pill, TlsBadge, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { DomainPicker } from '../DomainPicker';
import { EMPTY_TARGET, TargetEditor } from '../TargetEditor';
import { AccountField, FormSection } from '../proxyUi';
import { PROXY_HOST_LIMITS, isValidEmailOrDomain, isValidGroup, isValidRewritePrefix, isValidRoutePath } from '../proxyFormat';
import { SidecarPill } from '../AuthProvidersPanel';
import { CertificateStatusPill } from '../CertificatesPanel';
import { CheckList, TriStateSelect } from './fields';
import { nextKey, type HostForm, type HostRefs, type RouteRow } from './hostEditorModel';

export interface TabProps {
  form: HostForm;
  set: (patch: Partial<HostForm>) => void;
  refs: HostRefs;
  readOnly: boolean;
  platformStaff: boolean;
}

// ── General ─────────────────────────────────────────────────────────────────

export function GeneralTab({ form, set, readOnly, platformStaff, isNew, accounts, hostId, monitorId }: TabProps & {
  isNew: boolean;
  accounts: HostingAccount[];
  hostId: number | null;
  monitorId: number | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <FormSection title={t('proxy.editor.identity') || 'Host'}>
        {isNew && accounts.length > 1 && (
          <AccountField id="ph-account" accounts={accounts} value={form.accountId} disabled={readOnly}
            onChange={(v) => set({ accountId: v, domainIds: [], target: { ...EMPTY_TARGET }, routes: [], auth: { ...form.auth, accessListIds: [], authProviderId: null }, ssl: { ...form.ssl, importedCertificateId: null } })} />
        )}
        <div>
          <label className={labelCls} htmlFor="ph-name">{t('proxy.hosts.name') || 'Proxy host'}</label>
          <input id="ph-name" value={form.name} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} maxLength={64} placeholder={t('proxy.editor.namePlaceholder') || 'Vaultwarden'} className={inputCls} />
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <ToggleSwitch checked={form.enabled} disabled={readOnly} onChange={(v) => set({ enabled: v })} label={t('proxy.enabled') || 'Enabled'} description={t('proxy.editor.enabledHint') || 'Disabled: a 503 page keeps the domains.'} />
          <ToggleSwitch checked={form.autoMonitor} disabled={readOnly} onChange={(v) => set({ autoMonitor: v })} label={t('proxy.editor.autoMonitor') || 'Availability monitor'}
            description={monitorId != null
              ? <Link to="/uptime" className="text-accent hover:underline">{t('proxy.editor.monitorLink') || 'See the monitor'}</Link>
              : (t('proxy.editor.autoMonitorHint') || 'Creates and keeps an uptime monitor in sync.')} />
        </div>
      </FormSection>
      <FormSection title={t('proxy.domains.title') || 'Domains'}>
        <DomainPicker accountId={form.accountId} value={form.domainIds} onChange={(ids) => set({ domainIds: ids })} self={{ kind: 'proxy', id: hostId }} disabled={readOnly} />
      </FormSection>
      <FormSection title={t('proxy.hosts.target') || 'Target'} description={t('proxy.editor.targetHint') || 'Where the requests of location / go. Sub-routes can send some paths elsewhere (Routes tab).'}>
        <TargetEditor idPrefix="ph-target" accountId={form.accountId} value={form.target} onChange={(tg) => set({ target: tg })} platformStaff={platformStaff} disabled={readOnly} />
      </FormSection>
    </div>
  );
}

// ── SSL ─────────────────────────────────────────────────────────────────────

/** `enablesLetsEncrypt`: the save goes through the quick setup, which turns Let's Encrypt on for the domains. */
export function SslTab({ form, set, refs, readOnly, enablesLetsEncrypt = false }: TabProps & { enablesLetsEncrypt?: boolean }) {
  const { t, i18n } = useTranslation();
  const ssl = form.ssl;
  const patch = (p: Partial<ProxyHostSsl>) => set({ ssl: { ...ssl, ...p } });
  const imported = refs.certificates.filter((c) => c.kind === 'imported' && c.accountId === form.accountId);
  const selected = refs.domains.filter((d) => form.domainIds.includes(d.id));
  const cert = imported.find((c) => c.id === ssl.importedCertificateId) ?? null;
  return (
    <div className="space-y-4">
      <FormSection title={t('proxy.ssl.certificate') || 'Certificate'}>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(['auto', 'imported', 'none'] as const).map((m) => (
            <button key={m} type="button" disabled={readOnly} onClick={() => patch({ mode: m })} aria-pressed={ssl.mode === m}
              className={cn('rounded-lg border px-3 py-2.5 text-left transition-colors coarse:min-h-10', ssl.mode === m ? 'border-accent bg-accent/10' : 'border-bg-tertiary hover:bg-bg-hover', readOnly && 'cursor-not-allowed')}>
              <div className="text-sm font-medium text-text-primary">
                {m === 'auto' ? (t('proxy.ssl.modeAuto') || 'Let’s Encrypt') : m === 'imported' ? (t('proxy.ssl.modeImported') || 'Imported certificate') : (t('proxy.ssl.modeNone') || 'No HTTPS')}
              </div>
              <div className="mt-0.5 text-[11px] text-text-muted">
                {m === 'auto' ? (t('proxy.ssl.modeAutoHint') || 'The certificates of the domains, issued and renewed automatically.')
                  : m === 'imported' ? (t('proxy.ssl.modeImportedHint') || 'A certificate imported in the Certificates tab.')
                    : (t('proxy.ssl.modeNoneHint') || 'HTTP only (not recommended).')}
              </div>
            </button>
          ))}
        </div>
        {ssl.mode === 'imported' && (
          <div>
            <label className={labelCls} htmlFor="ph-cert">{t('proxy.ssl.importedPick') || 'Imported certificate'}</label>
            <select id="ph-cert" value={ssl.importedCertificateId ?? ''} disabled={readOnly} onChange={(e) => patch({ importedCertificateId: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
              <option value="">{imported.length ? (t('proxy.ssl.chooseCert') || 'Choose…') : (t('proxy.ssl.noImported') || 'No imported certificate in this account')}</option>
              {imported.map((c) => <option key={c.id} value={c.id}>{c.primaryName}{c.notAfter ? ` — ${new Date(c.notAfter).toLocaleDateString(i18n.language)}` : ''}</option>)}
            </select>
            {cert && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted"><CertificateStatusPill status={cert.status} notAfter={cert.notAfter} /> <span className="font-mono">{cert.names.join(', ')}</span></div>}
          </div>
        )}
        {ssl.mode === 'auto' && (
          selected.length === 0 ? <p className="text-xs text-text-muted">{t('proxy.ssl.noDomain') || 'Choose the domains first (General tab).'}</p> : (
            <ul className="space-y-1">
              {selected.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-md bg-bg-primary px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary">{d.name}</span>
                  {d.wildcard && <Pill>wildcard</Pill>}
                  <TlsBadge tlsMode={enablesLetsEncrypt && d.tlsMode === 'none' ? 'letsencrypt' : d.tlsMode} certificate={d.certificate} />
                </li>
              ))}
              {!enablesLetsEncrypt && selected.some((d) => d.tlsMode === 'none') && (
                <li className="flex items-start gap-1.5 pt-1 text-[11px] text-amber-400"><AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>{t('proxy.ssl.tlsOffWarning') || 'Let’s Encrypt is off for some of these domains: no certificate will be requested for them and they stay HTTP only. Turn it on in'}{' '}
                    <Link to="/domains" className="text-accent hover:underline">{t('nav.domains') || 'Domains'}</Link>.</span>
                </li>
              )}
              <li className="flex items-start gap-1.5 pt-1 text-[11px] text-text-muted"><Info size={12} className="mt-0.5 shrink-0" />{enablesLetsEncrypt
                ? (t('proxy.ssl.autoHintQuick') || 'Saving turns Let’s Encrypt on for these domains; HTTPS is served as soon as each certificate exists.')
                : (t('proxy.ssl.autoHint') || 'HTTPS is served as soon as each domain has its certificate (domains with Let’s Encrypt on).')}</li>
            </ul>
          )
        )}
      </FormSection>
      {ssl.mode !== 'none' && (
        <FormSection title={t('proxy.ssl.options') || 'HTTPS options'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ToggleSwitch checked={ssl.forceSsl} disabled={readOnly} onChange={(v) => patch({ forceSsl: v })} label={t('proxy.ssl.forceSsl') || 'Force HTTPS'} description={t('proxy.ssl.forceSslHint') || '301 from http to https (the ACME challenge stays on http).'} />
            <ToggleSwitch checked={ssl.http2} disabled={readOnly} onChange={(v) => patch({ http2: v })} label="HTTP/2" />
            <ToggleSwitch checked={ssl.hsts} disabled={readOnly} onChange={(v) => patch({ hsts: v, hstsSubdomains: v ? ssl.hstsSubdomains : false })} label="HSTS" description={t('proxy.ssl.hstsHint') || 'Browsers remember to use HTTPS for 2 years.'} />
            <ToggleSwitch checked={ssl.hstsSubdomains} disabled={readOnly || !ssl.hsts} onChange={(v) => patch({ hstsSubdomains: v })} label={t('proxy.ssl.hstsSubdomains') || 'HSTS on sub-domains'} />
          </div>
        </FormSection>
      )}
    </div>
  );
}

// ── Auth ────────────────────────────────────────────────────────────────────

export function AuthTab({ form, set, refs, readOnly }: TabProps) {
  const { t } = useTranslation();
  const auth = form.auth;
  const patch = (p: Partial<HostForm['auth']>) => set({ auth: { ...auth, ...p } });
  const lists = refs.accessLists.filter((l) => l.accountId === form.accountId);
  const providers = refs.authProviders.filter((p) => p.accountId === form.accountId);
  const provider = providers.find((p) => p.id === auth.authProviderId) ?? null;
  return (
    <div className="space-y-4">
      <FormSection title={t('proxy.tabs.accessLists') || 'Access lists'} description={t('proxy.editor.unionHint') || 'Several lists add up: their deny rules then allow rules are merged (any allow refuses every other address), their users share one password file, and "satisfy any" applies if one list has it.'}>
        <CheckList
          items={lists}
          value={auth.accessListIds}
          disabled={readOnly}
          onChange={(ids) => patch({ accessListIds: ids })}
          empty={<>{t('proxy.editor.noAccessList') || 'No access list in this account.'} <Link to="/proxy?tab=access-lists" className="text-accent hover:underline">{t('proxy.editor.createOne') || 'Create one'}</Link></>}
          render={(l) => (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-text-primary">{l.name}</span>
              <span className="font-mono text-[11px] text-text-muted">{l.rules.length} IP · {l.users.length} {t('proxy.editor.users') || 'users'}</span>
            </span>
          )}
        />
      </FormSection>
      <FormSection title={t('proxy.editor.forwardAuth') || 'Single sign-on (Azure AD)'}>
        <div>
          <label className={labelCls} htmlFor="ph-provider">{t('proxy.auth.name') || 'Provider'}</label>
          <select id="ph-provider" value={auth.authProviderId ?? ''} disabled={readOnly} onChange={(e) => patch({ authProviderId: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
            <option value="">{t('proxy.editor.noProvider') || 'None'}</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {provider && <div className="mt-1.5 flex items-center gap-2 text-[11px] text-text-muted">{t('proxy.auth.sidecar') || 'Sidecar'} <SidecarPill provider={provider} /></div>}
        </div>
        {auth.authProviderId != null && (
          <>
            <div>
              <label className={labelCls} htmlFor="ph-groups">{t('proxy.editor.allowedGroups') || 'Allowed groups (in addition to the provider)'}</label>
              <ChipsInput id="ph-groups" value={auth.allowedGroups} onChange={(v) => patch({ allowedGroups: v })} validate={isValidGroup} max={PROXY_HOST_LIMITS.allowedGroups} disabled={readOnly} ariaLabel={t('proxy.editor.allowedGroups') || 'Allowed groups (in addition to the provider)'} />
            </div>
            <div>
              <label className={labelCls} htmlFor="ph-emails">{t('proxy.editor.allowedEmails') || 'Allowed e-mails or domains'}</label>
              <ChipsInput id="ph-emails" value={auth.allowedEmails} onChange={(v) => patch({ allowedEmails: v })} validate={isValidEmailOrDomain} normalize={(v) => v.toLowerCase()} max={PROXY_HOST_LIMITS.allowedEmails} inputMode="email" disabled={readOnly} ariaLabel={t('proxy.editor.allowedEmails') || 'Allowed e-mails or domains'} />
              <p className="mt-1 text-[11px] text-text-muted">{t('proxy.editor.restrictHint') || 'Empty = everyone the provider accepts.'}</p>
            </div>
          </>
        )}
      </FormSection>
    </div>
  );
}

// ── Routes ──────────────────────────────────────────────────────────────────

export function RoutesTab({ form, set, refs, readOnly, platformStaff }: TabProps) {
  const { t } = useTranslation();
  const routes = form.routes;
  const lists = refs.accessLists.filter((l) => l.accountId === form.accountId);
  const update = (key: number, p: Partial<RouteRow>) => set({ routes: routes.map((r) => (r.key === key ? { ...r, ...p } : r)) });
  const move = (i: number, d: -1 | 1) => {
    const next = [...routes];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ routes: next });
  };
  const add = () => set({
    routes: [...routes, {
      key: nextKey(), path: '/api/', rewritePrefix: null, target: { ...form.target }, authMode: 'inherit', accessListMode: 'inherit',
      accessListIds: [], websocket: null, buffering: null, sortOrder: routes.length,
    }],
  });
  const paths = routes.map((r) => r.path.trim());
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('proxy.editor.routesHint') || 'Sub-routes send some paths to another target, before location /. The longest prefix wins; a sub-route on a honeypot bait path disables that bait.'}</p>
        {!readOnly && <Button size="sm" variant="secondary" className="ml-auto" onClick={add}><Plus size={13} className="mr-1.5" />{t('proxy.editor.addRoute') || 'Add a route'}</Button>}
      </div>
      {routes.length === 0 && <p className="rounded-xl bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">{t('proxy.editor.noRoute') || 'No sub-route: every path goes to the main target.'}</p>}
      {routes.map((r, i) => {
        const pathOk = isValidRoutePath(r.path);
        const dup = paths.indexOf(r.path.trim()) !== i;
        const rewriteOk = !r.rewritePrefix?.trim() || isValidRewritePrefix(r.rewritePrefix);
        return (
          <section key={r.key} className="rounded-xl bg-bg-secondary p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-text-primary">{r.path || '/'}</span>
              {r.rewritePrefix && <span className="font-mono text-xs text-text-muted">→ {r.rewritePrefix}</span>}
              {!readOnly && (
                <span className="ml-auto flex items-center gap-1">
                  <IconButton label={t('proxy.editor.moveUp') || 'Move up'} icon={<ArrowUp size={14} />} size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton label={t('proxy.editor.moveDown') || 'Move down'} icon={<ArrowDown size={14} />} size="sm" disabled={i === routes.length - 1} onClick={() => move(i, 1)} />
                  <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} size="sm" variant="danger" onClick={() => set({ routes: routes.filter((x) => x.key !== r.key) })} />
                </span>
              )}
            </div>
            <fieldset disabled={readOnly} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelCls} htmlFor={`rt-path-${r.key}`}>{t('proxy.editor.routePath') || 'Incoming path'}</label>
                  <input id={`rt-path-${r.key}`} value={r.path} onChange={(e) => update(r.key, { path: e.target.value })} placeholder="/api/" autoCapitalize="off" spellCheck={false}
                    className={cn(inputCls, 'font-mono', (!pathOk || dup) && 'ring-2 ring-status-down/50')} />
                  {dup && <p className="mt-1 text-[11px] text-status-down">{t('proxy.editor.routeDuplicate') || 'Two routes cannot share a path.'}</p>}
                </div>
                <div>
                  <label className={labelCls} htmlFor={`rt-rw-${r.key}`}>{t('proxy.editor.rewrite') || 'Rewrite the prefix to (optional)'}</label>
                  <input id={`rt-rw-${r.key}`} value={r.rewritePrefix ?? ''} onChange={(e) => update(r.key, { rewritePrefix: e.target.value || null })} placeholder="/" autoCapitalize="off" spellCheck={false}
                    className={cn(inputCls, 'font-mono', !rewriteOk && 'ring-2 ring-status-down/50')} />
                </div>
              </div>
              <TargetEditor idPrefix={`rt-tg-${r.key}`} accountId={form.accountId} value={r.target} onChange={(tg) => update(r.key, { target: tg })} platformStaff={platformStaff} disabled={readOnly} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <label className={labelCls} htmlFor={`rt-auth-${r.key}`}>{t('proxy.editor.routeAuth') || 'Sign-on'}</label>
                  <select id={`rt-auth-${r.key}`} value={r.authMode} onChange={(e) => update(r.key, { authMode: e.target.value as ProxyRouteAuthMode })} className={selectCls}>
                    <option value="inherit">{t('proxy.editor.inherit') || 'inherit'}</option>
                    <option value="none">{t('proxy.editor.none') || 'none'}</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor={`rt-acl-${r.key}`}>{t('proxy.tabs.accessLists') || 'Access lists'}</label>
                  <select id={`rt-acl-${r.key}`} value={r.accessListMode} onChange={(e) => update(r.key, { accessListMode: e.target.value as ProxyRouteAccessMode })} className={selectCls}>
                    <option value="inherit">{t('proxy.editor.inherit') || 'inherit'}</option>
                    <option value="none">{t('proxy.editor.none') || 'none'}</option>
                    <option value="override">{t('proxy.editor.override') || 'own lists'}</option>
                  </select>
                </div>
                <TriStateSelect id={`rt-ws-${r.key}`} label="WebSocket" value={r.websocket} onChange={(v) => update(r.key, { websocket: v })} />
                <TriStateSelect id={`rt-buf-${r.key}`} label={t('proxy.editor.buffering') || 'Buffering'} value={r.buffering} onChange={(v) => update(r.key, { buffering: v })} />
              </div>
              {r.accessListMode === 'override' && (
                <CheckList items={lists} value={r.accessListIds} onChange={(ids) => update(r.key, { accessListIds: ids })} empty={t('proxy.editor.noAccessList') || 'No access list in this account.'}
                  render={(l) => <span className="text-sm text-text-primary">{l.name}</span>} />
              )}
            </fieldset>
          </section>
        );
      })}
    </div>
  );
}
