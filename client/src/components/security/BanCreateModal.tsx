import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldBan } from 'lucide-react';
import type { HostingAccount, WebBan, WebBanScope } from '@oblimint/shared';
import { bansApi } from '@/api/bans.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { AccountField } from '@/components/proxy/proxyUi';
import { isIp, isValidCidr } from '@/components/proxy/proxyFormat';
import { proxyErrorMessage } from '@/components/proxy/proxyErrors';
import { cn } from '@/utils/cn';
import { useDurationLabel } from './bansUi';

/** 'default' = escalation ladder of the platform; null = permanent. */
type DurationChoice = 'default' | 'permanent' | 60 | 1440 | 10080 | 43200;
const CHOICES: DurationChoice[] = ['default', 60, 1440, 10080, 43200, 'permanent'];

/** Manual ban: account scope (proxy.manage) or platform scope (platform admin: nginx everywhere + nftables). */
export function BanCreateModal({ open, accounts, allowPlatform, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  /** Accounts the caller may ban for (proxy.manage). */
  accounts: HostingAccount[];
  allowPlatform: boolean;
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: (b: WebBan) => void;
}) {
  const { t } = useTranslation();
  const durationLabel = useDurationLabel();
  const [scope, setScope] = useState<WebBanScope>('account');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [ip, setIp] = useState('');
  const [duration, setDuration] = useState<DurationChoice>('default');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setScope(accounts.length === 0 && allowPlatform ? 'platform' : 'account');
    setAccountId(defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setIp('');
    setDuration('default');
    setReason('');
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = ip.trim();
  // IPv4 address, or an IPv6 address / prefix (bans are per /64).
  const ipOk = isIp(value) || (value.includes(':') && isValidCidr(value));
  const canSubmit = ipOk && (scope === 'platform' ? allowPlatform : accountId != null);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const b = await bansApi.create({
        ip: value,
        scope,
        accountId: scope === 'account' ? accountId : null,
        ...(duration === 'default' ? {} : { durationMinutes: duration === 'permanent' ? null : duration }),
        reason: reason.trim() || null,
      });
      onSaved(b);
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('bans.createFailed') || 'Failed to ban the address', 'bans'));
    } finally {
      setSaving(false);
    }
  };

  const choiceLabel = (c: DurationChoice) => (c === 'default' ? (t('bans.durationDefault') || 'Escalation (default)') : durationLabel(c === 'permanent' ? null : c));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('bans.createTitle') || 'Ban an address'}
      icon={<ShieldBan className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" variant="danger" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('bans.ban') || 'Ban'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {allowPlatform && accounts.length > 0 && (
          <SegmentedTabs<WebBanScope>
            size="sm"
            tabs={[
              { id: 'account', label: t('bans.scope.account') || 'Account' },
              { id: 'platform', label: t('bans.scope.platform') || 'Platform' },
            ]}
            value={scope}
            onChange={setScope}
            ariaLabel={t('bans.scopeLabel') || 'Scope'}
          />
        )}
        <p className="text-xs text-text-muted">
          {scope === 'platform'
            ? (t('bans.scope.platformHint') || 'Refused on every host of the platform, and dropped by the firewall on ports 80 / 443.')
            : (t('bans.scope.accountHint') || 'Refused on the sites and proxy hosts of this account only.')}
        </p>
        {scope === 'account' && accounts.length > 1 && <AccountField id="ban-account" accounts={accounts} value={accountId} onChange={setAccountId} />}
        <div>
          <label className={labelCls} htmlFor="ban-ip">{t('bans.ip') || 'Address'}</label>
          <input id="ban-ip" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.7" autoFocus autoCapitalize="off" spellCheck={false}
            className={cn(inputCls, 'font-mono', value && !ipOk && 'ring-2 ring-status-down/50')} />
          <p className="mt-1 text-[11px] text-text-muted">{t('bans.ipHint') || 'IPv6 addresses are banned per /64. Private, internal and never-ban addresses are refused.'}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="ban-duration">{t('bans.duration') || 'Duration'}</label>
          <select id="ban-duration" value={String(duration)} onChange={(e) => {
            const v = e.target.value;
            setDuration(v === 'default' || v === 'permanent' ? v : (Number(v) as DurationChoice));
          }} className={selectCls}>
            {CHOICES.map((c) => <option key={String(c)} value={String(c)}>{choiceLabel(c)}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ban-reason">{t('bans.reason') || 'Reason (optional)'}</label>
          <input id="ban-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className={inputCls} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
