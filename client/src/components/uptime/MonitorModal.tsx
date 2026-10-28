import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { HeartPulse } from 'lucide-react';
import type { HostingAccount, UptimeMonitor, UptimeMonitorInput, UptimeMonitorKind } from '@oblimint/shared';
import { uptimeApi } from '@/api/uptime.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage } from '@/components/apps/appsErrors';

const KINDS: UptimeMonitorKind[] = ['http', 'keyword', 'tcp'];

/** Create / edit an uptime monitor (http, keyword, tcp). accountId null = platform monitor (staff). */
export function MonitorModal({ monitor, accountId, accounts, preset, onClose, onSaved }: {
  monitor: UptimeMonitor | null;
  /** New monitor: name and URL prefilled (e.g. « Create a monitor for this site »). */
  preset?: { name: string; url: string };
  accountId: number | null;
  accounts: HostingAccount[];
  onClose: () => void;
  onSaved: (m: UptimeMonitor) => void;
}) {
  const { t } = useTranslation();
  const { isStaff, can } = useP4bAccess();
  const [account, setAccount] = useState<string>(monitor ? (monitor.accountId == null ? 'platform' : String(monitor.accountId)) : accountId != null ? String(accountId) : accounts.length === 1 ? String(accounts[0].id) : '');
  const [name, setName] = useState(monitor?.name ?? preset?.name ?? '');
  const [kind, setKind] = useState<UptimeMonitorKind>(monitor?.kind ?? 'http');
  const [url, setUrl] = useState(monitor?.url ?? preset?.url ?? 'https://');
  const [host, setHost] = useState(monitor?.host ?? '');
  const [port, setPort] = useState(monitor?.port != null ? String(monitor.port) : '');
  const [keyword, setKeyword] = useState(monitor?.keyword ?? '');
  const [keywordInvert, setKeywordInvert] = useState(monitor?.keywordInvert ?? false);
  const [method, setMethod] = useState<'GET' | 'HEAD'>(monitor?.method ?? 'GET');
  const [expected, setExpected] = useState((monitor?.expectedStatus ?? []).join(', '));
  const [interval, setInterval_] = useState(String(monitor?.intervalSec ?? 60));
  const [timeout, setTimeout_] = useState(String(monitor?.timeoutMs ?? 10000));
  const [retries, setRetries] = useState(String(monitor?.retries ?? 2));
  const [notify, setNotify] = useState(monitor?.notify ?? true);
  const [enabled, setEnabled] = useState(monitor?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Auto monitor (follows a proxy host): only name, retries, notify and state may change (server 409 autoMonitor otherwise).
  const locked = !!monitor?.auto;

  const submit = async () => {
    setError('');
    if (locked && monitor) {
      if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
      const rtA = Number(retries);
      if (!Number.isInteger(rtA) || rtA < 0 || rtA > 10) { setError(t('uptime.form.retriesInvalid') || 'Retries: between 0 and 10.'); return; }
      setSaving(true);
      try {
        const saved = await uptimeApi.updateMonitor(monitor.id, { name: name.trim(), retries: rtA, notify, enabled });
        toast.success(t('uptime.form.saved') || 'Monitor saved');
        onSaved(saved);
      } catch (err) {
        if (isStepUpHandled(err)) return;
        setError(appsErrorMessage(t, err, t('uptime.form.saveFailed') || 'Failed to save the monitor', 'uptime'));
      } finally {
        setSaving(false);
      }
      return;
    }
    if (!monitor && !account) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (kind !== 'tcp' && !/^https?:\/\/[^\s/]+/i.test(url.trim())) { setError(t('uptime.form.urlInvalid') || 'URL: http:// or https:// expected.'); return; }
    if (kind === 'keyword' && !keyword.trim()) { setError(t('uptime.form.keywordRequired') || 'The keyword is required.'); return; }
    const p = Number(port);
    if (kind === 'tcp' && (!host.trim() || !Number.isInteger(p) || p < 1 || p > 65535)) { setError(t('uptime.form.hostPortInvalid') || 'Host and port (1–65535) are required.'); return; }
    const codes = expected.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (codes.some((c) => !Number.isInteger(c) || c < 100 || c > 599)) { setError(t('uptime.form.statusInvalid') || 'Expected statuses: HTTP codes between 100 and 599.'); return; }
    const iv = Number(interval);
    const to = Number(timeout);
    const rt = Number(retries);
    if (!Number.isInteger(iv) || iv < 10) { setError(t('uptime.errors.intervalTooShort') || 'The check interval is too short.'); return; }
    if (!Number.isInteger(to) || to < 500 || to > 60000) { setError(t('uptime.form.timeoutInvalid') || 'Timeout: between 500 and 60000 ms.'); return; }
    if (!Number.isInteger(rt) || rt < 0 || rt > 10) { setError(t('uptime.form.retriesInvalid') || 'Retries: between 0 and 10.'); return; }
    const body = {
      name: name.trim(), kind,
      url: kind === 'tcp' ? null : url.trim(),
      host: kind === 'tcp' ? host.trim() : null,
      port: kind === 'tcp' ? p : null,
      keyword: kind === 'keyword' ? keyword : null,
      keywordInvert: kind === 'keyword' ? keywordInvert : false,
      method, expectedStatus: codes, intervalSec: iv, timeoutMs: to, retries: rt, notify, enabled,
    };
    setSaving(true);
    try {
      const saved = monitor
        ? await uptimeApi.updateMonitor(monitor.id, body)
        : await uptimeApi.createMonitor({ ...body, accountId: account === 'platform' ? null : Number(account) } as UptimeMonitorInput);
      toast.success(t('uptime.form.saved') || 'Monitor saved');
      onSaved(saved);
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('uptime.form.saveFailed') || 'Failed to save the monitor', 'uptime'));
    } finally {
      setSaving(false);
    }
  };

  const kindLabel = (k: UptimeMonitorKind) => (k === 'http' ? 'HTTP' : k === 'tcp' ? 'TCP' : (t('uptime.kind.keyword') || 'Keyword'));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<HeartPulse className="h-4 w-4 text-accent" />}
      title={monitor ? t('uptime.form.editTitle', { name: monitor.name, defaultValue: 'Edit {{name}}' }) : (t('uptime.form.createTitle') || 'New monitor')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{monitor ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {monitor?.auto && <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">{t('uptime.form.autoWarn') || 'This monitor follows a proxy host: its target is kept in sync with the host.'}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!monitor && accountId == null && (
            <div>
              <label className={labelCls} htmlFor="mon-account">{t('apps.list.account') || 'Account'}</label>
              <select id="mon-account" value={account} onChange={(e) => setAccount(e.target.value)} className={selectCls}>
                <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
                {isStaff && can('monitoring.manage') && <option value="platform">{t('uptime.platform') || 'Platform (no account)'}</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
              </select>
            </div>
          )}
          <div className={cn(!monitor && accountId == null ? '' : 'sm:col-span-2')}>
            <label className={labelCls} htmlFor="mon-name">{t('uptime.form.name') || 'Name'}</label>
            <input id="mon-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
          </div>
        </div>
        <fieldset disabled={locked} className={cn('min-w-0 space-y-3', locked && 'opacity-60')}>
        <SegmentedTabs<UptimeMonitorKind> size="sm" fill={false} value={kind} onChange={(k) => { if (!locked) setKind(k); }} tabs={KINDS.map((k) => ({ id: k, label: kindLabel(k) }))} />
        {kind === 'tcp' ? (
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
            <div>
              <label className={labelCls} htmlFor="mon-host">{t('uptime.form.host') || 'Host'}</label>
              <input id="mon-host" value={host} onChange={(e) => setHost(e.target.value)} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
            </div>
            <div>
              <label className={labelCls} htmlFor="mon-port">{t('network.port') || 'Port'}</label>
              <input id="mon-port" type="number" min="1" max="65535" value={port} onChange={(e) => setPort(e.target.value)} className={cn(inputCls, 'font-mono')} />
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3">
              <div>
                <label className={labelCls} htmlFor="mon-url">URL</label>
                <input id="mon-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
              </div>
              <div>
                <label className={labelCls} htmlFor="mon-method">{t('uptime.form.method') || 'Method'}</label>
                <select id="mon-method" value={method} onChange={(e) => setMethod(e.target.value as 'GET' | 'HEAD')} className={selectCls}>
                  <option value="GET">GET</option>
                  <option value="HEAD">HEAD</option>
                </select>
              </div>
            </div>
            {kind === 'keyword' && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div>
                  <label className={labelCls} htmlFor="mon-kw">{t('uptime.form.keyword') || 'Keyword'}</label>
                  <input id="mon-kw" value={keyword} onChange={(e) => setKeyword(e.target.value)} className={inputCls} />
                </div>
                <div className="pb-2"><ToggleSwitch size="sm" checked={keywordInvert} onChange={setKeywordInvert} label={<span className="text-xs">{t('uptime.form.keywordInvert') || 'Must be absent'}</span>} /></div>
              </div>
            )}
            <div>
              <label className={labelCls} htmlFor="mon-expected">{t('uptime.form.expected') || 'Expected statuses (empty = 2xx / 3xx)'}</label>
              <input id="mon-expected" value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="200, 204" className={cn(inputCls, 'font-mono')} />
            </div>
          </>
        )}
        </fieldset>
        <div className="grid grid-cols-3 gap-3">
          <div className={cn(locked && 'opacity-60')}>
            <label className={labelCls} htmlFor="mon-interval">{t('uptime.form.interval') || 'Interval (s)'}</label>
            <input id="mon-interval" type="number" min="10" value={interval} disabled={locked} onChange={(e) => setInterval_(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
          <div className={cn(locked && 'opacity-60')}>
            <label className={labelCls} htmlFor="mon-timeout">{t('uptime.form.timeout') || 'Timeout (ms)'}</label>
            <input id="mon-timeout" type="number" min="500" step="500" value={timeout} disabled={locked} onChange={(e) => setTimeout_(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="mon-retries">{t('uptime.form.retries') || 'Failures before down'}</label>
            <input id="mon-retries" type="number" min="0" max="10" value={retries} onChange={(e) => setRetries(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('uptime.form.enabled') || 'Active'} />
          <ToggleSwitch checked={notify} onChange={setNotify} label={t('uptime.form.notify') || 'Notify down / up'} />
        </div>
        <p className="text-xs text-text-muted">{t('uptime.form.hint') || 'Only public addresses can be checked. The minimum interval is set by the platform.'}</p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
