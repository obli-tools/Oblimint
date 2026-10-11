import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Ban, Clock, Globe, KeyRound, ListChecks, Lock, Plug, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, Unlock, UserCheck,
} from 'lucide-react';
import type { AccessMode, AccountAccessInfo } from '@oblimint/shared';
import { ACCESS_MODES, HostingSocketEvents } from '@oblimint/shared';
import { firewallApi } from '@/api/firewall.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { useConfirm } from '@/components/common/ConfirmDialog';
import {
  Card, EmptyState, Pill, apiErrorCode, inputCls, labelCls, payloadNumber, thCls, theadRowCls, useHostingEvents,
} from '@/components/hosting/hostingUi';
import { opsErrorMessage, toastOpsError } from '@/components/usage/opsErrors';
import { cn } from '@/utils/cn';
import { cidrIssue, formatMinutes, isoToLocalInput, localInputToIso } from './accessFormat';
import { MyIpsCard } from './MyIpsCard';

// info.applyError (W1: never silent): raw hostd text for staff, a fixed sentence
// for client users (the server masks it, A6).

const TTL_MIN = 15;
const TTL_MAX = 1440;

/**
 * Security tab of the account detail page (?tab=security): who may reach the
 * account's own ports (SFTP of the file server, external SQL ports). Mode
 * open / allow-list / auto after 2FA, rules, « my IPs » probes, automatic
 * grants, bans. Editing needs `files.manage`; the server stays the authority.
 */
