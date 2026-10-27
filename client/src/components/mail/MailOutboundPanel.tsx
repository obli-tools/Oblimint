import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Ban, Inbox, Pause, Pencil, Play, RefreshCw, RotateCw, Send, Server, Trash2 } from 'lucide-react';
import {
  HostingSocketEvents, type MailOutboundCounters, type MailOutboundState, type MailQueueItem, type MailUpdatedPayload, type SiteMailRelay,
} from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, inputCls, labelCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatBytes } from '@/components/databases/dbFormat';
import { cn } from '@/utils/cn';
import { OutboundStatusBadge, QueueStatusBadge } from './MailBadges';
import { Pager } from './MailListParts';
import { mailErrorMessage, mailLoadError, toastMailError } from './mailErrors';
import { clampPageOffset, intIn, isValidAddress, normalizeAddress } from './mailFormat';

const QUEUE_PAGE = 25;

/** Outbound tab of /mail (one account): sending state, site relays, queue. */
export function MailOutboundPanel({ accountId }: { accountId: number }) {
  const { can } = useHostingMe();
  return (
    <div className="flex flex-col gap-5">
      <OutboundStateCard accountId={accountId} />
      <RelaysCard accountId={accountId} />
      {/* Senders and recipients of every message: the mail managers only (server: mail.manage). */}
      {can('mail.manage', accountId) && <QueueCard accountId={accountId} />}
    </div>
  );
}

/** "sent · bounced · rejected · spam" of a window. */
function Counters({ c }: { c: MailOutboundCounters }) {
  const { t } = useTranslation();
  const cell = (label: string, v: number, tone?: string) => (
    <div className="min-w-0">
      <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className={cn('font-mono text-lg tabular-nums text-text-primary', tone)}>{v}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cell(t('mail.outbound.sent') || 'Sent', c.sent)}
      {cell(t('mail.outbound.bounced') || 'Bounced', c.bounced, c.bounced > 0 ? 'text-amber-400' : undefined)}
      {cell(t('mail.outbound.rejected') || 'Refused', c.rejected, c.rejected > 0 ? 'text-amber-400' : undefined)}
      {cell(t('mail.outbound.spam') || 'Spam', c.spam, c.spam > 0 ? 'text-status-down' : undefined)}
    </div>
  );
}

