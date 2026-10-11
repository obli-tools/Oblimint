import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Circle, Timer, Globe, Info, RefreshCw, RotateCcw, Search, Undo2 } from 'lucide-react';
import {
  HostingSocketEvents, type MigrationCutoverDomain, type MigrationCutoverItem, type MigrationCutoverItemCode, type MigrationUpdatedPayload,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { CopyButton, Pill, headerBtnCls, inputCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatDateTime, paramEntries } from '../migrationFormat';
import { CutoverStatePill, LoadState, checkboxCls, loadErrorOf, toastMigrationError, type LoadError } from '../migrationUi';

const ITEM_FALLBACK: Record<MigrationCutoverItemCode, { label: string; hint: string }> = {
  ttlLowered: { label: 'TTL lowered (≤ 300 s)', hint: 'Lower the TTL where the zone is served now (CWP, or Oblimint once the NS point here), then wait for the old TTL to expire. Checked live on the current name servers.' },
  targetReady: { label: 'Target ready', hint: 'Last initial run done, site published, DNS of the zone active.' },
  finalSync: { label: 'Final sync done', hint: 'A final-sync run succeeded after the TTL was lowered.' },
  nsChanged: { label: 'Name servers changed', hint: 'NS at the registrar point to the platform (live check).' },
  aRecordsChanged: { label: 'Web records changed', hint: 'A / AAAA / www point to the platform (live check).' },
  mxChanged: { label: 'Mail records changed', hint: 'MX (and SPF / DKIM / DMARC) point to the platform (live check).' },
  verified: { label: 'Ownership verified', hint: 'Domain ownership check is OK.' },
  certificateIssued: { label: 'Valid certificate at the switch', hint: "The certificate imported from CWP (or a Let's Encrypt one) is valid for 7 more days at least. Advisory: Let's Encrypt can only issue once the DNS points here, it then replaces the imported one." },
  sourceDisabled: { label: 'Source disabled in CWP', hint: 'Manual: vhost / mail disabled in CWP by the operator.' },
};

/** TTL set by the checklist buttons (zone delegated to our name servers): before the switch, then after it. */
const LOWERED_TTL = 300;
const RAISED_TTL = 3600;

/** Items that never block the switch: shown as a warning when not done. */
const ADVISORY_ITEMS: ReadonlySet<MigrationCutoverItemCode> = new Set(['certificateIssued']);

function ItemRow({ item, disabled, onToggle, onForce, extra }: {
  item: MigrationCutoverItem; disabled: boolean; onToggle: (v: boolean) => void; onForce?: (force: boolean) => void; extra?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const fb = ITEM_FALLBACK[item.code] ?? { label: item.code, hint: '' };
  const forced = item.detail?.forced === true;
  const detail = paramEntries(item.detail).filter(([k]) => k !== 'forced');
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      {item.auto ? (
        <span className="mt-0.5" aria-label={item.done ? (t('migration.cutover.done') || 'done') : (t('migration.cutover.notDone') || 'not done')}>
          {item.done ? <CheckCircle2 size={16} className="text-green-400" />
            : ADVISORY_ITEMS.has(item.code) ? <AlertTriangle size={16} className="text-amber-400" />
            : <Circle size={16} className="text-text-muted" />}
        </span>
      ) : (
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" disabled={disabled} checked={item.done} onChange={(e) => onToggle(e.target.checked)} aria-label={t(`migration.cutover.items.${item.code}.label`, { defaultValue: fb.label })} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={item.done ? 'text-text-primary' : 'text-text-secondary'}>{t(`migration.cutover.items.${item.code}.label`, { defaultValue: fb.label })}</span>
          <Pill tone={item.auto ? 'blue' : 'muted'}>{item.auto ? (t('migration.cutover.auto') || 'auto') : (t('migration.cutover.manual') || 'manual')}</Pill>
          {forced && <Pill tone="amber">{t('migration.cutover.forced') || 'forced'}</Pill>}
          {item.checkedAt && <span className="font-mono text-[10px] text-text-muted">{formatDateTime(item.checkedAt, i18n.language)}</span>}
          {onForce && (forced || !item.done) && (
            <button type="button" disabled={disabled} onClick={() => onForce(!forced)} className="text-[11px] text-accent hover:underline disabled:opacity-50">
              {forced ? (t('migration.cutover.unforce') || 'Remove the force') : (t('migration.cutover.force') || 'Force (with a note)')}
            </button>
          )}
          {extra}
        </div>
        <p className="text-[11px] text-text-muted">{t(`migration.cutover.items.${item.code}.hint`, { defaultValue: fb.hint })}</p>
        {detail.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {detail.map(([k, v]) => <span key={k} className="rounded bg-bg-primary px-1.5 py-px font-mono text-[10px] text-text-secondary">{k}: {v}</span>)}
          </div>
        )}
      </div>
    </li>
  );
}

function CutoverCard({ c, onChanged }: { c: MigrationCutoverDomain; onChanged: (c: MigrationCutoverDomain) => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState(c.notes ?? '');
  useEffect(() => { setNotes(c.notes ?? ''); }, [c.notes]);
  const switched = c.state === 'switched';

  const act = async (key: string, fn: () => Promise<MigrationCutoverDomain>, ok?: string) => {
    setBusy(key);
    try {
      onChanged(await fn());
      if (ok) toast.success(ok);
    } catch (err) {
      toastMigrationError(t, err, t('migration.cutover.actionFailed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  // The zone is delegated to our name servers already (live NS check): its TTL is set here, not at the source.
  const zoneHere = c.mode === 'ns-delegation' && c.items.some((i) => i.code === 'nsChanged' && i.done);
  const zoneTtl = async (ttl: number) => {
    const ok = await confirm({
      title: t('migration.cutover.zoneTtlTitle', { ttl, defaultValue: 'TTL of the zone: {{ttl}} s' }),
      message: t('migration.cutover.zoneTtlMessage', { ttl, defaultValue: 'The default TTL of the zone and of every record written by hand (or migrated) becomes {{ttl}} s on the Oblimint DNS. Resolvers keep the old answers until the previous TTL expires.' }),
      confirmLabel: t('migration.cutover.zoneTtlConfirm') || 'Apply',
    });
    if (!ok) return;
    void act('ttl', () => migrationApi.setCutoverZoneTtl(c.id, ttl), t('migration.cutover.zoneTtlDone', { ttl, defaultValue: 'TTL set to {{ttl}} s' }));
  };

  /** ttlLowered is checked live; the staff may force it (split DNS, anycast…) with a note explaining why. */
  const forceTtl = async (force: boolean) => {
    if (!force) {
      void act('item', () => migrationApi.updateCutover(c.id, { items: { ttlLowered: false } }));
      return;
    }
    const note = await prompt({
      title: t('migration.cutover.forceTitle') || 'Force « TTL lowered »',
      message: t('migration.cutover.forceMessage') || 'The live check can be wrong (split DNS, anycast…). Explain why the TTL is considered lowered: the note is kept with the checklist and audited.',
      defaultValue: c.notes ?? '',
      multiline: true,
      required: true,
      maxLength: 4000,
    });
    if (note == null || !note.trim()) return;
    void act('item', () => migrationApi.updateCutover(c.id, { items: { ttlLowered: true }, notes: note.trim() }));
  };

  const finalSync = async () => {
    if (!(await confirm({
      title: t('migration.cutover.finalSyncTitle') || 'Final sync',
      message: t('migration.cutover.finalSyncConfirm', { fqdn: c.fqdn, defaultValue: 'Start the final sync of the account of {{fqdn}}? Files, data, maildirs are copied again and the databases are RE-IMPORTED (the target databases are overwritten). Do it once the TTL is lowered, just before switching.' }),
      confirmLabel: t('migration.cutover.finalSync') || 'Final sync',
      danger: true,
    }))) return;
    setBusy('final');
    try {
      const run = await migrationApi.finalSync(c.id);
      toast.success(t('migration.cutover.finalSyncStarted') || 'Final sync queued');
      navigate(`/manage/migration/runs/${run.id}`);
    } catch (err) {
      toastMigrationError(t, err, t('migration.cutover.actionFailed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  const doSwitch = async () => {
    if (!(await confirm({
      title: t('migration.cutover.switchTitle') || 'Switch the domain',
      message: t('migration.cutover.switchConfirm', { fqdn: c.fqdn, defaultValue: 'Switch {{fqdn}} to Oblimint: the checklist is marked switched, Let\'s Encrypt takes over the certificate, and from now on the maildirs of this domain are never mirrored (no deletion). Type {{fqdn}} to confirm.' }),
      confirmLabel: t('migration.cutover.switch') || 'Switch',
      danger: true,
      requireText: c.fqdn,
    }))) return;
    void act('switch', () => migrationApi.switchCutover(c.id, { confirm: c.fqdn }), t('migration.cutover.switched') || 'Domain switched');
  };

  const rollback = async () => {
    if (!(await confirm({
      title: t('migration.cutover.rollbackTitle') || 'Roll the switch back',
      message: t('migration.cutover.rollbackConfirm') || 'The checklist goes back to « prepared ». Then put the original NS / records back at the registrar / DNS host. Mail received by Oblimint in between stays here: fetch it by IMAP. Nothing is deleted.',
      confirmLabel: t('migration.cutover.rollback') || 'Roll back',
      danger: true,
    }))) return;
    void act('rollback', () => migrationApi.rollbackCutover(c.id), t('migration.cutover.rolledBack') || 'Switch rolled back');
  };

  return (
    <section className={cn('rounded-xl bg-bg-secondary p-4', switched && 'ring-1 ring-green-500/30')}>
      <div className="flex flex-wrap items-center gap-2">
        <Globe size={15} className="text-accent" />
        <h3 className="font-mono text-base text-text-primary">{c.fqdn}</h3>
        <CutoverStatePill state={c.state} />
        <Pill tone="muted">{c.mode === 'ns-delegation' ? (t('migration.cutover.modes.nsDelegation') || 'NS delegation') : (t('migration.cutover.modes.records') || 'Records')}</Pill>
        <span className="font-mono text-[11px] text-text-muted">{c.cwpUsername}</span>
        {c.targetDomainId != null && <Link to="/domains" className="text-[11px] text-accent hover:underline">#{c.targetDomainId}</Link>}
        {c.observedTtl != null && <Pill tone={c.observedTtl <= 300 ? 'green' : 'amber'}>{t('migration.cutover.observedTtl', { ttl: c.observedTtl, defaultValue: 'TTL seen {{ttl}} s' })}</Pill>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" loading={busy === 'check'} disabled={busy != null} onClick={() => { void act('check', () => migrationApi.checkCutover(c.id)); }}><Search size={13} className="mr-1.5" />{t('migration.cutover.check') || 'Check'}</Button>
          {!switched && <Button size="sm" variant="secondary" loading={busy === 'final'} disabled={busy != null} onClick={() => { void finalSync(); }}><RotateCcw size={13} className="mr-1.5" />{t('migration.cutover.finalSync') || 'Final sync'}</Button>}
          {!switched && <Button size="sm" variant="danger" loading={busy === 'switch'} disabled={busy != null} onClick={() => { void doSwitch(); }}><ArrowRightLeft size={13} className="mr-1.5" />{t('migration.cutover.switch') || 'Switch'}</Button>}
          {switched && <Button size="sm" variant="secondary" loading={busy === 'rollback'} disabled={busy != null} onClick={() => { void rollback(); }}><Undo2 size={13} className="mr-1.5" />{t('migration.cutover.rollback') || 'Roll back'}</Button>}
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <ul className="divide-y divide-white/[0.04]">
          {c.items.map((it) => (
            <ItemRow
              key={it.code}
              item={it}
              disabled={busy != null}
              onToggle={(v) => { void act('item', () => migrationApi.updateCutover(c.id, { items: { [it.code]: v } })); }}
              onForce={it.code === 'ttlLowered' && !switched ? (force) => { void forceTtl(force); } : undefined}
              extra={it.code === 'ttlLowered' && zoneHere ? (
                <button type="button" disabled={busy != null} onClick={() => { void zoneTtl(switched ? RAISED_TTL : LOWERED_TTL); }} className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-50">
                  <Timer size={11} />
                  {switched
                    ? t('migration.cutover.raiseTtl', { ttl: RAISED_TTL, defaultValue: 'Raise the TTL in Oblimint ({{ttl}} s)' })
                    : t('migration.cutover.lowerTtl', { ttl: LOWERED_TTL, defaultValue: 'Lower the TTL in Oblimint ({{ttl}} s)' })}
                </button>
              ) : undefined}
            />
          ))}
        </ul>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
              {c.mode === 'ns-delegation' ? (t('migration.cutover.instructionsNs') || 'Name servers to set at the registrar') : (t('migration.cutover.instructionsRecords') || 'Records to set at the current DNS host')}
            </div>
            {c.instructions.length === 0 ? <p className="text-xs text-text-muted">—</p> : (
              <TableScroll>
                <table className="w-full min-w-[440px] text-xs">
                  <thead><tr className={theadRowCls}>
                    <th className="px-2 py-1.5 font-medium">{t('migration.inventory.recordName') || 'Name'}</th>
                    <th className="px-2 py-1.5 font-medium">{t('migration.inventory.recordType') || 'Type'}</th>
                    <th className="px-2 py-1.5 font-medium">{t('migration.cutover.value') || 'Value'}</th>
                    <th className="px-2 py-1.5 font-medium">TTL</th>
                  </tr></thead>
                  <tbody>
                    {c.instructions.map((r, i) => (
                      <tr key={`${r.name}-${r.type}-${i}`} className="border-t border-white/[0.04]">
                        <td className="px-2 py-1.5 font-mono"><span className="inline-flex items-center gap-1">{r.name}<CopyButton text={r.name} /></span></td>
                        <td className="px-2 py-1.5 font-mono text-text-primary">{r.type}</td>
                        <td className="px-2 py-1.5 font-mono"><span className="inline-flex items-center gap-1 break-all">{r.value}<CopyButton text={r.value} /></span></td>
                        <td className="px-2 py-1.5 font-mono text-text-muted">{r.ttl ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </div>
          <div>
            <label htmlFor={`notes-${c.id}`} className="mb-1 block text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('migration.cutover.notes') || 'Notes'}</label>
            <textarea id={`notes-${c.id}`} rows={2} className={cn(inputCls, 'text-xs')} value={notes} onChange={(e) => setNotes(e.target.value)} />
            {notes !== (c.notes ?? '') && (
              <Button size="sm" variant="secondary" className="mt-1.5" loading={busy === 'notes'} onClick={() => { void act('notes', () => migrationApi.updateCutover(c.id, { notes: notes || null })); }}>{t('common.save') || 'Save'}</Button>
            )}
          </div>
          {switched && c.switchedAt && <p className="text-xs text-green-400">{t('migration.cutover.switchedAt', { date: formatDateTime(c.switchedAt, i18n.language), defaultValue: 'Switched on {{date}}' })}</p>}
          {c.state === 'rolled-back' && <p className="text-xs text-amber-400">{t('migration.cutover.rollbackGuide') || 'Rolled back: restore the original NS / records at the registrar or DNS host. Mail received meanwhile stays in Oblimint (fetch it by IMAP).'}</p>}
        </div>
      </div>
    </section>
  );
}

/** Cutover checklist per migrated domain (docs/P5-PLAN.md §10). */
/** `selected`: CWP accounts selected in the plan (null = unknown: everything shown). */
export function PlanCutoverTab({ planId, selected = null }: { planId: number; selected?: string[] | null }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MigrationCutoverDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await migrationApi.cutover(planId);
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(loadErrorOf(t, err, t('migration.cutover.loadFailed') || 'Failed to load the cutover checklist'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [planId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MigrationUpdatedPayload | null;
    return payload?.entity === 'cutover' && payload.planId === planId;
  }, 800);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      setItems(await migrationApi.refreshCutover(planId));
    } catch (err) {
      toastMigrationError(t, err, t('migration.cutover.refreshFailed') || 'The live checks failed');
    } finally {
      setRefreshing(false);
    }
  };

  // Checklists of the accounts migrated by this plan only (an account unselected since its run stays reachable).
  const [everyAccount, setEveryAccount] = useState(false);
  const keep = selected ? new Set(selected) : null;
  const shown = everyAccount || !keep ? items : items.filter((c) => keep.has(c.cwpUsername));
  const hidden = items.length - shown.length;

  const upsert = (c: MigrationCutoverDomain) => setItems((cur) => cur.map((x) => (x.id === c.id ? c : x)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3 rounded-xl bg-sky-400/5 p-3 text-xs text-text-secondary ring-1 ring-sky-400/20">
        <Info size={14} className="mt-0.5 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1 space-y-1">
          <p>{t('migration.cutover.intro') || 'One checklist per migrated domain: lower the TTL, final sync, change the NS (zone migrated) or the records (zone elsewhere), switch, then Let\'s Encrypt takes over.'}</p>
          <p className="font-medium text-amber-400">{t('migration.cutover.ttlManual') || 'While the zone is served by CWP, lower its TTL there (the panel does not write on the source yet); once the NS point to Oblimint, use « Lower the TTL in Oblimint ».'}</p>
        </div>
        <button type="button" className={headerBtnCls} disabled={refreshing} onClick={() => { void refreshAll(); }}><RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />{t('migration.cutover.refreshAll') || 'Refresh all'}</button>
      </div>
      {(hidden > 0 || everyAccount) && (
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-text-muted">
          <input type="checkbox" checked={everyAccount} onChange={(e) => setEveryAccount(e.target.checked)} className={checkboxCls} />
          {t('migration.warnings.includeUnselected', { count: everyAccount ? items.length - (keep ? items.filter((c) => keep.has(c.cwpUsername)).length : 0) : hidden, defaultValue: 'Include the unselected accounts ({{count}})' })}
        </label>
      )}
      <LoadState loading={loading} error={error} empty={shown.length === 0} emptyIcon={<ArrowRightLeft />} emptyText={t('migration.cutover.empty') || 'No domain to switch yet: the checklist appears after the first successful run of an account.'}>
        <div className="space-y-3">
          {shown.map((c) => <CutoverCard key={c.id} c={c} onChanged={upsert} />)}
        </div>
      </LoadState>
    </div>
  );
}
