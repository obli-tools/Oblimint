import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Terminal } from 'lucide-react';
import { ANTHROPIC_OUTBOUND_RANGES, type KeyIpCoverage, type KeySecuritySettings, type KeySecurityStatus, type KeyStrictMode } from '@oblimint/shared';
import { keySecurityApi } from '@/api/keySecurity.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pill } from '@/components/common/Pill';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { hostingErrorMessage, toastHostingError } from '@/components/hosting/hostingUi';

/** Loose address / CIDR check (the server normalizes and refuses the rest). */
const CIDR_RE = /^[0-9a-f:.]+(\/\d{1,3})?$/i;

type Draft = Pick<KeySecuritySettings, 'requireIp' | 'strictMode' | 'maxFailures' | 'failureWindowMinutes' | 'trustedIps' | 'connectorSourceRanges'>;

const draftOf = (s: KeySecuritySettings): Draft => ({
  requireIp: s.requireIp, strictMode: s.strictMode, maxFailures: s.maxFailures, failureWindowMinutes: s.failureWindowMinutes,
  trustedIps: [...s.trustedIps], connectorSourceRanges: [...s.connectorSourceRanges],
});

/**
 * Settings page, group « API access & agents » (platform admin, master
 * workspace): IP security of the access keys / MCP connectors (spec §5) —
 * mandatory IP, strict mode (auto = 48 h log-only, then on), failed-attempt
 * limit, trusted IPs, connectors' source ranges, and the status panel (regime,
 * open keys keeping the strict mode off, current address covered or not,
 * "would have banned" journal).
 */
