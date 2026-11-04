import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { Eye, History, KeyRound, RotateCcw, Server, User } from 'lucide-react';
import type {
  DnsRestoreSkipReason, DnsRevisionSource, DnsSnapshotDiff, DnsSnapshotRecord, DnsZoneDetail, DnsZoneRevision, DnsZoneRevisionDetail,
} from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, Pill } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { dnsErrorMessage, toastDnsError } from './dnsErrors';

// History of a DNS zone (migration 038): the revisions filed at each change
// (panel, access keys, the platform's sync), the diff of one of them with the
// current records, and its restore (the records the platform maintains stay).

const ACTION_FALLBACK: Record<string, string> = {
  'record-created': 'Record created',
  'record-updated': 'Record changed',
  'record-deleted': 'Record deleted',
  'zone-created': 'Zone created',
  'zone-updated': 'Zone settings changed',
  'zone-reset': 'Zone reset',
  'template-applied': 'Template applied',
  'zone-restored': 'Revision restored',
  'mail-dns-fix': 'Mail DNS fixed',
  sync: 'Automatic update',
  initial: 'Initial state',
};

export function revisionActionLabel(t: TFunction, action: string): string {
  const key = action.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return t(`dns.history.actions.${key}`) || ACTION_FALLBACK[action] || action;
}

function sourceLabel(t: TFunction, s: DnsRevisionSource): string {
  const fb: Record<DnsRevisionSource, string> = { panel: 'Panel', api: 'API', mcp: 'MCP', system: 'Platform' };
  return t(`dns.history.sources.${s}`) || fb[s];
}

function skipReasonLabel(t: TFunction, r: DnsRestoreSkipReason): string {
  const fb: Record<DnsRestoreSkipReason, string> = {
    generated: 'maintained by the platform',
    protected: 'out of reach',
    invalid: 'no longer valid',
    conflict: 'conflicts with another record',
    limit: 'record limit reached',
  };
  return t(`dns.history.skip.${r}`) || fb[r];
}

const recordText = (r: DnsSnapshotRecord) => `${r.type} ${r.name}${r.priority !== null ? ` ${r.priority}` : ''} ${r.content}`;

function RevisionAuthor({ rev }: { rev: DnsZoneRevision }) {
  const { t } = useTranslation();
  const a = rev.author;
  if (a.kind === 'system') return <span className="inline-flex items-center gap-1"><Server size={12} />{t('dns.history.platform') || 'Platform'}</span>;
  if (a.kind === 'key') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        <KeyRound size={12} className="shrink-0" />
        <span className="truncate">{a.apiKeyName ?? `#${a.apiKeyId}`}</span>
        {a.name && <span className="truncate text-text-muted">({a.name})</span>}
      </span>
    );
  }
  return <span className="inline-flex min-w-0 items-center gap-1"><User size={12} className="shrink-0" /><span className="truncate">{a.name ?? `#${a.userId}`}</span></span>;
}

function SummaryCounts({ s }: { s: DnsZoneRevision['summary'] }) {
  return (
    <span className="inline-flex gap-2 font-mono text-[11px] tabular-nums">
      {s.added > 0 && <span className="text-status-up">+{s.added}</span>}
      {s.removed > 0 && <span className="text-red-400">−{s.removed}</span>}
      {s.changed > 0 && <span className="text-amber-400">~{s.changed}</span>}
    </span>
  );
}

/** Lines of a diff: + added (green), − removed (red), ~ changed (amber, before → after). */
function DiffLines({ diff }: { diff: DnsSnapshotDiff }) {
  const { t } = useTranslation();
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    return <p className="text-xs text-text-muted">{t('dns.history.noDiff') || 'No difference.'}</p>;
  }
  return (
    <ul className="space-y-0.5 break-all font-mono text-xs">
      {diff.removed.map((r, i) => <li key={`r${i}`} className="text-red-400">− {recordText(r)}</li>)}
      {diff.added.map((r, i) => <li key={`a${i}`} className="text-status-up">+ {recordText(r)}</li>)}
      {diff.changed.map((c, i) => (
        <li key={`c${i}`} className="text-amber-400">
          ~ {recordText(c.before)}
          {(c.fields.includes('content') || c.fields.includes('priority')) && <> → {c.after.priority !== null ? `${c.after.priority} ` : ''}{c.after.content}</>}
          {c.fields.includes('ttl') && <span className="text-text-muted"> · TTL {c.before.ttl} → {c.after.ttl}</span>}
          {c.fields.includes('disabled') && <span className="text-text-muted"> · {c.after.disabled ? (t('dns.records.disabled') || 'Disabled') : (t('dns.history.enabled') || 'Enabled')}</span>}
          {c.fields.includes('comment') && <span className="text-text-muted"> · {t('dns.history.comment') || 'comment'}</span>}
        </li>
      ))}
    </ul>
  );
}

