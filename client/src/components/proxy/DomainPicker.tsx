import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Globe } from 'lucide-react';
import type { Domain } from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { proxyApi } from '@/api/proxy.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { AddDomainInline } from '@/components/hosting/DomainCreateModal';
import { TlsBadge } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { bindingsOf, domainUnavailable, type DomainBinding, type DomainUnavailable } from './proxyFormat';

/**
 * Multi-select of the domains a proxy object may bind (docs/P4b-PLAN.md §8.1):
 * VERIFIED domains of the same account, without site routes, not bound to
 * another proxy object. Unavailable domains are listed, disabled, with why.
 */
export function DomainPicker({ accountId, value, onChange, self, disabled, onDomains }: {
  accountId: number | null;
  value: number[];
  onChange: (ids: number[]) => void;
  /** The object being edited (its own domains stay available). */
  self: { kind: DomainBinding['kind']; id: number | null };
  disabled?: boolean;
  /** Loaded domains of the account (for callers that show names / certificates). */
  onDomains?: (domains: Domain[]) => void;
}) {
  const { t } = useTranslation();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [bindings, setBindings] = useState<Map<number, DomainBinding>>(new Map());
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (accountId == null) { setDomains([]); return; }
    let cancelled = false;
    setLoading(true);
    // The bindings come from the proxy lists of the account; a list that fails
    // (module not deployed yet) just shows no binding — the server refuses anyway.
    Promise.all([
      domainsApi.list({ accountId }),
      proxyApi.listHosts({ accountId }).catch(() => []),
      proxyApi.listRedirections({ accountId }).catch(() => []),
      proxyApi.listDeadHosts({ accountId }).catch(() => []),
    ]).then(([ds, hosts, reds, deads]) => {
      if (cancelled) return;
      setDomains(ds);
      setBindings(bindingsOf(hosts, reds, deads));
      setFailed(false);
      onDomains?.(ds);
    }).catch(() => {
      if (!cancelled) { setDomains([]); setFailed(true); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => domains
    .map((d) => ({ d, why: domainUnavailable(d, bindings, self) }))
    .sort((a, b) => Number(a.why !== null) - Number(b.why !== null) || a.d.name.localeCompare(b.d.name)), [domains, bindings, self]);

  const reason = (why: DomainUnavailable, d: Domain): string => {
    switch (why) {
      case 'notVerified': return t('proxy.domains.notVerified') || 'ownership not verified';
      case 'siteRoutes': return t('proxy.domains.siteRoutes') || 'served by site routes';
      case 'bound': {
        const b = bindings.get(d.id);
        if (b?.kind === 'proxy') return t('proxy.domains.boundHost', { name: b.label, defaultValue: 'used by the proxy host {{name}}' });
        if (b?.kind === 'redirect') return t('proxy.domains.boundRedirect') || 'used by a redirection';
        return t('proxy.domains.boundDead') || 'used by a dead host';
      }
      default: return '';
    }
  };

  const toggle = (id: number) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  if (accountId == null) return <p className="text-xs text-text-muted">{t('proxy.domains.pickAccount') || 'Choose the hosting account first.'}</p>;
  if (loading) return <div className="flex justify-center py-4"><LoadingSpinner size="sm" /></div>;
  if (failed) return <p className="text-xs text-status-down">{t('proxy.domains.loadFailed') || 'Failed to load the domains of the account.'}</p>;
  if (domains.length === 0) {
    return (
      <p className="text-xs text-text-muted">
        {t('proxy.domains.none') || 'This account has no domain yet.'}{' '}
        {/* Added in place, account preset: the form being edited stays open. */}
        <AddDomainInline accountId={accountId} label={t('proxy.domains.addLink') || 'Add a domain'} onCreated={(d) => { const next = [...domains, d]; setDomains(next); onDomains?.(next); }} />
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg bg-bg-primary p-1.5">
        {rows.map(({ d, why }) => {
          const checked = value.includes(d.id);
          const off = disabled || (why !== null && !checked);
          return (
            <li key={d.id}>
              <button
                type="button"
                disabled={off}
                onClick={() => toggle(d.id)}
                aria-pressed={checked}
                className={cn(
                  'flex w-full flex-wrap items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors coarse:min-h-10',
                  checked ? 'bg-accent/10' : 'hover:bg-bg-hover',
                  off && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', checked ? 'border-accent bg-accent text-white' : 'border-text-muted/40')}>
                  {checked && <Check size={11} />}
                </span>
                <Globe size={13} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary">
                  {d.name}{d.includeWww && <span className="text-text-muted"> + www</span>}{d.wildcard && <span className="text-text-muted"> + *.</span>}
                </span>
                {why ? (
                  <span className="text-[11px] text-amber-400">{reason(why, d)}</span>
                ) : (
                  <TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-text-muted">
        {t('proxy.domains.hint') || 'Only verified domains of the account, not served by site routes or another proxy object, can be bound (one consumer per domain).'}
      </p>
    </div>
  );
}
