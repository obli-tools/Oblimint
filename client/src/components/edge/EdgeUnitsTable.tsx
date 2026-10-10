import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { EdgeUnitOwnerKind, EdgeUnitState, HostingAccount } from '@oblimint/shared';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { EdgeUnitPill } from '@/components/proxy/proxyUi';
import { unitNeedsAttention } from '@/components/proxy/proxyFormat';
import { cn } from '@/utils/cn';

export function useOwnerKindLabel(): (k: EdgeUnitOwnerKind) => string {
  const { t } = useTranslation();
  return (k) => {
    switch (k) {
      case 'site-domain': return t('edgeUnits.owner.siteDomain') || 'Site domain';
      case 'platform': return t('edgeUnits.owner.platform') || 'Platform';
      case 'contributed': return t('edgeUnits.owner.contributed') || 'Contributed';
      case 'proxy-host': return t('edgeUnits.owner.proxyHost') || 'Proxy host';
      case 'redirection': return t('edgeUnits.owner.redirection') || 'Redirection';
      case 'dead-host': return t('edgeUnits.owner.deadHost') || 'Dead host';
      case 'stream': return t('edgeUnits.owner.stream') || 'Stream';
      default: return t('edgeUnits.owner.global') || 'Global';
    }
  };
}

function ownerLink(u: EdgeUnitState): string | null {
  if (u.ownerId == null) return null;
  if (u.ownerKind === 'proxy-host') return `/proxy/hosts/${u.ownerId}`;
  if (u.ownerKind === 'redirection') return `/proxy?tab=redirections${u.accountId ? `&account=${u.accountId}` : ''}`;
  if (u.ownerKind === 'dead-host') return `/proxy?tab=dead-hosts${u.accountId ? `&account=${u.accountId}` : ''}`;
  if (u.ownerKind === 'stream') return '/proxy?tab=streams';
  return null;
}

/** Units of the edge with their full validation output (platform admin), retry per unit. */
export function EdgeUnitsTable({ units, accounts, retrying, onRetry }: {
  units: EdgeUnitState[];
  accounts: HostingAccount[];
  retrying: string | null;
  onRetry: (u: EdgeUnitState) => void;
}) {
  const { t, i18n } = useTranslation();
  const ownerLabel = useOwnerKindLabel();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }) : '—');
  const account = (id: number | null) => (id == null ? '—' : accounts.find((a) => a.id === id)?.username ?? `#${id}`);

  return (
    <TableScroll className="rounded-xl bg-bg-secondary">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className={theadRowCls}>
            <th className={`${thCls} w-8`}><span className="sr-only">{t('edgeUnits.details') || 'Details'}</span></th>
            <th className={thCls}>{t('edgeUnits.unit') || 'Unit'}</th>
            <th className={thCls}>{t('edgeUnits.ownerLabel') || 'Owner'}</th>
            <th className={thCls}>{t('proxy.account') || 'Hosting account'}</th>
            <th className={thCls}>{t('edgeUnits.status') || 'Status'}</th>
            <th className={thCls}>{t('edgeUnits.checked') || 'Checked / applied'}</th>
            <th className={`${thCls} w-28`}><span className="sr-only">{t('proxy.actions') || 'Actions'}</span></th>
          </tr>
        </thead>
        <tbody>
          {units.map((u) => {
            const expanded = open.has(u.unitId);
            const link = ownerLink(u);
            const hasDetail = !!u.error || u.upstreams.length > 0 || u.desiredHash !== u.activeHash;
            return (
              <Fragment key={u.unitId}>
                <tr className={cn('align-top transition-colors hover:bg-bg-hover', unitNeedsAttention(u.status) && 'bg-amber-400/[0.03]')}>
                  <td className="px-2 py-3">
                    {hasDetail && (
                      <button type="button" onClick={() => toggle(u.unitId)} aria-expanded={expanded} aria-label={t('edgeUnits.details') || 'Details'} className="rounded p-1 text-text-muted hover:text-text-primary">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-primary">{u.unitId}</td>
                  <td className="px-4 py-3 text-xs text-text-secondary">
                    {ownerLabel(u.ownerKind)}
                    {u.ownerId != null && (link ? <Link to={link} className="ml-1.5 text-accent hover:underline">#{u.ownerId}</Link> : <span className="ml-1.5 font-mono text-text-muted">#{u.ownerId}</span>)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{account(u.accountId)}</td>
                  <td className="px-4 py-3"><EdgeUnitPill unit={u} /></td>
                  <td className="px-4 py-3 font-mono text-[11px] text-text-muted">{fmt(u.checkedAt)}<br />{fmt(u.appliedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {u.status !== 'active' && u.status !== 'disabled' && (
                      <Button size="sm" variant="secondary" loading={retrying === u.unitId} disabled={retrying !== null} onClick={() => onRetry(u)}>
                        <RotateCcw size={13} className="mr-1.5" />{t('proxy.unit.retry') || 'Retry now'}
                      </Button>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td />
                    <td colSpan={6} className="px-4 pb-4">
                      {u.error && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-primary p-2.5 font-mono text-[11px] text-text-secondary">{u.error}</pre>}
                      {u.upstreams.length > 0 && (
                        <ul className="mt-2 space-y-1 text-[11px]">
                          {u.upstreams.map((up) => (
                            <li key={`${up.where}-${up.target}`} className="flex flex-wrap gap-2 font-mono">
                              <span className={up.reachable === false ? 'text-status-down' : up.reachable ? 'text-green-400' : 'text-text-muted'}>●</span>
                              <span className="text-text-secondary">{up.where}</span>→<span className="text-text-primary">{up.target}</span>
                              {up.error && <span className="text-amber-400">{up.error}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 font-mono text-[10px] text-text-muted">
                        {t('edgeUnits.hashes', { desired: u.desiredHash?.slice(0, 12) ?? '—', active: u.activeHash?.slice(0, 12) ?? '—', defaultValue: 'desired {{desired}} · served {{active}}' })}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
