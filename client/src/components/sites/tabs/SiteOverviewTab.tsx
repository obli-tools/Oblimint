import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Clock, Cpu, Eye, FolderUp, Globe, History, ListChecks, RefreshCw, Rocket, ScanSearch, Timer, Wand2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import {
  HostingSocketEvents, appProfileDef,
  type AppProfileId, type DbInstance, type Domain, type ProfileDetection, type StagingStatus,
} from '@oblimint/shared';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { releasesApi } from '@/api/releases.api';
import { sitesApi } from '@/api/sites.api';
import { domainsApi } from '@/api/domains.api';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LaunchChecklist, type ChecklistItem } from '@/components/common/ObjectTiles';
import { MiniStat } from '@/components/usage/HeroCards';
import { VerificationBadge } from '@/components/dns/DnsBadges';
import { TlsBadge, useHostingEvents } from '@/components/hosting/hostingUi';
import { useDomainDrawer } from '@/components/hosting/DomainDrawer';
import { DbInstanceCreateModal } from '@/components/databases/DbInstanceCreateModal';
import type { SiteTab } from '@/utils/links';
import { BaseBadge, FileStatusIcon, Pill, PolicyBadge } from '../SiteBadges';
import { findDocrootDataPath, formatCountdown, formatDateTime } from '../siteForm';
import { isNotImplemented, siteErrorMessage, toastSiteError } from '../siteErrors';
import { useHostingEvent } from '../useHostingEvent';
import { cardCls, sectionLabelCls } from '../styles';
import type { SiteTabProps } from './types';
import { PreviewCard, useSitePreview } from '../previews/PreviewCard';
import { StartPreviewModal } from '../previews/StartPreviewModal';

type GoTo = (tab: SiteTab, extra?: Record<string, string>) => void;

/**
 * Overview of a site (coherence plan 1.3): what is left to put it online
 * (each line opens the right form in place), its addresses, the staging
 * folder and the application detection. The settings live in Configuration,
 * the PHP limits in Runtime & PHP.
 */
export function SiteOverviewTab(props: SiteTabProps & { onGoTo: GoTo }) {
  // The staging state of StagingCard, shared with the checklist (« code uploaded »).
  const [staging, setStaging] = useState<StagingStatus | null>(null);
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-3">
        <LaunchCard {...props} staging={staging} />
      </div>
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        <StagingCard {...props} onStaging={setStaging} />
        <DetectCard {...props} />
      </div>
    </div>
  );
}

// ── Launch checklist, addresses, tiles ──────────────────────────────────────

