import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { RotateCw, Trash2, Upload, Workflow as WorkflowIcon } from 'lucide-react';
import type {
  AppStack, CertificateListItem, HostingAccount, SftpTarget, Workflow, WorkflowAction, WorkflowActionKind, WorkflowInput, WorkflowTrigger,
  WorkflowTriggerKind,
} from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { ScheduleEditor } from '@/components/maintenance/ScheduleEditor';
import { looksLikeCron } from '@/components/cron/cronFormat';
import { browserTimezone } from '@/components/maintenance/maintenanceFormat';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage } from '@/components/apps/appsErrors';
import { triggerKindLabel } from './automationUi';

const KINDS: WorkflowTriggerKind[] = ['cert-renewal', 'cron', 'interval', 'manual'];

type ActionDraft = WorkflowAction & { _key: number };

let keySeq = 0;
function draftOf(a: WorkflowAction): ActionDraft {
  return { ...a, _key: ++keySeq };
}
function newAction(kind: WorkflowActionKind): ActionDraft {
  return kind === 'export-certificate'
    ? draftOf({ kind, certificate: null, sftpTargetId: null, remotePath: '', format: 'pem-split' })
    : draftOf({ kind, stackId: null, services: [] });
}

/** Create / edit a workflow: trigger (certificate renewal, cron with a readable preview, interval, manual) + actions. */
export function WorkflowModal({ workflow, accountId, accounts, onClose, onSaved }: {
  workflow: Workflow | null;
  accountId: number | null;
  accounts: HostingAccount[];
  onClose: () => void;
  onSaved: (w: Workflow) => void;
}) {
  const { t } = useTranslation();
  const { isStaff, can } = useP4bAccess();
  const [account, setAccount] = useState<string>(workflow ? (workflow.accountId == null ? 'platform' : String(workflow.accountId)) : accountId != null ? String(accountId) : accounts.length === 1 ? String(accounts[0].id) : '');
  const [name, setName] = useState(workflow?.name ?? '');
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [kind, setKind] = useState<WorkflowTriggerKind>(workflow?.trigger.kind ?? 'cert-renewal');
  const [interval, setInterval_] = useState(String(workflow?.trigger.intervalMinutes ?? 60));
  const [cron, setCron] = useState(workflow?.trigger.cron ?? '0 3 * * *');
  const [timezone, setTimezone] = useState(workflow?.trigger.timezone ?? browserTimezone());
  const [certNames, setCertNames] = useState<string[]>(workflow?.trigger.certificateNames ?? []);
  const [actions, setActions] = useState<ActionDraft[]>(() => (workflow?.actions ?? [{ kind: 'export-certificate', certificate: null, sftpTargetId: null, remotePath: '', format: 'pem-split' }]).map(draftOf));
  const [certs, setCerts] = useState<CertificateListItem[]>([]);
  const [targets, setTargets] = useState<SftpTarget[]>([]);
  const [stacks, setStacks] = useState<AppStack[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Pickers: objects of the same account only (platform workflows: platform objects).
  useEffect(() => {
    if (!account) { setCerts([]); setTargets([]); setStacks([]); return; }
    let cancelled = false;
    const scope = account === 'platform' ? {} : { accountId: Number(account) };
    const same = <T extends { accountId: number | null }>(l: T[]) => l.filter((x) => (account === 'platform' ? x.accountId == null : x.accountId === Number(account)));
    automationApi.listCertificates(scope).then((l) => { if (!cancelled) setCerts(same(l)); }).catch(() => { if (!cancelled) setCerts([]); });
    automationApi.listSftpTargets(scope).then((l) => { if (!cancelled) setTargets(same(l)); }).catch(() => { if (!cancelled) setTargets([]); });
    if (account !== 'platform') appsApi.listStacks({ accountId: Number(account) }).then((l) => { if (!cancelled) setStacks(l); }).catch(() => { if (!cancelled) setStacks([]); });
    else setStacks([]);
    return () => { cancelled = true; };
  }, [account]);

  const patchAction = (key: number, patch: Partial<WorkflowAction>) => setActions((cur) => cur.map((a) => (a._key === key ? { ...a, ...patch } : a)));

  const submit = async () => {
    setError('');
    if (!workflow && !account) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    const trigger: WorkflowTrigger = { kind };
    if (kind === 'interval') {
      const n = Number(interval);
      if (!Number.isInteger(n) || n < 5) { setError(t('automation.form.intervalMin') || 'Interval: at least 5 minutes.'); return; }
      trigger.intervalMinutes = n;
    } else if (kind === 'cron') {
      if (!looksLikeCron(cron) || cron.trim().startsWith('@')) { setError(t('automation.errors.invalidCron') || 'Invalid cron expression.'); return; }
      trigger.cron = cron.trim();
      trigger.timezone = timezone;
    } else if (kind === 'cert-renewal') {
      trigger.certificateNames = certNames;
    }
    if (actions.length === 0) { setError(t('automation.form.noAction') || 'Add at least one action.'); return; }
    for (const a of actions) {
      if (a.kind === 'export-certificate' && (!a.certificate || !a.sftpTargetId)) { setError(t('automation.form.exportIncomplete') || 'Export: choose the certificate and the SFTP target.'); return; }
      if (a.kind === 'export-certificate' && a.remotePath && (a.remotePath.includes('..') || a.remotePath.startsWith('/'))) { setError(t('automation.form.remotePathInvalid') || 'The remote path is relative to the base path of the target (no .. nor leading /).'); return; }
      if (a.kind === 'restart-app' && !a.stackId) { setError(t('automation.form.restartIncomplete') || 'Restart: choose the application.'); return; }
    }
    const cleanActions: WorkflowAction[] = actions.map(({ _key: _ignored, ...a }) => (a.kind === 'export-certificate'
      ? { kind: a.kind, certificate: a.certificate, sftpTargetId: a.sftpTargetId, remotePath: a.remotePath?.trim() || null, format: a.format ?? 'pem-split' }
      : { kind: a.kind, stackId: a.stackId, services: a.services ?? [] }));
    setSaving(true);
    try {
      const saved = workflow
        ? await automationApi.updateWorkflow(workflow.id, { name: name.trim(), enabled, trigger, actions: cleanActions })
        : await automationApi.createWorkflow({ accountId: account === 'platform' ? null : Number(account), name: name.trim(), enabled, trigger, actions: cleanActions } as WorkflowInput);
      toast.success(t('automation.form.saved') || 'Workflow saved');
      onSaved(saved);
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('automation.form.saveFailed') || 'Failed to save the workflow', 'automation'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      icon={<WorkflowIcon className="h-4 w-4 text-accent" />}
      title={workflow ? t('automation.form.editTitle', { name: workflow.name, defaultValue: 'Edit {{name}}' }) : (t('automation.form.createTitle') || 'New workflow')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{workflow ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!workflow && accountId == null && (
            <div>
              <label className={labelCls} htmlFor="wf-account">{t('apps.list.account') || 'Account'}</label>
              <select id="wf-account" value={account} onChange={(e) => setAccount(e.target.value)} className={selectCls}>
                <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
                {isStaff && can('monitoring.manage') && <option value="platform">{t('uptime.platform') || 'Platform (no account)'}</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
              </select>
            </div>
          )}
          <div className={cn(!workflow && accountId == null ? '' : 'sm:col-span-2')}>
            <label className={labelCls} htmlFor="wf-name">{t('automation.form.name') || 'Name'}</label>
            <input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
          </div>
        </div>
        <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('automation.form.enabled') || 'Active'} />

        <section className="space-y-3 rounded-lg bg-bg-primary p-3">
          <div className={labelCls}>{t('automation.form.trigger') || 'Trigger'}</div>
          <SegmentedTabs<WorkflowTriggerKind> size="sm" fill={false} value={kind} onChange={setKind} tabs={KINDS.map((k) => ({ id: k, label: triggerKindLabel(t, k) }))} />
          {kind === 'cert-renewal' && (
            <div>
              <label className={labelCls}>{t('automation.form.certNames') || 'Certificate names watched (empty = every certificate of the account)'}</label>
              <ChipsInput value={certNames} onChange={setCertNames} placeholder="example.com, *.example.com" normalize={(v) => v.toLowerCase()} validate={(v) => /^(\*\.)?[a-z0-9.-]+$/.test(v)} />
            </div>
          )}
          {kind === 'interval' && (
            <div className="max-w-xs">
              <label className={labelCls} htmlFor="wf-interval">{t('automation.form.intervalMinutes') || 'Every (minutes, ≥ 5)'}</label>
              <input id="wf-interval" type="number" min="5" value={interval} onChange={(e) => setInterval_(e.target.value)} className={cn(inputCls, 'font-mono')} />
            </div>
          )}
          {kind === 'cron' && <ScheduleEditor idPrefix="wf" cron={cron} timezone={timezone} onChange={(n) => { setCron(n.cron); setTimezone(n.timezone); }} />}
          {kind === 'manual' && <p className="text-xs text-text-muted">{t('automation.trigger.manualOnly') || 'Run by hand only'}</p>}
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={labelCls}>{t('automation.form.actions') || 'Actions (in order)'}</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setActions((a) => [...a, newAction('export-certificate')])}><Upload size={13} className="mr-1" />{t('automation.action.export') || 'Export a certificate'}</Button>
              <Button size="sm" variant="secondary" disabled={account === 'platform'} onClick={() => setActions((a) => [...a, newAction('restart-app')])}><RotateCw size={13} className="mr-1" />{t('automation.action.restart') || 'Restart an application'}</Button>
            </div>
          </div>
          {actions.length === 0 && <p className="text-xs text-text-muted">{t('automation.form.noAction') || 'Add at least one action.'}</p>}
          {actions.map((a, idx) => (
            <ActionEditor
              key={a._key}
              index={idx}
              action={a}
              certs={certs}
              targets={targets}
              stacks={stacks}
              onChange={(p) => patchAction(a._key, p)}
              onRemove={() => setActions((cur) => cur.filter((x) => x._key !== a._key))}
            />
          ))}
        </section>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

function ActionEditor({ index, action, certs, targets, stacks, onChange, onRemove }: {
  index: number;
  action: WorkflowAction;
  certs: CertificateListItem[];
  targets: SftpTarget[];
  stacks: AppStack[];
  onChange: (p: Partial<WorkflowAction>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [services, setServices] = useState<string[]>([]);
  useEffect(() => {
    if (action.kind !== 'restart-app' || !action.stackId) { setServices([]); return; }
    let cancelled = false;
    appsApi.getStack(action.stackId).then((s) => { if (!cancelled) setServices(s.services.map((x) => x.name)); }).catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, [action.kind, action.stackId]);
  const certKey = action.certificate ? `${action.certificate.kind}:${action.certificate.id}` : '';
  const toggleService = (s: string) => {
    const cur = action.services ?? [];
    onChange({ services: cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s] });
  };
  return (
    <div className="rounded-lg bg-bg-primary p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/15 font-mono text-[10px] text-accent">{index + 1}</span>
        <span className="text-sm font-medium text-text-primary">{action.kind === 'export-certificate' ? (t('automation.action.export') || 'Export a certificate') : (t('automation.action.restart') || 'Restart an application')}</span>
        <IconButton className="ml-auto" label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} variant="ghost" onClick={onRemove} />
      </div>
      {action.kind === 'export-certificate' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>{t('automation.action.certificate') || 'Certificate'}</label>
            <select value={certKey} onChange={(e) => { const [k, id] = e.target.value.split(':'); onChange({ certificate: e.target.value ? { kind: k as 'acme' | 'imported', id: Number(id) } : null }); }} className={selectCls}>
              <option value="">{t('automation.action.pickCertificate') || 'Choose a certificate…'}</option>
              {certs.map((c) => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.primaryName}{c.names.length > 1 ? ` (+${c.names.length - 1})` : ''} · {c.kind === 'acme' ? 'ACME' : (t('automation.action.imported') || 'imported')}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('automation.action.target') || 'SFTP target'}</label>
            <select value={action.sftpTargetId ?? ''} onChange={(e) => onChange({ sftpTargetId: e.target.value ? Number(e.target.value) : null })} className={selectCls}>
              <option value="">{t('automation.action.pickTarget') || 'Choose a target…'}</option>
              {targets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.username}@{s.host})</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('automation.action.remotePath') || 'Remote folder (relative to the base path)'}</label>
            <input value={action.remotePath ?? ''} onChange={(e) => onChange({ remotePath: e.target.value })} placeholder="certs/example.com" className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
          </div>
          <div>
            <label className={labelCls}>{t('automation.action.format') || 'Format'}</label>
            <select value={action.format ?? 'pem-split'} onChange={(e) => onChange({ format: e.target.value as 'pem-split' | 'pem-bundle' })} className={selectCls}>
              <option value="pem-split">{t('automation.action.formatSplit') || 'fullchain.pem + privkey.pem'}</option>
              <option value="pem-bundle">{t('automation.action.formatBundle') || 'One PEM bundle'}</option>
            </select>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label className={labelCls}>{t('automation.action.stack') || 'Application'}</label>
            <select value={action.stackId ?? ''} onChange={(e) => onChange({ stackId: e.target.value ? Number(e.target.value) : null, services: [] })} className={selectCls}>
              <option value="">{t('automation.action.pickStack') || 'Choose an application…'}</option>
              {stacks.map((s) => <option key={s.id} value={s.id}>{s.displayName} ({s.name})</option>)}
            </select>
          </div>
          {services.length > 0 && (
            <div>
              <div className={labelCls}>{t('automation.action.services') || 'Services (none ticked = every service)'}</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {services.map((s) => (
                  <label key={s} className="flex cursor-pointer items-center gap-2 font-mono text-[13px] text-text-primary coarse:min-h-10">
                    <input type="checkbox" checked={(action.services ?? []).includes(s)} onChange={() => toggleService(s)} className="accent-accent" />{s}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