function OutboundStateCard({ accountId }: { accountId: number }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { me, can } = useHostingMe();
  const staffManage = me?.kind === 'staff' && can('mail.manage', accountId);
  const [state, setState] = useState<MailOutboundState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await mailApi.outbound(accountId));
      setError(null);
    } catch (err) {
      setState(null);
      setError(mailLoadError(t, err, t('mail.outbound.loadFailed') || 'Failed to load the outbound state'));
    }
  }, [accountId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    return payload?.entity === 'outbound' && (payload.accountId == null || payload.accountId === accountId);
  }, 800);

  const suspend = async () => {
    const reason = await prompt({
      title: t('mail.outbound.suspendTitle') || 'Suspend outbound mail',
      message: t('mail.outbound.suspendConfirm') || 'The mailboxes and the sites of this account can no longer send (reception continues). Reason (optional, shown to the staff):',
      placeholder: t('mail.outbound.reasonPlaceholder') || 'Spam complaint…',
      maxLength: 500,
      plain: false,
      confirmLabel: t('mail.outbound.suspend') || 'Suspend sending',
    });
    if (reason === null) return;
    setBusy(true);
    try {
      setState(await mailApi.suspendOutbound(accountId, reason.trim() || null));
      toast.success(t('mail.outbound.suspended') || 'Outbound mail suspended');
    } catch (err) {
      toastMailError(t, err, t('mail.outbound.actionFailed') || 'The action failed');
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (!(await confirm({
      title: t('mail.outbound.resumeTitle') || 'Resume outbound mail',
      message: t('mail.outbound.resumeConfirm') || 'The mailboxes and the sites of this account may send again. Make sure the cause (compromised password, spamming script…) is fixed.',
      confirmLabel: t('mail.outbound.resume') || 'Resume sending',
    }))) return;
    setBusy(true);
    try {
      setState(await mailApi.resumeOutbound(accountId));
      toast.success(t('mail.outbound.resumed') || 'Outbound mail resumed');
    } catch (err) {
      toastMailError(t, err, t('mail.outbound.actionFailed') || 'The action failed');
    } finally {
      setBusy(false);
    }
  };

  const reasonText = (code: string | null) => (code ? t(`mail.outbound.reasons.${code}`, { defaultValue: code }) : null);

  return (
    <Card
      title={t('mail.outbound.title') || 'Outbound mail'}
      icon={<Send size={14} className="text-accent" />}
      actions={
        <>
          {state && staffManage && (state.status === 'active'
            ? <Button size="sm" variant="secondary" loading={busy} onClick={() => { void suspend(); }}><Pause size={13} className="mr-1.5" />{t('mail.outbound.suspend') || 'Suspend sending'}</Button>
            : <Button size="sm" loading={busy} onClick={() => { void resume(); }}><Play size={13} className="mr-1.5" />{t('mail.outbound.resume') || 'Resume sending'}</Button>)}
          <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={13} />} onClick={() => { void load(); }} />
        </>
      }
    >
      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : !state ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <OutboundStatusBadge status={state.status} />
            <span className="text-xs text-text-muted">
              {state.perHourLimit == null
                ? (t('mail.outbound.noLimit') || 'No hourly limit')
                : t('mail.outbound.limit', { count: state.perHourLimit, defaultValue: 'Limit: {{count}} messages / hour' })}
            </span>
          </div>
          {state.status === 'suspended' && (
            <div className="rounded-md border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-400">
              <div className="flex items-start gap-2">
                <Ban size={13} className="mt-0.5 shrink-0" />
                <span>
                  {reasonText(state.reason) ?? (t('mail.outbound.suspendedNoReason') || 'Sending is suspended.')}
                  {state.suspendedAt && <> · {new Date(state.suspendedAt).toLocaleString(i18n.language)}</>}
                  {state.suspendedBy && <> · {state.suspendedBy === 'auto' ? (t('mail.outbound.byAuto') || 'automatic protection') : state.suspendedBy}</>}
                </span>
              </div>
              {me?.kind !== 'staff' && <p className="mt-1.5 text-text-secondary">{t('mail.outbound.contactSupport') || 'Contact the support to resume sending once the cause is fixed.'}</p>}
            </div>
          )}
          <div>
            <div className="mb-2 text-xs text-text-muted">{t('mail.outbound.lastHour') || 'Last hour'}</div>
            <Counters c={state.lastHour} />
          </div>
          <div>
            <div className="mb-2 text-xs text-text-muted">{t('mail.outbound.last24h') || 'Last 24 hours'}</div>
            <Counters c={state.last24h} />
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Site relays (PHP mail() → msmtp → oblimint-mail-relay) ─────────────────

function RelaysCard({ accountId }: { accountId: number }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const manage = can('mail.manage', accountId);
  const [relays, setRelays] = useState<SiteMailRelay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [editing, setEditing] = useState<SiteMailRelay | null>(null);

  const load = useCallback(async () => {
    try {
      setRelays(await mailApi.relays(accountId));
      setError(null);
    } catch (err) {
      setRelays(null);
      setError(mailLoadError(t, err, t('mail.relay.loadFailed') || 'Failed to load the site relays'));
    }
  }, [accountId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    return payload?.entity === 'relay' && (payload.accountId == null || payload.accountId === accountId);
  }, 800);

  const replace = (r: SiteMailRelay) => setRelays((cur) => (cur ? cur.map((x) => (x.siteId === r.siteId ? r : x)) : cur));

  const toggle = async (r: SiteMailRelay, enabled: boolean) => {
    setBusy(r.siteId);
    try {
      replace(await mailApi.updateSiteRelay(r.siteId, { enabled }));
    } catch (err) {
      toastMailError(t, err, t('mail.relay.saveFailed') || 'Failed to save the relay');
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (r: SiteMailRelay) => {
    if (!(await confirm({
      title: t('mail.relay.rotateTitle') || 'Regenerate the relay credentials',
      message: t('mail.relay.rotateConfirm', { site: r.siteName, defaultValue: 'New relay credentials are written into the site {{site}} (msmtp); the old ones stop working at once.' }),
      confirmLabel: t('mail.relay.rotate') || 'Regenerate',
    }))) return;
    setBusy(r.siteId);
    try {
      replace(await mailApi.rotateSiteRelay(r.siteId));
      toast.success(t('mail.relay.rotated') || 'Relay credentials regenerated');
    } catch (err) {
      toastMailError(t, err, t('mail.relay.rotateFailed') || 'Failed to regenerate the credentials');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('mail.relay.title') || 'Site relay (PHP mail())'} icon={<Server size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">{t('mail.relay.description') || 'The sites send their PHP mail() through the authenticated relay of the platform: the sender is forced to an address of the account and the volume is limited per site.'}</p>
      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : relays === null ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : relays.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{t('mail.relay.empty') || 'This account has no site.'}</p>
      ) : (
        <ul className="space-y-2">
          {relays.map((r) => (
            <li key={r.siteId} className="rounded-lg bg-bg-primary p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/sites/${r.siteId}`} className="font-medium text-text-primary hover:text-accent">{r.siteName}</Link>
                {r.enabled
                  ? (r.configured ? <Pill tone="green">{t('mail.relay.active') || 'active'}</Pill> : <Pill tone="blue">{t('mail.relay.pending') || 'being configured'}</Pill>)
                  : <Pill>{t('mail.relay.off') || 'off'}</Pill>}
                <span className="font-mono text-[11px] text-text-muted">{r.username}</span>
                <div className="ml-auto flex items-center gap-1">
                  {manage && (
                    <>
                      <ToggleSwitch size="sm" checked={r.enabled} disabled={busy !== null} onChange={(v) => { void toggle(r, v); }} ariaLabel={t('mail.relay.enabled') || 'Relay enabled'} />
                      <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={13} />} disabled={busy !== null} onClick={() => setEditing(r)} />
                      <IconButton label={t('mail.relay.rotate') || 'Regenerate'} icon={<RotateCw size={13} />} disabled={busy !== null || !r.enabled} onClick={() => { void rotate(r); }} />
                    </>
                  )}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <InfoRow label={t('mail.relay.defaultSender') || 'Default sender'} mono>{r.defaultSender ?? (t('mail.relay.autoSender') || 'automatic (noreply@…)')}</InfoRow>
                <InfoRow label={t('mail.relay.perHour') || 'Limit / hour'} mono>{r.perHour ?? (t('mail.relay.planValue') || 'plan value')}</InfoRow>
                <InfoRow label={t('mail.relay.sentLastHour') || 'Sent (last hour)'} mono>{r.sentLastHour}</InfoRow>
              </div>
              {r.allowedSenders.length > 0 && (
                <p className="mt-2 break-all text-[11px] text-text-muted">{t('mail.relay.allowed') || 'Allowed senders:'} <span className="font-mono">{r.allowedSenders.join(', ')}</span></p>
              )}
            </li>
          ))}
        </ul>
      )}
      <RelayEditModal relay={editing} onClose={() => setEditing(null)} onSaved={(r) => { replace(r); setEditing(null); toast.success(t('mail.relay.saved') || 'Relay saved'); }} />
    </Card>
  );
}

function RelayEditModal({ relay, onClose, onSaved }: { relay: SiteMailRelay | null; onClose: () => void; onSaved: (r: SiteMailRelay) => void }) {
  const { t } = useTranslation();
  const [sender, setSender] = useState('');
  const [perHour, setPerHour] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!relay) return;
    setSender(relay.defaultSender ?? '');
    setPerHour(relay.perHour == null ? '' : String(relay.perHour));
    setError('');
  }, [relay]);

  const senderOk = !sender.trim() || isValidAddress(sender);
  const perHourVal = perHour.trim() ? intIn(perHour, 0, 1_000_000) : null;
  const perHourOk = !perHour.trim() || perHourVal !== null;

  const submit = async () => {
    if (!relay || !senderOk || !perHourOk) return;
    setSaving(true);
    setError('');
    try {
      onSaved(await mailApi.updateSiteRelay(relay.siteId, { defaultSender: sender.trim() ? normalizeAddress(sender) : null, perHour: perHourVal }));
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.relay.saveFailed') || 'Failed to save the relay'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={relay !== null}
      onClose={onClose}
      title={t('mail.relay.editTitle', { site: relay?.siteName ?? '', defaultValue: 'Relay of {{site}}' })}
      icon={<Server className="h-4 w-4 text-accent" />}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!senderOk || !perHourOk} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelCls} htmlFor="rl-sender">{t('mail.relay.defaultSender') || 'Default sender'}</label>
          <input id="rl-sender" type="email" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="noreply@example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', !senderOk && 'ring-2 ring-status-down/50')} />
          <p className="mt-1 text-xs text-text-muted">{t('mail.relay.defaultSenderHint') || 'An address of an active mail domain of the account. Empty: noreply@ the first mail domain.'}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="rl-hour">{t('mail.relay.perHour') || 'Limit / hour'}</label>
          <input id="rl-hour" type="number" min={0} inputMode="numeric" value={perHour} onChange={(e) => setPerHour(e.target.value)} placeholder={t('mail.relay.planValue') || 'plan value'} className={cn(inputCls, 'font-mono', !perHourOk && 'ring-2 ring-status-down/50')} />
          <p className="mt-1 text-xs text-text-muted">{t('mail.relay.perHourHint') || 'Capped by the plan. Empty: the plan value.'}</p>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

