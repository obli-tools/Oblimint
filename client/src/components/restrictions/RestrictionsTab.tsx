import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Lock } from 'lucide-react';
import type { RestrictableActionDef, RestrictionFloor, RestrictionLevel, RestrictionMap, RestrictionVia, RestrictionsView } from '@oblimint/shared';
import { RESTRICTION_LEVELS, RESTRICTION_VIAS } from '@oblimint/shared';
import { restrictionsApi } from '@/api/restrictions.api';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { actionLabel } from '@/components/approvals/approvalsUi';
import { RestrictionScopeModal } from './RestrictionScopeModal';
import {
  belowFloor, changedKeys, floorOf, groupByCategory, levelOf, scopeCount, scopeIsEmpty, viaChoosable,
  withFloor, withLevel, withScope, withVia,
} from './restrictionsLogic';

// Matrix of the sensitive actions of the workspace (spec §6.1, Obliance
// AdminUsersPage RestrictionsTab): per action None / 2FA (sensitive) /
// Approval (restricted), the surface (all / keys and agents / panel) and the
// scope (accounts / sites). The platform floor is shown, locked: a level
// below it cannot be chosen. A platform admin on the master workspace also
// edits the floor itself (second view). Saving is the action
// restrictions.manage: a code may be asked, or the change filed for approval.

type View = 'matrix' | 'floor';

const LEVEL_FALLBACK: Record<RestrictionLevel, string> = { none: 'None', sensitive: '2FA', restricted: 'Approval' };
const VIA_FALLBACK: Record<RestrictionVia, string> = { all: 'Everywhere', keys: 'Keys and agents', panel: 'Panel' };
const CATEGORY_FALLBACK: Record<string, string> = {
  sites: 'Sites and accounts', releases: 'Releases, windows and backups', files: 'Files', databases: 'Databases',
  domains: 'Domains, DNS, proxy and firewall', mail: 'Mail', cron: 'Cron jobs and previews', keys: 'Access keys and connectors',
  tenant: 'Workspace and users', platform: 'Platform',
};

function levelBtnCls(lv: RestrictionLevel, active: boolean): string {
  const base = 'px-2.5 py-1 coarse:py-2 text-[11px] font-medium rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
  if (active) {
    return `${base} ${lv === 'restricted' ? 'bg-red-400/10 border-red-400 text-red-400'
      : lv === 'sensitive' ? 'bg-orange-400/10 border-orange-400 text-orange-400'
        : 'bg-bg-tertiary border-transparent text-text-primary'}`;
  }
  const color = lv === 'none' ? 'border-transparent text-text-muted'
    : lv === 'restricted' ? 'border-red-400/40 text-red-400' : 'border-orange-400/40 text-orange-400';
  return `${base} ${color} hover:border-accent/50`;
}

