import { useState, useEffect, type KeyboardEvent } from 'react';
import { Server, Eye, EyeOff, ArrowLeftRight, Info, Cpu, HardDrive, Database, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ObligateConfig, PlatformUpdatesSummary } from '@oblimint/shared';
import { platformUpdatesApi } from '@/api/platformUpdates.api';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useAuthStore } from '@/store/authStore';
import { settingsApi } from '@/api/settings.api';
import { isStepUpHandled } from '@/api/client';
import type { SystemInfo } from '@/types';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { PageContainer } from '@/components/common/PageContainer';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { MEDIA, matchesMedia } from '@/hooks/useMediaQuery';
import { HostingSettingsSections } from '@/components/settings/HostingSettingsSections';
import { NotificationChannelsSection } from '@/components/notifications/NotificationChannelsSection';
import { MaintenanceSettingsSections } from '@/components/maintenance/MaintenanceSettingsSections';
import { MailSettingsSections } from '@/components/mail/MailSettingsSections';
import { AppsSettingsSections } from '@/components/settings/AppsSettingsSections';
import { ProxySettingsSections } from '@/components/settings/ProxySettingsSections';
import { useHostingMe } from '@/store/hostingStore';
import { cn } from '@/utils/cn';

// Invisible ≥40px hit area around small icon toggles (touch only).
const TOUCH_HIT = "coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-['']";
/** Minimum length of the Obligate inbound secret (same rule as the server). */
const INBOUND_SECRET_MIN = 16;

// Touch: the keyboard's Done/Enter key commits a blur-saved field (closing
// the Android keyboard does not blur it).
function blurOnEnterTouch(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Enter' && matchesMedia(MEDIA.coarse)) {
    e.preventDefault();
    e.currentTarget.blur();
  }
}

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-text-muted shrink-0">{label}</span>
      <span className="font-mono text-xs text-text-primary min-w-0 text-right break-all">{value}</span>
    </div>
  );
}