// ── Queue ───────────────────────────────────────────────────────────────────

function QueueCard({ accountId }: { accountId: number }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const manage = can('mail.manage', accountId);
  const [items, setItems] = useState<MailQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await mailApi.queue({ accountId, limit: QUEUE_PAGE, offset });
      if (n !== seq.current) return;
      // The last message of the last page is gone (retry / delete / delivered):
      // go back to the last non-empty page instead of a wrong 'queue empty'.
      const back = clampPageOffset(offset, res.total, QUEUE_PAGE, res.items.length);
      if (back != null) { setOffset(back); return; }
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(mailLoadError(t, err, t('mail.queue.loadFailed') || 'Failed to load the queue'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, offset, t]);
  useEffect(() => { setLoading(true); void load(); }, [load]);

  const act = async (item: MailQueueItem, action: 'retry' | 'delete') => {
    if (action === 'delete' && !(await confirm({
      title: t('mail.queue.deleteTitle') || 'Delete the message',
      message: t('mail.queue.deleteConfirm', { sender: item.sender || '<>', defaultValue: 'Delete this message of {{sender}} from the queue? It will never be delivered.' }),
      danger: true,
    }))) return;
    setBusy(item.queueId);
    try {
      await mailApi.queueAction(item.queueId, action);
      toast.success(action === 'retry' ? (t('mail.queue.retried') || 'Delivery retried') : (t('mail.queue.deleted') || 'Message deleted'));
      void load();
    } catch (err) {
      toastMailError(t, err, t('mail.queue.actionFailed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={t('mail.queue.title') || 'Queue'}
      icon={<Inbox size={14} className="text-accent" />}
      actions={<IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={13} />} onClick={() => { void load(); }} />}
    >
      {loading ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{t('mail.queue.empty') || 'The queue is empty: every message was delivered.'}</p>
      ) : (
        <div className="space-y-2">
          <GroupedTable<MailQueueItem>
            storageKey="mail-queue"
            singleGroupFlat
            className="bg-bg-primary"
            minWidth={820}
            defaultSort={{ column: 'arrived', dir: 'desc' }}
            groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (q) => q.queueId) }]}
            columns={[
              { id: 'arrived', header: t('mail.queue.arrived') || 'Arrived', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-secondary', sort: (q) => q.arrivedAt, cell: (q) => new Date(q.arrivedAt).toLocaleString(i18n.language) },
              { id: 'sender', header: t('mail.queue.sender') || 'Sender', tdClassName: 'max-w-[14rem] break-all font-mono text-xs text-text-primary', sort: (q) => q.sender, cell: (q) => q.sender || '<>' },
              { id: 'recipients', header: t('mail.queue.recipients') || 'Recipients', tdClassName: 'max-w-[16rem] break-all font-mono text-xs text-text-secondary', sort: (q) => q.recipients.join(','), cell: (q) => q.recipients.join(', ') },
              {
                id: 'status', header: t('mail.queue.status.title') || 'State', sort: (q) => q.status,
                cell: (q) => (
                  <>
                    <QueueStatusBadge status={q.status} />
                    {q.reason && <div className="mt-1 max-w-[18rem] break-words text-[11px] text-text-muted">{q.reason}</div>}
                    {q.nextAttemptAt && <div className="mt-0.5 text-[10px] text-text-muted">{t('mail.queue.next', { date: new Date(q.nextAttemptAt).toLocaleString(i18n.language), defaultValue: 'next try {{date}}' })}</div>}
                  </>
                ),
              },
              { id: 'size', header: t('mail.queue.size') || 'Size', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (q) => q.sizeBytes, cell: (q) => formatBytes(t, q.sizeBytes) },
              {
                id: 'actions', header: <span className="sr-only">{t('mail.actions') || 'Actions'}</span>, thClassName: 'w-20', tdClassName: 'text-right',
                cell: (q) => (manage ? (
                  <span className="inline-flex gap-1">
                    <IconButton label={t('mail.queue.retry') || 'Retry now'} icon={<RotateCw size={13} />} disabled={busy !== null} onClick={() => { void act(q, 'retry'); }} />
                    <IconButton label={t('common.delete') || 'Delete'} variant="danger" icon={<Trash2 size={13} />} disabled={busy !== null} onClick={() => { void act(q, 'delete'); }} />
                  </span>
                ) : null),
              },
            ]}
          />
          <Pager offset={offset} total={total} pageSize={QUEUE_PAGE} onOffset={setOffset} />
        </div>
      )}
    </Card>
  );
}
