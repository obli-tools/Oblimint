import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, ListPlus, Pencil } from 'lucide-react';
import type { DnsRecord, DnsRecordType, DnsZoneDetail } from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { apiErrorCode, inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import {
  CAA_TAGS, RECORD_TYPES, TTL_MAX, TTL_MIN, TTL_PRESETS, emptyRecordForm, fqdnOf, normalizeRecordName, recordFormToInput,
  recordToForm, validateRecordForm, type CaaTag, type RecordField, type RecordForm,
} from './dnsRecords';
import { apiErrorDetails, dnsErrorMessage } from './dnsErrors';

/** Server field name (recordInvalid details.field) → form field to highlight. */
function serverField(field: unknown, type: DnsRecordType, message?: unknown): RecordField | null {
  if (field === 'content') {
    if (type === 'SRV') {
      // The server reports weight, port and target errors all as 'content': tell them apart by its message.
      const m = typeof message === 'string' ? message.toLowerCase() : '';
      return m.includes('weight') ? 'weight' : m.includes('port') ? 'port' : 'target';
    }
    return type === 'CAA' ? 'caaValue' : 'value';
  }
  if (typeof field === 'string' && ['name', 'ttl', 'priority', 'weight', 'port', 'target', 'comment'].includes(field)) return field as RecordField;
  return null;
}

/** Add / edit a record of a hosted zone (per-type fields, client validation mirroring the server). */
export function DnsRecordModal({ open, zone, record, onClose, onSaved }: {
  open: boolean;
  zone: DnsZoneDetail;
  /** null = create. */
  record: DnsRecord | null;
  onClose: () => void;
  onSaved: (r: DnsRecord) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<RecordForm>(emptyRecordForm());
  const [touched, setTouched] = useState<Partial<Record<RecordField, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<RecordField | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(record ? recordToForm(record, zone.defaultTtl) : emptyRecordForm());
    setTouched({}); setSubmitted(false); setError(null); setErrorField(null);
  }, [open, record, zone.defaultTtl]);

  const others = useMemo(() => zone.records.filter((r) => r.origin !== 'system'), [zone.records]);
  const issues = validateRecordForm(form, zone.name, others, record?.id ?? null);
  const issueOf = (f: RecordField) => ((submitted || touched[f]) ? issues.find((i) => i.field === f) : undefined);
  const set = <K extends keyof RecordForm>(k: K, v: RecordForm[K]) => {
    setForm((cur) => ({ ...cur, [k]: v }));
    if (errorField === k) { setErrorField(null); setError(null); }
  };
  const blur = (f: RecordField) => setTouched((cur) => ({ ...cur, [f]: true }));

  const normalizedName = normalizeRecordName(form.name, zone.name);
  const fqdn = 'name' in normalizedName ? fqdnOf(normalizedName.name, zone.name) : null;

  const submit = async () => {
    setSubmitted(true);
    if (issues.length > 0) return;
    setSaving(true);
    setError(null);
    setErrorField(null);
    try {
      const input = recordFormToInput(form, zone.name);
      onSaved(record ? await dnsApi.updateRecord(zone.id, record.id, input) : await dnsApi.createRecord(zone.id, input));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dnsErrorMessage(t, err, t('dns.records.saveFailed') || 'Failed to save the record'));
      if (apiErrorCode(err) === 'recordInvalid') setErrorField(serverField(apiErrorDetails(err)?.field, form.type, (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error));
      else if (apiErrorCode(err) === 'recordConflict') setErrorField('name');
    } finally {
      setSaving(false);
    }
  };

  const field = (f: RecordField, label: ReactNode, input: ReactNode, hint?: ReactNode) => {
    const issue = issueOf(f);
    return (
      <div>
        <label className={labelCls} htmlFor={`rec-${f}`}>{label}</label>
        {input}
        {issue ? (
          <p className="mt-1 text-xs text-status-down">{t(`dns.validation.${issue.key}`) || issue.fallback}</p>
        ) : hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
      </div>
    );
  };
  const invalidCls = (f: RecordField) => ((issueOf(f) || errorField === f) ? 'ring-2 ring-status-down' : '');
  const textInput = (f: RecordField & keyof RecordForm, placeholder: string, opts: { numeric?: boolean; mono?: boolean } = {}) => (
    <input
      id={`rec-${f}`}
      value={form[f] as string}
      onChange={(e) => set(f, e.target.value as never)}
      onBlur={() => blur(f)}
      placeholder={placeholder}
      inputMode={opts.numeric ? 'numeric' : undefined}
      autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
      className={cn(inputCls, opts.mono !== false && 'font-mono', invalidCls(f))}
    />
  );

  const valuePlaceholder: Partial<Record<DnsRecordType, string>> = {
    A: '192.0.2.10', AAAA: '2001:db8::10', CNAME: 'target.example.net', MX: 'mail.example.com', NS: 'ns1.example.net', TXT: 'v=spf1 mx -all',
  };
  const valueLabel: Partial<Record<DnsRecordType, string>> = {
    A: t('dns.records.fields.ipv4') || 'IPv4 address',
    AAAA: t('dns.records.fields.ipv6') || 'IPv6 address',
    CNAME: t('dns.records.fields.target') || 'Target',
    MX: t('dns.records.fields.mailServer') || 'Mail server',
    NS: t('dns.records.fields.nameserver') || 'Name server',
    TXT: t('dns.records.fields.text') || 'Text',
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={record ? (t('dns.records.editTitle') || 'Edit the record') : (t('dns.records.addTitle') || 'Add a record')}
      icon={record ? <Pencil className="h-4 w-4 text-accent" /> : <ListPlus className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={submitted && issues.length > 0} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {record?.origin === 'auto' && (
          <p className="flex items-start gap-2 rounded-lg border border-sky-400/30 bg-sky-400/5 px-3 py-2 text-xs text-sky-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>{t('dns.records.autoEditNotice') || 'This record is generated by the panel. Once edited it becomes a manual record: the panel no longer updates it (for instance when the server IP changes).'}</span>
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
          <div>
            <label className={labelCls} htmlFor="rec-type">{t('dns.records.fields.type') || 'Type'}</label>
            <select
              id="rec-type"
              value={form.type}
              disabled={record !== null}
              onChange={(e) => {
                const type = e.target.value as DnsRecordType;
                setForm((cur) => ({ ...emptyRecordForm(type), name: cur.name, ttl: cur.ttl, comment: cur.comment, disabled: cur.disabled }));
                setTouched({});
              }}
              className={selectCls}
            >
              {RECORD_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
            </select>
          </div>
          {field('name', t('dns.records.fields.name') || 'Name', textInput('name', form.type === 'SRV' ? '_sip._tcp' : '@'),
            fqdn ? <span className="break-all font-mono">{fqdn}</span> : (t('dns.records.nameHint') || '@ = the zone itself.'))}
        </div>

        {(form.type === 'A' || form.type === 'AAAA' || form.type === 'CNAME' || form.type === 'NS') && (
          field('value', valueLabel[form.type], textInput('value', valuePlaceholder[form.type] ?? ''))
        )}
        {form.type === 'MX' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
            {field('priority', t('dns.records.fields.priority') || 'Priority', textInput('priority', '10', { numeric: true }))}
            {field('value', valueLabel.MX, textInput('value', valuePlaceholder.MX ?? ''))}
          </div>
        )}
        {form.type === 'TXT' && field('value', valueLabel.TXT, (
          <textarea
            id="rec-value"
            value={form.value}
            rows={3}
            onChange={(e) => set('value', e.target.value)}
            onBlur={() => blur('value')}
            placeholder={valuePlaceholder.TXT}
            spellCheck={false}
            className={cn(inputCls, 'font-mono', invalidCls('value'))}
          />
        ), t('dns.records.txtHint') || 'Without quotes; long texts are split into 255-character strings automatically.')}
        {form.type === 'SRV' && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[6rem_6rem_6rem_1fr]">
            {field('priority', t('dns.records.fields.priority') || 'Priority', textInput('priority', '10', { numeric: true }))}
            {field('weight', t('dns.records.fields.weight') || 'Weight', textInput('weight', '5', { numeric: true }))}
            {field('port', t('dns.records.fields.port') || 'Port', textInput('port', '5060', { numeric: true }))}
            <div className="col-span-2 sm:col-span-1">
              {field('target', t('dns.records.fields.target') || 'Target', textInput('target', 'sip.example.com'), t('dns.records.srvTargetHint') || '« . » = service not available.')}
            </div>
          </div>
        )}
        {form.type === 'CAA' && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[6rem_9rem_1fr]">
            {field('caaFlags', t('dns.records.fields.flags') || 'Flags', textInput('caaFlags', '0', { numeric: true }))}
            {field('caaTag', t('dns.records.fields.tag') || 'Tag', (
              <select id="rec-caaTag" value={form.caaTag} onChange={(e) => set('caaTag', e.target.value as CaaTag)} className={selectCls}>
                {CAA_TAGS.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            ))}
            <div className="col-span-2 sm:col-span-1">
              {field('caaValue', t('dns.records.fields.value') || 'Value', textInput('caaValue', form.caaTag === 'iodef' ? 'mailto:security@example.com' : 'letsencrypt.org'))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field('ttl', t('dns.records.fields.ttl') || 'TTL (seconds)', (
            <>
              <input
                id="rec-ttl"
                value={form.ttl}
                list="rec-ttl-presets"
                inputMode="numeric"
                onChange={(e) => set('ttl', e.target.value)}
                onBlur={() => blur('ttl')}
                placeholder={t('dns.records.ttlZoneDefault', { ttl: zone.defaultTtl, defaultValue: 'Zone default ({{ttl}})' })}
                className={cn(inputCls, 'font-mono', invalidCls('ttl'))}
              />
              <datalist id="rec-ttl-presets">{TTL_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
            </>
          ), `${TTL_MIN} – ${TTL_MAX}`)}
          {field('comment', t('dns.records.fields.comment') || 'Comment', textInput('comment', '', { mono: false }))}
        </div>
        <ToggleSwitch
          checked={form.disabled}
          onChange={(v) => set('disabled', v)}
          label={t('dns.records.disabled') || 'Disabled'}
          description={t('dns.records.disabledHint') || 'Kept in the panel but not published.'}
        />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