export function AccountSecurityTab({ accountId }: { accountId: number }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canEdit = can('files.manage', accountId);
  const [info, setInfo] = useState<AccountAccessInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const data = await firewallApi.getAccess(accountId);
      if (id !== seq.current) return;
      setInfo(data);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setInfo(null);
      setError(opsErrorMessage(t, err, 'security', t('security.loadFailed') || 'Failed to load the access settings'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.ACCESS_UPDATED, HostingSocketEvents.FILESRV_UPDATED], () => { void load(); }, (_e, p) => payloadNumber(p, 'accountId') === accountId);

  const changed = (next: AccountAccessInfo) => { seq.current++; setInfo(next); setError(null); };

  if (loading && !info) return <div className="flex justify-center py-8"><LoadingSpinner /></div>;
  if (!info) {
    return (
      <div className="space-y-4">
        <EmptyState icon={<AlertTriangle />} text={error ?? (t('security.loadFailed') || 'Failed to load the access settings')} action={
          <Button size="sm" variant="secondary" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={13} className="mr-1.5" />{t('common.refresh') || 'Refresh'}</Button>
        } />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">{t('security.tab.subtitle') || 'Who may reach the SFTP and SQL ports of this account.'}</p>
      <AppliedBanner info={info} onReload={() => { void load(); }} />
      <ModeCard info={info} canEdit={canEdit} onChanged={changed} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MyIpsCard accountId={accountId} canEdit={canEdit} rules={info.rules} onChanged={changed} />
        <PortsCard info={info} />
      </div>
      <RulesCard info={info} canEdit={canEdit} onChanged={changed} onReload={() => { void load(); }} />
      <GrantsCard info={info} canEdit={canEdit} onReload={() => { void load(); }} />
      <BansCard info={info} canEdit={canEdit} onReload={() => { void load(); }} />
    </div>
  );
}

// ── Applied state ───────────────────────────────────────────────────────────

function AppliedBanner({ info, onReload }: { info: AccountAccessInfo; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  if (info.applyError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-status-down/30 bg-status-down/5 p-3 text-xs text-status-down">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div>{t('security.applied.error') || 'The firewall rules could not be applied:'}</div>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">{info.applyError}</pre>
        </div>
        <IconButton size="sm" label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={13} />} onClick={onReload} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      {info.applied
        ? <Pill tone="green"><ShieldCheck size={10} />{t('security.applied.ok') || 'applied'}</Pill>
        : <Pill tone="amber"><Clock size={10} />{t('security.applied.pending') || 'pending'}</Pill>}
      <span>
        {info.applied
          ? t('security.applied.at', { date: info.appliedAt ? new Date(info.appliedAt).toLocaleString(i18n.language) : '—', defaultValue: 'Applied by the host on {{date}}.' })
          : (t('security.applied.pendingHint') || 'The host has not applied the latest state yet (in progress, or hostd unreachable).')}
      </span>
    </div>
  );
}

// ── Mode ────────────────────────────────────────────────────────────────────

function modeIcon(m: AccessMode) {
  return m === 'open' ? <Unlock size={15} /> : m === 'allowlist' ? <ListChecks size={15} /> : <UserCheck size={15} />;
}

function ModeCard({ info, canEdit, onChanged }: { info: AccountAccessInfo; canEdit: boolean; onChanged: (i: AccountAccessInfo) => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<AccessMode | 'ttl' | null>(null);
  const [ttl, setTtl] = useState(String(info.grantTtlMinutes));
  useEffect(() => { setTtl(String(info.grantTtlMinutes)); }, [info.grantTtlMinutes]);

  const label = (m: AccessMode) => ({
    open: t('security.mode.open') || 'Open',
    allowlist: t('security.mode.allowlist') || 'Allow-list',
    'auto-2fa': t('security.mode.auto2fa') || 'Auto after 2FA',
  })[m];
  const hint = (m: AccessMode) => ({
    open: t('security.mode.openHint') || 'Everyone may connect; addresses that fail to authenticate too often are banned.',
    allowlist: t('security.mode.allowlistHint') || 'Only the addresses and ranges of the rules below may connect (bans still apply).',
    'auto-2fa': t('security.mode.auto2faHint') || 'The rules, plus the addresses of the client users who signed in to the panel with 2FA (temporary grant, renewed while they use the panel).',
  })[m];

  const setMode = async (mode: AccessMode) => {
    if (mode === info.mode || !canEdit) return;
    setBusy(mode);
    try {
      onChanged(await firewallApi.updateAccess(info.accountId, { mode }));
      toast.success(t('security.mode.saved') || 'Access mode saved');
    } catch (err) {
      if (apiErrorCode(err) === 'lockoutRisk') {
        const ok = await confirm({
          title: t('security.lockout.title') || 'Risk of locking yourself out',
          message: t('security.lockout.message') || 'The allow-list is empty and none of your addresses is allowed: once this mode is applied, nobody can reach the SFTP / SQL ports of this account until a rule is added. Switch anyway?',
          confirmLabel: t('security.lockout.confirm') || 'Switch anyway',
          danger: true,
        });
        if (ok) {
          try {
            onChanged(await firewallApi.updateAccess(info.accountId, { mode, confirm: true }));
            toast.success(t('security.mode.saved') || 'Access mode saved');
          } catch (err2) {
            toastOpsError(t, err2, 'security', t('security.mode.saveFailed') || 'Failed to change the access mode');
          }
        }
      } else {
        toastOpsError(t, err, 'security', t('security.mode.saveFailed') || 'Failed to change the access mode');
      }
    } finally {
      setBusy(null);
    }
  };

  const ttlNum = Number(ttl);
  const ttlValid = Number.isInteger(ttlNum) && ttlNum >= TTL_MIN && ttlNum <= TTL_MAX;
  const saveTtl = async () => {
    if (!ttlValid || ttlNum === info.grantTtlMinutes) return;
    setBusy('ttl');
    try {
      onChanged(await firewallApi.updateAccess(info.accountId, { grantTtlMinutes: ttlNum }));
      toast.success(t('security.ttl.saved') || 'Grant lifetime saved');
    } catch (err) {
      toastOpsError(t, err, 'security', t('security.ttl.saveFailed') || 'Failed to save the grant lifetime');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('security.mode.title') || 'Access mode'} icon={<Lock size={14} className="text-accent" />}>
      <div role="radiogroup" aria-label={t('security.mode.title') || 'Access mode'} className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {ACCESS_MODES.map((m) => {
          const selected = info.mode === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!canEdit || busy !== null}
              onClick={() => { void setMode(m); }}
              className={cn(
                'rounded-xl border-2 p-3.5 text-left transition-all disabled:cursor-default',
                selected
                  ? 'border-accent bg-accent/5 shadow-[0_0_0_1px_rgb(var(--c-accent)/0.2)]'
                  : 'border-transparent bg-bg-primary/60 enabled:hover:border-accent/30 enabled:hover:bg-bg-hover',
                !canEdit && !selected && 'opacity-60',
              )}
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <span className={selected ? 'text-accent' : 'text-text-muted'}>{modeIcon(m)}</span>
                {label(m)}
                {busy === m && <RefreshCw size={12} className="ml-auto animate-spin text-text-muted" />}
              </span>
              <p className="mt-1.5 text-xs text-text-secondary">{hint(m)}</p>
            </button>
          );
        })}
      </div>

      {info.mode === 'auto-2fa' && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="w-40">
            <label className={labelCls} htmlFor="access-ttl">{t('security.ttl.label') || 'Grant lifetime (minutes)'}</label>
            <input
              id="access-ttl"
              type="number"
              inputMode="numeric"
              min={TTL_MIN}
              max={TTL_MAX}
              value={ttl}
              disabled={!canEdit}
              onChange={(e) => setTtl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveTtl(); } }}
              className={cn(inputCls, 'font-mono')}
            />
          </div>
          {canEdit && (
            <Button size="sm" variant="secondary" loading={busy === 'ttl'} disabled={!ttlValid || ttlNum === info.grantTtlMinutes} onClick={() => { void saveTtl(); }}>
              {t('common.save') || 'Save'}
            </Button>
          )}
          <p className="min-w-0 flex-1 basis-60 text-xs text-text-muted">
            {ttlValid
              ? t('security.ttl.hint', { value: formatMinutes(ttlNum, { h: t('security.units.h') || 'h', min: t('security.units.min') || 'min' }), defaultValue: 'An address stays allowed {{value}} after the last activity of its session in the panel.' })
              : t('security.ttl.range', { min: TTL_MIN, max: TTL_MAX, defaultValue: 'Between {{min}} and {{max}} minutes.' })}
          </p>
        </div>
      )}
      {!canEdit && <p className="mt-3 text-xs text-text-muted">{t('security.readOnly') || 'Changing the access rules needs the « file access » permission on this account.'}</p>}
    </Card>
  );
}