export function KeySecuritySection() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<KeySecuritySettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<KeySecurityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatus = useCallback(async () => {
    setRefreshing(true);
    try { setStatus(await keySecurityApi.status()); } catch { /* the settings still show */ } finally { setRefreshing(false); }
  }, []);
  const load = useCallback(async () => {
    try {
      const s = await keySecurityApi.get();
      setSettings(s);
      setDraft(draftOf(s));
      setError(null);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('keySecurity.loadFailed') || 'The access-key security settings could not be loaded'));
    }
    void loadStatus();
  }, [t, loadStatus]);
  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => !!settings && !!draft && JSON.stringify(draftOf(settings)) !== JSON.stringify(draft), [settings, draft]);
  const title = t('keySecurity.title') || 'IP security of the access keys';

  if (!settings || !draft) {
    return (
      <SettingsBlock id="settings-key-security" icon={<ShieldCheck />} title={title}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      const s = await keySecurityApi.update(draft);
      setSettings(s);
      setDraft(draftOf(s));
      toast.success(t('keySecurity.saved') || 'Access-key security saved');
      void loadStatus();
    } catch (err) {
      toastHostingError(t, err, t('keySecurity.saveFailed') || 'The settings could not be saved');
    } finally { setSaving(false); }
  };

  const modeTabs: Array<{ id: KeyStrictMode; label: string }> = [
    { id: 'auto', label: t('keySecurity.mode.auto') || 'Automatic' },
    { id: 'log', label: t('keySecurity.mode.log') || 'Log only' },
    { id: 'on', label: t('keySecurity.mode.on') || 'Strict' },
    { id: 'off', label: t('keySecurity.mode.off') || 'Off' },
  ];
  const modeHint: Record<KeyStrictMode, string> = {
    auto: t('keySecurity.modeHint.auto') || 'Log only for 48 hours after the first start, then strict by itself (the platform admins are notified).',
    log: t('keySecurity.modeHint.log') || 'Addresses outside every key are journaled ("would have banned"), never banned.',
    on: t('keySecurity.modeHint.on') || 'When every active key has addresses, any other address that touches /mcp, /api/v1 or /oauth/token is banned without end.',
    off: t('keySecurity.modeHint.off') || 'No intrusion ban. Repeated bad keys are still banned.',
  };
  const coverageLabel = (c: KeyIpCoverage | null): string => ({
    allowList: t('keySecurity.coverage.allowList') || 'in the list of a key',
    trusted: t('keySecurity.coverage.trusted') || 'trusted IP',
    connectorRange: t('keySecurity.coverage.connectorRange') || 'connectors\' range',
    adminSession: t('keySecurity.coverage.adminSession') || 'open platform-admin session',
    neverBanned: t('keySecurity.coverage.neverBanned') || 'never banned (private / node / never-ban list)',
  }[c ?? 'allowList'] ?? '');
  const effective = status?.strictMode;

  return (
    <SettingsBlock
      id="settings-key-security"
      icon={<ShieldCheck />}
      title={title}
      description={t('keySecurity.intro') || 'Who may reach /mcp, /api/v1 and the OAuth token endpoint of the connectors. A ban is a platform ban: it covers every web port of the edge — the panel, the client space, the webmail and every hosted site. A shared NAT address (office, 4G) that gets banned loses the sites too.'}
      dirty={dirty}
      saving={saving}
      onSave={() => { void save(); }}
      onReset={() => setDraft(draftOf(settings))}
    >
      {/* Status panel */}
      <div className="space-y-3 rounded-lg bg-bg-primary p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text-primary">{t('keySecurity.status.title') || 'Current state'}</span>
          {status && (
            <>
              <Pill tone={status.regime === 'strict' ? 'green' : 'amber'}>
                {status.regime === 'strict' ? (t('keySecurity.regime.strict') || 'every key closed') : (t('keySecurity.regime.watch') || 'watch mode')}
              </Pill>
              <Pill tone={effective === 'on' ? 'accent' : effective === 'log' ? 'blue' : 'muted'}>
                {effective === 'on' ? (t('keySecurity.effective.on') || 'strict mode active') : effective === 'log' ? (t('keySecurity.effective.log') || 'log only') : (t('keySecurity.effective.off') || 'strict mode off')}
              </Pill>
            </>
          )}
          <Button size="sm" variant="secondary" className="ml-auto" loading={refreshing} onClick={() => { void loadStatus(); }}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />{t('common.refresh') || 'Refresh'}
          </Button>
        </div>
        {status ? (
          <div className="space-y-2 text-xs text-text-secondary">
            {settings.strictMode === 'auto' && status.autoStrictAt && effective === 'log' && (
              <p>{t('keySecurity.status.autoAt', { date: fmt(status.autoStrictAt), defaultValue: 'Strict from {{date}} (end of the 48 h log-only period).' })}</p>
            )}
            <p>
              {t('keySecurity.status.keys', { active: status.activeKeys, size: status.allowListSize, defaultValue: '{{active}} active key(s), allow-list of {{size}} entries.' })}
            </p>
            {status.currentIp && (
              <p className="flex flex-wrap items-center gap-1.5">
                {status.currentIpCovered
                  ? <CheckCircle2 className="h-3.5 w-3.5 text-status-up" />
                  : <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                {status.currentIpCovered
                  ? t('keySecurity.status.ipCovered', { ip: status.currentIp, how: coverageLabel(status.currentIpCoverage), defaultValue: 'Your current address ({{ip}}) is covered: {{how}}.' })
                  : t('keySecurity.status.ipNotCovered', { ip: status.currentIp, defaultValue: 'Your current address ({{ip}}) is in no key\'s list: outside your panel session it would be banned in strict mode. Add it to the trusted IPs if you call the API from here.' })}
              </p>
            )}
            {status.openKeys.length > 0 && (
              <div>
                <p className="text-amber-400">{t('keySecurity.status.openKeys', { count: status.openKeys.length, defaultValue: 'Open keys keeping the strict mode off ({{count}}):' })}</p>
                <ul className="mt-1 space-y-0.5">
                  {status.openKeys.map((k) => (
                    <li key={k.id} className="font-mono text-[11px]">
                      <Link className="text-accent hover:underline" to={`/accounts/${k.accountId}?tab=keys`}>{k.name}</Link>
                      {' · '}{k.kind === 'connector' ? (t('apiKeys.connector.badge') || 'Claude connector') : (t('keySecurity.status.key') || 'key')}
                      {' · '}{k.accountUsername ?? `#${k.accountId}`}{' · '}{k.tenantName ?? `#${k.tenantId}`}{' · '}{k.owner ?? '—'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {status.staffSessionIps.length > 0 && (
              <p>{t('keySecurity.status.sessions') || 'Exempt (open platform-admin sessions):'} <span className="font-mono">{status.staffSessionIps.join(', ')}</span></p>
            )}
            {status.lastBan && (
              <p>{t('keySecurity.status.lastBan', { ip: status.lastBan.ip, date: fmt(status.lastBan.at), defaultValue: 'Last ban: {{ip}} ({{date}}).' })} <Link className="text-accent hover:underline" to="/security/bans">{t('keySecurity.status.bansLink') || 'Bans'}</Link></p>
            )}
            {status.wouldHaveBanned.length > 0 && (
              <div>
                <p>{t('keySecurity.status.wouldBan') || 'Would have been banned (log only):'}</p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-text-muted">
                  {status.wouldHaveBanned.slice(0, 10).map((w) => <li key={`${w.ip}-${w.at}`}>{fmt(w.at)} · {w.ip} · {w.surface}</li>)}
                </ul>
              </div>
            )}
          </div>
        ) : <div className="flex justify-center py-2"><LoadingSpinner /></div>}
      </div>

      {/* Strict mode */}
      <Field label={t('keySecurity.strictMode') || 'Strict mode'} hint={modeHint[draft.strictMode]}>
        <SegmentedTabs tabs={modeTabs} value={draft.strictMode} onChange={(v) => set('strictMode', v)} size="sm" fill={false} ariaLabel={t('keySecurity.strictMode') || 'Strict mode'} />
      </Field>

      <ToggleSwitch
        checked={draft.requireIp}
        onChange={(v) => set('requireIp', v)}
        label={t('keySecurity.requireIp') || 'An IP address is mandatory on the access keys'}
        description={t('keySecurity.requireIpHint') || 'Default of every workspace (a workspace may override it). A key without address is refused at use until restricted; a connector is covered by the connectors\' ranges.'}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('keySecurity.maxFailures') || 'Bad keys tolerated'} htmlFor="ks-max" hint={t('keySecurity.maxFailuresHint') || 'From one address within the window, then a ban on the escalation ladder of the bans.'}>
          <input id="ks-max" type="number" min={1} max={100} className={settingsInputCls} value={draft.maxFailures}
            onChange={(e) => set('maxFailures', Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
        </Field>
        <Field label={t('keySecurity.window') || 'Window (minutes)'} htmlFor="ks-window">
          <input id="ks-window" type="number" min={1} max={1440} className={settingsInputCls} value={draft.failureWindowMinutes}
            onChange={(e) => set('failureWindowMinutes', Math.max(1, Math.min(1440, Number(e.target.value) || 1)))} />
        </Field>
      </div>

      <Field label={t('keySecurity.trustedIps') || 'Trusted IPs'} hint={t('keySecurity.trustedIpsHint') || 'Never banned by the key surfaces (their bad keys are refused, not counted). Your office, your CI runners.'}>
        <ChipsInput value={draft.trustedIps} onChange={(v) => set('trustedIps', v)} validate={(v) => CIDR_RE.test(v)} max={256} placeholder="203.0.113.0/24" ariaLabel={t('keySecurity.trustedIps') || 'Trusted IPs'} />
      </Field>

      <Field
        label={t('keySecurity.connectorRanges') || 'Connectors\' source ranges'}
        hint={t('keySecurity.connectorRangesHint') || 'Where the Claude connectors call from (Anthropic\'s published outbound addresses). Always allowed for a connector and never banned. Empty: every connector counts as an open key.'}
      >
        <ChipsInput value={draft.connectorSourceRanges} onChange={(v) => set('connectorSourceRanges', v)} validate={(v) => CIDR_RE.test(v)} max={64} placeholder={ANTHROPIC_OUTBOUND_RANGES[0]} ariaLabel={t('keySecurity.connectorRanges') || 'Connectors\' source ranges'} />
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => set('connectorSourceRanges', [...new Set([...draft.connectorSourceRanges, ...ANTHROPIC_OUTBOUND_RANGES])])}>
          {t('keySecurity.anthropicRanges') || 'Anthropic ranges'}
        </Button>
      </Field>

      <p className="flex items-start gap-2 rounded-lg bg-bg-primary p-3 text-xs text-text-muted">
        <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <span>
          {t('keySecurity.cliHint') || 'Locked out? From the server: docker exec <panel container> node dist/src/cli/keySecurity.js unban <ip> (or trust <ip>, status, help).'}
        </span>
      </p>
    </SettingsBlock>
  );
}
