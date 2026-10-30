import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield } from 'lucide-react';
import type { HostingAccount, RestrictableActionDef, RestrictionScope, RestrictionScopeMode, Site } from '@oblimint/shared';
import { Modal } from '@/components/common/Modal';
import { accountsApi } from '@/api/accounts.api';
import { sitesApi } from '@/api/sites.api';
import { useTenantStore } from '@/store/tenantStore';
import { cleanScope } from './restrictionsLogic';

// Scope of one restriction (Obliance RestrictionScopeModal): every account
// (default), only some accounts / sites, or all except them. Accounts and
// sites of the current workspace only (the server drops any other id).

const CAP = 200;

export function RestrictionScopeModal({ def, label, scope, onClose, onSave }: {
  def: RestrictableActionDef;
  label: string;
  scope: RestrictionScope;
  onClose: () => void;
  onSave: (scope: RestrictionScope) => void;
}) {
  const { t } = useTranslation();
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const [mode, setMode] = useState<RestrictionScopeMode>(scope.mode);
  const [accountIds, setAccountIds] = useState<number[]>(scope.accountIds ?? []);
  const [siteIds, setSiteIds] = useState<number[]>(scope.siteIds ?? []);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [query, setQuery] = useState('');
  const withSites = def.scopable === 'site';

  useEffect(() => {
    accountsApi.list(tenantId ? { tenantId } : {})
      .then((r) => setAccounts(r.filter((a) => !tenantId || a.tenantId === tenantId)))
      .catch(() => {});
    if (withSites) {
      sitesApi.list()
        .then((r) => setSites(r.filter((s) => !tenantId || s.tenantId === tenantId)))
        .catch(() => {});
    }
  }, [tenantId, withSites]);

  const q = query.trim().toLowerCase();
  const shownAccounts = useMemo(() => {
    const list = q ? accounts.filter((a) => `${a.username} ${a.displayName ?? ''}`.toLowerCase().includes(q)) : accounts;
    return [...list.filter((a) => accountIds.includes(a.id)), ...list.filter((a) => !accountIds.includes(a.id))].slice(0, CAP);
  }, [accounts, accountIds, q]);
  const shownSites = useMemo(() => {
    const list = q ? sites.filter((s) => `${s.name} ${s.slug} ${s.accountUsername}`.toLowerCase().includes(q)) : sites;
    return [...list.filter((s) => siteIds.includes(s.id)), ...list.filter((s) => !siteIds.includes(s.id))].slice(0, CAP);
  }, [sites, siteIds, q]);

  const toggle = (arr: number[], id: number): number[] => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  const chip = (on: boolean) => `px-2 py-0.5 coarse:px-3 coarse:py-2 text-[11px] rounded border ${
    on ? 'bg-accent/20 border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
  }`;
  const nothingPicked = mode !== 'all' && accountIds.length === 0 && (!withSites || siteIds.length === 0);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<Shield className="w-4 h-4 text-accent" />}
      title={t('restrictions.scope.title', { action: label, defaultValue: 'Scope — {{action}}' })}
      bodyClassName="px-4 py-3 space-y-3"
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1.5 coarse:py-2.5 text-xs rounded text-text-muted hover:text-text-primary">
            {t('common.cancel') || 'Cancel'}
          </button>
          <button
            onClick={() => onSave(cleanScope({ mode, accountIds, siteIds }, def.scopable))}
            className="px-3 py-1.5 coarse:py-2.5 text-xs bg-accent text-white rounded hover:bg-accent/90"
          >
            {t('restrictions.scope.apply') || 'Apply scope'}
          </button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'include', 'exclude'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={`px-3 py-1.5 coarse:py-2.5 text-xs rounded border ${
              mode === m ? 'bg-accent text-white border-accent' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {m === 'all' ? (t('restrictions.scope.all') || 'Every account (default)')
              : m === 'include' ? (t('restrictions.scope.include') || 'Only these')
                : (t('restrictions.scope.exclude') || 'All except these')}
          </button>
        ))}
      </div>
      {mode !== 'all' && (
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={withSites ? (t('restrictions.scope.searchBoth') || 'Search accounts and sites…') : (t('restrictions.scope.searchAccounts') || 'Search accounts…')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div>
            <p className="text-[10px] uppercase text-text-muted font-medium mb-1">{t('restrictions.scope.accounts') || 'Accounts'}</p>
            <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto overscroll-contain rounded p-1.5 bg-bg-tertiary/30">
              {accounts.length === 0 && <span className="text-xs text-text-muted italic">{t('restrictions.scope.noAccounts') || 'No accounts'}</span>}
              {shownAccounts.map((a) => (
                <button key={a.id} onClick={() => setAccountIds((x) => toggle(x, a.id))} aria-pressed={accountIds.includes(a.id)} className={chip(accountIds.includes(a.id))}>
                  {a.displayName ? `${a.displayName} (${a.username})` : a.username}
                </button>
              ))}
            </div>
          </div>
          {withSites && (
            <div>
              <p className="text-[10px] uppercase text-text-muted font-medium mb-1">{t('restrictions.scope.sites') || 'Sites'}</p>
              <div className="flex flex-wrap gap-1 max-h-48 overflow-y-auto overscroll-contain rounded p-1.5 bg-bg-tertiary/30">
                {sites.length === 0 && <span className="text-xs text-text-muted italic">{t('restrictions.scope.noSites') || 'No sites'}</span>}
                {shownSites.map((s) => (
                  <button key={s.id} onClick={() => setSiteIds((x) => toggle(x, s.id))} aria-pressed={siteIds.includes(s.id)} className={chip(siteIds.includes(s.id))}>
                    {s.name} <span className="font-mono opacity-70">· {s.accountUsername}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="text-[11px] text-text-muted">
            {withSites
              ? (t('restrictions.scope.hintSites') || 'A site matches when it is listed or when its account is listed. A batch touching one listed element is checked as a whole.')
              : (t('restrictions.scope.hintAccounts') || 'A batch touching one listed account is checked as a whole.')}
          </p>
          {nothingPicked && (
            <p className="text-[11px] text-orange-400">
              {mode === 'include'
                ? (t('restrictions.scope.emptyInclude') || 'Nothing selected: the restriction applies to nothing.')
                : (t('restrictions.scope.emptyExclude') || 'Nothing selected: the restriction applies to everything.')}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