function LaunchCard({ site, onPublish, onGoTo, staging }: SiteTabProps & { onGoTo: GoTo; staging: StagingStatus | null }) {
  const { t, i18n } = useTranslation();
  const { can } = useHostingMe();
  const drawer = useDomainDrawer();
  // null = not readable by the caller (the line is shown as unknown).
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [instances, setInstances] = useState<DbInstance[] | null>(null);
  const [creatingDb, setCreatingDb] = useState(false);

  const loadDomains = useCallback(() => {
    domainsApi.list({ accountId: site.accountId }).then(setDomains).catch(() => setDomains(null));
  }, [site.accountId]);
  useEffect(() => { loadDomains(); }, [loadDomains]);
  const instancesSeq = useRef(0);
  const loadInstances = useCallback(() => {
    const seq = ++instancesSeq.current;
    databasesApi.listInstances({ accountId: site.accountId })
      .then((l) => { if (seq === instancesSeq.current) setInstances(l); })
      .catch(() => { if (seq === instancesSeq.current) setInstances(null); });
  }, [site.accountId]);
  useEffect(() => { loadInstances(); }, [loadInstances]);
  useHostingEvents([
    HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED, HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED,
  ], () => { loadDomains(); });

  // The addresses of the site: every route of a domain of the account to this site.
  const addresses = useMemo(() => (domains ?? []).flatMap((d) => d.routes
    .filter((r) => r.siteId === site.id)
    .map((r) => ({ key: `${d.id}-${r.id}`, domain: d, prefix: r.pathPrefix }))), [domains, site.id]);
  const routed = useMemo(() => [...new Map(addresses.map((a) => [a.domain.id, a.domain])).values()], [addresses]);
  const unverified = routed.find((d) => d.verification?.status !== 'verified');
  const noHttps = routed.find((d) => d.tlsMode !== 'none' && d.certificate?.status !== 'valid');

  const canDomains = can('domains.manage', site.accountId);
  const canDb = can('databases.manage', site.accountId);
  // Code uploaded: something in the staging folder, pending or already published.
  const codeDone = site.currentReleaseNumber != null || (staging != null && (staging.lastUploadAt != null || staging.pendingChanges > 0));
  const items: ChecklistItem[] = [
    {
      key: 'code', done: codeDone, unknown: !codeDone && staging === null,
      label: t('objectPage.site.code') || 'Code uploaded',
      hint: staging?.lastUploadAt
        ? formatDateTime(staging.lastUploadAt, i18n.language)
        : (t('objectPage.site.codeHint') || 'Upload the code into the staging folder: SFTP or the Files tab.'),
      action: codeDone ? null : { label: t('sites.tabs.files') || 'Files', onClick: () => onGoTo('files') },
    },
    {
      key: 'route', done: routed.length > 0, unknown: domains === null,
      label: t('objectPage.site.route') || 'A domain points to the site',
      hint: routed.length > 0 ? routed.map((d) => d.name).join(', ') : (t('objectPage.site.routeHint') || 'Visitors reach the site through a domain routed to it.'),
      action: canDomains ? { label: t('domains.create') || 'Add a domain', onClick: () => onGoTo('domains', { add: '1' }) } : null,
    },
    {
      key: 'verified', done: routed.length > 0 && !unverified, unknown: domains === null || routed.length === 0,
      label: t('objectPage.site.verified') || 'Domain ownership verified',
      hint: unverified ? t('objectPage.site.verifiedHint', { name: unverified.name, defaultValue: '{{name}} still shows a placeholder page.' }) : undefined,
      action: unverified ? { label: t('objectPage.open') || 'Open', onClick: () => drawer.open(unverified.id) } : null,
    },
    {
      key: 'https', done: routed.length > 0 && !noHttps, unknown: domains === null || routed.length === 0,
      label: t('objectPage.site.https') || 'HTTPS certificate valid',
      hint: noHttps ? t('objectPage.site.httpsHint', { name: noHttps.name, defaultValue: 'No valid certificate yet for {{name}}.' }) : undefined,
      action: noHttps ? { label: t('objectPage.open') || 'Open', onClick: () => drawer.open(noHttps.id) } : null,
    },
    {
      key: 'db', done: (instances?.length ?? 0) > 0, unknown: instances === null,
      label: t('objectPage.site.db') || 'A database is available',
      hint: instances && instances.length > 0
        ? instances.map((i) => i.name).join(', ')
        : (t('objectPage.site.dbHint') || 'Only if the application needs one (the account instances are shared by its sites).'),
      // No instance yet: created in place (as on the account); else its settings in Configuration.
      action: !canDb ? null : instances?.length === 0
        ? { label: t('databases.create') || 'New instance', onClick: () => setCreatingDb(true) }
        : { label: t('objectPage.site.dbAction') || 'Database settings', onClick: () => onGoTo('config', { section: 'db' }) },
    },
    {
      key: 'published', done: site.currentReleaseNumber != null,
      label: t('objectPage.site.published') || 'First release published',
      hint: site.currentReleaseNumber != null ? `#${site.currentReleaseNumber}` : (t('objectPage.site.publishedHint') || 'Upload the code into the staging folder (SFTP or Files tab), then publish it.'),
      action: can('releases.publish', site.accountId) ? { label: t('releases.publish.button') || 'Publish', onClick: onPublish } : null,
    },
  ];

  return (
    <>
      <div className={cardCls}>
        <div className="mb-3 flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-accent" />
          <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('objectPage.site.launchTitle') || 'Going live'}</h2>
        </div>
        <LaunchChecklist items={items} />
      </div>

      <div className={cardCls}>
        <div className="mb-3 flex items-center gap-2">
          <Globe className="h-4 w-4 text-accent" />
          <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('objectPage.site.addresses') || 'Addresses'}</h2>
          <button type="button" onClick={() => onGoTo('domains')} className="text-xs text-accent hover:underline">{t('objectPage.manage') || 'Manage'}</button>
        </div>
        {domains === null ? (
          <p className="text-xs text-text-muted">{t('objectPage.notReadable') || 'Not available.'}</p>
        ) : addresses.length === 0 ? (
          <p className="text-xs text-text-muted">{t('domains.routes.siteEmpty') || 'No domain points to this site yet.'}</p>
        ) : (
          <ul className="space-y-1.5">
            {addresses.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => drawer.open(a.domain.id)} className="break-all text-left font-mono text-sm text-text-primary hover:text-accent">
                  {a.domain.name}<span className="text-accent">{a.prefix}</span>
                </button>
                <VerificationBadge verification={a.domain.verification} />
                <TlsBadge tlsMode={a.domain.tlsMode} certificate={a.domain.certificate} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MiniStat
          icon={<History size={15} />}
          label={t('sites.tabs.releases') || 'Releases'}
          value={site.currentReleaseNumber != null ? `#${site.currentReleaseNumber}` : null}
          sub={site.currentReleaseNumber != null ? (t('objectPage.site.live') || 'live release') : (t('objectPage.site.nothingLive') || 'nothing published')}
          onClick={() => onGoTo('releases')}
        />
        <MiniStat icon={<Cpu size={15} />} label={t('sites.tabs.runtimePhp') || 'Runtime & PHP'} value={<BaseBadge base={site.base} compact />} onClick={() => onGoTo('runtime')} />
        <MiniStat
          icon={<Globe size={15} />}
          label={t('sites.tabs.domains') || 'Domains'}
          value={domains === null ? null : routed.length}
          sub={unverified ? (t('objectPage.toVerify') || 'to verify') : undefined}
          tone={unverified ? 'amber' : undefined}
          onClick={() => onGoTo('domains')}
        />
      </div>

      {creatingDb && (
        <DbInstanceCreateModal
          open
          accountId={site.accountId}
          onClose={() => setCreatingDb(false)}
          onCreated={(i) => { setCreatingDb(false); toast.success(t('databases.created', { name: i.name, defaultValue: 'Instance {{name}} created' })); loadInstances(); }}
        />
      )}
    </>
  );
}

