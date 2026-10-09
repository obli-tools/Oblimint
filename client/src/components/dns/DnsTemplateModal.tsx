import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileStack, Plus, Trash2 } from 'lucide-react';
import type { DnsRecordType, DnsTemplate, DnsTemplateRecord } from '@oblimint/shared';
import { dnsApi } from '@/api/dns.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { RECORD_TYPES, TEMPLATE_PLACEHOLDERS, templateRecordIssue } from './dnsRecords';
import { dnsErrorMessage } from './dnsErrors';

interface Row { name: string; type: DnsRecordType; content: string; ttl: string; priority: string }

const toRow = (r: DnsTemplateRecord): Row => ({
  name: r.name, type: r.type, content: r.content, ttl: r.ttl == null ? '' : String(r.ttl), priority: r.priority == null ? '' : String(r.priority),
});

function toRecord(r: Row): DnsTemplateRecord {
  const num = (s: string) => (s.trim() === '' || !/^\d+$/.test(s.trim()) ? null : Number(s.trim()));
  return {
    name: r.name.trim().toLowerCase() || '@',
    type: r.type,
    content: r.content.trim(),
    ttl: num(r.ttl),
    priority: r.type === 'MX' || r.type === 'SRV' ? num(r.priority) : null,
  };
}

/** Create / edit a DNS template of the tenant (records with {domain} {ipv4} {ipv6} {panel}). */
export function DnsTemplateModal({ open, template, onClose, onSaved }: {
  open: boolean;
  /** null = create. */
  template: DnsTemplate | null;
  onClose: () => void;
  onSaved: (tp: DnsTemplate) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? '');
    setDescription(template?.description ?? '');
    setIsDefault(template?.isDefault ?? false);
    setRows(template ? template.records.map(toRow) : [
      { name: '@', type: 'A', content: '{ipv4}', ttl: '', priority: '' },
      { name: 'www', type: 'CNAME', content: '{domain}.', ttl: '', priority: '' },
    ]);
    setError(null);
  }, [open, template]);

  const issues = rows.map((r) => templateRecordIssue(toRecord(r)));
  const canSubmit = !saving && name.trim() !== '' && issues.every((i) => i === null);

  const setRow = (i: number, patch: Partial<Row>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, isDefault, records: rows.map(toRecord) };
      onSaved(template ? await dnsApi.updateTemplate(template.id, body) : await dnsApi.createTemplate(body));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dnsErrorMessage(t, err, t('dns.templates.saveFailed') || 'Failed to save the template'));
    } finally {
      setSaving(false);
    }
  };

  const issueText: Record<NonNullable<ReturnType<typeof templateRecordIssue>>, string> = {
    name: t('dns.templates.issue.name') || 'Invalid name',
    content: t('dns.templates.issue.content') || 'Content required',
    ttl: t('dns.validation.ttlRange') || 'TTL between 60 and 604800 seconds.',
    priority: t('dns.validation.priorityRange') || 'Priority between 0 and 65535.',
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={template ? (t('dns.templates.editTitle') || 'Edit the template') : (t('dns.templates.createTitle') || 'New DNS template')}
      icon={<FileStack className="h-4 w-4 text-accent" />}
      size="xl"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="tpl-name">{t('dns.templates.name') || 'Name'}</label>
            <input id="tpl-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} className={inputCls} autoFocus />
          </div>
          <div>
            <label className={labelCls} htmlFor="tpl-desc">{t('dns.templates.description') || 'Description'}</label>
            <input id="tpl-desc" value={description} maxLength={255} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
          </div>
        </div>
        <ToggleSwitch
          checked={isDefault}
          onChange={setIsDefault}
          label={t('dns.templates.isDefault') || 'Default template'}
          description={t('dns.templates.isDefaultHint') || 'Applied to every new zone of the workspace (one default at most).'}
        />
        <div className="rounded-lg bg-bg-primary px-3 py-2 text-xs text-text-muted">
          {t('dns.templates.placeholders') || 'Placeholders, replaced when the template is applied:'}{' '}
          {TEMPLATE_PLACEHOLDERS.map((p) => <code key={p} className="mr-1.5 rounded bg-bg-tertiary px-1 font-mono text-text-secondary">{p}</code>)}
        </div>

        <div>
          <div className="mb-1 flex items-center">
            <span className={labelCls}>{t('dns.templates.records') || 'Records'}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setRows((cur) => [...cur, { name: '', type: 'A', content: '', ttl: '', priority: '' }])}
            >
              <Plus size={13} className="mr-1" />{t('dns.records.add') || 'Add a record'}
            </Button>
          </div>
          {rows.length === 0 && <p className="text-xs text-text-muted">{t('dns.templates.noRecord') || 'No record.'}</p>}
          <ul className="space-y-2">
            {rows.map((r, i) => {
              const needsPriority = r.type === 'MX' || r.type === 'SRV';
              return (
                <li key={i} className="rounded-lg bg-bg-primary p-2">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_2fr_5rem_5rem_auto]">
                    <input
                      aria-label={t('dns.records.fields.name') || 'Name'}
                      value={r.name}
                      onChange={(e) => setRow(i, { name: e.target.value })}
                      placeholder="@"
                      autoCapitalize="off" autoCorrect="off" spellCheck={false}
                      className={cn(inputCls, 'font-mono', issues[i] === 'name' && r.name && 'ring-2 ring-status-down')}
                    />
                    <select aria-label={t('dns.records.fields.type') || 'Type'} value={r.type} onChange={(e) => setRow(i, { type: e.target.value as DnsRecordType })} className={selectCls}>
                      {RECORD_TYPES.map((ty) => <option key={ty} value={ty}>{ty}</option>)}
                    </select>
                    <input
                      aria-label={t('dns.records.fields.content') || 'Content'}
                      value={r.content}
                      onChange={(e) => setRow(i, { content: e.target.value })}
                      placeholder="{ipv4}"
                      autoCapitalize="off" autoCorrect="off" spellCheck={false}
                      className={cn(inputCls, 'col-span-2 font-mono sm:col-span-1')}
                    />
                    <input
                      aria-label={t('dns.records.fields.ttl') || 'TTL'}
                      value={r.ttl}
                      inputMode="numeric"
                      onChange={(e) => setRow(i, { ttl: e.target.value })}
                      placeholder={t('dns.records.ttlDefault') || 'TTL'}
                      className={cn(inputCls, 'font-mono', issues[i] === 'ttl' && 'ring-2 ring-status-down')}
                    />
                    <input
                      aria-label={t('dns.records.fields.priority') || 'Priority'}
                      value={needsPriority ? r.priority : ''}
                      disabled={!needsPriority}
                      inputMode="numeric"
                      onChange={(e) => setRow(i, { priority: e.target.value })}
                      placeholder={needsPriority ? (t('dns.records.fields.priority') || 'Priority') : '—'}
                      className={cn(inputCls, 'font-mono', issues[i] === 'priority' && 'ring-2 ring-status-down')}
                    />
                    <IconButton
                      label={t('common.delete') || 'Delete'}
                      icon={<Trash2 size={14} />}
                      variant="danger"
                      className="justify-self-end"
                      onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                    />
                  </div>
                  {issues[i] && (r.name || r.content) && <p className="mt-1 text-xs text-status-down">{issueText[issues[i]!]}</p>}
                </li>
              );
            })}
          </ul>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
