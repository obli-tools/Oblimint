import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronRight, ExternalLink, KeyRound, Mail, Plus, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type Mailbox, type MailDomain, type MailUpdatedPayload } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { EmptyState, headerAccentBtnCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { MailboxFlags, MailQuotaBar } from './MailBadges';
import { MailboxCreateModal } from './MailboxCreateModal';
import { PasswordRevealModal } from './MailPasswordModals';
import { MailSearch, Pager } from './MailListParts';
import { useDebounced } from './useDebounced';
import { useMailboxActions } from './useMailboxActions';
import { mailLoadError } from './mailErrors';
import { clampPageOffset } from './mailFormat';

const PAGE = 50;

/** Mailboxes of an account / a mail domain: quota bars, flags, actions (password, webmail, delete). */
export function MailboxesPanel({ accountId, tenantId, mailDomainId, showAccount = true, showTenant = false, webmailAvailable = true }: {
  accountId?: number | null;
  tenantId?: number;
  mailDomainId?: number;
  showAccount?: boolean;
  showTenant?: boolean;
  /** The platform has a webmail (overview.webmail.kind ≠ none). */
  webmailAvailable?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, can } = useHostingMe();
  const staff = me?.kind === 'staff';
  const [items, setItems] = useState<Mailbox[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [domains, setDomains] = useState<MailDomain[]>([]);
  const [creating, setCreating] = useState(false);
  // Generated password of a new mailbox: kept only while the reveal dialog is open (MA4).
  const [revealed, setRevealed] = useState<{ address: string; password: string } | null>(null);

  useEffect(() => { setOffset(0); }, [q, accountId, tenantId, mailDomainId]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await mailApi.listMailboxes({ accountId: accountId ?? undefined, tenantId, mailDomainId, search: q || undefined, limit: PAGE, offset });
      if (n !== seq.current) return;
      // The last item of the last page is gone (delete): go back to the last
      // non-empty page instead of an empty page without a pager.
      const back = clampPageOffset(offset, res.total, PAGE, res.items.length);
      if (back != null) { setOffset(back); return; }
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setTotal(0);
      setError(mailLoadError(t, err, t('mail.mailboxes.loadFailed') || 'Failed to load the mailboxes'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, mailDomainId, q, offset, t]);

  const loadDomains = useCallback(async () => {
    try {
      const list = await mailApi.listDomains({ accountId: accountId ?? undefined, tenantId });
      setDomains(mailDomainId ? list.filter((d) => d.id === mailDomainId) : list);
    } catch {
      setDomains([]);
    }
  }, [accountId, tenantId, mailDomainId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => { void loadDomains(); }, [loadDomains]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); void loadDomains(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    if (!payload || !['mailbox', 'mailDomain', 'outbound'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const actions = useMailboxActions({ staff, onChanged: () => { void load(); } });
  const manageableDomains = useMemo(() => domains.filter((d) => can('mail.manage', d.accountId)), [domains, can]);
  const canCreate = manageableDomains.length > 0;
  const createBtn = canCreate ? (
    <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('mail.mailboxes.add') || 'New mailbox'}</button>
  ) : null;

  const rowMenu = (m: Mailbox) => {
    const manage = can('mail.manage', m.accountId);
    if (!manage) return null;
    return (
      <ActionMenu
        disabled={actions.busy !== null}
        items={[
          { key: 'webmail', icon: <ExternalLink className="h-4 w-4" />, label: t('webmail.open') || 'Open webmail', onClick: () => { void actions.openWebmail(m); }, disabled: !webmailAvailable || !m.enabled },
          { key: 'password', icon: <KeyRound className="h-4 w-4" />, label: t('mail.password.change') || 'Change the password', onClick: () => actions.changePassword(m) },
          { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('mail.mailboxes.delete') || 'Delete', onClick: () => { void actions.remove(m); }, danger: true, separator: true },
        ]}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('mail.mailboxes.search') || 'Search an address…'} />
        <div className="ml-auto">{createBtn}</div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Mail />}
          text={q ? (t('common.noMatch') || 'No match') : domains.length === 0 ? (t('mail.mailboxes.noDomain') || 'Enable mail on a domain first (Domains tab).') : (t('mail.mailboxes.empty') || 'No mailbox yet.')}
          action={!q ? createBtn ?? undefined : undefined}
        />
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((m) => (
              <li key={m.id} className="rounded-xl bg-bg-secondary px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Link to={`/mail/mailboxes/${m.id}`} className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-text-primary hover:text-accent">{m.address}</Link>
                  {rowMenu(m) ?? <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />}
                </div>
                {m.displayName && <div className="truncate text-xs text-text-muted">{m.displayName}</div>}
                <div className="mt-2"><MailQuotaBar usedBytes={m.usedBytes} quotaMb={m.quotaMb} /></div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                  <MailboxFlags box={m} />
                  {showTenant && <TenantBadge tenantId={m.tenantId} />}
                </div>
              </li>
            ))}
          </ul>
          <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('mail.mailboxes.address') || 'Address'}</th>
                  {showAccount && <th className={thCls}>{t('mail.account') || 'Hosting account'}</th>}
                  {showTenant && <th className={thCls}>{t('hostingCommon.tenant') || 'Workspace'}</th>}
                  <th className={thCls}>{t('mail.mailboxes.quota') || 'Quota'}</th>
                  <th className={thCls}>{t('mail.mailboxes.flags') || 'State'}</th>
                  <th className={`${thCls} w-14`}><span className="sr-only">{t('mail.actions') || 'Actions'}</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id} onClick={() => navigate(`/mail/mailboxes/${m.id}`)} className="cursor-pointer transition-colors hover:bg-bg-hover">
                    <td className="px-4 py-3">
                      <Link to={`/mail/mailboxes/${m.id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-text-primary hover:text-accent">{m.address}</Link>
                      {m.displayName && <div className="text-[11px] text-text-muted">{m.displayName}</div>}
                    </td>
                    {showAccount && <td className="px-4 py-3 font-mono text-xs text-text-secondary">{domains.find((d) => d.id === m.mailDomainId)?.accountUsername ?? `#${m.accountId}`}</td>}
                    {showTenant && <td className="px-4 py-3"><TenantBadge tenantId={m.tenantId} /></td>}
                    <td className="px-4 py-3"><MailQuotaBar usedBytes={m.usedBytes} quotaMb={m.quotaMb} compact /></td>
                    <td className="px-4 py-3"><MailboxFlags box={m} /></td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>{rowMenu(m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <Pager offset={offset} total={total} pageSize={PAGE} onOffset={setOffset} />
        </>
      )}

      {actions.modals}
      <MailboxCreateModal
        open={creating}
        domains={manageableDomains}
        defaultDomainId={mailDomainId ?? null}
        staff={staff}
        onClose={() => setCreating(false)}
        onCreated={(m) => {
          setCreating(false);
          toast.success(t('mail.mailboxes.created', { address: m.address, defaultValue: 'Mailbox {{address}} created' }));
          if (m.generatedPassword) setRevealed({ address: m.address, password: m.generatedPassword });
          void load();
        }}
      />
      <PasswordRevealModal password={revealed?.password ?? null} address={revealed?.address ?? ''} onClose={() => setRevealed(null)} />
    </div>
  );
}