// ── Ports ───────────────────────────────────────────────────────────────────

function PortsCard({ info }: { info: AccountAccessInfo }) {
  const { t } = useTranslation();
  return (
    <Card title={t('security.ports.title') || 'Protected ports'} icon={<Plug size={14} className="text-accent" />}>
      {info.ports.length === 0 ? (
        <p className="text-xs text-text-muted">{t('security.ports.none') || 'No port open for this account (file server off, no external SQL access).'}</p>
      ) : (
        <ul className="space-y-2">
          {info.ports.map((p) => (
            <li key={`${p.kind}-${p.port}`} className="flex items-center gap-3 rounded-lg bg-bg-primary px-3 py-2">
              <Pill tone={p.kind === 'filesrv' ? 'blue' : 'accent'}>{p.kind === 'filesrv' ? (t('security.ports.sftp') || 'SFTP') : (t('security.ports.sql') || 'SQL')}</Pill>
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{p.label}</span>
              <span className="font-mono text-sm text-text-secondary">{p.port}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-text-muted">{t('security.ports.hint') || 'The rules apply to these ports only: the websites stay public.'}</p>
    </Card>
  );
}

// ── Rules ───────────────────────────────────────────────────────────────────

function RulesCard({ info, canEdit, onChanged, onReload }: {
  info: AccountAccessInfo; canEdit: boolean; onChanged: (i: AccountAccessInfo) => void; onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);
  const { sorted: sortedRules, sort } = useTableSort(info.rules, {
    cidr: (r) => r.cidr, label: (r) => r.label ?? '', expires: (r) => r.expiresAt ?? '~', createdBy: (r) => r.createdBy ?? '',
  });

  const issue = cidr.trim() ? cidrIssue(cidr) : null;
  const issueText = issue === 'tooWide'
    ? (t('security.errors.cidrTooWide') || 'This range is too wide (at least /8 in IPv4, /32 in IPv6).')
    : issue === 'invalid' ? (t('security.errors.invalidCidr') || 'Enter an IPv4 / IPv6 address or a CIDR range.') : null;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!cidr.trim() || issue) { setFormError(issueText ?? (t('security.errors.invalidCidr') || 'Enter an IPv4 / IPv6 address or a CIDR range.')); return; }
    const expiresAt = localInputToIso(expires);
    if (expires && (!expiresAt || Date.parse(expiresAt) < Date.now() + 5 * 60_000)) {
      setFormError(t('security.rules.expiryTooSoon') || 'The expiry must be at least 5 minutes from now.');
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      await firewallApi.addRule(info.accountId, { cidr: cidr.trim(), label: label.trim() || null, expiresAt });
      setCidr(''); setLabel(''); setExpires('');
      toast.success(t('security.rules.added') || 'Rule added');
      onReload();
    } catch (err) {
      setFormError(opsErrorMessage(t, err, 'security', t('security.rules.addFailed') || 'Failed to add the rule'));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: number, value: string) => {
    if (!(await confirm({
      title: t('security.rules.deleteTitle') || 'Delete the rule',
      message: t('security.rules.deleteConfirm', { cidr: value, defaultValue: 'Remove {{cidr}} from the allow-list? Connections from it are refused once the change is applied (except in open mode).' }),
      confirmLabel: t('common.delete') || 'Delete',
      danger: true,
    }))) return;
    setDeleting(id);
    try {
      await firewallApi.deleteRule(info.accountId, id);
      onChanged({ ...info, rules: info.rules.filter((r) => r.id !== id) });
      toast.success(t('security.rules.deleted') || 'Rule deleted');
      onReload();
    } catch (err) {
      toastOpsError(t, err, 'security', t('security.rules.deleteFailed') || 'Failed to delete the rule');
    } finally {
      setDeleting(null);
    }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');

  return (
    <Card
      title={t('security.rules.title') || 'Allow-list rules'}
      icon={<Globe size={14} className="text-accent" />}
      actions={<span className="font-mono text-[11px] text-text-muted">{info.rules.length} / 100</span>}
    >
      {info.mode === 'open' && info.rules.length > 0 && (
        <p className="mb-3 text-xs text-amber-400">{t('security.rules.openNote') || 'The account is in open mode: these rules are kept but not enforced (they still protect their addresses from bans).'}</p>
      )}
      {canEdit && (
        <form onSubmit={add} className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" noValidate>
          <div>
            <label className={labelCls} htmlFor="rule-cidr">{t('security.rules.cidr') || 'Address or range'}</label>
            <input id="rule-cidr" value={cidr} onChange={(e) => { setCidr(e.target.value); setFormError(null); }} placeholder="203.0.113.4 · 2001:db8::/48" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', issue && 'ring-1 ring-status-down')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="rule-label">{t('security.rules.label') || 'Label (optional)'}</label>
            <input id="rule-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder={t('security.rules.labelPlaceholder') || 'Office'} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="rule-expires">{t('security.rules.expires') || 'Expires (optional)'}</label>
            <input id="rule-expires" type="datetime-local" value={expires} min={isoToLocalInput(new Date(Date.now() + 5 * 60_000))} onChange={(e) => setExpires(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
          <Button type="submit" size="sm" loading={adding} className="sm:mb-px"><Plus size={13} className="mr-1.5" />{t('security.rules.add') || 'Add'}</Button>
          {(formError || issueText) && <p className="whitespace-pre-line text-xs text-status-down sm:col-span-4">{formError ?? issueText}</p>}
        </form>
      )}
      {info.rules.length === 0 ? (
        <p className="py-3 text-center text-xs text-text-muted">{t('security.rules.empty') || 'No rule yet.'}</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {sortedRules.map((r) => (
              <li key={r.id} className="flex items-start gap-2 rounded-lg bg-bg-primary px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-text-primary">{r.cidr}</div>
                  {r.label && <div className="truncate text-xs text-text-secondary">{r.label}</div>}
                  <div className="mt-0.5 font-mono text-[11px] text-text-muted">{r.expiresAt ? `${t('security.rules.until') || 'until'} ${fmt(r.expiresAt)}` : (t('security.rules.permanent') || 'permanent')}</div>
                </div>
                {canEdit && <IconButton variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} disabled={deleting === r.id} onClick={() => { void remove(r.id, r.cidr); }} />}
              </li>
            ))}
          </ul>
          <TableScroll className="max-md:hidden">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <SortTh k="cidr" sort={sort} className={thCls}>{t('security.rules.cidr') || 'Address or range'}</SortTh>
                  <SortTh k="label" sort={sort} className={thCls}>{t('security.rules.labelCol') || 'Label'}</SortTh>
                  <SortTh k="expires" sort={sort} className={thCls}>{t('security.rules.expiresCol') || 'Expires'}</SortTh>
                  <SortTh k="createdBy" sort={sort} className={thCls}>{t('security.rules.createdBy') || 'Added by'}</SortTh>
                  {canEdit && <th className={thCls} />}
                </tr>
              </thead>
              <tbody>
                {sortedRules.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-bg-hover">
                    <td className="px-4 py-2.5 font-mono text-text-primary">{r.cidr}</td>
                    <td className="px-4 py-2.5 text-text-secondary">{r.label ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{r.expiresAt ? fmt(r.expiresAt) : (t('security.rules.permanent') || 'permanent')}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-muted">{r.createdBy ?? '—'}</td>
                    {canEdit && (
                      <td className="px-4 py-2.5 text-right">
                        <IconButton variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} disabled={deleting === r.id} onClick={() => { void remove(r.id, r.cidr); }} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
    </Card>
  );
}

// ── Grants (auto-2fa) ───────────────────────────────────────────────────────

function GrantsCard({ info, canEdit, onReload }: { info: AccountAccessInfo; canEdit: boolean; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);
  if (info.mode !== 'auto-2fa' && info.grants.length === 0) return null;

  const revoke = async (id: number, ip: string) => {
    if (!(await confirm({
      title: t('security.grants.revokeTitle') || 'Revoke the grant',
      message: t('security.grants.revokeConfirm', { ip, defaultValue: 'Revoke the automatic grant of {{ip}}? It comes back at the next activity of its 2FA session.' }),
      confirmLabel: t('security.grants.revoke') || 'Revoke',
      danger: true,
    }))) return;
    setBusy(id);
    try {
      await firewallApi.deleteGrant(info.accountId, id);
      toast.success(t('security.grants.revoked') || 'Grant revoked');
      onReload();
    } catch (err) {
      toastOpsError(t, err, 'security', t('security.grants.revokeFailed') || 'Failed to revoke the grant');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('security.grants.title') || 'Automatic grants (2FA)'} icon={<KeyRound size={14} className="text-accent" />}>
      {info.grants.length === 0 ? (
        <p className="py-3 text-center text-xs text-text-muted">{t('security.grants.empty') || 'No active grant: they appear when a client user of this account signs in with 2FA.'}</p>
      ) : (
        <ul className="space-y-2">
          {info.grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-bg-primary px-3 py-2">
              <span className="min-w-0 break-all font-mono text-sm text-text-primary">{g.ip}</span>
              <Pill tone="muted">IPv{g.family}</Pill>
              <Pill tone={g.source === 'probe' ? 'blue' : 'green'}>{g.source === 'probe' ? (t('security.grants.sourceProbe') || 'probe') : (t('security.grants.sourceSession') || 'session')}</Pill>
              <span className="text-xs text-text-secondary">{g.username ?? `#${g.userId}`}</span>
              <span className="font-mono text-[11px] text-text-muted max-sm:basis-full">{t('security.grants.expires', { date: new Date(g.expiresAt).toLocaleString(i18n.language), defaultValue: 'expires {{date}}' })}</span>
              {canEdit && (
                <Button size="sm" variant="ghost" className="ml-auto" loading={busy === g.id} onClick={() => { void revoke(g.id, g.ip); }}>
                  {t('security.grants.revoke') || 'Revoke'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Bans ────────────────────────────────────────────────────────────────────

function BansCard({ info, canEdit, onReload }: { info: AccountAccessInfo; canEdit: boolean; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState<number | null>(null);

  const unban = async (id: number) => {
    setBusy(id);
    try {
      await firewallApi.unban(info.accountId, id);
      toast.success(t('security.bans.unbanned') || 'Address unbanned');
      onReload();
    } catch (err) {
      toastOpsError(t, err, 'security', t('security.bans.unbanFailed') || 'Failed to unban the address');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={t('security.bans.title') || 'Banned addresses'}
      icon={<ShieldAlert size={14} className="text-accent" />}
      actions={info.bans.length > 0 ? <Pill tone="red"><Ban size={10} />{info.bans.length}</Pill> : undefined}
    >
      {info.bans.length === 0 ? (
        <p className="py-3 text-center text-xs text-text-muted">{t('security.bans.empty') || 'No banned address.'}</p>
      ) : (
        <ul className="space-y-2">
          {info.bans.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-bg-primary px-3 py-2">
              <span className="min-w-0 break-all font-mono text-sm text-text-primary">{b.ip}</span>
              <Pill tone={b.service === 'sftp' ? 'blue' : 'accent'}>{b.service === 'sftp' ? (t('security.ports.sftp') || 'SFTP') : (t('security.ports.sql') || 'SQL')}</Pill>
              <span className="text-xs text-text-secondary">{t('security.bans.failures', { count: b.failures, defaultValue: '{{count}} failures' })}</span>
              <span className="font-mono text-[11px] text-text-muted max-sm:basis-full">{t('security.bans.until', { date: new Date(b.expiresAt).toLocaleString(i18n.language), defaultValue: 'until {{date}}' })}</span>
              {b.reason && <span className="w-full truncate text-[11px] text-text-muted" title={b.reason}>{b.reason}</span>}
              {canEdit && (
                <Button size="sm" variant="ghost" className="ml-auto" loading={busy === b.id} onClick={() => { void unban(b.id); }}>
                  {t('security.bans.unban') || 'Unban'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-text-muted">{t('security.bans.hint') || 'Repeated authentication failures (SFTP, external SQL) ban the address for a while. An address of the rules is never banned.'}</p>
    </Card>
  );
}