/**
 * Settings — single scrolling page of sections, like Obliance's
 * (About / system info, Obligate SSO gateway). Route: platform admin, or tenant staff
 * with the 'settings' capability, who only get the notification channels section.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { isAdmin } = useAuthStore();
  const admin = isAdmin();
  // Notification channels (plan §6.5): platform admin, or tenant staff with the 'settings' capability.
  // The other sections stay platform-admin only.
  const { me } = useHostingMe();
  const canNotify = admin || (me?.kind === 'staff' && (me.staffCapabilities === '*' || me.staffCapabilities.includes('settings')));

  // ── System info (About section) ──
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  // Platform updates indicator (platform admin on the master tenant).
  const masterAdmin = useIsMasterTenant();
  const [updates, setUpdates] = useState<PlatformUpdatesSummary | null>(null);
  useEffect(() => {
    if (!masterAdmin) { setUpdates(null); return; }
    platformUpdatesApi.summary().then(setUpdates).catch(() => setUpdates(null));
  }, [masterAdmin]);

  // ── Obligate SSO Integration ──
  const [obligateCfg, setObligateCfg] = useState<ObligateConfig | null>(null);
  const [obligateUrl, setObligateUrl] = useState('');
  const [obligateApiKey, setObligateApiKey] = useState('');
  const [showObligateKey, setShowObligateKey] = useState(false);
  const [obligateInboundSecret, setObligateInboundSecret] = useState('');
  const [showInboundSecret, setShowInboundSecret] = useState(false);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    if (!admin) return;
    setSystemInfoLoading(true);
    settingsApi.getSystemInfo().then(setSystemInfo).catch(() => {}).finally(() => setSystemInfoLoading(false));
    settingsApi.getObligateConfig().then((cfg) => {
      setObligateCfg(cfg);
      setObligateUrl(cfg.url ?? '');
    }).catch(() => {});
  }, [admin]);

  async function saveObligateConfig() {
    try {
      const trimmedUrl = obligateUrl.trim().replace(/\/$/, '');
      if (trimmedUrl === (obligateCfg?.url ?? '').replace(/\/$/, '') && !obligateApiKey.trim()) return;
      if (trimmedUrl && trimmedUrl === window.location.origin.replace(/\/$/, '')) {
        toast.error(t('settings.obligate.selfUrl') || 'Obligate URL cannot point to this application. Enter the URL of your Obligate SSO gateway.');
        return;
      }
      const patch: { url?: string | null; apiKey?: string | null } = { url: trimmedUrl || null };
      if (obligateApiKey.trim()) patch.apiKey = obligateApiKey.trim();
      const updated = await settingsApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      setObligateApiKey('');
      toast.success(t('settings.obligate.saved') || 'Obligate configuration saved');
    } catch (err) {
      if (isStepUpHandled(err)) return;
      toast.error(t('settings.obligate.saveFailed') || 'Failed to save Obligate configuration');
    }
  }

  // Inbound secret: saved on its own, never with the URL or the key.
  async function patchObligateSecrets(patch: { inboundSecret?: string | null }) {
    try {
      const updated = await settingsApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      if ('inboundSecret' in patch) setObligateInboundSecret('');
      toast.success(t('settings.obligate.secretsSaved') || 'Obligate configuration saved');
    } catch (err: any) {
      if (isStepUpHandled(err)) return;
      const serverError = String(err?.response?.data?.error ?? '');
      toast.error(/at least 16 characters/i.test(serverError)
        ? (t('settings.obligate.inboundSecret.tooShort') || 'The inbound secret must be at least 16 characters long.')
        : (t('settings.obligate.secretsSaveFailed') || 'Failed to save Obligate configuration'));
    }
  }

  async function saveInboundSecret() {
    const value = obligateInboundSecret.trim();
    if (!value) return;
    if (value.length < INBOUND_SECRET_MIN) {
      toast.error(t('settings.obligate.inboundSecret.tooShort') || 'The inbound secret must be at least 16 characters long.');
      return;
    }
    const ok = await confirm({
      title: t('settings.obligate.inboundSecret.confirmTitle') || 'Set an inbound secret?',
      message: t('settings.obligate.inboundSecret.confirmMessage') || 'From now on, Obligate calls to this server must present this secret instead of the API key. Until Obligate is updated to send it, all of its calls will be refused, including the deactivations and deletions of SSO users.',
      confirmLabel: t('settings.obligate.inboundSecret.confirmButton') || 'Set the secret',
      danger: true,
    });
    if (!ok) return;
    await patchObligateSecrets({ inboundSecret: value });
  }

  async function setSsoEnabled(enabled: boolean) {
    setEnabling(true);
    try {
      const updated = await settingsApi.patchObligateConfig({ enabled });
      setObligateCfg(updated);
      toast.success(enabled
        ? (t('settings.obligate.enabledToast') || 'SSO enabled')
        : (t('settings.obligate.disabledToast') || 'SSO disabled'));
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(t('settings.obligate.saveFailed') || 'Failed to save Obligate configuration');
    } finally {
      setEnabling(false);
    }
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(t('about.uptimeDays', { count: d, defaultValue: '{{count}}d' }));
    if (h > 0) parts.push(t('about.uptimeHours', { count: h, defaultValue: '{{count}}h' }));
    parts.push(t('about.uptimeMinutes', { count: m, defaultValue: '{{count}}m' }));
    return parts.join(' ');
  }

  const mb = (n: number) => `${n} ${t('units.mb') || 'MB'}`;
  const setBadge = (
    <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20">
      {t('settings.obligate.setBadge') || 'SET'}
    </span>
  );

  return (
    <PageContainer className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary mb-2">{t('settings.title') || 'Settings'}</h1>
        <p className="text-xs font-mono tracking-wider text-text-muted">
          {t('settings.globalDesc') || 'Platform-wide settings of this Oblimint server.'}
        </p>
      </div>

      {/* ── About ── */}
      {admin && (<div>
        <div className="flex items-center gap-2 mb-4">
          <Info size={18} className="text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">{t('about.title') || 'About'}</h2>
        </div>
        <div className="rounded-lg bg-bg-secondary p-5">
          {systemInfoLoading ? (
            <p className="text-sm text-text-muted animate-pulse">{t('about.loading') || 'Loading system information...'}</p>
          ) : systemInfo ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                  <Server size={12} /> {t('about.versions') || 'Versions'}
                </p>
                <AboutRow label={t('about.server') || 'Server'} value={`v${systemInfo.appVersion}`} />
                <AboutRow label={t('about.client') || 'Client'} value={`v${__APP_VERSION__}`} />
                <AboutRow label={t('about.node') || 'Node.js'} value={systemInfo.nodeVersion} />
                {updates && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs text-text-muted shrink-0">{t('platformUpdates.aboutLabel') || 'Platform updates'}</span>
                    <Link to="/manage/nodes?tab=updates" className={cn('font-mono text-xs hover:underline',
                      updates.updating ? 'text-sky-400' : updates.failed > 0 ? 'text-status-down' : updates.available > 0 ? 'text-amber-400' : 'text-text-primary')}>
                      {updates.updating ? (t('platformUpdates.status.updating') || 'Updating')
                        : updates.failed > 0 ? (t('platformUpdates.status.failed') || 'Failed')
                        : updates.available > 0 ? t('platformUpdates.availableCount', { count: updates.available, defaultValue: '{{count}} to apply' })
                        : updates.checkedAt ? (t('platformUpdates.status.upToDate') || 'Up to date') : (t('platformUpdates.status.unchecked') || 'Not checked')}
                    </Link>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                  <Clock size={12} /> {t('about.instance') || 'Instance'}
                </p>
                <AboutRow label={t('about.uptime') || 'Uptime'} value={formatUptime(systemInfo.uptimeSeconds)} />
                <AboutRow
                  label={t('about.environment') || 'Environment'}
                  value={systemInfo.environment.isDocker ? (t('about.docker') || 'Docker') : (t('about.native') || 'Native')}
                />
                <AboutRow label={t('about.platform') || 'Platform'} value={systemInfo.environment.platform} />
                <AboutRow label={t('about.cpuCores') || 'CPU cores'} value={String(systemInfo.cpu.cores)} />
              </div>
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                  <HardDrive size={12} /> {t('about.memory') || 'Memory'}
                </p>
                <AboutRow label={t('about.processRss') || 'Process RSS'} value={mb(systemInfo.memory.processRssMb)} />
                <AboutRow label={t('about.heapUsed') || 'Heap used'} value={mb(systemInfo.memory.processHeapMb)} />
                <AboutRow label={t('about.systemFree') || 'System free'} value={`${systemInfo.memory.systemFreeMb} / ${mb(systemInfo.memory.systemTotalMb)}`} />
              </div>
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                  <Cpu size={12} /> {t('about.cpuLoad') || 'CPU load'}
                </p>
                <AboutRow label={t('about.load1') || '1 min'} value={String(systemInfo.cpu.loadAvg1)} />
                <AboutRow label={t('about.load5') || '5 min'} value={String(systemInfo.cpu.loadAvg5)} />
                <AboutRow label={t('about.load15') || '15 min'} value={String(systemInfo.cpu.loadAvg15)} />
              </div>
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                  <Database size={12} /> {t('about.database') || 'Database'}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">{t('about.postgres') || 'PostgreSQL'}</span>
                  <span className={cn(
                    'flex items-center gap-1.5 text-xs font-medium',
                    systemInfo.environment.dbStatus === 'ok' ? 'text-status-up' : 'text-status-down',
                  )}>
                    <span className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      systemInfo.environment.dbStatus === 'ok' ? 'bg-status-up' : 'bg-status-down',
                    )} />
                    {systemInfo.environment.dbStatus === 'ok' ? (t('about.connected') || 'Connected') : (t('about.error') || 'Error')}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t('about.loadFailed') || 'Failed to load system information.'}</p>
          )}
        </div>
      </div>

      )}

      {/* ── P2: hosting platform settings (DNS, previews, DB admin, access, usage) ── */}
      {admin && <HostingSettingsSections />}

      {/* ── P3: scanner (ClamAV + YARA) and maintenance settings ── */}
      {admin && <MaintenanceSettingsSections />}

      {/* ── P4: mail service (engine, webmail, DNS defaults, anti-spam, limits, bans) ── */}
      {admin && <MailSettingsSections />}

      {/* ── P4b: applications, monitoring, network segmentation (ui-apps) — edge and bans (ui-proxy) ── */}
      {admin && <AppsSettingsSections />}
      {admin && <ProxySettingsSections />}

      {/* ── P2: notification channels of the workspace ── */}
      {canNotify && <NotificationChannelsSection />}

      {/* ── Obligate SSO Gateway ── */}
      {admin && (<div>
        <div className="flex items-center gap-2 mb-4">
          <ArrowLeftRight size={16} className="text-text-muted" />
          <h2 className="text-lg font-semibold text-text-primary">{t('settings.obligate.title') || 'Obligate SSO Gateway'}</h2>
        </div>
        <div className="rounded-lg bg-bg-secondary p-5 space-y-4">
          <p className="text-sm text-text-muted">
            {t('settings.obligate.description') || 'Connect this app to your Obligate SSO gateway for centralized authentication and cross-app navigation. Register this app in Obligate first, then paste the API key here.'}
          </p>
          <div className="bg-status-pending-bg border border-status-pending/30 rounded-md p-3 text-sm text-status-pending">
            {t('settings.obligate.warning') || 'When enabled, staff users sign in through the Obligate gateway. If the gateway becomes unreachable, local authentication is automatically restored as a fallback. Customer (client) accounts always sign in locally.'}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              <label htmlFor="obligate-url" className="text-sm font-medium text-text-secondary">{t('settings.obligate.url') || 'Obligate URL'}</label>
              {obligateCfg?.url && (
                <a href={obligateCfg.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline coarse:py-2">
                  {t('settings.obligate.open') || 'Open ↗'}
                </a>
              )}
            </div>
            <div className="flex gap-2">
              <input
                id="obligate-url"
                type="url"
                inputMode="url"
                enterKeyHint="done"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('settings.obligate.urlPlaceholder') || 'https://obligate.example.com'}
                value={obligateUrl}
                onChange={(e) => setObligateUrl(e.target.value)}
                onBlur={() => void saveObligateConfig()}
                onKeyDown={blurOnEnterTouch}
                className="w-full min-w-0 flex-1 rounded-lg bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
              {obligateUrl.trim().replace(/\/$/, '') !== (obligateCfg?.url ?? '').replace(/\/$/, '') && (
                <Button type="button" size="sm" className="hidden coarse:inline-flex shrink-0" onMouseDown={(e) => e.preventDefault()} onClick={() => void saveObligateConfig()}>
                  {t('common.save') || 'Save'}
                </Button>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="obligate-key" className="block text-sm font-medium text-text-secondary mb-1">
              {t('settings.obligate.apiKey') || 'API key'}
              {obligateCfg?.apiKeySet && setBadge}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  id="obligate-key"
                  type={showObligateKey ? 'text' : 'password'}
                  placeholder={obligateCfg?.apiKeySet ? '••••••••••••••••••••••••••••••••••••' : (t('settings.obligate.apiKeyPlaceholder') || 'Paste the API key from Obligate…')}
                  value={obligateApiKey}
                  onChange={(e) => setObligateApiKey(e.target.value)}
                  onBlur={() => { if (obligateApiKey.trim()) void saveObligateConfig(); }}
                  onKeyDown={blurOnEnterTouch}
                  enterKeyHint="done"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
                <button
                  type="button"
                  onClick={() => setShowObligateKey((v) => !v)}
                  aria-label={t('settings.toggleSecretVisibility') || 'Show / hide'}
                  aria-pressed={showObligateKey}
                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary ${TOUCH_HIT}`}
                >
                  {showObligateKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {obligateApiKey.trim() && (
                <Button type="button" size="sm" className="hidden coarse:inline-flex shrink-0" onMouseDown={(e) => e.preventDefault()} onClick={() => void saveObligateConfig()}>
                  {t('common.save') || 'Save'}
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-xs text-text-muted">
              {t('settings.obligate.apiKeyHint') || 'Generate this key in Obligate → Connected Apps → Add App (application type: oblimint).'}
            </p>
          </div>

          {obligateCfg?.apiKeySet && (
            <div>
              <label htmlFor="obligate-inbound" className="block text-sm font-medium text-text-secondary mb-1">
                {t('settings.obligate.inboundSecret.label') || 'Inbound secret (optional)'}
                {obligateCfg.inboundSecretSet && setBadge}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    id="obligate-inbound"
                    type={showInboundSecret ? 'text' : 'password'}
                    placeholder={obligateCfg.inboundSecretSet ? '••••••••••••••••••••••••••••••••••••' : (t('settings.obligate.inboundSecret.placeholder') || 'Empty: the API key is expected')}
                    value={obligateInboundSecret}
                    disabled={!!obligateCfg.inboundSecretFromEnv}
                    onChange={(e) => setObligateInboundSecret(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveInboundSecret(); } }}
                    enterKeyHint="done"
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowInboundSecret((v) => !v)}
                    aria-label={t('settings.toggleSecretVisibility') || 'Show / hide'}
                    aria-pressed={showInboundSecret}
                    className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary ${TOUCH_HIT}`}
                  >
                    {showInboundSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {obligateInboundSecret.trim() && (
                  <Button type="button" size="sm" className="shrink-0" onClick={() => void saveInboundSecret()}>
                    {t('common.save') || 'Save'}
                  </Button>
                )}
                {obligateCfg.inboundSecretSet && !obligateCfg.inboundSecretFromEnv && (
                  <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => void patchObligateSecrets({ inboundSecret: null })}>
                    {t('settings.obligate.inboundSecret.clear') || 'Clear'}
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-xs text-text-muted">
                {obligateCfg.inboundSecretFromEnv
                  ? (t('settings.obligate.inboundSecret.fromEnv') || 'Set by the OBLIGATE_INBOUND_SECRET environment variable.')
                  : (t('settings.obligate.inboundSecret.hint') || 'Secret that Obligate must present when it calls this server (user sync, app info, dashboard stats), at least 16 characters. Leave empty to keep expecting the API key.')}
              </p>
            </div>
          )}

          {obligateCfg?.url && obligateCfg.apiKeySet && (
            <div className="pt-4 mt-4">
              <ToggleSwitch
                checked={obligateCfg.enabled}
                disabled={enabling}
                onChange={(v) => void setSsoEnabled(v)}
                label={t('settings.obligate.enableSso') || 'Enable SSO'}
                description={t('settings.obligate.enableSsoHint') || 'When enabled, the login page redirects to Obligate for authentication. Users are auto-provisioned on first login. Cross-app navigation buttons appear in the header.'}
              />
            </div>
          )}
        </div>
      </div>)}
    </PageContainer>
  );
}