export function RestrictionsTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<RestrictionsView | null>(null);
  const [map, setMap] = useState<RestrictionMap>({});
  const [floor, setFloor] = useState<RestrictionFloor>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<View>('matrix');
  const [scopeFor, setScopeFor] = useState<RestrictableActionDef | null>(null);

  const apply = (v: RestrictionsView) => { setData(v); setMap(v.map); setFloor(v.floor); };

  const load = async () => {
    setLoadError(null);
    try {
      apply(await restrictionsApi.get());
    } catch (err) {
      setLoadError(apiErrorMessage(err, t('restrictions.loadFailed') || 'Failed to load the restrictions'));
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) {
    return (
      <div className="p-4 rounded-lg border border-red-400/30 bg-red-400/5">
        <p className="text-sm text-red-400 font-medium">{t('restrictions.loadFailed') || 'Failed to load the restrictions'}</p>
        <p className="text-xs text-text-muted mt-1">{loadError}</p>
      </div>
    );
  }
  if (!data) return <div className="flex justify-center py-10"><LoadingSpinner /></div>;

  const mapChanges = changedKeys(data.map, map);
  const floorChanges = [...new Set([...Object.keys(data.floor), ...Object.keys(floor)])].filter((k) => data.floor[k] !== floor[k]);
  const dirty = view === 'matrix' ? mapChanges.length > 0 : floorChanges.length > 0;
  const groups = groupByCategory(data.actions);
  const withoutTotp = data.stats.withoutTotp;

  const save = async () => {
    setSaving(true);
    try {
      const next = view === 'matrix' ? await restrictionsApi.setMap(map) : await restrictionsApi.setFloor(floor);
      apply(next);
      toast.success(t('restrictions.saved') || 'Restrictions saved');
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('restrictions.saveFailed') || 'Failed to save the restrictions'));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => { setMap(data.map); setFloor(data.floor); };

  return (
    <div className="space-y-4">
      {(withoutTotp.staff > 0 || withoutTotp.clients > 0) && (
        <div className="flex items-start gap-2 rounded-lg border border-orange-400/30 bg-orange-400/5 p-3 text-xs text-orange-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {t('restrictions.withoutTotp', {
              staff: withoutTotp.staff, clients: withoutTotp.clients,
              defaultValue: '{{staff}} staff member(s) and {{clients}} client login(s) concerned have no two-factor authentication: the actions marked 2FA are refused to them (they are invited to enable it), and they cannot approve.',
            })}
          </span>
        </div>
      )}

      <div className="rounded-lg bg-bg-secondary p-3 text-[11px] text-text-muted space-y-1">
        <p>
          <strong className="text-text-primary">{t('restrictions.level.none') || 'None'}</strong>{' '}
          {t('restrictions.legend.none') || '= no extra check.'}{' '}
          <strong className="text-orange-400">{t('restrictions.level.sensitive') || '2FA'}</strong>{' '}
          {t('restrictions.legend.sensitive') || '= a fresh 2FA code of the acting user (through an access key or an agent: his confirmation in Approvals). Without 2FA the action is refused.'}{' '}
          <strong className="text-red-400">{t('restrictions.level.restricted') || 'Approval'}</strong>{' '}
          {t('restrictions.legend.restricted') || '= a second authorised person approves it in Approvals, with his own code (strongest).'}
        </p>
        <p>
          {t('restrictions.legend.via') || 'Surface: everywhere, only through the access keys and agents (REST, MCP, Claude connectors), or only in the panel. Scope: every account, or only / all except some accounts and sites.'}
        </p>
        {Object.keys(data.floor).length > 0 && (
          <p className="inline-flex items-center gap-1">
            <Lock className="w-3 h-3" />
            {t('restrictions.legend.floor') || 'Platform floor: set by the platform administrators, no level below it can be chosen.'}
          </p>
        )}
      </div>

      {data.canEditPlatform && (
        <SegmentedTabs<View>
          size="sm"
          fill={false}
          tabs={[
            { id: 'matrix', label: t('restrictions.view.matrix') || 'Workspace matrix' },
            { id: 'floor', label: t('restrictions.view.floor') || 'Platform floor (every workspace)' },
          ]}
          value={view}
          onChange={(v) => { reset(); setView(v); }}
        />
      )}
      {view === 'floor' && (
        <p className="text-[11px] text-text-muted">
          {t('restrictions.floorHint') || 'Minimal level of each action in every workspace, whatever its own matrix (no reseller can lower it). Applies everywhere, every surface, every account.'}
        </p>
      )}

      {groups.map(([cat, acts]) => (
        <div key={cat} className="rounded-lg bg-bg-secondary overflow-hidden">
          <div className="px-3 py-2 bg-bg-tertiary/50">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">{t(`restrictions.categories.${cat}`) || CATEGORY_FALLBACK[cat] || cat}</span>
          </div>
          <div className="divide-y divide-border/40">
            {acts.map((a) => {
              const label = actionLabel(t, a.key);
              const entry = map[a.key];
              const fl = floorOf(data.floor, a.key);
              const level = view === 'floor' ? floorOf(floor, a.key) : levelOf(map, a.key);
              const choose = (lv: RestrictionLevel) => {
                if (view === 'floor') setFloor((f) => withFloor(f, a.key, lv));
                else setMap((m) => withLevel(m, a.key, lv));
              };
              return (
                <div key={a.key} className="flex flex-wrap md:flex-nowrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <div className="flex-1 min-w-0 max-md:basis-full">
                    <p className="text-sm text-text-primary md:truncate">{label}</p>
                    <p className="text-[10px] text-text-muted font-mono">
                      {a.key}
                      <span className="ml-2 font-sans">
                        {a.surfaces.map((s) => (s === 'panel' ? (t('restrictions.surface.panel') || 'panel') : (t('restrictions.surface.keys') || 'keys'))).join(' · ')}
                      </span>
                    </p>
                  </div>

                  {view === 'matrix' && fl !== 'none' && (
                    <span
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted"
                      title={t('restrictions.floorTitle') || 'Platform floor: set by the platform administrators'}
                    >
                      <Lock className="w-3 h-3" />
                      {t('restrictions.floorBadge', { level: t(`restrictions.level.${fl}`) || LEVEL_FALLBACK[fl], defaultValue: 'floor: {{level}}' })}
                    </span>
                  )}

                  <div className="flex items-center gap-1 shrink-0" role="radiogroup" aria-label={label}>
                    {RESTRICTION_LEVELS.map((lv) => {
                      const locked = view === 'matrix' && belowFloor(lv, fl);
                      // Below the floor the floor's own level reads as the active one.
                      const active = view === 'matrix' && belowFloor(level, fl) ? lv === fl : level === lv;
                      return (
                        <button
                          key={lv}
                          role="radio"
                          aria-checked={active}
                          disabled={locked}
                          onClick={() => choose(lv)}
                          title={locked ? (t('restrictions.lockedByFloor') || 'Below the platform floor') : undefined}
                          className={levelBtnCls(lv, active)}
                        >
                          {t(`restrictions.level.${lv}`) || LEVEL_FALLBACK[lv]}
                        </button>
                      );
                    })}
                  </div>

                  {view === 'matrix' && (
                    <>
                      <select
                        value={entry?.via ?? 'all'}
                        disabled={!entry || !viaChoosable(a)}
                        onChange={(e) => setMap((m) => withVia(m, a.key, e.target.value as RestrictionVia))}
                        aria-label={t('restrictions.viaLabel') || 'Surface'}
                        className="shrink-0 rounded bg-bg-tertiary px-2 py-1 coarse:py-2 text-[11px] text-text-primary disabled:opacity-30 focus:outline-none focus:ring-1 focus:ring-accent"
                      >
                        {RESTRICTION_VIAS.map((v) => <option key={v} value={v}>{t(`restrictions.via.${v}`) || VIA_FALLBACK[v]}</option>)}
                      </select>
                      {a.scopable !== 'none' ? (
                        <button
                          disabled={!entry}
                          onClick={() => setScopeFor(a)}
                          className={`shrink-0 px-2 py-1 coarse:py-2 text-[10px] rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                            entry && entry.scope.mode !== 'all'
                              ? (scopeIsEmpty(entry.scope) ? 'border-orange-400 text-orange-400 bg-orange-400/10' : 'border-accent text-accent bg-accent/10')
                              : 'border-transparent text-text-muted hover:border-accent/40'
                          }`}
                          title={t('restrictions.scope.hint') || 'Accounts and sites this restriction applies to'}
                        >
                          {entry?.scope.mode === 'include'
                            ? t('restrictions.scope.btnInclude', { count: scopeCount(entry.scope), defaultValue: 'Scope: only {{count}}' })
                            : entry?.scope.mode === 'exclude'
                              ? t('restrictions.scope.btnExclude', { count: scopeCount(entry.scope), defaultValue: 'Scope: all but {{count}}' })
                              : (t('restrictions.scope.btnAll') || 'Scope: all')}
                        </button>
                      ) : (
                        <span className="shrink-0 w-[5.5rem] max-md:hidden" aria-hidden />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="sticky bottom-0 flex items-center justify-end gap-2 bg-bg-primary/90 py-2 backdrop-blur">
        {dirty && (
          <span className="text-xs text-orange-400">
            {t('restrictions.unsaved', { count: view === 'matrix' ? mapChanges.length : floorChanges.length, defaultValue: '{{count}} unsaved change(s)' })}
          </span>
        )}
        <button
          onClick={reset}
          disabled={!dirty || saving}
          className="px-3 py-1.5 coarse:py-2.5 text-xs rounded text-text-muted hover:text-text-primary disabled:opacity-30"
        >
          {t('restrictions.reset') || 'Reset'}
        </button>
        <button
          onClick={() => { void save(); }}
          disabled={!dirty || saving}
          className="px-3 py-1.5 coarse:py-2.5 text-xs bg-accent text-white rounded hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? (t('restrictions.saving') || 'Saving…') : (t('common.save') || 'Save')}
        </button>
      </div>

      {scopeFor && map[scopeFor.key] && (
        <RestrictionScopeModal
          def={scopeFor}
          label={actionLabel(t, scopeFor.key)}
          scope={map[scopeFor.key].scope}
          onClose={() => setScopeFor(null)}
          onSave={(scope) => { setMap((m) => withScope(m, scopeFor, scope)); setScopeFor(null); }}
        />
      )}
    </div>
  );
}
