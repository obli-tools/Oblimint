import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowDown, Info, Wrench } from 'lucide-react';
import type { MailDnsFixItem, MailDnsFixPlan, MailDnsStatus } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { Pill } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { mailErrorCode, mailErrorMessage } from './mailErrors';

// "Fix" of the mail records of a hosted zone (POST /mail/domains/:id/dns/fix):
// preview (before → after per record, consequences), the user unticks what
// he does not want, apply re-validates server-side (409 fixPlanChanged →
// review again). OWNED BY MODULE `ui-mail`.

const host = (s: string) => s.replace(/\.$/, '');
const line = (r: { content: string; priority: number | null }) => (r.priority != null ? `${r.priority} ${r.content}` : r.content);

function itemTitle(t: TFunction, it: MailDnsFixItem): string {
  switch (it.kind) {
    case 'mx': return t('mail.dns.fix.item.mx') || 'Route incoming mail back to this server';
    case 'spf': return t('mail.dns.fix.item.spf') || 'Authorise this server to send the mail of the domain (SPF)';
    case 'dkim': return t('mail.dns.fix.item.dkim') || 'Publish the DKIM key of this server';
    default: return t('mail.dns.fix.item.dmarc') || 'Publish the DMARC policy of the domain';
  }
}

function consequence(t: TFunction, it: MailDnsFixItem, domain: string): string | null {
  switch (it.kind) {
    case 'mx': {
      const hosts = it.before.filter((r) => r.type === 'MX').map((r) => host(r.content));
      return hosts.length
        ? t('mail.dns.fix.consequence.mx', { domain, hosts: hosts.join(', '), defaultValue: 'Incoming mail for {{domain}} will arrive on this server instead of {{hosts}}.' })
        : t('mail.dns.fix.consequence.mxNew', { domain, defaultValue: 'Incoming mail for {{domain}} will arrive on this server.' });
    }
    case 'spf':
      return it.lostSpfTerms.length
        ? t('mail.dns.fix.consequence.spf', { terms: it.lostSpfTerms.join(' '), defaultValue: 'Servers previously authorised ({{terms}}) will no longer be: their messages may be rejected or marked as spam.' })
        : null;
    case 'dkim':
      return it.before.length ? (t('mail.dns.fix.consequence.dkim') || 'The key published at this name is replaced by the key this server signs with.') : null;
    default:
      return it.before.length ? (t('mail.dns.fix.consequence.dmarc') || 'The current DMARC policy is replaced by the one of the DNS options of this domain.') : null;
  }
}

function blockedReason(t: TFunction, it: MailDnsFixItem): string {
  switch (it.reason) {
    case 'notGenerated': return t('mail.dns.fix.blocked.notGenerated') || 'The mail records of this domain are not published (mail disabled, domain not verified or account suspended).';
    case 'systemRecord': return t('mail.dns.fix.blocked.systemRecord') || 'A record managed by the platform holds this name.';
    case 'cnameAtName': return t('mail.dns.fix.blocked.cnameAtName') || 'A CNAME at this name redirects everything, including the website: change it in the DNS zone.';
    default: return t('mail.dns.fix.blocked.stillHidden') || 'Another record would still hide the expected one: check the DNS zone.';
  }
}