// ── Staging ──────────────────────────────────────────────────────────────────

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [active]);
  return now;
}

const STAGING_LIST_MAX = 50;

function StagingCard({ site, onPublish, onStaging }: SiteTabProps & { onStaging?: (s: StagingStatus) => void }) {
  const { t, i18n } = useTranslation();
  const { can } = useHostingMe();
  const [staging, setStaging] = useState<StagingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** Set on a 501: the endpoint is not wired on this server, stop polling it. */
  const unavailable = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await releasesApi.staging(site.id);
      setStaging(next);
      onStaging?.(next);
      setError('');
    } catch (err) {
      if (isNotImplemented(err)) unavailable.current = true;
      setError(isNotImplemented(err) ? (t('sites.errors.notImplemented') || 'This feature is not available on this server yet.') : siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, t]); // eslint-disable-line react-hooks/exhaustive-deps -- onStaging is a state setter

  useEffect(() => { void load(); }, [load]);
  // SFTP uploads do not emit a socket event: poll while the tab is open.
  useEffect(() => {
    const h = window.setInterval(() => { if (document.visibilityState === 'visible' && !unavailable.current) void load(); }, 20_000);
    return () => window.clearInterval(h);
  }, [load]);
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RELEASE_UPDATED, (p) => { if (p.siteId === site.id) void load(); });

  // Feature B: preview of the staging (code.read + releases.publish; approval mode: + releases.approve).
  const { preview, reload: reloadPreview } = useSitePreview(site.id);
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreviewStaging = !!staging && staging.pendingChanges > 0 && can('code.read', site.accountId) && can('releases.publish', site.accountId)
    && (site.publishMode !== 'approval' || can('releases.approve', site.accountId));

  const deadline = staging?.autoPublishAt ? new Date(staging.autoPublishAt).getTime() : null;
  const now = useNow(deadline !== null);
  const remaining = deadline !== null ? Math.max(0, (deadline - now) / 1000) : null;

  return (
    <div className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <FolderUp className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('sites.staging.title') || 'Staging folder'}</h2>
        <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-3.5 w-3.5" />} size="sm" onClick={() => void load()} />
      </div>
      <p className="mb-3 font-mono text-xs text-text-muted break-all">/staging/{site.slug}/</p>

      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : error ? (
        <p className="text-sm text-text-muted">{error}</p>
      ) : staging && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="font-display text-3xl font-semibold tabular-nums text-text-primary">{staging.pendingChanges}</span>
            <span className="text-sm text-text-secondary">
              {t('sites.staging.pending', { count: staging.pendingChanges, defaultValue: 'pending change(s)' })}
            </span>
          </div>
          <div className="flex flex-col gap-1 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {t('sites.staging.lastUpload') || 'Last upload:'} <span className="font-mono">{formatDateTime(staging.lastUploadAt, i18n.language)}</span>
            </span>
            {remaining !== null && site.publishMode === 'auto' && (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <Timer className="h-3.5 w-3.5" />
                {t('sites.staging.autoPublishIn') || 'Automatic publication in'} <span className="font-mono tabular-nums">{formatCountdown(remaining)}</span>
              </span>
            )}
          </div>

          {stagingRestoreText(t, staging) && (
            <p className={`rounded-lg px-3 py-2 text-xs ${staging.restore?.status === 'failed' ? 'bg-red-400/10 text-red-400' : 'bg-bg-tertiary/60 text-text-secondary'}`}>
              {stagingRestoreText(t, staging)}
            </p>
          )}

          {staging.warnings.length > 0 && (
            <ul className="space-y-1">
              {stagingWarningTexts(t, staging).map((w) => (
                <li key={w} className="flex items-start gap-2 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">{w}</span>
                </li>
              ))}
            </ul>
          )}

          {staging.files.length > 0 && (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto overscroll-contain rounded-lg bg-bg-tertiary/50 p-2">
              {staging.files.slice(0, STAGING_LIST_MAX).map((f) => (
                <li key={`${f.status}:${f.path}`} className="flex min-w-0 items-center gap-2 text-xs">
                  <FileStatusIcon status={f.status} />
                  <span className="truncate font-mono text-text-secondary" title={f.path}>{f.path}</span>
                </li>
              ))}
              {(staging.truncated || staging.files.length > STAGING_LIST_MAX) && (
                <li className="pt-1 text-[11px] text-text-muted">{t('sites.staging.truncated') || 'List truncated.'}</li>
              )}
            </ul>
          )}

          {(staging.pendingChanges > 0 && can('releases.publish', site.accountId)) || canPreviewStaging ? (
            <div className="flex flex-wrap gap-2">
              {staging.pendingChanges > 0 && can('releases.publish', site.accountId) && (
                <Button size="sm" onClick={onPublish} className="w-full sm:w-auto">
                  <Rocket size={14} className="mr-1" />
                  {t('releases.publish.button') || 'Publish'}
                </Button>
              )}
              {canPreviewStaging && (
                <Button size="sm" variant="secondary" onClick={() => setPreviewOpen(true)} className="w-full sm:w-auto">
                  <Eye size={14} className="mr-1" />
                  {t('previews.startStaging') || 'Preview the staging'}
                </Button>
              )}
            </div>
          ) : null}
          {preview?.target === 'staging' && <PreviewCard site={site} preview={preview} onChanged={reloadPreview} compact />}
        </div>
      )}
      {previewOpen && (
        <StartPreviewModal
          site={site} release={null} current={preview}
          onClose={() => setPreviewOpen(false)}
          onStarted={() => { setPreviewOpen(false); void reloadPreview(); }}
        />
      )}
    </div>
  );
}

