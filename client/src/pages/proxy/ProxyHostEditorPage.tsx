import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  BarChart3, Code2, Gauge, Globe, KeyRound, Lock, Route, Settings2, ShieldAlert, Trash2, Waypoints,
} from 'lucide-react';
import {
  HostingSocketEvents,
  type AdvancedConfigLintResult, type HostingAccount, type ProxyHost, type ProxyUpdatedPayload,
} from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { domainsApi } from '@/api/domains.api';
import { bansApi } from '@/api/bans.api';
import { proxyApi, proxyAppsLookup } from '@/api/proxy.api';
import { Button } from '@/components/common/Button';
import { AccountLink, DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { EdgeUnitBanner, EdgeUnitPill, useProxyAccess } from '@/components/proxy/proxyUi';
import { patchSearchParams } from '@/components/common/AccountScope';
import { lintIssuesOf, proxyErrorCode, proxyErrorMessage, proxyLoadError, toastProxyError } from '@/components/proxy/proxyErrors';
import { targetComplete } from '@/components/proxy/TargetEditor';
import {
  EMPTY_REFS, HOST_TABS, changedFields, createPayload, emptyForm, formFromHost, formIssues, updatePayload,
  type HostForm, type HostRefs, type HostTab,
} from '@/components/proxy/hostEditor/hostEditorModel';
import { AuthTab, GeneralTab, RoutesTab, SslTab } from '@/components/proxy/hostEditor/HostTabsMain';
import { ExpertTab, HoneypotTab, OthersTab, PerformanceTab } from '@/components/proxy/hostEditor/HostTabsMore';

function isTab(v: string | null): v is HostTab {
  return v !== null && (HOST_TABS as readonly string[]).includes(v);
}

/**
 * /proxy/hosts/new (quick setup `?stack=<id>&service=<s>&port=<p>`, account
 * `?account=<id>`) and /proxy/hosts/:id — tabs `?tab=general|ssl|auth|routes|
 * honeypot|performance|others|expert` (expert: platform staff). Shows the
 * edge unit state of the host with a Retry button (docs/P4b-PLAN.md §8, §13).
 * OWNED BY MODULE `ui-proxy`.
 */
export function ProxyHostEditorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const hostId = id ? Number(id) || null : null;
  const isNew = hostId == null;
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const { canManage, platformStaff } = useProxyAccess();

  const quick = useMemo(() => {
    const stack = Number(params.get('stack')) || null;
    const port = Number(params.get('port')) || null;
    const service = params.get('service');
    return isNew && stack && service && port ? { stackId: stack, service, port } : null;
  }, [isNew, params]);

  const [host, setHost] = useState<ProxyHost | null>(null);
  const [form, setForm] = useState<HostForm | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [refs, setRefs] = useState<HostRefs>(EMPTY_REFS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lintIssues, setLintIssues] = useState<AdvancedConfigLintResult['issues']>([]);

  const tab: HostTab = isTab(tabParam) && (tabParam !== 'expert' || platformStaff) ? tabParam : 'general';
  const setTab = (next: HostTab) => setParams((prev) => patchSearchParams(prev, { tab: next === 'general' ? null : next }), { replace: true });

  // ── load the host (edit) or build the new form (+ quick setup) ──
  const loadHost = useCallback(async () => {
    if (hostId == null) return;
    try {
      const h = await proxyApi.getHost(hostId);
      setHost(h);
      setLoadError(null);
      return h;
    } catch (err) {
      setLoadError(proxyLoadError(t, err, t('proxy.hosts.loadOneFailed') || 'Failed to load the proxy host'));
      return null;
    }
  }, [hostId, t]);

  useEffect(() => {
    let cancelled = false;
    setForm(null);
    setHost(null);
    setSaveError(null);
    setLintIssues([]);
    if (hostId != null) {
      void loadHost().then((h) => {
        if (cancelled || !h) return;
        const f = formFromHost(h);
        setForm(f);
        setBaseline(JSON.stringify(f));
      });
    } else {
      const accountParam = Number(params.get('account')) || null;
      void (async () => {
        let list: HostingAccount[] = [];
        try { list = await accountsApi.list(); } catch { list = []; }
        if (cancelled) return;
        setAccounts(list);
        let accountId = accountParam ?? null;
        const f = emptyForm(null);
        if (quick) {
          try {
            const stack = await proxyAppsLookup.stack(quick.stackId);
            if (cancelled) return;
            accountId = stack.accountId;
            f.name = stack.displayName || stack.name;
          } catch { /* the stack stays unknown: the server refuses it at creation */ }
          f.target = { kind: 'app', stackId: quick.stackId, service: quick.service, port: quick.port, scheme: 'http' };
          f.options = { ...f.options, websocket: true, blockExploits: true };
          // Same SSL defaults as the server quick setup (Let's Encrypt → HSTS on).
          f.ssl = { ...f.ssl, mode: 'auto', forceSsl: true, http2: true, hsts: true, hstsSubdomains: false };
        }
        const manageable = list.filter((a) => canManage(a.id));
        if (accountId == null && manageable.length === 1) accountId = manageable[0].id;
        f.accountId = accountId;
        setForm(f);
        setBaseline(JSON.stringify(f));
      })();
    }
    return () => { cancelled = true; };
    // Rebuild only for another host / another quick setup, not on tab changes.
  }, [hostId, quick?.stackId, quick?.service, quick?.port]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edge unit / certificate changes of this host: refresh the read-only parts (unit, domains), keep the draft.
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void loadHost(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    return hostId != null && !!payload && ((payload.entity === 'host' && payload.id === hostId) || payload.entity === 'edgeUnit' || payload.entity === 'certificate');
  }, 1000);

  // ── objects of the account the tabs pick from ──
  const accountId = form?.accountId ?? null;
  useEffect(() => {
    if (accountId == null) { setRefs(EMPTY_REFS); return; }
    let cancelled = false;
    void Promise.all([
      domainsApi.list({ accountId }).catch(() => []),
      proxyApi.listAccessLists({ accountId }).catch(() => []),
      proxyApi.listAuthProviders({ accountId }).catch(() => []),
      proxyApi.listCustomPages({ accountId }).catch(() => []),
      proxyApi.listCertificates({ accountId }).catch(() => []),
      bansApi.honeypotPresets().catch(() => []),
    ]).then(([domains, accessLists, authProviders, pages, certificates, presets]) => {
      if (!cancelled) setRefs({ domains, accessLists, authProviders, pages, certificates, presets } as HostRefs);
    });
    return () => { cancelled = true; };
  }, [accountId]);

  const set = useCallback((patch: Partial<HostForm>) => setForm((f) => (f ? { ...f, ...patch } : f)), []);

  const readOnly = !!form && !canManage(form.accountId ?? undefined);
  const dirty = !!form && JSON.stringify(form) !== baseline;
  const targetOk = !!form && targetComplete(form.target) && form.routes.every((r) => targetComplete(r.target));
  const issues = form ? formIssues(form, targetOk) : {};
  const canSave = !!form && !readOnly && Object.keys(issues).length === 0 && (isNew || dirty);

  const save = async () => {
    if (!form || !canSave) return;
    setSaving(true);
    setSaveError(null);
    setLintIssues([]);
    try {
      let saved: ProxyHost;
      if (hostId != null) {
        saved = await proxyApi.updateHost(hostId, updatePayload(form, platformStaff));
      } else if (quick && form.target.kind === 'app' && form.target.stackId === quick.stackId) {
        // Quick setup creates the host from the stack (+ Let's Encrypt, monitor), then the rest of the form is applied.
        saved = await proxyApi.quickSetup({
          stackId: quick.stackId, service: form.target.service ?? quick.service, port: form.target.port, domainIds: form.domainIds,
          letsencrypt: form.ssl.mode === 'auto', autoMonitor: form.autoMonitor,
        });
        // Follow-up PUT only for what differs from the quick-setup result (no second apply otherwise).
        const rest = changedFields(updatePayload(form, platformStaff), updatePayload(formFromHost(saved), platformStaff));
        if (Object.keys(rest).length > 0) {
          try {
            saved = await proxyApi.updateHost(saved.id, rest);
          } catch (err) {
            toastProxyError(t, err, t('proxy.editor.quickPartial') || 'The host was created, but some options could not be saved');
          }
        }
      } else {
        saved = await proxyApi.createHost(createPayload(form, platformStaff));
      }
      toast.success(isNew ? (t('proxy.hosts.created') || 'Proxy host created') : (t('proxy.hosts.saved') || 'Proxy host saved'));
      setHost(saved);
      const f = formFromHost(saved);
      setForm(f);
      setBaseline(JSON.stringify(f));
      if (isNew) navigate(`/proxy/hosts/${saved.id}`, { replace: true });
    } catch (err) {
      const lint = lintIssuesOf(err);
      if (lint.length > 0) { setLintIssues(lint as AdvancedConfigLintResult['issues']); setTab('expert'); }
      setSaveError(proxyErrorMessage(t, err, t('proxy.hosts.saveFailed') || 'Failed to save the proxy host'));
      if (proxyErrorCode(err) === 'domainInUse' || proxyErrorCode(err) === 'domainNotVerified') setTab('general');
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    if (hostId == null) return;
    setRetrying(true);
    try {
      setHost(await proxyApi.retryHost(hostId));
      toast.success(t('proxy.hosts.retried') || 'Applied again');
    } catch (err) {
      toastProxyError(t, err, t('proxy.hosts.retryFailed') || 'The new attempt failed');
    } finally {
      setRetrying(false);
    }
  };

  const remove = async () => {
    if (!host) return;
    if (!(await confirm({
      title: t('proxy.hosts.deleteTitle') || 'Delete the proxy host',
      message: t('proxy.hosts.deleteConfirm', { name: host.name, defaultValue: 'Delete {{name}}? Its domains are released (they can be bound again or routed to a site).' }),
      danger: true,
      requireText: host.name,
    }))) return;
    try {
      await proxyApi.deleteHost(host.id);
      toast.success(t('proxy.hosts.deleted') || 'Proxy host deleted');
      navigate('/proxy', { replace: true });
    } catch (err) {
      toastProxyError(t, err, t('proxy.hosts.deleteFailed') || 'Failed to delete the proxy host');
    }
  };

  const dot = (k: HostTab) => (issues[k] ? <span className="h-1.5 w-1.5 rounded-full bg-status-down" aria-hidden="true" /> : null);
  const tabs: SegmentedTab<HostTab>[] = [
    { id: 'general', label: t('proxy.editor.tabs.general') || 'General', icon: <Globe size={15} />, badge: dot('general') },
    { id: 'ssl', label: 'SSL', icon: <Lock size={15} />, badge: dot('ssl') },
    { id: 'auth', label: t('proxy.editor.tabs.auth') || 'Access', icon: <KeyRound size={15} />, badge: dot('auth') },
    { id: 'routes', label: t('proxy.editor.tabs.routes') || 'Routes', icon: <Route size={15} />, badge: issues.routes ? dot('routes') : form?.routes.length ? <span className="ml-1 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{form.routes.length}</span> : null },
    { id: 'honeypot', label: t('proxy.editor.tabs.honeypot') || 'Honeypot', icon: <ShieldAlert size={15} />, badge: dot('honeypot') },
    { id: 'performance', label: t('proxy.editor.tabs.performance') || 'Performance', icon: <Gauge size={15} />, badge: dot('performance') },
    { id: 'others', label: t('proxy.editor.tabs.others') || 'Others', icon: <Settings2 size={15} />, badge: dot('others') },
    { id: 'expert', label: t('proxy.editor.tabs.expert') || 'Expert', icon: <Code2 size={15} />, hidden: !platformStaff, badge: dot('expert') },
  ];

  if (loadError) {
    return (
      <PageContainer className="flex flex-col gap-4">
        <DetailHeader backTo="/proxy" title={t('nav.proxy') || 'Proxy'} />
        <EmptyState icon={<Waypoints />} text={loadError} />
      </PageContainer>
    );
  }
  if (!form) return <div className="flex justify-center py-16"><LoadingSpinner /></div>;

  const tabProps = { form, set, refs, readOnly, platformStaff };
  const manageable = accounts.filter((a) => canManage(a.id));

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        // Fallback: the proxy hosts of its account (no proxy tab on the account page: a tile, phase 3).
        backTo={`/proxy${form.accountId ? `?account=${form.accountId}` : ''}`}
        title={isNew ? (quick ? (t('proxy.editor.quickTitle') || 'Expose the application') : (t('proxy.editor.newTitle') || 'New proxy host')) : (host?.name || form.name)}
        badges={host ? <EdgeUnitPill unit={host.edge} /> : undefined}
        subtitle={host ? [<AccountLink key="account" accountId={host.accountId} username={host.accountUsername} to={`/proxy?account=${host.accountId}`} />] : undefined}
        actions={(
          <>
            {host && <Link to={`/traffic/${host.id}`} className={headerBtnCls}><BarChart3 size={14} />{t('proxy.hosts.traffic') || 'Traffic'}</Link>}
            {host && !readOnly && (
              <Button size="sm" variant="ghost" onClick={() => { void remove(); }}><Trash2 size={14} className="mr-1.5" />{t('common.delete') || 'Delete'}</Button>
            )}
            {!readOnly && (
              <Button size="sm" loading={saving} disabled={!canSave} onClick={() => { void save(); }}>
                {isNew ? (t('common.create') || 'Create') : (t('common.save') || 'Save')}
              </Button>
            )}
          </>
        )}
      />
      {quick && isNew && (
        <p className="-mt-2 text-sm text-text-muted">{t('proxy.editor.quickHint', { service: quick.service, port: quick.port, defaultValue: 'Service {{service}}, port {{port}}: choose the domains; Let’s Encrypt, HTTP/2, WebSocket and the availability monitor are turned on.' })}</p>
      )}
      {readOnly && <p className="-mt-2 text-xs text-amber-400">{t('proxy.editor.readOnly') || 'Read only: you cannot change the proxy objects of this account.'}</p>}

      {host && <EdgeUnitBanner unit={host.edge} canRetry={!readOnly} retrying={retrying} onRetry={() => { void retry(); }} />}
      {host && !platformStaff && host.hasAdvancedConfig && (
        <p className="text-xs text-text-muted">{t('proxy.editor.hasAdvanced') || 'This host has an advanced configuration set by the platform staff.'}</p>
      )}

      <SegmentedTabs<HostTab> tabs={tabs} value={tab} onChange={setTab} ariaLabel={t('proxy.hosts.name') || 'Proxy host'} fill={false} size="sm" />

      {tab === 'general' && (
        <GeneralTab {...tabProps} isNew={isNew} accounts={manageable} hostId={hostId} monitorId={host?.monitorId ?? null} />
      )}
      {tab === 'ssl' && <SslTab {...tabProps} enablesLetsEncrypt={!!quick && form.target.kind === 'app' && form.target.stackId === quick.stackId} />}
      {tab === 'auth' && <AuthTab {...tabProps} />}
      {tab === 'routes' && <RoutesTab {...tabProps} />}
      {tab === 'honeypot' && <HoneypotTab {...tabProps} />}
      {tab === 'performance' && <PerformanceTab {...tabProps} />}
      {tab === 'others' && <OthersTab {...tabProps} />}
      {tab === 'expert' && platformStaff && <ExpertTab {...tabProps} serverIssues={lintIssues} />}

      {saveError && <p className="whitespace-pre-line rounded-lg bg-status-down/5 p-3 text-sm text-status-down">{saveError}</p>}
      {!readOnly && (
        <div className="flex justify-end gap-2">
          {dirty && !isNew && <Button size="sm" variant="secondary" onClick={() => { setForm(JSON.parse(baseline) as HostForm); setSaveError(null); }}>{t('common.cancel') || 'Cancel'}</Button>}
          <Button size="sm" loading={saving} disabled={!canSave} onClick={() => { void save(); }}>{isNew ? (t('common.create') || 'Create') : (t('common.save') || 'Save')}</Button>
        </div>
      )}
    </PageContainer>
  );
}
