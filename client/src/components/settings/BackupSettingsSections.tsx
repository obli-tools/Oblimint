import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Archive, CheckCircle2, FlaskConical, HardDrive, KeyRound, Pencil, Play, Plus, Trash2, XCircle } from 'lucide-react';
import type { BackupDestination, BackupDestinationConfig, BackupDestinationKind, BackupRun, BackupSettings } from '@oblimint/shared';
import { BACKUP_PASSPHRASE_MIN } from '@oblimint/shared';
import { backupsApi } from '@/api/backups.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { Pill, hostingErrorMessage, toastHostingError } from '@/components/hosting/hostingUi';
import { formatBytes } from '@/components/usage/usageFormat';
import { cn } from '@/utils/cn';

/**
 * Settings page (platform admin): external backups — destinations (local
 * folder, SFTP, S3-compatible), passphrase, daily schedule, retention, the
 * panel's own backup and the last runs.
 */
export function BackupSettingsSections() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [destinations, setDestinations] = useState<BackupDestination[]>([]);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; destinationId: number | null; hour: string; retentionDays: string; keepMin: string; includePanel: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<BackupDestination | 'new' | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [passOpen, setPassOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, d, r] = await Promise.all([backupsApi.settings(), backupsApi.destinations(), backupsApi.runs()]);
      setSettings(s);
      setDestinations(d);
      setRuns(r);
      setDraft({ enabled: s.enabled, destinationId: s.destinationId, hour: String(s.hour), retentionDays: String(s.retentionDays), keepMin: String(s.keepMin), includePanel: s.includePanel });
      setError(null);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('backups.loadFailed') || 'The backup settings could not be loaded'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  // Follow running runs.
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running')) return;
    const id = setInterval(() => { void backupsApi.runs().then(setRuns).catch(() => {}); }, 4000);
    return () => clearInterval(id);
  }, [runs]);

  if (!settings || !draft) {
    return (
      <SettingsBlock icon={<Archive />} title={t('backups.title') || 'Backups'}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }

  const base = { enabled: settings.enabled, destinationId: settings.destinationId, hour: String(settings.hour), retentionDays: String(settings.retentionDays), keepMin: String(settings.keepMin), includePanel: settings.includePanel };
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  const num = (v: string, min: number, max: number) => (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  const valid = num(draft.hour, 0, 23) !== null && num(draft.retentionDays, 1, 3650) !== null && num(draft.keepMin, 0, 365) !== null;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');

  const save = async () => {
    setSaving(true);
    try {
      const s = await backupsApi.updateSettings({
        enabled: draft.enabled, destinationId: draft.destinationId, hour: num(draft.hour, 0, 23)!, retentionDays: num(draft.retentionDays, 1, 3650)!,
        keepMin: num(draft.keepMin, 0, 365)!, includePanel: draft.includePanel,
      });
      setSettings(s);
      toast.success(t('backups.saved') || 'Backup settings saved');
    } catch (err) {
      if (!isStepUpHandled(err)) toastHostingError(t, err, t('backups.saveFailed') || 'The settings could not be saved');
    } finally { setSaving(false); }
  };

  const test = async (d: BackupDestination) => {
    setTesting(d.id);
    try {
      const r = await backupsApi.testDestination(d.id);
      setDestinations((list) => list.map((x) => (x.id === r.id ? r : x)));
      if (r.lastTestError) toast.error(r.lastTestError); else toast.success(t('backups.testOk') || 'Destination reachable: write, read and delete succeeded');
    } catch (err) { toastHostingError(t, err, t('backups.testFailed') || 'The test failed'); } finally { setTesting(null); }
  };

  const remove = async (d: BackupDestination) => {
    if (!(await confirm({
      title: t('backups.deleteDestination') || 'Delete the destination',
      message: t('backups.deleteDestinationConfirm', { name: d.name, defaultValue: 'Delete "{{name}}"? The backups already written there stay on it but can no longer be restored from the panel.' }),
      danger: true,
    }))) return;
    try { await backupsApi.removeDestination(d.id); await load(); } catch (err) { toastHostingError(t, err, t('backups.deleteFailed') || 'The destination could not be deleted'); }
  };

  const runPanel = async () => {
    try {
      await backupsApi.runPanel();
      toast.success(t('backups.runStarted') || 'Backup started');
      setRuns(await backupsApi.runs());
    } catch (err) { toastHostingError(t, err, t('backups.runFailed') || 'The backup could not start'); }
  };

  const kindLabel = (k: BackupDestinationKind) => ({ local: t('backups.kinds.local') || 'Local folder', sftp: 'SFTP', s3: t('backups.kinds.s3') || 'S3-compatible' }[k]);
  const summary = (d: BackupDestination) => {
    const s = d.settings;
    if (d.kind === 'sftp') return `${s.username}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}:${s.path || '.'}`;
    if (d.kind === 's3') return `${s.endpoint ? `${String(s.endpoint).replace(/^https?:\/\//, '')} · ` : ''}${s.bucket}${s.prefix ? `/${s.prefix}` : ''}`;
    return `backups/${s.subdir || ''}`;
  };

  return (
    <>
      <SettingsBlock
        id="backups"
        icon={<Archive />}
        title={t('backups.title') || 'Backups'}
        description={t('backups.intro') || 'Daily off-site copy of every account (site code, data, databases) and of the panel. Everything is encrypted on this server with your passphrase before it leaves: the destination never sees the content.'}
        dirty={dirty}
        saving={saving}
        canSave={valid}
        onSave={() => { void save(); }}
        onReset={() => setDraft(base)}
      >
        <div className={cn('flex flex-wrap items-start gap-3 rounded-lg p-3', settings.passphraseSet ? 'bg-bg-tertiary' : 'bg-amber-400/10')}>
          <KeyRound size={16} className={cn('mt-0.5 shrink-0', settings.passphraseSet ? 'text-accent' : 'text-amber-400')} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium text-text-primary">{settings.passphraseSet ? (t('backups.passphraseSet') || 'Encryption passphrase set') : (t('backups.passphraseMissing') || 'No encryption passphrase yet')}</div>
            <p className="mt-0.5 text-xs text-text-muted">{t('backups.passphraseHint') || 'Keep it outside the platform (password manager, safe): without it, no backup can be restored.'}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setPassOpen(true)}>{settings.passphraseSet ? (t('backups.passphraseChange') || 'Change') : (t('backups.passphraseSetAction') || 'Set the passphrase')}</Button>
        </div>

        <ToggleSwitch
          checked={draft.enabled}
          onChange={(v) => setDraft({ ...draft, enabled: v })}
          label={t('backups.enabled') || 'Daily backups'}
          description={t('backups.enabledHint') || 'Every account (unless excluded in its Backups tab), then the panel.'}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t('backups.destination') || 'Destination'} htmlFor="bk-dest">
            <select id="bk-dest" className={settingsInputCls} value={draft.destinationId ?? ''} onChange={(e) => setDraft({ ...draft, destinationId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{t('backups.noDestination') || '— none —'}</option>
              {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label={t('backups.hour') || 'Hour (server time)'} htmlFor="bk-hour">
            <input id="bk-hour" type="number" min={0} max={23} className={cn(settingsInputCls, 'font-mono')} value={draft.hour} onChange={(e) => setDraft({ ...draft, hour: e.target.value })} />
          </Field>
          <Field label={t('backups.retentionDays') || 'Keep (days)'} htmlFor="bk-ret">
            <input id="bk-ret" type="number" min={1} max={3650} className={cn(settingsInputCls, 'font-mono')} value={draft.retentionDays} onChange={(e) => setDraft({ ...draft, retentionDays: e.target.value })} />
          </Field>
          <Field label={t('backups.keepMin') || 'Always keep the last'} htmlFor="bk-min" hint={t('backups.keepMinHint') || 'Backups per account, even older.'}>
            <input id="bk-min" type="number" min={0} max={365} className={cn(settingsInputCls, 'font-mono')} value={draft.keepMin} onChange={(e) => setDraft({ ...draft, keepMin: e.target.value })} />
          </Field>
        </div>
        <ToggleSwitch
          checked={draft.includePanel}
          onChange={(v) => setDraft({ ...draft, includePanel: v })}
          label={t('backups.includePanel') || 'Also back up the panel'}
          description={t('backups.includePanelHint') || 'Panel database and configuration file (needed to rebuild the platform after a server loss).'}
        />
        {settings.lastScheduledAt && <p className="text-xs text-text-muted">{t('backups.lastScheduled', { date: fmt(settings.lastScheduledAt), defaultValue: 'Last scheduled run: {{date}}' })}</p>}
      </SettingsBlock>

      <SettingsBlock
        id="settings-backup-destinations"
        icon={<HardDrive />}
        title={t('backups.destinations') || 'Backup destinations'}
        headerExtra={<Button size="sm" onClick={() => setEditing('new')}><Plus className="mr-1 h-3.5 w-3.5" />{t('backups.addDestination') || 'Add'}</Button>}
      >
        {!destinations.length ? (
          <p className="text-sm text-text-muted">{t('backups.noDestinations') || 'No destination yet: add an SFTP server or an S3-compatible bucket (AWS, Backblaze B2, Wasabi, Scaleway, OVH, MinIO…).'}</p>
        ) : (
          <div className="divide-y divide-border">
            {destinations.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-text-primary">{d.name}</span>
                    <Pill>{kindLabel(d.kind)}</Pill>
                    {d.lastTestAt && (d.lastTestError
                      ? <Pill tone="red" title={d.lastTestError}><XCircle size={11} className="mr-1 inline" />{t('backups.testKo') || 'unreachable'}</Pill>
                      : <Pill tone="green"><CheckCircle2 size={11} className="mr-1 inline" />{t('backups.testOkShort') || 'tested'}</Pill>)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-text-muted">{summary(d)}</div>
                  {d.hostKey && <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted" title={t('backups.hostKeyHint') || 'Server key pinned at the first successful test'}>{d.hostKey}</div>}
                  {d.lastTestError && <div className="mt-0.5 text-xs text-status-down">{d.lastTestError}</div>}
                </div>
                <Button size="sm" variant="secondary" loading={testing === d.id} onClick={() => { void test(d); }}><FlaskConical className="mr-1 h-3.5 w-3.5" />{t('backups.test') || 'Test'}</Button>
                <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(d)} />
                <IconButton variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-4 w-4" />} onClick={() => { void remove(d); }} />
              </div>
            ))}
          </div>
        )}
      </SettingsBlock>

      <SettingsBlock
        id="settings-backup-runs"
        icon={<Archive />}
        title={t('backups.runs') || 'Last backups'}
        headerExtra={<Button size="sm" variant="secondary" onClick={() => { void runPanel(); }}><Play className="mr-1 h-3.5 w-3.5" />{t('backups.runPanel') || 'Back up the panel now'}</Button>}
      >
        {!runs.length ? <p className="text-sm text-text-muted">{t('backups.noRuns') || 'No backup yet.'}</p> : (
          <div className="max-h-96 divide-y divide-border overflow-y-auto">
            {runs.slice(0, 100).map((r) => <RunRow key={r.id} run={r} fmt={fmt} />)}
          </div>
        )}
      </SettingsBlock>

      <DestinationModal
        open={editing !== null}
        destination={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={async (d) => { setEditing(null); await load(); void test(d); }}
      />
      <PassphraseModal open={passOpen} replace={settings.passphraseSet} onClose={() => setPassOpen(false)} onSaved={(s) => { setPassOpen(false); setSettings(s); }} />
    </>
  );
}

export function RunRow({ run, fmt, children }: { run: BackupRun; fmt: (iso: string | null) => string; children?: React.ReactNode }) {
  const { t } = useTranslation();
  const tone = run.status === 'ok' ? 'green' : run.status === 'partial' ? 'amber' : run.status === 'failed' ? 'red' : 'accent';
  const label = {
    ok: t('backups.status.ok') || 'complete', partial: t('backups.status.partial') || 'partial',
    failed: t('backups.status.failed') || 'failed', running: t('backups.status.running') || 'running…',
  }[run.status];
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-text-muted">{fmt(run.startedAt)}</span>
        <span className="font-medium text-text-primary">{run.scope === 'panel' ? (t('backups.panel') || 'Panel') : (run.accountUsername ?? `#${run.accountId}`)}</span>
        <Pill tone={tone}>{label}</Pill>
        {run.trigger === 'manual' && <Pill>{t('backups.manual') || 'manual'}</Pill>}
        {run.purgedAt && <Pill>{t('backups.purged') || 'expired'}</Pill>}
        <span className="ml-auto font-mono text-xs text-text-muted">{run.status !== 'running' && formatBytes(run.bytes)}{run.destinationName ? ` · ${run.destinationName}` : ''}</span>
        {children}
      </div>
      {run.errors.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-status-down">{run.errors.slice(0, 5).map((e, i) => <li key={i} className="break-words">{e}</li>)}</ul>}
    </div>
  );
}

type DestDraft = {
  name: string; kind: BackupDestinationKind;
  subdir: string;
  host: string; port: string; username: string; password: string; privateKey: string; path: string;
  bucket: string; region: string; endpoint: string; prefix: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
};

function draftOf(d: BackupDestination | null): DestDraft {
  const s = d?.settings ?? {};
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    name: d?.name ?? '', kind: d?.kind ?? 'sftp', subdir: str(s.subdir),
    host: str(s.host), port: str(s.port || ''), username: str(s.username), password: '', privateKey: '', path: str(s.path),
    bucket: str(s.bucket), region: str(s.region), endpoint: str(s.endpoint), prefix: str(s.prefix), accessKeyId: '', secretAccessKey: '', forcePathStyle: s.forcePathStyle === true,
  };
}

function DestinationModal({ open, destination, onClose, onSaved }: { open: boolean; destination: BackupDestination | null; onClose: () => void; onSaved: (d: BackupDestination) => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState<DestDraft>(draftOf(destination));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setF(draftOf(destination)); setErr(null); } }, [open, destination]);
  const editing = destination !== null;
  const set = (p: Partial<DestDraft>) => setF((x) => ({ ...x, ...p }));

  const config = (): BackupDestinationConfig => {
    if (f.kind === 'local') return { kind: 'local', ...(f.subdir.trim() ? { subdir: f.subdir.trim() } : {}) };
    if (f.kind === 'sftp') {
      return {
        kind: 'sftp', host: f.host.trim(), username: f.username.trim(), ...(f.port.trim() ? { port: Number(f.port) } : {}),
        ...(f.password ? { password: f.password } : {}), ...(f.privateKey.trim() ? { privateKey: f.privateKey } : {}), ...(f.path.trim() ? { path: f.path.trim() } : {}),
      };
    }
    return {
      kind: 's3', bucket: f.bucket.trim(), ...(f.region.trim() ? { region: f.region.trim() } : {}), ...(f.endpoint.trim() ? { endpoint: f.endpoint.trim() } : {}),
      ...(f.prefix.trim() ? { prefix: f.prefix.trim() } : {}), forcePathStyle: f.forcePathStyle, accessKeyId: f.accessKeyId.trim(), secretAccessKey: f.secretAccessKey,
    };
  };

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      onSaved(await backupsApi.saveDestination(destination?.id ?? null, { name: f.name.trim(), config: config() }));
    } catch (e) {
      if (!isStepUpHandled(e)) setErr(hostingErrorMessage(t, e, t('backups.destinationSaveFailed') || 'The destination could not be saved'));
    } finally { setSaving(false); }
  };

  const keep = editing ? (t('backups.keepSecret') || 'empty = unchanged') : undefined;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      icon={<HardDrive size={16} />}
      title={editing ? (t('backups.editDestination') || 'Edit the destination') : (t('backups.newDestination') || 'New backup destination')}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
        <Button loading={saving} disabled={!f.name.trim()} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
      </>}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('backups.name') || 'Name'} htmlFor="bd-name">
            <input id="bd-name" className={settingsInputCls} value={f.name} maxLength={64} onChange={(e) => set({ name: e.target.value })} placeholder="Backblaze, NAS…" />
          </Field>
          <Field label={t('backups.kind') || 'Type'} htmlFor="bd-kind">
            <select id="bd-kind" className={settingsInputCls} value={f.kind} onChange={(e) => set({ kind: e.target.value as BackupDestinationKind })}>
              <option value="sftp">SFTP</option>
              <option value="s3">{t('backups.kinds.s3') || 'S3-compatible'}</option>
              <option value="local">{t('backups.kinds.local') || 'Local folder'}</option>
            </select>
          </Field>
        </div>
        {f.kind === 'local' && (
          <>
            <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-3 text-xs text-text-secondary">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
              {t('backups.localWarning') || 'A folder on this server\'s data disk: it does not protect against the loss of the server. For tests, or a mounted external disk.'}
            </p>
            <Field label={t('backups.subdir') || 'Sub-folder of <data>/backups'} htmlFor="bd-sub">
              <input id="bd-sub" className={cn(settingsInputCls, 'font-mono')} value={f.subdir} onChange={(e) => set({ subdir: e.target.value })} />
            </Field>
          </>
        )}
        {f.kind === 'sftp' && (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <Field label={t('backups.host') || 'Server'} htmlFor="bd-host"><input id="bd-host" className={cn(settingsInputCls, 'font-mono')} value={f.host} onChange={(e) => set({ host: e.target.value })} /></Field>
              <Field label={t('backups.port') || 'Port'} htmlFor="bd-port"><input id="bd-port" type="number" className={cn(settingsInputCls, 'font-mono')} value={f.port} placeholder="22" onChange={(e) => set({ port: e.target.value })} /></Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('backups.username') || 'User'} htmlFor="bd-user"><input id="bd-user" className={cn(settingsInputCls, 'font-mono')} value={f.username} autoComplete="off" onChange={(e) => set({ username: e.target.value })} /></Field>
              <Field label={t('backups.remotePath') || 'Remote folder'} htmlFor="bd-path"><input id="bd-path" className={cn(settingsInputCls, 'font-mono')} value={f.path} placeholder="backups" onChange={(e) => set({ path: e.target.value })} /></Field>
            </div>
            <Field label={t('backups.password') || 'Password'} htmlFor="bd-pass" hint={keep}>
              <input id="bd-pass" type="password" autoComplete="new-password" className={settingsInputCls} value={f.password} onChange={(e) => set({ password: e.target.value })} />
            </Field>
            <Field label={t('backups.privateKey') || 'Or private key (OpenSSH)'} htmlFor="bd-key" hint={keep}>
              <textarea id="bd-key" rows={3} className={cn(settingsInputCls, 'font-mono text-xs')} value={f.privateKey} onChange={(e) => set({ privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            </Field>
            <p className="text-xs text-text-muted">{t('backups.hostKeyPin') || 'The server key is recorded at the first successful test; a different key later is refused.'}</p>
          </>
        )}
        {f.kind === 's3' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('backups.bucket') || 'Bucket'} htmlFor="bd-bucket"><input id="bd-bucket" className={cn(settingsInputCls, 'font-mono')} value={f.bucket} onChange={(e) => set({ bucket: e.target.value })} /></Field>
              <Field label={t('backups.region') || 'Region'} htmlFor="bd-region"><input id="bd-region" className={cn(settingsInputCls, 'font-mono')} value={f.region} placeholder="us-east-1" onChange={(e) => set({ region: e.target.value })} /></Field>
            </div>
            <Field label={t('backups.endpoint') || 'Endpoint (other than AWS)'} htmlFor="bd-ep" hint={t('backups.endpointHint') || 'e.g. https://s3.eu-central-003.backblazeb2.com — empty for AWS.'}>
              <input id="bd-ep" className={cn(settingsInputCls, 'font-mono')} value={f.endpoint} onChange={(e) => set({ endpoint: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('backups.accessKeyId') || 'Access key ID'} htmlFor="bd-ak" hint={keep}><input id="bd-ak" autoComplete="off" className={cn(settingsInputCls, 'font-mono')} value={f.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} /></Field>
              <Field label={t('backups.secretAccessKey') || 'Secret key'} htmlFor="bd-sk" hint={keep}><input id="bd-sk" type="password" autoComplete="new-password" className={settingsInputCls} value={f.secretAccessKey} onChange={(e) => set({ secretAccessKey: e.target.value })} /></Field>
            </div>
            <Field label={t('backups.prefix') || 'Prefix (folder in the bucket)'} htmlFor="bd-prefix"><input id="bd-prefix" className={cn(settingsInputCls, 'font-mono')} value={f.prefix} placeholder="oblimint" onChange={(e) => set({ prefix: e.target.value })} /></Field>
            <ToggleSwitch checked={f.forcePathStyle} onChange={(v) => set({ forcePathStyle: v })} size="sm" label={t('backups.pathStyle') || 'Path-style addressing (MinIO and some providers)'} />
          </>
        )}
        {err && <p className="whitespace-pre-line text-xs text-status-down">{err}</p>}
      </div>
    </Modal>
  );
}

