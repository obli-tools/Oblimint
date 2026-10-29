import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Copy, HeartPulse, KeyRound, Send, Trash2 } from 'lucide-react';
import type { DeepHealthCheck, HealthMonitorSettings } from '@oblimint/shared';
import { healthMonitorApi } from '@/api/healthMonitor.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pill } from '@/components/common/Pill';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { hostingErrorMessage, toastHostingError } from '@/components/hosting/hostingUi';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';

/**
 * Settings page (platform admin, master workspace): token of GET /health/deep
 * for an external monitor, and the optional heartbeat URL (push monitor)
 * called every minute while every deep check is green.
 */
export function HealthMonitorSection() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<HealthMonitorSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await healthMonitorApi.get());
      setError(null);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('healthMonitor.loadFailed') || 'The health monitoring settings could not be loaded'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const title = t('healthMonitor.title') || 'Health monitoring';
  if (!settings) {
    return (
      <SettingsBlock icon={<HeartPulse />} title={title}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }) : '—');
  const deepUrl = `${window.location.origin}/health/deep`;

  const saveUrl = async (value: string | null) => {
    setSaving(true);
    try {
      setSettings(await healthMonitorApi.setHeartbeat(value));
      setUrl('');
      toast.success(value ? (t('healthMonitor.urlSaved') || 'Heartbeat URL saved') : (t('healthMonitor.urlRemoved') || 'Heartbeat URL removed'));
    } catch (err) {
      toastHostingError(t, err, t('healthMonitor.saveFailed') || 'The heartbeat URL could not be saved');
    } finally { setSaving(false); }
  };

  const newToken = async () => {
    if (settings.tokenSet && !(await confirm({
      title: t('healthMonitor.regenerate') || 'New token',
      message: t('healthMonitor.regenerateConfirm') || 'The current token stops working at once: update your monitor with the new one.',
      danger: true,
    }))) return;
    try {
      const r = await healthMonitorApi.createToken();
      setSettings(r.settings);
      setToken(r.token);
    } catch (err) { toastHostingError(t, err, t('healthMonitor.tokenFailed') || 'The token could not be created'); }
  };

  const revoke = async () => {
    if (!(await confirm({
      title: t('healthMonitor.revoke') || 'Disable the deep check',
      message: t('healthMonitor.revokeConfirm') || 'GET /health/deep will answer 404 until a new token is created.',
      danger: true,
    }))) return;
    try {
      setSettings(await healthMonitorApi.revokeToken());
      setToken(null);
    } catch (err) { toastHostingError(t, err, t('healthMonitor.tokenFailed') || 'The token could not be changed'); }
  };

  const test = async () => {
    setTesting(true);
    try {
      const s = await healthMonitorApi.test();
      setSettings(s);
      if (s.lastHeartbeatError) toast.error(s.lastHeartbeatError);
      else toast.success(t('healthMonitor.testOk') || 'Every check is green: heartbeat sent');
    } catch (err) { toastHostingError(t, err, t('healthMonitor.testFailed') || 'The test failed'); } finally { setTesting(false); }
  };

  const copy = (text: string) => { void copyText(text).then((ok) => (ok ? toast.success(t('common.copied') || 'Copied') : toast.error(t('common.error') || 'Error'))); };

  const checkLabel = (c: DeepHealthCheck) => ({
    postgres: 'PostgreSQL', hostd: 'hostd', edge: t('healthMonitor.checks.edge') || 'Edge', dns: t('healthMonitor.checks.dns') || 'DNS (PowerDNS)',
    mail: t('healthMonitor.checks.mail') || 'Mail', workers: t('healthMonitor.checks.workers') || 'Workers', disk: t('healthMonitor.checks.disk') || 'Disk',
  }[c.id]);
  const report = settings.lastReport;

  return (
    <SettingsBlock
      id="settings-health-monitor"
      icon={<HeartPulse />}
      title={title}
      description={t('healthMonitor.intro') || 'Let an external monitor watch the platform: a deep check (database, hostd, edge, DNS, mail, workers, disk) behind a token, and an optional heartbeat URL called every minute while everything is green.'}
    >
      {/* Deep check token */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <KeyRound size={16} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">{t('healthMonitor.deepTitle') || 'Deep check endpoint'}</span>
          {settings.tokenSet
            ? <Pill tone="green">{t('healthMonitor.enabled') || 'enabled'}</Pill>
            : <Pill>{t('healthMonitor.disabled') || 'disabled'}</Pill>}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-bg-primary px-3 py-2 font-mono text-xs text-text-secondary">{deepUrl}</code>
          <Button size="sm" variant="secondary" onClick={() => copy(deepUrl)}><Copy className="h-3.5 w-3.5" /></Button>
        </div>
        <p className="text-xs text-text-muted">
          {t('healthMonitor.deepHint') || 'Send the token as "Authorization: Bearer <token>" (or ?token=<token> for a monitor that only takes a URL). HTTP 200 when every check passes, 503 otherwise.'}
          {settings.tokenCreatedAt && <> {t('healthMonitor.tokenCreated', { date: fmt(settings.tokenCreatedAt), defaultValue: 'Token created {{date}}.' })}</>}
        </p>
        {token && (
          <div className="rounded-lg bg-amber-400/10 p-3">
            <p className="mb-2 text-xs text-amber-400">{t('healthMonitor.tokenOnce') || 'Copy the token now: it will not be shown again.'}</p>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-bg-primary px-2 py-1.5 font-mono text-xs text-text-primary">{token}</code>
              <Button size="sm" variant="secondary" onClick={() => copy(token)}><Copy className="mr-1 h-3.5 w-3.5" />{t('common.copy') || 'Copy'}</Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => { void newToken(); }}>{settings.tokenSet ? (t('healthMonitor.regenerate') || 'New token') : (t('healthMonitor.createToken') || 'Create a token')}</Button>
          {settings.tokenSet && <Button size="sm" variant="secondary" onClick={() => { void revoke(); }}><Trash2 className="mr-1 h-3.5 w-3.5" />{t('healthMonitor.revoke') || 'Disable the deep check'}</Button>}
        </div>
      </div>

      {/* Heartbeat */}
      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Send size={16} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">{t('healthMonitor.heartbeatTitle') || 'Outbound heartbeat'}</span>
          {settings.heartbeatSet
            ? <Pill tone={settings.lastHeartbeatError ? 'amber' : 'green'}>{settings.heartbeatOrigin ?? (t('healthMonitor.configured') || 'configured')}</Pill>
            : <Pill>{t('healthMonitor.notConfigured') || 'not configured'}</Pill>}
        </div>
        {!settings.workersEnabled && <p className="text-xs text-amber-400">{t('healthMonitor.workersOff') || 'Background workers are off on this panel (OBLIMINT_WORKERS=off): no heartbeat is sent.'}</p>}
        <Field
          label={settings.heartbeatSet ? (t('healthMonitor.replaceUrl') || 'Replace the heartbeat URL') : (t('healthMonitor.url') || 'Heartbeat URL')}
          htmlFor="hm-url"
          hint={t('healthMonitor.urlHint') || 'A push URL (Healthchecks, Uptime Kuma, Obliview…), called with GET every minute only while every check is green: your monitor alerts when the beats stop. Stored encrypted; only its host is shown back.'}
        >
          <input
            id="hm-url"
            type="url"
            className={cn(settingsInputCls, 'font-mono')}
            placeholder="https://monitor.example.com/api/push/…"
            value={url}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={saving} disabled={!url.trim()} onClick={() => { void saveUrl(url.trim()); }}>{t('common.save') || 'Save'}</Button>
          {settings.heartbeatSet && <Button size="sm" variant="secondary" loading={testing} onClick={() => { void test(); }}><Send className="mr-1 h-3.5 w-3.5" />{t('healthMonitor.test') || 'Check and send now'}</Button>}
          {settings.heartbeatSet && <Button size="sm" variant="secondary" disabled={saving} onClick={() => { void saveUrl(null); }}><Trash2 className="mr-1 h-3.5 w-3.5" />{t('healthMonitor.removeUrl') || 'Remove'}</Button>}
        </div>
        {settings.heartbeatSet && (
          <p className="text-xs text-text-muted">
            {t('healthMonitor.lastBeat', { date: fmt(settings.lastHeartbeatAt), defaultValue: 'Last heartbeat: {{date}}' })}
            {settings.lastHeartbeatError && <span className="block text-status-down">{settings.lastHeartbeatError}</span>}
          </p>
        )}
      </div>

      {/* Last report */}
      {report && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-text-primary">{t('healthMonitor.lastReport') || 'Last checks'}</span>
            <Pill tone={report.status === 'ok' ? 'green' : 'red'}>{report.status === 'ok' ? (t('healthMonitor.allGreen') || 'all green') : (t('healthMonitor.failing') || 'failing')}</Pill>
            <span className="text-xs text-text-muted">{fmt(report.checkedAt)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {report.checks.map((c) => (
              <Pill key={c.id} tone={c.status === 'ok' ? 'green' : c.status === 'fail' ? 'red' : 'muted'} title={c.detail ?? undefined}>
                {checkLabel(c)}{c.detail && c.status !== 'ok' ? ` · ${c.detail}` : ''}
              </Pill>
            ))}
          </div>
        </div>
      )}
    </SettingsBlock>
  );
}
