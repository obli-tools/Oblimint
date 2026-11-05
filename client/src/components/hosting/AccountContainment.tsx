import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, ExternalLink, RotateCw, ShieldAlert, ShieldOff, XCircle } from 'lucide-react';
import type {
  AccountContainment, ContainmentAuditRow, ContainmentClientReset, ContainmentOpenWindow, ContainmentStatus, ContainmentStep, HostingAccount, WindowStatus,
} from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Pill, type Tone } from '@/components/common/Pill';
import { Card, toastHostingError } from '@/components/hosting/hostingUi';
import { WindowStatusBadge } from '@/components/maintenance/MaintenanceBadges';

const STATUS_TONE: Record<ContainmentStatus, Tone> = { running: 'blue', partial: 'orange', active: 'red', lifted: 'muted' };
const TEXTAREA = 'w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

/** Confirmation of the containment: what it does, an optional reason. The step-up comes from the API. */
export function ContainModal({ account, open, onClose, onDone }: {
  account: HostingAccount; open: boolean; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const report = await accountsApi.contain(account.id, { reason: reason.trim() || null });
      if (report.status === 'active') toast.success(t('accounts.containment.done') || 'Account contained');
      else toast.error(t('accounts.containment.incomplete') || 'Containment incomplete: see the report and resume');
      setReason('');
      onClose();
      onDone();
    } catch (err) {
      toastHostingError(t, err, t('accounts.containment.failed') || 'Containment failed');
    } finally {
      setBusy(false);
    }
  };
  const effects = [
    t('accounts.containment.effects.credentials') || 'Revokes the access keys, connectors and window tokens, and ends the client sessions.',
    t('accounts.containment.effects.sftp') || 'Cuts SFTP: new unknown password, SSH keys removed, ports closed (SQL from outside too), and ends the external SQL connections already open. The site\'s are never touched.',
    t('accounts.containment.effects.publish') || 'Puts the sites in approval mode and closes the open windows: their changes wait for a review and stay served until the staff rejects them.',
    t('accounts.containment.effects.evidence') || 'Freezes the staging / release diff and the audit over ±72 h.',
    t('accounts.containment.effects.serving') || 'The sites keep serving, and their database passwords do not change. Only the staff can lift it.',
  ];
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<ShieldAlert size={18} className="text-red-400" />}
      title={t('accounts.containment.title', { username: account.username, defaultValue: 'Contain {{username}}' })}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('common.cancel') || 'Cancel'}</Button>
          <Button variant="danger" onClick={() => { void submit(); }} loading={busy}>{t('accounts.containment.action') || 'Contain'}</Button>
        </>
      )}
    >
      <ul className="mb-3 flex list-disc flex-col gap-1 pl-5 text-sm text-text-secondary">
        {effects.map((e) => <li key={e}>{e}</li>)}
      </ul>
      <label className="mb-1 block text-xs text-text-muted" htmlFor="containment-reason">{t('accounts.containment.reason') || 'Reason (optional)'}</label>
      <textarea id="containment-reason" className={TEXTAREA} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}

function StepIcon({ step }: { step: ContainmentStep }) {
  if (step.status === 'done') return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-status-up" />;
  if (step.status === 'failed') return <XCircle size={14} className="mt-0.5 shrink-0 text-red-400" />;
  return <CircleDashed size={14} className="mt-0.5 shrink-0 text-text-muted" />;
}