// ── Application detection ────────────────────────────────────────────────────

function DetectCard({ site, onSiteChange, onGoTo }: SiteTabProps & { onGoTo: GoTo }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const [detection, setDetection] = useState<ProfileDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [applying, setApplying] = useState(false);

  const detect = async () => {
    setDetecting(true);
    try {
      setDetection(await releasesApi.detectProfile(site.id));
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setDetecting(false);
    }
  };

  const applyProfile = async () => {
    if (!detection?.profile) return;
    setApplying(true);
    try {
      const paths = await sitesApi.applyProfile(site.id, detection.profile);
      if (site.appProfile !== detection.profile) onSiteChange(await sitesApi.update(site.id, { appProfile: detection.profile }));
      // applyProfile returns every data path of the site, not only the added ones.
      toast.success(t('sites.detect.applied', { count: paths.length, defaultValue: 'Profile applied ({{count}} data paths in total)' }));
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setApplying(false);
    }
  };

  const applyDocroot = async () => {
    if (detection?.suggestedDocroot == null) return;
    const docroot = detection.suggestedDocroot;
    try {
      const covering = findDocrootDataPath(docroot, (await sitesApi.dataPaths(site.id)).map((p) => p.path));
      if (covering !== null) {
        toast.error(t('sites.form.docrootInDataPath', { path: covering, defaultValue: 'The document root cannot be inside the data path {{path}}/.' }));
        return;
      }
      onSiteChange(await sitesApi.update(site.id, { docroot }));
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      toastSiteError(err, t);
    }
  };

  const profileLabel = (id: AppProfileId) => (id === 'static' ? (t('sites.profile.static') || 'Static site') : appProfileDef(id).label);

  return (
    <div className={cardCls}>
      <div className="mb-2 flex items-center gap-2">
        <ScanSearch className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('sites.detect.title') || 'Application detection'}</h2>
      </div>
      <p className="mb-3 text-xs text-text-muted">
        {t('sites.detect.explain') || 'Looks for well-known files in the staging folder to recognise the application and suggest its base and data paths.'}
      </p>
      <Button variant="secondary" size="sm" onClick={detect} loading={detecting}>
        <Wand2 size={14} className="mr-1" />
        {t('sites.detect.button') || 'Detect the application'}
      </Button>

      {detection && (
        <div className="mt-4 space-y-3 rounded-lg bg-bg-tertiary/60 p-3">
          {!detection.profile ? (
            <p className="text-sm text-text-secondary">{t('sites.detect.none') || 'No known application found in the staging folder.'}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text-secondary">{t('sites.detect.found') || 'Detected:'}</span>
                <Pill tone="accent">{profileLabel(detection.profile)}</Pill>
                {site.appProfile === detection.profile && <Pill tone="green"><Check className="h-3 w-3" />{t('sites.detect.current') || 'current profile'}</Pill>}
              </div>
              {detection.markers.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {detection.markers.map((m) => <code key={m} className="rounded bg-bg-primary/60 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">{m}</code>)}
                </div>
              )}

              {detection.suggestedDataPaths.length > 0 && (
                <div>
                  <div className={sectionLabelCls}>{t('sites.detect.dataPaths') || 'Suggested data paths'}</div>
                  <ul className="space-y-1">
                    {detection.suggestedDataPaths.map((d) => (
                      <li key={d.path} className="flex flex-wrap items-center gap-2 text-xs">
                        <code className="font-mono text-text-primary">{d.path}/</code>
                        <PolicyBadge policy={d.policy} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {canManage && (
                <div className="flex flex-col gap-2">
                  <Button size="sm" onClick={applyProfile} loading={applying}>
                    {t('sites.detect.apply') || 'Apply this profile (data paths)'}
                  </Button>
                  {detection.suggestedDocroot != null && detection.suggestedDocroot !== site.docroot && (
                    <Button size="sm" variant="secondary" onClick={() => void applyDocroot()}>
                      {t('sites.detect.useDocroot', { docroot: detection.suggestedDocroot || '/', defaultValue: 'Use the document root "{{docroot}}"' })}
                    </Button>
                  )}
                  {detection.suggestedBase && detection.suggestedBase !== site.base && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                      <span>{t('sites.detect.suggestedBase') || 'Recommended base:'}</span>
                      <BaseBadge base={detection.suggestedBase} compact />
                      <Button size="sm" variant="ghost" onClick={() => onGoTo('runtime', { switchTo: detection.suggestedBase! })}>
                        {t('sites.detect.switchBase') || 'Switch…'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Staging warnings, translated from their codes (server French text as a last resort). */
function stagingWarningTexts(t: TFunction, staging: StagingStatus): string[] {
  const items = staging.warningItems;
  if (!Array.isArray(items) || items.length === 0) return staging.warnings;
  return items.map((w, i) => {
    switch (w.code) {
      case 'stagingMissing': return t('sites.staging.warnings.stagingMissing') || 'The staging folder does not exist yet.';
      case 'nestedRepo': return t('sites.staging.warnings.nestedRepo', { path: w.path ?? '' }) || `Nested git repository (excluded from publications): ${w.path ?? ''}`;
      case 'symlink': return t('sites.staging.warnings.symlink', { path: w.path ?? '' }) || `Symbolic link: ${w.path ?? ''}`;
      case 'moreSymlinks': return t('sites.staging.warnings.moreSymlinks', { count: w.count ?? 0 }) || `… and ${w.count ?? 0} more symbolic link(s)`;
      case 'liveOlderThanBase': return t('sites.staging.warnings.liveOlderThanBase', { releaseNumber: w.releaseNumber ?? '?', baseNumber: w.baseNumber ?? '?' })
        || `Rollback: the live release #${w.releaseNumber ?? '?'} is older than #${w.baseNumber ?? '?'}, whose code the staging still holds. Publishing it as is would undo the rollback: copy the live release into the staging first.`;
      case 'baseNotPublished': return t('sites.staging.warnings.baseNotPublished', { baseNumber: w.baseNumber ?? '?', status: w.status ?? '' })
        || `The staging was last committed as release #${w.baseNumber ?? '?'}, which is not live (${w.status ?? ''}).`;
      case 'autoPublishHeld': return t('sites.staging.warnings.autoPublishHeld', { count: w.count ?? 0, releaseNumber: w.releaseNumber ?? '?' })
        || `Automatic publication held: the staging would put back online ${w.count ?? 0} file(s) of release #${w.releaseNumber ?? '?'}, undone by a rollback. Publish manually or copy the live release into the staging.`;
      default: return staging.warnings[i] ?? '';
    }
  }).filter(Boolean);
}

/** Copy of a release into the staging, running or finished (StagingStatus.restore). */
function stagingRestoreText(t: TFunction, staging: StagingStatus): string | null {
  const r = staging.restore;
  if (!r) return null;
  if (r.status === 'running') return t('sites.staging.restore.running', { number: r.releaseNumber }) || `Copying release #${r.releaseNumber} into the staging…`;
  if (r.status === 'failed') return t('sites.staging.restore.failed', { number: r.releaseNumber }) || `The copy of release #${r.releaseNumber} into the staging failed.`;
  const done = t('sites.staging.restore.done', { number: r.releaseNumber, remaining: r.result?.remaining ?? 0 })
    || `Release #${r.releaseNumber} copied into the staging (${r.result?.remaining ?? 0} path(s) still differing).`;
  const lost = r.result?.modeLostCount ?? 0;
  if (!lost) return done;
  const paths = (r.result?.modeLost ?? []).slice(0, 5).join(', ');
  return `${done} ${t('sites.staging.restore.modeLost', { count: lost, paths })
    || `${lost} file(s) were copied without their executable bit (${paths}…): make them executable again in the staging (chmod +x over SFTP) before publishing.`}`;
}
