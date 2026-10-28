import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRightLeft, Check, Eye, Layers, Loader2, Plus, RefreshCw, RotateCw, Square, Trash2, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  HostingSocketEvents, SITE_BASES, isSiteBaseId, phpAdvisoriesUnfixedOnBranch, siteBaseDef,
  type ContainerState, type HostingChangedPayload, type RuntimeRole, type RuntimeSwitchCheck, type RuntimeWarningCode, type SiteBaseId, type SiteRuntime,
  type SiteRuntimeStatus,
} from '@oblimint/shared';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { accountsApi } from '@/api/accounts.api';
import { runtimeApi } from '@/api/runtime.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { siteHref } from '@/utils/links';
import { BasePicker } from '../BasePicker';
import { isBaseAllowed } from '../allowedBases';
import { BaseBadge, PhpVersionBadge, Pill, useBaseLabel, type Tone } from '../SiteBadges';
import { formatDateTime } from '../siteForm';
import { isNotImplemented, siteErrorMessage, toastSiteError } from '../siteErrors';
import { useHostingEvent } from '../useHostingEvent';
import { cardCls, fieldCls, sectionLabelCls } from '../styles';
import type { SiteTabProps } from './types';
import { PreviewCard, useSitePreview } from '../previews/PreviewCard';

/**
 * Bases the plan of the site's account allows (null = the whole catalog, or
 * not known yet: the server stays the authority with 409 baseNotAllowed).
 * Refetched when the account (plan change) or a plan is updated.
 */