/** Closing a window takes nothing back: said wherever the staff decides, with the way to the review. */
function ServedWindows({ windows }: { windows: ContainmentOpenWindow[] }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/5 p-3 text-xs">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="min-w-0">
        <p className="font-medium text-amber-400">{t('accounts.containment.windows.title') || 'Window content still served'}</p>
        <p className="mb-1.5 text-text-secondary">{t('accounts.containment.windows.warning') || 'The content of a closed window stays served until the staff rejects it. Closing a window takes nothing back from the site.'}</p>
        <ul className="flex flex-col gap-1">
          {windows.map((w) => (
            <li key={w.windowId} className="flex flex-wrap items-center gap-2 text-text-primary">
              {t('accounts.containment.windows.item', { number: w.number, site: w.siteName, defaultValue: 'Window #{{number}} of {{site}}' })}
              <WindowStatusBadge status={w.status as WindowStatus} />
              <Link to={w.reviewPath} className="inline-flex items-center gap-1 text-accent hover:underline">
                {t('accounts.containment.windows.review') || 'Open the review'}<ExternalLink size={12} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ClientResets({ resets }: { resets: ContainmentClientReset[] }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1">
      {resets.map((c) => (
        <li key={c.userId} className="break-words text-xs text-text-primary">
          <span className="font-mono">{c.username}</span>{' '}
          <span className={c.mail === 'sent' || (c.mail === null && c.selfService) ? 'text-text-muted' : 'text-amber-400'}>
            {c.mail
              ? t(`accounts.containment.resets.mail.${c.mail}`) || c.mail
              : c.selfService
                ? t('accounts.containment.resets.selfService') || 'gets a link by e-mail'
                : t('accounts.containment.resets.staffOnly') || 'no link possible (address not verified or sending not configured): the staff sets a password'}
          </span>
          {c.otherAccounts > 0 && <span className="text-text-muted">, {t('accounts.containment.resets.others', { count: c.otherAccounts, defaultValue: '{{count}} other account(s) not contained' })}</span>}
          {c.otherContained > 0 && <span className="text-text-muted">, {t('accounts.containment.resets.othersContained', { count: c.otherContained, defaultValue: '{{count}} other account(s) still contained, reset asked again when they are lifted' })}</span>}
        </li>
      ))}
    </ul>
  );
}

/** The account's containment: a notice for everyone, the report and its actions for the staff. */
export function AccountContainmentPanel({ account, isStaff, canManage, onChanged }: {
  account: HostingAccount; isStaff: boolean; canManage: boolean; onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [report, setReport] = useState<AccountContainment | null>(null);
  const [audit, setAudit] = useState<{ items: ContainmentAuditRow[]; total: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [lifting, setLifting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const contained = !!account.containedAt;

  const load = useCallback(async () => {
    if (!isStaff || !canManage) return;
    try {
      setReport(await accountsApi.containment(account.id));
    } catch { /* the notice stays; the report is a convenience */ }
  }, [account.id, isStaff, canManage]);
  useEffect(() => { void load(); }, [load, account.containedAt]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const stepLabel = (key: string) => t(`accounts.containment.steps.${key}`) || key;

  const resume = async () => {
    setBusy(true);
    try {
      const r = await accountsApi.contain(account.id, {});
      setReport(r);
      if (r.status === 'active') toast.success(t('accounts.containment.done') || 'Account contained');
      else toast.error(t('accounts.containment.incomplete') || 'Containment incomplete: see the report and resume');
      onChanged();
    } catch (err) {
      toastHostingError(t, err, t('accounts.containment.failed') || 'Containment failed');
    } finally {
      setBusy(false);
    }
  };
  const lift = async () => {
    setBusy(true);
    try {
      const r = await accountsApi.liftContainment(account.id, { note: note.trim() || null });
      setReport(r);
      setLifting(false);
      setNote('');
      toast.success(t('accounts.containment.lifted') || 'Containment lifted');
      onChanged();
    } catch (err) {
      toastHostingError(t, err, t('accounts.containment.liftFailed') || 'Could not lift the containment');
    } finally {
      setBusy(false);
    }
  };
  const openAudit = async () => {
    try {
      setAudit(await accountsApi.containmentAudit(account.id));
    } catch (err) {
      toastHostingError(t, err, t('accounts.containment.auditFailed') || 'Could not read the frozen audit');
    }
  };

  const notice = contained ? (
    <div className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/5 p-3 text-xs text-red-400">
      <ShieldAlert size={14} className="mt-0.5 shrink-0" />
      <span>
        {isStaff
          ? (t('accounts.containment.bannerStaff', { date: fmt(account.containedAt ?? null), defaultValue: 'Contained since {{date}}: the sites serve, access is cut, nothing that opens access can be created until the containment is lifted.' }))
          : (t('accounts.containment.bannerClient') || 'This account is contained after a security incident: your sites keep serving, but access and changes are suspended. Contact your host: only they can lift it.')}
      </span>
    </div>
  ) : null;

  if (!report || (!contained && !isStaff)) return notice;

  const failed = report.steps.filter((s) => s.status !== 'done').length;
  const sqlUnreliable = report.sqlSessions.filter((i) => i.state === 'unreliable');
  const done = report.steps.length - failed;
  const live = report.status !== 'lifted';
  return (
    <>
      {notice}
      <Card
        icon={<ShieldOff size={16} className="text-text-muted" />}
        title={t('accounts.containment.report') || 'Containment'}
        actions={(
          <>
            <Pill tone={STATUS_TONE[report.status]}>{t(`accounts.containment.status.${report.status}`) || report.status}</Pill>
            {live && report.status !== 'active' && (
              <Button size="sm" variant="secondary" onClick={() => { void resume(); }} loading={busy}><RotateCw size={14} className="mr-1" />{t('accounts.containment.resume') || 'Resume'}</Button>
            )}
            {live && <Button size="sm" variant="danger" onClick={() => setLifting(true)} disabled={busy}>{t('accounts.containment.lift') || 'Lift'}</Button>}
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? <ChevronDown size={14} className="mr-1" /> : <ChevronRight size={14} className="mr-1" />}
              {t('accounts.containment.details') || 'Details'}
            </Button>
          </>
        )}
      >
        <p className="text-xs text-text-muted">
          {t('accounts.containment.summary', {
            date: fmt(report.startedAt), by: report.startedByName ?? '—', done, total: report.steps.length,
            defaultValue: 'Started {{date}} by {{by}}: {{done}} of {{total}} steps done.',
          })}
          {report.reason ? ` ${report.reason}` : ''}
        </p>
        {report.status === 'lifted' && (
          <p className="mt-1 text-xs text-text-muted">
            {t('accounts.containment.liftedSummary', { date: fmt(report.liftedAt), by: report.liftedByName ?? '—', defaultValue: 'Lifted {{date}} by {{by}}. Old keys, tokens and SFTP password stay revoked: create new ones.' })}
            {report.liftNote ? ` ${report.liftNote}` : ''}
          </p>
        )}
        {report.liftWarnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-400">{w}</p>)}
        {sqlUnreliable.length > 0 && (
          <p className="mt-1 text-xs text-amber-400">
            {t('accounts.containment.sql.title') || 'External SQL connections'} ({sqlUnreliable.map((i) => i.name).join(', ')}) : {t('accounts.containment.sql.unreliable') || 'site / external could not be told apart: nothing was ended on this engine, check by hand'}
          </p>
        )}
        {report.reviewWindows.length > 0 && <ServedWindows windows={report.reviewWindows} />}
        {report.status === 'lifted' && report.clientPasswordResets.length > 0 && (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium text-text-secondary">{t('accounts.containment.resets.title') || 'Client passwords'}</h3>
            <ClientResets resets={report.clientPasswordResets} />
          </div>
        )}
        {expanded && (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-medium text-text-secondary">{t('accounts.containment.stepsTitle') || 'Steps'}</h3>
              <ul className="flex flex-col gap-1.5">
                {report.steps.map((s) => (
                  <li key={s.key} className="flex items-start gap-2 text-xs">
                    <StepIcon step={s} />
                    <span className="min-w-0 text-text-primary">
                      {stepLabel(s.key)}
                      {s.count !== null && s.count > 0 && <span className="ml-1 font-mono text-text-muted">({s.count})</span>}
                      {s.error && <span className="block break-words text-red-400">{s.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <div>
                <h3 className="mb-2 text-xs font-medium text-text-secondary">{t('accounts.containment.credentials') || 'Credentials revoked'}</h3>
                {report.credentials.length === 0
                  ? <p className="text-xs text-text-muted">{t('accounts.containment.none') || 'None'}</p>
                  : (
                    <ul className="flex flex-col gap-1">
                      {report.credentials.map((c) => (
                        <li key={`${c.family}:${c.id}`} className="break-words text-xs text-text-primary">
                          <span className="text-text-muted">{t(`accounts.containment.family.${c.family}`) || c.family}</span> {c.name}
                          {c.ref && <span className="ml-1 font-mono text-text-muted">{c.ref}</span>}
                          {c.lastUsedAt && <span className="ml-1 text-text-muted">{fmt(c.lastUsedAt)}{c.lastUsedIp ? `, ${c.lastUsedIp}` : ''}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
              {report.accessRules.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-medium text-text-secondary">{t('accounts.containment.rules') || 'Allow-list rules to review before lifting'}</h3>
                  <ul className="flex flex-col gap-1">
                    {report.accessRules.map((r) => <li key={r.cidr} className="break-words font-mono text-xs text-text-primary">{r.cidr}{r.note ? ` (${r.note})` : ''}</li>)}
                  </ul>
                </div>
              )}
              {report.sqlSessions.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-medium text-text-secondary">{t('accounts.containment.sql.title') || 'External SQL connections'}</h3>
                  <ul className="flex flex-col gap-1.5">
                    {report.sqlSessions.map((i) => (
                      <li key={i.instanceId} className="break-words text-xs text-text-primary">
                        {i.name} <span className="text-text-muted">({i.engine})</span>{' '}
                        <span className={i.state === 'unreliable' || i.state === 'failed' ? 'text-amber-400' : 'text-text-muted'}>
                          {t(`accounts.containment.sql.${i.state}`, { killed: i.killed, kept: i.kept, defaultValue: i.state })}
                        </span>
                        {i.error && <span className="block break-words text-red-400">{i.error}</span>}
                        {i.sessions.length > 0 && (
                          <span className="block font-mono text-[11px] text-text-muted">{i.sessions.map((s) => `${s.user}@${s.ip}`).join(', ')}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="mb-2 text-xs font-medium text-text-secondary">{t('accounts.containment.frozenDiff') || 'Frozen staging / release diff'}</h3>
                <ul className="flex flex-col gap-2">
                  {report.sites.map((s) => (
                    <li key={s.siteId} className="text-xs text-text-primary">
                      {s.siteName}{' '}
                      <span className="text-text-muted">
                        {s.note
                          ? (t(`accounts.containment.freezeNote.${s.note}`) || s.note)
                          : t('accounts.containment.frozenCount', { count: s.total, defaultValue: '{{count}} path(s) differ' })}
                      </span>
                      {s.entries.length > 0 && (
                        <ul className="mt-1 max-h-32 overflow-auto rounded-lg bg-bg-tertiary p-2 font-mono text-[11px] text-text-secondary">
                          {s.entries.map((e) => <li key={e.path} className="break-all">{e.status} {e.path}</li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-xs font-medium text-text-secondary">{t('accounts.containment.frozenAudit') || 'Frozen audit'}</h3>
                <p className="text-xs text-text-muted">
                  {t('accounts.containment.auditSpan', { count: report.auditCount, from: fmt(report.auditFrom), until: fmt(report.auditUntil), defaultValue: '{{count}} entries, {{from}} to {{until}}' })}
                </p>
                {audit === null
                  ? <Button size="sm" variant="ghost" className="mt-1" onClick={() => { void openAudit(); }}>{t('accounts.containment.showAudit') || 'Show'}</Button>
                  : (
                    <ul className="mt-1 max-h-48 overflow-auto rounded-lg bg-bg-tertiary p-2 font-mono text-[11px] text-text-secondary">
                      {audit.items.map((a) => <li key={a.id} className="break-all">{fmt(a.createdAt)} {a.action} {a.ipAddress ?? ''}</li>)}
                    </ul>
                  )}
              </div>
            </div>
          </div>
        )}
      </Card>
      <Modal
        open={lifting}
        onClose={() => setLifting(false)}
        icon={<ShieldOff size={18} className="text-text-muted" />}
        title={t('accounts.containment.liftTitle') || 'Lift the containment'}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setLifting(false)} disabled={busy}>{t('common.cancel') || 'Cancel'}</Button>
            <Button variant="danger" onClick={() => { void lift(); }} loading={busy}>{t('accounts.containment.lift') || 'Lift'}</Button>
          </>
        )}
      >
        <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-500/5 p-3">
          <p className="mb-2 text-sm text-text-primary">{t('accounts.containment.resets.effect') || 'The lift forces a password reset for each client of the account: the old one is refused, sessions and connectors end. The password belongs to the login: access to its other accounts also waits for this reset.'}</p>
          {report.clientPasswordResets.length === 0
            ? <p className="text-xs text-text-muted">{t('accounts.containment.resets.none') || 'No client on this account.'}</p>
            : <ClientResets resets={report.clientPasswordResets} />}
        </div>
        {report.reviewWindows.length > 0 && <div className="mb-3"><ServedWindows windows={report.reviewWindows} /></div>}
        <p className="mb-3 text-sm text-text-secondary">
          {t('accounts.containment.liftConfirm') || 'The publish modes and the file server come back. Old keys, tokens, SSH keys and the SFTP password stay revoked. Review the frozen diff and the allow-list rules first. A fresh second-factor code is asked.'}
        </p>
        <label className="mb-1 block text-xs text-text-muted" htmlFor="containment-note">{t('accounts.containment.note') || 'Note (optional)'}</label>
        <textarea id="containment-note" className={TEXTAREA} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </>
  );
}