function RevisionModal({ zone, revisionId, manage, onClose, onRestored }: {
  zone: DnsZoneDetail; revisionId: number | null; manage: boolean; onClose: () => void; onRestored: () => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<DnsZoneRevisionDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (revisionId === null) return;
    let live = true;
    setDetail(null);
    setError('');
    dnsApi.getRevision(zone.id, revisionId)
      .then((d) => { if (live) setDetail(d); })
      .catch((err) => { if (live) setError(dnsErrorMessage(t, err, t('dns.history.loadFailed') || 'Failed to load the history')); });
    return () => { live = false; };
  }, [zone.id, revisionId, t]);

  const plan = detail?.plan;
  const canRestore = manage && zone.kind === 'hosted' && !!plan && (plan.add.length > 0 || plan.remove.length > 0);

  const restore = async () => {
    if (!detail || !plan) return;
    if (!(await confirm({
      title: t('dns.history.restoreTitle') || 'Restore this revision',
      message: t('dns.history.restoreConfirm', {
        seq: detail.revision.seq, add: plan.add.length, remove: plan.remove.length,
        defaultValue: 'Put the records of revision #{{seq}} back? {{add}} record(s) written back, {{remove}} removed. The records the platform maintains stay as they are. The restore files a new revision: you can undo it.',
      }),
      confirmLabel: t('dns.history.restore') || 'Restore',
      danger: plan.remove.length > 0,
    }))) return;
    setBusy(true);
    try {
      const r = await dnsApi.restoreRevision(zone.id, detail.revision.id);
      toast.success(r.revision
        ? (t('dns.history.restored', { seq: detail.revision.seq, defaultValue: 'Revision #{{seq}} restored' }))
        : (t('dns.history.nothingToRestore') || 'Nothing to restore: the records already match'));
      onRestored();
      onClose();
    } catch (err) {
      toastDnsError(t, err, t('dns.history.restoreFailed') || 'Failed to restore the revision');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={revisionId !== null}
      onClose={onClose}
      size="xl"
      icon={<History className="h-4 w-4 text-accent" />}
      title={detail
        ? t('dns.history.revisionTitle', { seq: detail.revision.seq, defaultValue: 'Revision #{{seq}}' })
        : (t('dns.history.title') || 'History')}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.close') || 'Close'}</Button>
          {manage && zone.kind === 'hosted' && (
            <Button onClick={() => { void restore(); }} disabled={!canRestore || busy}>
              <RotateCcw size={14} className="mr-1" />{t('dns.history.restore') || 'Restore'}
            </Button>
          )}
        </>
      )}
    >
      {error ? <p className="text-sm text-red-400">{error}</p> : !detail ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span>{new Date(detail.revision.createdAt).toLocaleString(i18n.language)}</span>
            <span>·</span>
            <span>{revisionActionLabel(t, detail.revision.action)}</span>
            <span>·</span>
            <RevisionAuthor rev={detail.revision} />
            <Pill>{sourceLabel(t, detail.revision.source)}</Pill>
          </div>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-text-primary">{t('dns.history.sinceTitle') || 'Changes since this revision'}</h3>
            <p className="mb-2 text-[11px] text-text-muted">{t('dns.history.sinceHint') || 'From this revision to the current records.'}</p>
            <DiffLines diff={detail.diff} />
          </section>
          {plan && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold text-text-primary">{t('dns.history.planTitle') || 'What a restore would do'}</h3>
              {!plan.add.length && !plan.remove.length ? (
                <p className="text-xs text-text-muted">{t('dns.history.planEmpty') || 'Nothing: the records you can restore already match this revision.'}</p>
              ) : (
                <DiffLines diff={{ added: plan.add, removed: plan.remove, changed: [] }} />
              )}
              {plan.skipped.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-[11px] text-text-muted">{t('dns.history.skippedTitle') || 'Left as they are:'}</p>
                  <ul className="space-y-0.5 break-all font-mono text-xs text-text-muted">
                    {plan.skipped.map((s, i) => (
                      <li key={i}>{s.op === 'add' ? '+' : '−'} {recordText(s.record)} <span className="font-sans">· {skipReasonLabel(t, s.reason)}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-text-primary">
              {t('dns.history.recordsTitle', { count: detail.records.length, defaultValue: 'Records of this revision ({{count}})' })}
            </h3>
            <ul className="max-h-56 space-y-0.5 overflow-y-auto break-all font-mono text-xs text-text-secondary">
              {detail.records.map((r, i) => <li key={i} className={cn(r.disabled && 'opacity-60')}>{recordText(r)} <span className="text-text-muted">TTL {r.ttl}</span></li>)}
            </ul>
          </section>
        </div>
      )}
    </Modal>
  );
}

/** History tab of a zone: its revisions, most recent first. `refreshKey` changes when the zone changes. */
export function DnsZoneHistoryCard({ zone, manage, refreshKey, onRestored }: {
  zone: DnsZoneDetail; manage: boolean; refreshKey: string; onRestored: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [revisions, setRevisions] = useState<DnsZoneRevision[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setRevisions(await dnsApi.listRevisions(zone.id));
      setError('');
    } catch (err) {
      setError(dnsErrorMessage(t, err, t('dns.history.loadFailed') || 'Failed to load the history'));
    }
  }, [zone.id, t]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <Card title={t('dns.history.title') || 'History'} icon={<History size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">
        {t('dns.history.intro') || 'Each change of the records files a revision: in the panel, by an access key, or by the platform itself (sites, subdomains, mail). Open one to compare it with the current records and restore it.'}
      </p>
      {error ? <p className="text-sm text-red-400">{error}</p> : revisions === null ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : revisions.length === 0 ? (
        <p className="py-6 text-center text-xs text-text-muted">{t('dns.history.empty') || 'No revision yet: the first one is filed at the next change or sync.'}</p>
      ) : (
        <ul className="divide-y divide-bg-tertiary">
          {revisions.map((rev, i) => (
            <li key={rev.id} className="flex items-start gap-3 py-2.5">
              <span className="mt-0.5 w-10 shrink-0 font-mono text-xs text-text-muted">#{rev.seq}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-medium text-text-primary">{revisionActionLabel(t, rev.action)}</span>
                  {rev.restoredFromSeq !== null && (
                    <span className="text-xs text-text-muted">{t('dns.history.fromSeq', { seq: rev.restoredFromSeq, defaultValue: '(from #{{seq}})' })}</span>
                  )}
                  {i === 0 && <Pill tone="accent">{t('dns.history.current') || 'current'}</Pill>}
                  <SummaryCounts s={rev.summary} />
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
                  <span>{new Date(rev.createdAt).toLocaleString(i18n.language)}</span>
                  <span>·</span>
                  <RevisionAuthor rev={rev} />
                  <Pill>{sourceLabel(t, rev.source)}</Pill>
                </div>
                {rev.summary.lines.length > 0 && rev.action !== 'initial' && (
                  <ul className="mt-1 space-y-0.5 break-all font-mono text-[11px] text-text-muted">
                    {rev.summary.lines.slice(0, 3).map((l, j) => <li key={j}>{l}</li>)}
                    {rev.summary.added + rev.summary.removed + rev.summary.changed > 3 && <li>…</li>}
                  </ul>
                )}
              </div>
              <IconButton label={t('dns.history.view') || 'Compare / restore'} icon={<Eye size={13} />} size="sm" onClick={() => setOpen(rev.id)} />
            </li>
          ))}
        </ul>
      )}
      <RevisionModal
        zone={zone}
        revisionId={open}
        manage={manage}
        onClose={() => setOpen(null)}
        onRestored={() => { onRestored(); void load(); }}
      />
    </Card>
  );
}