function PassphraseModal({ open, replace, onClose, onSaved }: { open: boolean; replace: boolean; onClose: () => void; onSaved: (s: BackupSettings) => void }) {
  const { t } = useTranslation();
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setP1(''); setP2(''); setAck(false); } }, [open]);
  const ok = p1.length >= BACKUP_PASSPHRASE_MIN && p1 === p2 && ack;

  const generate = () => {
    const words = new Uint8Array(24);
    crypto.getRandomValues(words);
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const s = Array.from(words, (b) => alphabet[b % alphabet.length]).join('').replace(/(.{6})(?!$)/g, '$1-');
    setP1(s);
    setP2(s);
  };

  const submit = async () => {
    setSaving(true);
    try {
      onSaved(await backupsApi.updateSettings({ passphrase: p1, replacePassphrase: replace }));
      toast.success(t('backups.passphraseSaved') || 'Passphrase saved');
    } catch (e) {
      if (!isStepUpHandled(e)) toastHostingError(t, e, t('backups.saveFailed') || 'The settings could not be saved');
    } finally { setSaving(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<KeyRound size={16} />}
      title={t('backups.passphraseTitle') || 'Backup encryption passphrase'}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
        <Button loading={saving} disabled={!ok} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
      </>}
    >
      <div className="space-y-4">
        {replace && (
          <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-3 text-xs text-text-secondary">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
            {t('backups.passphraseReplaceWarning') || 'The backups already made stay encrypted with the OLD passphrase: the panel will no longer be able to restore them. Keep the old one if you may need them.'}
          </p>
        )}
        <Field label={t('backups.passphrase') || 'Passphrase'} htmlFor="bp-1" hint={t('backups.passphraseMin', { n: BACKUP_PASSPHRASE_MIN, defaultValue: 'At least {{n}} characters.' })}>
          <div className="flex gap-2">
            <input id="bp-1" type="text" autoComplete="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} value={p1} onChange={(e) => setP1(e.target.value)} />
            <Button variant="secondary" onClick={generate}>{t('backups.generate') || 'Generate'}</Button>
          </div>
        </Field>
        <Field label={t('backups.passphraseConfirm') || 'Again'} htmlFor="bp-2">
          <input id="bp-2" type="text" autoComplete="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono', p2 && p1 !== p2 && 'ring-2 ring-status-down/50')} value={p2} onChange={(e) => setP2(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2 text-sm text-text-secondary">
          <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          {t('backups.passphraseAck') || 'I have stored this passphrase outside the platform. Without it, the backups cannot be restored.'}
        </label>
      </div>
    </Modal>
  );
}
