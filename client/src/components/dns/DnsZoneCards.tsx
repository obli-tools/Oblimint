import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CheckCircle2, FileStack, KeyRound, ListChecks, RotateCcw, Settings2, Signpost, XCircle } from 'lucide-react';
import type { DnsDelegationCheck, DnsExpectedRecord, DnsTemplate, DnsZoneDetail, DnsZoneKind } from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, CopyButton, InfoRow, Pill, inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { zoneKindLabel } from './DnsBadges';
import { CopyField } from './DomainOwnershipCard';
import { TTL_MAX, TTL_MIN } from './dnsRecords';
import { dnsErrorMessage, toastDnsError } from './dnsErrors';

// ── settings: kind, default TTL, DNSSEC (+ DS records) ──────────────────────

export function ZoneSettingsCard({ zone, manage, onChanged }: { zone: DnsZoneDetail; manage: boolean; onChanged: (z: DnsZoneDetail) => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [ttl, setTtl] = useState(String(zone.defaultTtl));
  const [busy, setBusy] = useState<'ttl' | 'dnssec' | 'kind' | null>(null);
  // Also give that TTL to every record written by hand / from a template (auto records always follow the default).
  const [ttlAll, setTtlAll] = useState(false);
  useEffect(() => { setTtl(String(zone.defaultTtl)); }, [zone.defaultTtl]);

  const ttlNum = /^\d+$/.test(ttl.trim()) ? Number(ttl.trim()) : NaN;
  const ttlValid = ttlNum >= TTL_MIN && ttlNum <= TTL_MAX;
  const hosted = zone.kind === 'hosted';

  const update = async (what: 'ttl' | 'dnssec' | 'kind', body: Parameters<typeof dnsApi.updateZone>[1], okMsg: string) => {
    setBusy(what);
    try {
      onChanged(await dnsApi.updateZone(zone.id, body));
      toast.success(okMsg);
    } catch (err) {
      toastDnsError(t, err, t('dns.zone.saveFailed') || 'Failed to update the zone');
    } finally {
      setBusy(null);
    }
  };

  const toggleDnssec = async (on: boolean) => {
    if (!on && !(await confirm({
      title: t('dns.dnssec.disableTitle') || 'Disable DNSSEC',
      message: t('dns.dnssec.disableConfirm') || 'Remove the DS records at your registrar FIRST and wait for their TTL to expire: otherwise the domain stops resolving for validating resolvers. Disable DNSSEC now?',
      confirmLabel: t('common.disable') || 'Disable',
      danger: true,
    }))) return;
    await update('dnssec', { dnssec: on }, on ? (t('dns.dnssec.enabled') || 'DNSSEC enabled: publish the DS record at your registrar') : (t('dns.dnssec.disabled') || 'DNSSEC disabled'));
  };

  const changeKind = async (kind: DnsZoneKind) => {
    if (kind === zone.kind) return;
    if (!(await confirm({
      title: t('dns.zone.kindChangeTitle') || 'Change where the DNS is hosted',
      message: kind === 'external'
        ? (t('dns.zone.toExternalConfirm') || 'The zone stops being served by our name servers. Create the listed records at your DNS provider and update the delegation at your registrar first. Continue?')
        : (t('dns.zone.toHostedConfirm') || 'The zone will be served by our name servers once the domain is verified. Then set our name servers at your registrar. Continue?'),
    }))) return;
    await update('kind', { kind }, t('dns.zone.saved') || 'Zone updated');
  };

  return (
    <Card title={t('dns.zone.settings') || 'Zone settings'} icon={<Settings2 size={14} className="text-accent" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="zone-kind-set">{t('dns.zone.kind') || 'Kind'}</label>
            <select
              id="zone-kind-set"
              value={zone.kind}
              disabled={!manage || busy !== null || zone.accountId === null}
              onChange={(e) => { void changeKind(e.target.value as DnsZoneKind); }}
              className={selectCls}
            >
              <option value="hosted">{zoneKindLabel(t, 'hosted')}</option>
              <option value="external">{zoneKindLabel(t, 'external')}</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="zone-ttl">{t('dns.zone.defaultTtl') || 'Default TTL (seconds)'}</label>
            <div className="flex gap-2">
              <input
                id="zone-ttl"
                value={ttl}
                inputMode="numeric"
                disabled={!manage || !hosted}
                onChange={(e) => setTtl(e.target.value)}
                className={cn(inputCls, 'font-mono', !ttlValid && 'ring-2 ring-status-down')}
              />
              {manage && hosted && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === 'ttl'}
                  disabled={!ttlValid || (ttlNum === zone.defaultTtl && !ttlAll) || busy !== null}
                  onClick={() => {
                    void update('ttl', { defaultTtl: ttlNum, ...(ttlAll ? { applyTtlToRecords: true } : {}) }, t('dns.zone.saved') || 'Zone updated');
                    setTtlAll(false);
                  }}
                >
                  {t('common.save') || 'Save'}
                </Button>
              )}
            </div>
            {!ttlValid && <p className="mt-1 text-xs text-status-down">{t('dns.validation.ttlRange') || `TTL between ${TTL_MIN} and ${TTL_MAX} seconds.`}</p>}
            {manage && hosted && (
              <label className="mt-1.5 inline-flex cursor-pointer items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={ttlAll} onChange={(e) => setTtlAll(e.target.checked)} />
                {t('dns.zone.applyTtlToRecords') || 'Also apply it to every existing record'}
              </label>
            )}
          </div>
        </div>
        {hosted && (
          <ToggleSwitch
            checked={zone.dnssec}
            disabled={!manage || busy !== null}
            onChange={(v) => { void toggleDnssec(v); }}
            label={<span className="inline-flex items-center gap-1.5"><KeyRound size={13} />DNSSEC</span>}
            description={t('dns.dnssec.hint') || 'Signs the zone (ECDSA P-256). Publish the DS record below at your registrar to activate the chain of trust.'}
          />
        )}
        {hosted && zone.dnssec && zone.dnssecInfo && zone.dnssecInfo.ds.length > 0 && (
          <div className="space-y-2">
            <div className={labelCls}>{t('dns.dnssec.ds') || 'DS records to publish at the registrar'}</div>
            {zone.dnssecInfo.ds.map((ds) => (
              <div key={ds} className="flex items-start gap-1 rounded-md bg-bg-primary py-1 pl-2.5 pr-1">
                <span className="min-w-0 flex-1 break-all py-0.5 font-mono text-[12px] text-text-primary">{ds}</span>
                <CopyButton text={ds} className="shrink-0" />
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── what to set at the registrar / the DNS provider ─────────────────────────

function purposeLabel(t: ReturnType<typeof useTranslation>['t'], p: string): string {
  const fb: Record<string, string> = {
    web: 'Web', www: 'www', mail: 'Mail', spf: 'SPF', dmarc: 'DMARC', verification: 'Ownership', delegation: 'Delegation',
  };
  const key = `dns.expected.purpose.${p}`;
  const v = t(key);
  return v && v !== key ? v : (fb[p] ?? p);
}

/** Hosted: our name servers to set at the registrar. External: the records to create at the provider. */
export function ExpectedRecordsCard({ zone }: { zone: DnsZoneDetail }) {
  const { t } = useTranslation();
  if (zone.kind === 'hosted') {
    if (zone.nameservers.length === 0) return null;
    return (
      <Card title={t('dns.expected.nsTitle') || 'Name servers to set at the registrar'} icon={<Signpost size={14} className="text-accent" />}>
        <p className="mb-2 text-xs text-text-muted">{t('dns.expected.nsHelp') || 'Declare these name servers at the registrar of the domain so that this zone is served.'}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {zone.nameservers.map((ns) => <CopyField key={ns} label="NS" value={ns} />)}
        </div>
      </Card>
    );
  }
  const rows: DnsExpectedRecord[] = zone.expected;
  return (
    <Card title={t('dns.expected.title') || 'Records to create at your DNS provider'} icon={<ListChecks size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">
        {t('dns.expected.help') || 'The DNS of this domain is hosted elsewhere: create these records at your provider. Nothing is published by our name servers.'}
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">{t('dns.expected.none') || 'Nothing to create.'}</p>
      ) : (
        <GroupedTable<DnsExpectedRecord>
          singleGroupFlat
          className="bg-bg-primary"
          minWidth={640}
          groups={[{ key: 'expected', label: '', sortLabel: '', nodes: flatNodes(rows, (r) => `${r.type}|${r.name}|${r.content}`) }]}
          renderCard={(r) => (
            <div className="space-y-1 rounded-lg bg-bg-primary p-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Pill tone="accent">{r.type}</Pill>
                <Pill>{purposeLabel(t, r.purpose)}</Pill>
                {r.priority != null && <span className="font-mono text-text-muted">{t('dns.records.fields.priority') || 'Priority'} {r.priority}</span>}
              </div>
              <CopyField label={t('dns.records.fields.name') || 'Name'} value={r.name} />
              <CopyField label={t('dns.records.fields.content') || 'Content'} value={r.content} />
            </div>
          )}
          columns={[
            { id: 'name', header: t('dns.records.fields.name') || 'Name', sort: (r) => r.name, cell: (r) => <span className="inline-flex items-center gap-1 break-all font-mono text-xs">{r.name}<CopyButton text={r.name} /></span> },
            { id: 'type', header: t('dns.records.fields.type') || 'Type', tdClassName: 'font-mono text-xs text-accent', sort: (r) => r.type, cell: (r) => r.type },
            { id: 'priority', header: t('dns.records.fields.priority') || 'Priority', tdClassName: 'font-mono text-xs', sort: (r) => r.priority ?? null, cell: (r) => r.priority ?? '—' },
            { id: 'content', header: t('dns.records.fields.content') || 'Content', sort: (r) => r.content, cell: (r) => <span className="inline-flex items-center gap-1 break-all font-mono text-xs">{r.content}<CopyButton text={r.content} /></span> },
            { id: 'purpose', header: t('dns.expected.purpose.title') || 'Purpose', tdClassName: 'text-xs text-text-muted', sort: (r) => purposeLabel(t, r.purpose), cell: (r) => purposeLabel(t, r.purpose) },
          ]}
        />
      )}
    </Card>
  );
}

// ── delegation check ────────────────────────────────────────────────────────

export function DelegationCard({ zone }: { zone: DnsZoneDetail }) {
  const { t, i18n } = useTranslation();
  const [check, setCheck] = useState<DnsDelegationCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await dnsApi.checkDelegation(zone.id));
    } catch (err) {
      setError(dnsErrorMessage(t, err, t('dns.delegation.failed') || 'The delegation check failed'));
    } finally {
      setBusy(false);
    }
  };

  const expected = check?.expectedNameservers ?? zone.nameservers;
  return (
    <Card
      title={t('dns.delegation.title') || 'Delegation'}
      icon={<Signpost size={14} className="text-accent" />}
      actions={(
        <Button size="sm" variant="secondary" loading={busy} onClick={() => { void run(); }}>
          {t('dns.delegation.check') || 'Check'}
        </Button>
      )}
    >
      {!check ? (
        <p className="text-xs text-text-muted">
          {error ?? (t('dns.delegation.help') || 'Asks the public resolvers which name servers the domain points to, and compares them with ours.')}
        </p>
      ) : (
        <div className="space-y-3">
          <p className={cn('flex items-center gap-2 text-sm', check.delegated ? 'text-green-400' : 'text-amber-400')}>
            {check.delegated ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            {check.delegated
              ? (t('dns.delegation.ok') || 'The domain is delegated to our name servers.')
              : (t('dns.delegation.notOk') || 'The domain is not (yet) delegated to our name servers.')}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label={t('dns.delegation.public') || 'Public name servers'} mono>
              {check.publicNameservers.length ? check.publicNameservers.map((ns) => (
                <div key={ns} className={cn(expected.includes(ns) ? 'text-text-primary' : 'text-amber-400')}>{ns}</div>
              )) : '—'}
            </InfoRow>
            <InfoRow label={t('dns.delegation.expected') || 'Expected'} mono>
              {expected.length ? expected.map((ns) => <div key={ns}>{ns}</div>) : '—'}
            </InfoRow>
          </div>
          {check.error && <p className="text-xs text-status-down">{check.error}</p>}
          <p className="font-mono text-[11px] text-text-muted">{new Date(check.checkedAt).toLocaleString(i18n.language)}</p>
          {error && <p className="text-xs text-status-down">{error}</p>}
        </div>
      )}
    </Card>
  );
}

// ── reset / apply a template ────────────────────────────────────────────────

export function ZoneResetModal({ open, zone, onClose, onDone }: { open: boolean; zone: DnsZoneDetail; onClose: () => void; onDone: (z: DnsZoneDetail) => void }) {
  const { t } = useTranslation();
  const [keepManual, setKeepManual] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setKeepManual(true); setError(null); } }, [open]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onDone(await dnsApi.resetZone(zone.id, keepManual));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dnsErrorMessage(t, err, t('dns.reset.failed') || 'Failed to reset the zone'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dns.reset.title') || 'Reset the zone'}
      icon={<RotateCcw className="h-4 w-4 text-accent" />}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" variant={keepManual ? 'primary' : 'danger'} loading={saving} onClick={() => { void submit(); }}>{t('dns.reset.confirm') || 'Reset'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{t('dns.reset.text') || 'The automatic records are regenerated from the domains and the settings.'}</p>
        {/* The server always drops auto + template records (keepManual only spares manual ones). */}
        <p className="text-xs text-amber-400">
          {t('dns.reset.templateWarning') || 'Records that came from a template are deleted, then recreated only from the template linked to the zone (if any). Template records you edited are manual and follow the option below.'}
        </p>
        <ToggleSwitch
          checked={keepManual}
          onChange={setKeepManual}
          label={t('dns.reset.keepManual') || 'Keep my manual records'}
          description={keepManual ? undefined : (t('dns.reset.dropWarning') || 'Every manual record is deleted as well.')}
        />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

export function ApplyTemplateModal({ open, zone, onClose, onDone }: { open: boolean; zone: DnsZoneDetail; onClose: () => void; onDone: (z: DnsZoneDetail) => void }) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<DnsTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTemplateId(''); setError(null); setTemplates(null);
    dnsApi.listTemplates({ tenantId: zone.tenantId })
      .then((list) => { setTemplates(list); const def = list.find((x) => x.isDefault); if (def) setTemplateId(def.id); })
      .catch((err) => { setTemplates([]); setError(dnsErrorMessage(t, err, t('dns.templates.loadFailed') || 'Failed to load the templates')); });
  }, [open, zone.tenantId, t]);

  const selected = templates?.find((x) => x.id === templateId) ?? null;

  const submit = async () => {
    if (templateId === '') return;
    setSaving(true);
    setError(null);
    try {
      onDone(await dnsApi.applyTemplate(zone.id, templateId));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dnsErrorMessage(t, err, t('dns.templates.applyFailed') || 'Failed to apply the template'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dns.templates.applyTitle') || 'Apply a template'}
      icon={<FileStack className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={templateId === ''} onClick={() => { void submit(); }}>{t('dns.templates.apply') || 'Apply'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="apply-tpl">{t('dns.templates.template') || 'Template'}</label>
          <select id="apply-tpl" value={templateId} disabled={!templates?.length} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
            <option value="">{templates && templates.length === 0 ? (t('dns.templates.empty') || 'No template yet.') : (t('dns.templates.choose') || 'Choose a template…')}</option>
            {(templates ?? []).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
          </select>
        </div>
        {selected && (
          <ul className="space-y-1 rounded-lg bg-bg-primary p-2 font-mono text-[12px]">
            {selected.records.map((r, i) => (
              <li key={i} className="flex min-w-0 gap-2">
                <span className="w-20 shrink-0 truncate text-text-secondary">{r.name}</span>
                <span className="w-12 shrink-0 text-accent">{r.type}</span>
                <span className="min-w-0 break-all">{r.priority != null ? `${r.priority} ` : ''}{r.content}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted">{t('dns.templates.applyHint') || 'The records of the template are added to the zone (placeholders replaced); conflicting records are reported.'}</p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