export function MailDnsFixModal({ open, mailDomainId, focus, ptr, onClose, onApplied, prompt = false }: {
  open: boolean;
  mailDomainId: number;
  /** Item id ('<kind>:<FQDN>') of the row whose Fix was clicked; null = every fixable record. */
  focus: string | null;
  ptr: MailDnsStatus['ptr'] | null;
  onClose: () => void;
  onApplied: (status: MailDnsStatus) => void;
  /**
   * Opened by itself right after mail was enabled on the domain (not by a click on « Fix »):
   * asks first whether mail should now come to this server; closing leaves the warning of the card.
   */
  prompt?: boolean;
}) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<MailDnsFixPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setApplyError(null);
    setStale(false);
    try {
      const p = await mailApi.dnsFixPreview(mailDomainId);
      setPlan(p);
      setChecked(new Set(p.items.filter((i) => i.status === 'fix' && (!focus || i.id === focus)).map((i) => i.id)));
    } catch (err) {
      setPlan(null);
      setLoadError(mailErrorMessage(t, err, t('mail.dns.fix.loadFailed') || 'Failed to prepare the fix'));
    } finally {
      setLoading(false);
    }
  }, [mailDomainId, focus, t]);

  useEffect(() => { if (open) void load(); else setPlan(null); }, [open, load]);

  const fixItems = useMemo(() => (plan?.items ?? []).filter((i) => i.status === 'fix' && (!focus || i.id === focus)), [plan, focus]);
  const blockedItems = useMemo(() => (plan?.items ?? []).filter((i) => i.status === 'blocked' && (!focus || i.id === focus)), [plan, focus]);
  const ptrBad = !!ptr && [ptr.ipv4, ptr.ipv6].some((p) => p && p.status !== 'ok' && p.status !== 'unchecked');

  const toggle = (id: string) => setChecked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const apply = async () => {
    if (!plan) return;
    const items = fixItems.filter((i) => checked.has(i.id)).map((i) => ({ id: i.id, fingerprint: i.fingerprint }));
    if (!items.length) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await mailApi.dnsFixApply(mailDomainId, items);
      toast.success(t('mail.dns.fix.applied', { count: res.applied.length, defaultValue: 'Zone fixed: {{count}} record(s) now served by our name servers' }));
      onApplied(res.status);
      onClose();
    } catch (err) {
      const code = mailErrorCode(err);
      setStale(code === 'fixPlanChanged');
      setApplyError(mailErrorMessage(t, err, t('mail.dns.fix.failed') || 'The fix failed'));
    } finally {
      setApplying(false);
    }
  };

  const nsList = (plan?.expectedNameservers ?? []).join(', ');
  // MX of the previous provider stored in the zone (prompt line).
  const previousMx = [...new Set(fixItems.filter((i) => i.kind === 'mx').flatMap((i) => i.before.filter((r) => r.type === 'MX').map((r) => host(r.content))))];

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!applying}
      title={t('mail.dns.fix.title') || 'Fix the mail records of the zone'}
      icon={<Wrench className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" disabled={applying} onClick={onClose}>{prompt ? (t('mail.dns.fix.notNow') || 'Not now') : (t('common.cancel') || 'Cancel')}</Button>
          {stale ? (
            <Button size="sm" loading={loading} onClick={() => { void load(); }}>{t('mail.dns.fix.reviewAgain') || 'Review again'}</Button>
          ) : (
            <Button size="sm" loading={applying} disabled={!plan || fixItems.every((i) => !checked.has(i.id))} onClick={() => { void apply(); }}>
              {t('mail.dns.fix.apply') || 'Apply'}
            </Button>
          )}
        </>
      }
    >
      {loading && !plan ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : loadError ? (
        <p className="flex items-start gap-2 text-sm text-status-down"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{loadError}</p>
      ) : plan ? (
        <div className="space-y-3">
          {prompt && fixItems.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{previousMx.length
                ? t('mail.dns.fix.promptMx', { hosts: previousMx.join(', '), defaultValue: 'This zone already contains mail records pointing elsewhere (e.g. {{hosts}}): mail would keep going there. Route mail to this server now?' })
                : (t('mail.dns.fix.prompt') || 'This zone already contains mail records that override the ones of this server: mail would not work as expected. Fix them now?')}</span>
            </p>
          )}
          <p className="text-xs text-text-muted">
            {t('mail.dns.fix.intro', { zone: plan.zoneName ?? plan.domain, defaultValue: 'Records stored in the zone {{zone}} hide the records this server needs. Ticked lines are removed so that our name servers serve the expected records instead. Other records of the zone are not touched.' })}
          </p>

          {plan.delegated === false && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {t('mail.dns.fix.notDelegated', {
                  found: plan.publicNameservers.length ? plan.publicNameservers.join(', ') : '—',
                  expected: nsList || '—',
                  defaultValue: 'The name servers of this domain do not point to ours yet (found: {{found}}). The change is written now and takes effect once the registrar delegates the domain to {{expected}}.',
                })}
              </span>
            </p>
          )}
          {plan.delegated === null && (
            <p className="flex items-start gap-2 text-xs text-text-muted">
              <Info size={13} className="mt-0.5 shrink-0" />
              {t('mail.dns.fix.delegationUnknown', { expected: nsList || '—', defaultValue: 'The delegation of the domain could not be checked: the change takes effect once the domain points to {{expected}}.' })}
            </p>
          )}

          {fixItems.length === 0 && blockedItems.length === 0 && (
            <p className="rounded-lg bg-bg-primary px-3 py-4 text-center text-xs text-text-muted">
              {t('mail.dns.fix.nothing') || 'Nothing to fix: the zone already serves the expected records. A difference seen by « Check now » then comes from the delegation or from the cache of the resolvers.'}
            </p>
          )}

          <ul className="space-y-2">
            {fixItems.map((it) => {
              const on = checked.has(it.id);
              const note = consequence(t, it, plan.domain);
              return (
                <li key={it.id} className={cn('rounded-lg bg-bg-primary p-3', !on && 'opacity-60')}>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" checked={on} disabled={applying} onChange={() => toggle(it.id)} className="mt-0.5 accent-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{itemTitle(t, it)}</span>
                        <span className="font-mono text-[11px] font-semibold text-accent">{it.type}</span>
                      </span>
                      <span className="mt-0.5 block break-all font-mono text-xs text-text-muted">{it.name}</span>
                    </span>
                  </label>
                  <div className="mt-2 space-y-1 pl-6">
                    <div className="text-[11px] uppercase tracking-wide text-text-muted">{t('mail.dns.fix.before') || 'Before (removed)'}</div>
                    {it.before.length === 0 ? (
                      <div className="text-xs text-text-muted">{t('mail.dns.fix.nothingRemoved') || 'Nothing to remove: the expected record is written again.'}</div>
                    ) : it.before.map((r) => (
                      <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md bg-red-500/10 px-2 py-1">
                        <span className="break-all font-mono text-xs text-red-300 line-through">{r.type !== it.type ? `${r.type} ` : ''}{line(r)}</span>
                        {!r.served && <Pill>{t('mail.dns.fix.disabled') || 'disabled'}</Pill>}
                      </div>
                    ))}
                    <ArrowDown size={12} className="text-text-muted" />
                    <div className="text-[11px] uppercase tracking-wide text-text-muted">{t('mail.dns.fix.after') || 'After (served)'}</div>
                    {it.after.map((r) => (
                      <div key={line(r)} className="rounded-md bg-emerald-500/10 px-2 py-1 break-all font-mono text-xs text-emerald-300">{line(r)}</div>
                    ))}
                    {note && <p className="pt-1 text-xs text-amber-400">{note}</p>}
                  </div>
                </li>
              );
            })}
          </ul>

          {blockedItems.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-text-secondary">{t('mail.dns.fix.blockedTitle') || 'Cannot be fixed here'}</div>
              {blockedItems.map((it) => (
                <div key={it.id} className="rounded-lg bg-bg-primary px-3 py-2 text-xs">
                  <span className="font-mono text-text-primary">{it.type} {it.name}</span>
                  <p className="mt-0.5 text-text-muted">{blockedReason(t, it)}</p>
                </div>
              ))}
            </div>
          )}

          {ptrBad && (
            <p className="flex items-start gap-2 text-xs text-text-muted">
              <Info size={13} className="mt-0.5 shrink-0" />
              {t('mail.dns.fix.ptr') || 'The reverse DNS (PTR) is set at the provider of the server addresses, not in the zone: it cannot be fixed here.'}
            </p>
          )}

          {applyError && (
            <p className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-status-down">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />{applyError}
            </p>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