function usePlanAllowedBases(accountId: number): SiteBaseId[] | null {
  const [allowed, setAllowed] = useState<SiteBaseId[] | null>(null);
  const load = useCallback(async () => {
    try {
      setAllowed((await accountsApi.get(accountId)).allowedBases ?? null);
    } catch {
      setAllowed(null);
    }
  }, [accountId]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvent<HostingChangedPayload>(HostingSocketEvents.HOSTING_CHANGED, (p) => {
    if (p?.entity === 'plan' || (p?.entity === 'account' && p.id === accountId)) void load();
  });
  return allowed;
}

const STATE_TONE: Record<ContainerState, Tone> = {
  running: 'green', stopped: 'muted', missing: 'amber', restarting: 'blue', error: 'red', unknown: 'muted',
};

export function SiteRuntimeTab({ site, reloadSite, switchTo, onSwitchHandled }: SiteTabProps & {
  /** Base proposed by another tab (?switchTo=<base>): opens the switch flow once. */
  switchTo: string | null;
  onSwitchHandled: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const allowedBases = usePlanAllowedBases(site.accountId);
  const { preview: releasePreview, reload: reloadReleasePreview } = useSitePreview(site.id);

  const [status, setStatus] = useState<SiteRuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [loading, setLoading] = useState(true);
  const [switchBase, setSwitchBase] = useState<SiteBaseId | null>(null);
  const [busy, setBusy] = useState<'restart' | 'promote' | 'stopPreview' | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await runtimeApi.status(site.id));
      setStatusError('');
    } catch (err) {
      setStatusError(isNotImplemented(err) ? (t('sites.errors.notImplemented') || 'This feature is not available on this server yet.') : siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, t]);

  useEffect(() => { void load(); }, [load, site.base, site.previewBase]);
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RUNTIME_UPDATED, (p) => { if (p.siteId === site.id) void load(); });

  useEffect(() => {
    if (!switchTo) return;
    if (isSiteBaseId(switchTo) && switchTo !== site.base && canManage) setSwitchBase(switchTo);
    onSwitchHandled();
  }, [switchTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (kind: 'restart' | 'promote' | 'stopPreview') => {
    if (kind === 'promote' && !(await confirm({
      title: t('runtime.preview.promote') || 'Promote',
      message: t('runtime.preview.promoteConfirm', { base: site.previewBase ?? '', defaultValue: 'Make {{base}} the base of the site? Production traffic switches to it and the old container is removed.' }),
      confirmLabel: t('runtime.preview.promote') || 'Promote',
    }))) return;
    if (kind === 'restart' && !(await confirm({
      message: t('runtime.restartConfirm') || 'Restart the containers of the site? Visitors may get errors for a few seconds.',
      confirmLabel: t('runtime.restart') || 'Restart',
    }))) return;
    setBusy(kind);
    try {
      const next = kind === 'restart' ? await runtimeApi.restart(site.id)
        : kind === 'promote' ? await runtimeApi.promotePreview(site.id)
          : await runtimeApi.stopPreview(site.id);
      setStatus(next);
      toast.success({
        restart: t('runtime.restarted') || 'Containers restarted',
        promote: t('runtime.preview.promoted') || 'Preview promoted to production',
        stopPreview: t('runtime.preview.stopped') || 'Preview stopped',
      }[kind]);
      await reloadSite();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(null);
    }
  };

  const previewBase = status?.previewBase ?? site.previewBase;
  const previewUrl = status?.previewUrl ?? site.previewUrl;

  return (
    <div className="space-y-4">
      {/* Current runtime + containers */}
      <div className={cardCls}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-text-primary">{t('runtime.current') || 'Current base'}</h2>
          <BaseBadge base={site.base} />
          <div className="ml-auto flex items-center gap-1">
            <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-3.5 w-3.5" />} size="sm" onClick={() => void load()} />
            {canManage && (
              <Button size="sm" variant="secondary" onClick={() => void run('restart')} loading={busy === 'restart'}>
                <RotateCw size={14} className="mr-1" />{t('runtime.restart') || 'Restart'}
              </Button>
            )}
          </div>
        </div>
        {loading ? (
          <div className="flex justify-center py-8"><LoadingSpinner /></div>
        ) : statusError ? (
          <p className="text-sm text-text-muted">{statusError}</p>
        ) : status && status.containers.length === 0 ? (
          <p className="text-sm text-text-muted">{t('runtime.noContainer') || 'No container yet (the site is being provisioned or is stopped).'}</p>
        ) : status && <ContainersTable status={status} />}
      </div>

      {/* Blue/green preview */}
      {previewBase && (
        <div className="rounded-xl border border-blue-400/30 bg-blue-500/5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Eye className="h-4 w-4 text-blue-400" />
            <h2 className="text-sm font-semibold text-text-primary">{t('runtime.preview.title') || 'Preview (blue/green)'}</h2>
            <BaseBadge base={previewBase} />
          </div>
          <p className="mt-2 text-xs text-text-muted">
            {t('runtime.preview.explain') || 'The candidate base serves the SAME current release on a private URL. Production is untouched until you promote it.'}
          </p>
          {previewUrl && (
            <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 break-all font-mono text-sm text-blue-400 hover:underline">
              {previewUrl}<ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          )}
          {canManage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void run('promote')} loading={busy === 'promote'} disabled={busy !== null}>
                <Check size={14} className="mr-1" />{t('runtime.preview.promote') || 'Promote'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void run('stopPreview')} loading={busy === 'stopPreview'} disabled={busy !== null}>
                <Square size={14} className="mr-1" />{t('runtime.preview.stop') || 'Stop the preview'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Feature B: live preview of a release / of the staging (started from the Releases tab or the staging card). */}
      <PreviewCard site={site} preview={releasePreview} onChanged={reloadReleasePreview} />

      {/* Base catalog */}
      <div className={cardCls}>
        <div className="mb-1 flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">{t('runtime.catalog.title') || 'Change base'}</h2>
        </div>
        <p className="mb-4 text-xs text-text-muted">
          {t('runtime.catalog.explain') || 'The code does not change: the same release is served by another engine or PHP version. Pick a base to see the checks before switching.'}
        </p>
        <BasePicker
          value={null}
          readOnly={!canManage}
          isDisabled={(b) => b === site.base || !isBaseAllowed(allowedBases, b)}
          onSelect={(b) => setSwitchBase(b)}
          markers={(b) => (
            <>
              {b === site.base && <Pill tone="green" className="text-[10px]">{t('runtime.catalog.current') || 'current'}</Pill>}
              {b === previewBase && <Pill tone="blue" className="text-[10px]">{t('runtime.catalog.preview') || 'preview'}</Pill>}
              {b !== site.base && !isBaseAllowed(allowedBases, b) && <Pill tone="muted" className="text-[10px]">{t('runtime.notInPlan') || 'not in plan'}</Pill>}
            </>
          )}
        />
      </div>

      <SecondaryRuntimes site={site} canManage={canManage} allowedBases={allowedBases} />

      {switchBase && (
        <SwitchModal
          siteId={site.id}
          from={site.base}
          to={switchBase}
          previewRunning={!!previewBase}
          onClose={() => setSwitchBase(null)}
          onDone={async (next) => {
            setSwitchBase(null);
            setStatus(next);
            await reloadSite();
          }}
        />
      )}
    </div>
  );
}

type RuntimeContainer = SiteRuntimeStatus['containers'][number];

function ContainersTable({ status }: { status: SiteRuntimeStatus }) {
  const { t, i18n } = useTranslation();
  const roleLabel = (r: RuntimeRole) => ({
    primary: t('runtime.roles.primary') || 'primary',
    secondary: t('runtime.roles.secondary') || 'secondary',
    preview: t('runtime.roles.preview') || 'preview',
  })[r];
  const stateLabel = (s: ContainerState) => ({
    running: t('runtime.states.running') || 'running',
    stopped: t('runtime.states.stopped') || 'stopped',
    missing: t('runtime.states.missing') || 'missing',
    restarting: t('runtime.states.restarting') || 'restarting',
    error: t('runtime.states.error') || 'error',
    unknown: t('runtime.states.unknown') || 'unknown',
  })[s];
  return (
    <GroupedTable<RuntimeContainer>
      storageKey="site-runtime"
      singleGroupFlat
      className="bg-bg-tertiary/40"
      minWidth={820}
      groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(status.containers, (c) => c.name) }]}
      columns={[
        {
          id: 'role', header: t('runtime.fields.role') || 'Role', sort: (c) => c.role,
          cell: (c) => <Pill tone={c.role === 'preview' ? 'blue' : c.role === 'secondary' ? 'muted' : 'accent'} className="text-[10px] uppercase">{roleLabel(c.role)}</Pill>,
        },
        { id: 'container', header: t('runtime.fields.container') || 'Container', tdClassName: 'font-mono text-xs text-text-secondary', sort: (c) => c.name, cell: (c) => c.name },
        { id: 'base', header: t('runtime.fields.base') || 'Base', sort: (c) => c.base, cell: (c) => <BaseBadge base={c.base} compact /> },
        { id: 'php', header: t('runtime.fields.php') || 'PHP', sort: (c) => c.phpVersion ?? '', cell: (c) => (c.phpVersion ? <PhpVersionBadge version={c.phpVersion} /> : <span className="text-text-muted">—</span>) },
        { id: 'state', header: t('runtime.fields.state') || 'State', sort: (c) => c.state, cell: (c) => <Pill tone={STATE_TONE[c.state]}>{stateLabel(c.state)}</Pill> },
        { id: 'started', header: t('runtime.fields.startedAt') || 'Started', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-muted', sort: (c) => c.startedAt ?? '', cell: (c) => formatDateTime(c.startedAt, i18n.language) },
        {
          id: 'health', header: t('runtime.fields.health') || 'Health', tdClassName: 'text-xs', sort: (c) => c.health ?? '',
          cell: (c) => (c.health ? <span className={c.health === 'healthy' ? 'text-status-up' : c.health === 'unhealthy' ? 'text-red-400' : 'text-text-secondary'}>{c.health}</span> : <span className="text-text-muted">—</span>),
        },
        {
          id: 'limits', header: t('runtime.fields.limits') || 'Limits', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-muted', sort: (c) => c.memoryLimitMb ?? null,
          cell: (c) => <>{c.memoryLimitMb != null ? `${c.memoryLimitMb} MB` : '∞'} · {c.cpuLimit != null ? `${c.cpuLimit} CPU` : '∞'}</>,
        },
      ]}
    />
  );
}

// ── Switch flow ──────────────────────────────────────────────────────────────

function SwitchModal({ siteId, from, to, previewRunning, onClose, onDone }: {
  siteId: number;
  from: SiteBaseId;
  to: SiteBaseId;
  previewRunning: boolean;
  onClose: () => void;
  onDone: (status: SiteRuntimeStatus) => Promise<void>;
}) {
  const { t } = useTranslation();
  const baseLabel = useBaseLabel();
  const [check, setCheck] = useState<RuntimeSwitchCheck | null>(null);
  const [checkError, setCheckError] = useState('');
  const [busy, setBusy] = useState<'direct' | 'preview' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    runtimeApi.check(siteId, to)
      .then((c) => { if (!cancelled) setCheck(c); })
      .catch((err) => { if (!cancelled) setCheckError(siteErrorMessage(err, t)); });
    return () => { cancelled = true; };
  }, [siteId, to, t]);

  const warningText = (code: RuntimeWarningCode, fallback: string) => ({
    htaccessIgnored: t('runtime.warnings.htaccessIgnored') || fallback,
    unmaintainedRuntime: t('runtime.warnings.unmaintainedRuntime') || fallback,
    vulnerableRuntime: t('runtime.warnings.vulnerableRuntime') || fallback,
    phpDowngrade: t('runtime.warnings.phpDowngrade') || fallback,
    phpMajorChange: t('runtime.warnings.phpMajorChange') || fallback,
    staticBaseWithPhp: t('runtime.warnings.staticBaseWithPhp') || fallback,
    imageMissing: t('runtime.warnings.imageMissing') || fallback,
  })[code] ?? fallback;

  const go = async (mode: 'direct' | 'preview') => {
    setBusy(mode);
    setError('');
    try {
      const status = await runtimeApi.switchBase(siteId, { base: to, mode });
      toast.success(mode === 'direct'
        ? t('runtime.switch.done', { base: baseLabel(to), defaultValue: 'The site now runs on {{base}}' })
        : t('runtime.switch.previewStarted', { base: baseLabel(to), defaultValue: 'Preview on {{base}} started' }));
      await onDone(status);
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setBusy(null);
    }
  };

  const toDef = siteBaseDef(to);

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      size="lg"
      title={t('runtime.switch.title') || 'Change base'}
      icon={<ArrowRightLeft className="h-4 w-4 text-accent" />}
      dismissible={!busy}
      footer={
        <>
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={!!busy}>{t('common.cancel') || 'Cancel'}</Button>
          <Button variant="secondary" size="sm" onClick={() => void go('preview')} loading={busy === 'preview'} disabled={!check || !!busy}>
            <Eye size={14} className="mr-1" />{t('runtime.switch.preview') || 'Preview (blue/green)'}
          </Button>
          <Button size="sm" onClick={() => void go('direct')} loading={busy === 'direct'} disabled={!check || !!busy}>
            <ArrowRightLeft size={14} className="mr-1" />{t('runtime.switch.direct') || 'Switch now'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <BaseBadge base={from} />
          <ArrowRightLeft className="h-4 w-4 text-text-muted" />
          <BaseBadge base={to} />
          {toDef.htaccess && <Pill tone="muted" className="text-[10px]">.htaccess</Pill>}
        </div>

        {!check && !checkError ? (
          <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t('runtime.switch.checking') || 'Checking compatibility…'}</p>
        ) : checkError ? (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{checkError}</p>
        ) : check && check.warnings.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg bg-status-up/10 px-3 py-2 text-sm text-status-up">
            <Check className="h-4 w-4" />{t('runtime.switch.noWarning') || 'No compatibility warning.'}
          </p>
        ) : check && (
          <ul className="space-y-1.5">
            {check.warnings.map((w) => (
              <li key={w.code} className="flex items-start gap-2 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{warningText(w.code, w.message)}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 text-xs text-text-muted sm:grid-cols-2">
          <div className="rounded-lg bg-bg-tertiary/60 p-3">
            <div className="mb-1 font-semibold text-text-secondary">{t('runtime.switch.direct') || 'Switch now'}</div>
            {t('runtime.switch.directHint') || 'The production container is recreated on the new base: a short interruption, then the health check.'}
          </div>
          <div className="rounded-lg bg-bg-tertiary/60 p-3">
            <div className="mb-1 font-semibold text-text-secondary">{t('runtime.switch.preview') || 'Preview (blue/green)'}</div>
            {t('runtime.switch.previewHint') || 'Starts the new base next to production on a private preview URL; promote it once checked.'}
            {previewRunning && <div className="mt-1 text-amber-400">{t('runtime.switch.replacesPreview') || 'Replaces the running preview.'}</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Secondary runtimes ───────────────────────────────────────────────────────

function SecondaryRuntimes({ site, canManage, allowedBases }: { site: SiteTabProps['site']; canManage: boolean; allowedBases: SiteBaseId[] | null }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const baseLabel = useBaseLabel();
  const [runtimes, setRuntimes] = useState<SiteRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newBase, setNewBase] = useState<SiteBaseId | ''>('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setRuntimes(await sitesApi.runtimes(site.id));
      setError('');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, t]);

  useEffect(() => { void load(); }, [load]);
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RUNTIME_UPDATED, (p) => { if (p.siteId === site.id) void load(); });

  const add = async () => {
    if (!newBase) return;
    setAdding(true);
    try {
      await sitesApi.addRuntime(site.id, { base: newBase });
      toast.success(t('runtime.secondary.added') || 'Secondary runtime added');
      setNewBase('');
      await load();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (rt: SiteRuntime) => {
    if (!(await confirm({
      message: t('runtime.secondary.deleteConfirm', { base: baseLabel(rt.base), defaultValue: 'Remove the secondary runtime {{base}}?' }),
      danger: true,
    }))) return;
    try {
      await sitesApi.deleteRuntime(site.id, rt.id);
      toast.success(t('runtime.secondary.deleted') || 'Secondary runtime removed');
      await load();
    } catch (err) {
      toastSiteError(err, t);
    }
  };

  return (
    <div className={cardCls}>
      <div className="mb-1 flex items-center gap-2">
        <Layers className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">{t('runtime.secondary.title') || 'Secondary runtimes'}</h2>
      </div>
      <p className="mb-4 text-xs text-text-muted">
        {t('runtime.secondary.explain') || 'A secondary runtime serves a path prefix of the SAME release with another engine (e.g. /legacy/ on PHP 7.4). Attach it to a prefix in the Routes tab or on the Domains page.'}{' '}
        <Link to={siteHref(site.id, 'routes')} className="text-accent hover:underline">{t('sites.tabs.routes') || 'Routes & domains'}</Link>
      </p>

      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : error ? (
        <p className="text-sm text-text-muted">{error}</p>
      ) : runtimes.length === 0 ? (
        <p className="text-sm text-text-muted">{t('runtime.secondary.none') || 'No secondary runtime.'}</p>
      ) : (
        <ul className="space-y-2">
          {runtimes.map((rt) => (
            <li key={rt.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-bg-tertiary/50 px-3 py-2">
              <BaseBadge base={rt.base} compact />
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {rt.routes.length === 0 ? (
                  <span className="text-xs text-text-muted">{t('runtime.secondary.noRoute') || 'no route yet'}</span>
                ) : rt.routes.map((r) => (
                  <code key={r.routeId} className="rounded bg-bg-primary/60 px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">{r.domainName}{r.pathPrefix}</code>
                ))}
              </div>
              {canManage && (
                <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-3.5 w-3.5" />} variant="danger" size="sm" onClick={() => void remove(rt)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <select value={newBase} onChange={(e) => setNewBase(e.target.value as SiteBaseId | '')} className={`${fieldCls} sm:w-64`} aria-label={t('runtime.fields.base') || 'Base'}>
            <option value="">{t('runtime.secondary.pickBase') || 'Choose a base…'}</option>
            {SITE_BASES.filter((b) => b.id !== site.base).map((b) => (
              <option key={b.id} value={b.id} disabled={!isBaseAllowed(allowedBases, b.id)}>{baseLabel(b.id)}{b.php && phpAdvisoriesUnfixedOnBranch(b.php).length ? ` — /!\\ ${t('runtime.vulnerableShort') || 'Vulnerable'}` : b.unmaintained ? ` — ${t('runtime.unmaintained') || 'Unmaintained runtime'}` : ''}{isBaseAllowed(allowedBases, b.id) ? '' : ` (${t('runtime.notInPlan') || 'not in plan'})`}</option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={() => void add()} loading={adding} disabled={!newBase || !isBaseAllowed(allowedBases, newBase)}>
            <Plus size={14} className="mr-1" />{t('runtime.secondary.add') || 'Add'}
          </Button>
        </div>
      )}
      <div className={`${sectionLabelCls} mt-4 mb-0 normal-case tracking-normal`}>
        {t('runtime.secondary.note') || 'The longest matching prefix wins; the primary runtime serves everything else.'}
      </div>
    </div>
  );
}
