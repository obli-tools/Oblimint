import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FileKey2, Globe, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { HostingSocketEvents, type CertificateListItem, type CertificateStatus, type HostingAccount, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useDomainDrawer } from '@/components/hosting/DomainDrawer';
import { AccountField, ListState, useProxyAccess } from './proxyUi';
import { proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';

const EXPIRING_DAYS = 14;
/** Server limit of each PEM field of an import (64 KiB). */
const MAX_PEM = 64 * 1024;

/** Status pill of a certificate (expiring soon = amber). */
export function CertificateStatusPill({ status, notAfter, lastError }: { status: CertificateStatus; notAfter: string | null; lastError?: string | null }) {
  const { t, i18n } = useTranslation();
  const until = notAfter ? new Date(notAfter) : null;
  const expiring = status === 'valid' && until != null && until.getTime() - Date.now() < EXPIRING_DAYS * 86_400_000;
  let pill;
  if (status === 'valid') {
    pill = expiring
      ? <Pill tone="amber">{t('proxy.certs.expiring', { date: until!.toLocaleDateString(i18n.language), defaultValue: 'expires {{date}}' })}</Pill>
      : <Pill tone="green">{t('proxy.certs.valid') || 'valid'}</Pill>;
  } else if (status === 'pending') pill = <Pill tone="blue">{t('proxy.certs.pending') || 'pending'}</Pill>;
  else if (status === 'expired') pill = <Pill tone="red">{t('proxy.certs.expired') || 'expired'}</Pill>;
  else pill = <Pill tone="red">{t('proxy.certs.failed') || 'failed'}</Pill>;
  return lastError ? <Tip content={<span className="whitespace-pre-wrap font-mono text-[11px]">{lastError}</span>}><span className="cursor-help">{pill}</span></Tip> : pill;
}

/**
 * Certificates usable by proxy objects: ACME certificates of the domains (P1/P2) + imported ones.
 * Mounted by Proxy → Certificates and Domains & DNS → Certificates (coherence plan D14): only the
 * imported ones are managed here; an ACME row opens the drawer of its domain, the one place where
 * a Let's Encrypt certificate is managed.
 */
export function CertificatesPanel({ accountId, tenantId, accounts, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { canManage } = useProxyAccess();
  const drawer = useDomainDrawer();
  const [items, setItems] = useState<CertificateListItem[]>([]);
  const [status, setStatus] = useState<CertificateStatus | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountDir = useAccountDirectory();
  const [importing, setImporting] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await proxyApi.listCertificates({ accountId: accountId ?? undefined, tenantId, status: status || undefined });
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.certs.loadFailed') || 'Failed to load the certificates'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, status, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED, HostingSocketEvents.CERTIFICATE_UPDATED], () => { void load(); }, (e, p) => (
    e === HostingSocketEvents.CERTIFICATE_UPDATED || (p as ProxyUpdatedPayload | null)?.entity === 'certificate'
  ), 1000);

  const remove = async (c: CertificateListItem) => {
    if (!(await confirm({
      title: t('proxy.certs.deleteTitle') || 'Delete the imported certificate',
      message: t('proxy.certs.deleteConfirm', { name: c.primaryName, defaultValue: 'Delete the imported certificate {{name}}? Its key is destroyed.' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteImportedCertificate(c.id);
      toast.success(t('proxy.certs.deleted') || 'Certificate deleted');
      setItems((cur) => cur.filter((x) => !(x.kind === 'imported' && x.id === c.id)));
    } catch (err) {
      toastProxyError(t, err, t('proxy.certs.deleteFailed') || 'Failed to delete the certificate');
    }
  };

  const manageable = accounts.filter((a) => canManage(a.id));
  const importBtn = canManage(accountId) && manageable.length > 0
    ? <button onClick={() => setImporting(true)} className={headerAccentBtnCls}><Upload size={14} />{t('proxy.certs.import') || 'Import a certificate'}</button>
    : null;
  const usedByLabel = (u: CertificateListItem['usedBy'][number]) => {
    switch (u.kind) {
      case 'site-domain': return t('proxy.certs.usedSite') || 'sites';
      case 'proxy-host': return t('proxy.certs.usedHost') || 'proxy host';
      case 'redirection': return t('proxy.certs.usedRedirect') || 'redirection';
      case 'dead-host': return t('proxy.certs.usedDead') || 'dead host';
      default: return t('proxy.certs.usedWorkflow') || 'workflow';
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('proxy.certs.status') || 'Status'} value={status} onChange={(e) => setStatus(e.target.value as CertificateStatus | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-48')}>
          <option value="">{t('proxy.certs.allStatus') || 'Every status'}</option>
          <option value="valid">{t('proxy.certs.valid') || 'valid'}</option>
          <option value="pending">{t('proxy.certs.pending') || 'pending'}</option>
          <option value="failed">{t('proxy.certs.failed') || 'failed'}</option>
          <option value="expired">{t('proxy.certs.expired') || 'expired'}</option>
        </select>
        <div className="ml-auto">{importBtn}</div>
      </div>
      <p className="-mt-1 text-xs text-text-muted">
        {t('proxy.certs.description') || 'Let’s Encrypt certificates of the domains (renewed automatically, DNS-01 for wildcards) and imported certificates. A proxy host uses the certificates of its domains, or an imported one.'}{' '}
        {t('proxy.certs.acmeHint') || 'A Let’s Encrypt certificate is managed from its domain: click its name.'}
      </p>
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<ShieldCheck />} emptyText={t('proxy.certs.empty') || 'No certificate.'} emptyAction={importBtn ?? undefined}>
        <GroupedTable<CertificateListItem>
          storageKey="proxy-certificates"
          singleGroupFlat
          minWidth={860}
          defaultSort={{ column: 'names' }}
          groups={showAccount
            ? groupRowsByAccount(items, accountDir, (c) => ({ id: c.accountId, username: c.accountUsername }), (rows) => domainTree(rows, (c) => c.primaryName, (c) => `${c.kind}-${c.id}`), t('proxy.platformGroup') || 'Platform')
            : [{ key: 'all', label: '', sortLabel: '', nodes: domainTree(items, (c) => c.primaryName, (c) => `${c.kind}-${c.id}`) }]}
          columns={[
            {
              id: 'names', header: t('proxy.certs.names') || 'Names', tdClassName: 'max-w-[20rem]', sort: (c) => c.primaryName,
              cell: (c) => (
                <>
                  {c.kind === 'acme' && c.domainId != null ? (
                    <button type="button" onClick={() => drawer.open(c.domainId!)} className="font-mono text-[13px] text-text-primary hover:text-accent hover:underline" title={t('proxy.certs.openDomain') || 'Open the domain'}>
                      {c.primaryName}
                    </button>
                  ) : <span className="font-mono text-[13px] text-text-primary">{c.primaryName}</span>}
                  {c.names.length > 1 && <div className="mt-0.5 break-all font-mono text-[11px] text-text-muted">{c.names.filter((n) => n !== c.primaryName).join(', ')}</div>}
                </>
              ),
            },
            {
              id: 'source', header: t('proxy.certs.source') || 'Source', sort: (c) => c.kind,
              cell: (c) => (
                <>
                  {c.kind === 'acme' ? <Pill tone="blue">ACME</Pill> : <Pill tone="accent">{t('proxy.certs.imported') || 'imported'}</Pill>}
                  {c.issuer && <div className="mt-0.5 text-[11px] text-text-muted">{c.issuer}</div>}
                </>
              ),
            },
            { id: 'status', header: t('proxy.certs.status') || 'Status', sort: (c) => c.status, cell: (c) => <CertificateStatusPill status={c.status} notAfter={c.notAfter} lastError={c.lastError} /> },
            {
              id: 'expires', header: t('proxy.certs.expires') || 'Expires', tdClassName: 'font-mono text-xs text-text-secondary', sort: (c) => c.notAfter ?? '',
              cell: (c) => (c.notAfter ? new Date(c.notAfter).toLocaleDateString(i18n.language) : '—'),
            },
            {
              id: 'usedBy', header: t('proxy.usedBy') || 'Used by', tdClassName: 'text-xs text-text-secondary', sort: (c) => c.usedBy.length,
              cell: (c) => (c.usedBy.length === 0 ? '—' : (
                <ul className="space-y-0.5">
                  {c.usedBy.slice(0, 3).map((u) => <li key={`${u.kind}-${u.id}`}><span className="text-text-muted">{usedByLabel(u)}</span> {u.name}</li>)}
                  {c.usedBy.length > 3 && <li className="text-text-muted">+{c.usedBy.length - 3}</li>}
                </ul>
              )),
            },
            ...(showTenant && !showAccount ? [{ id: 'tenant', header: t('proxy.tenant') || 'Workspace', cell: (c: CertificateListItem) => <TenantBadge tenantId={c.tenantId} /> }] : []),
            { id: 'actions', header: <span className="sr-only">{t('proxy.actions') || 'Actions'}</span>, thClassName: 'w-14', tdClassName: 'text-right', cell: (c) => (c.kind === 'acme' && c.domainId != null
              ? <IconButton label={t('proxy.certs.openDomain') || 'Open the domain'} icon={<Globe size={14} />} variant="ghost" size="sm" onClick={() => drawer.open(c.domainId!)} />
              : c.kind === 'imported' && c.accountId != null && canManage(c.accountId)
                ? <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} variant="danger" size="sm" onClick={() => { void remove(c); }} />
                : null) },
          ]}
        />
      </ListState>

      <CertificateImportModal
        open={importing}
        accounts={manageable}
        defaultAccountId={accountId}
        onClose={() => setImporting(false)}
        onSaved={() => { setImporting(false); toast.success(t('proxy.certs.importedToast') || 'Certificate imported'); void load(); }}
      />
    </div>
  );
}

function CertificateImportModal({ open, accounts, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  accounts: HostingAccount[];
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [chain, setChain] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAccountId(defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setName('');
    setCert('');
    setKey('');
    setChain('');
    setError('');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server limit: 64 KiB per PEM field (certImport schema).
  const fits = (v: string) => v.trim().length <= MAX_PEM;
  const certOk = /-----BEGIN CERTIFICATE-----/.test(cert) && fits(cert);
  const keyOk = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) && fits(key);
  const chainOk = !chain.trim() || (/-----BEGIN CERTIFICATE-----/.test(chain) && fits(chain));
  const tooBig = !fits(cert) || !fits(key) || !fits(chain);
  const canSubmit = accountId != null && name.trim().length > 0 && certOk && keyOk && chainOk;

  const readFile = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_PEM) {
      setError(t('proxy.certs.fileTooBig', { name: f.name, defaultValue: '{{name}} is too big (64 KiB at most per PEM file).' }));
      return;
    }
    setError('');
    void f.text().then(setter);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      await proxyApi.importCertificate({ accountId: accountId!, name: name.trim(), certificatePem: cert.trim(), privateKeyPem: key.trim(), chainPem: chain.trim() || null });
      setKey('');
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.certs.importFailed') || 'Failed to import the certificate'));
    } finally {
      setSaving(false);
    }
  };

  const pemField = (id: string, label: string, value: string, setter: (v: string) => void, ok: boolean, placeholder: string) => (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <label className="text-xs text-text-muted" htmlFor={id}>{label}</label>
        <label className="ml-auto cursor-pointer text-[11px] text-accent hover:underline">
          {t('proxy.certs.fromFile') || 'From a file…'}
          <input type="file" accept=".pem,.crt,.key,.cer,.txt" className="sr-only" onChange={readFile(setter)} />
        </label>
      </div>
      <textarea id={id} value={value} onChange={(e) => setter(e.target.value)} rows={5} spellCheck={false} placeholder={placeholder}
        className={cn(inputCls, 'resize-y font-mono text-[11px] leading-snug', value && !ok && 'ring-2 ring-status-down/50')} />
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('proxy.certs.importTitle') || 'Import a certificate'}
      icon={<FileKey2 className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('proxy.certs.importAction') || 'Import'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {accounts.length > 1 && <AccountField id="ci-account" accounts={accounts} value={accountId} onChange={setAccountId} />}
        <div>
          <label className={labelCls} htmlFor="ci-name">{t('proxy.certs.name') || 'Name'}</label>
          <input id="ci-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="wildcard-2027" className={inputCls} />
        </div>
        {pemField('ci-cert', t('proxy.certs.certificatePem') || 'Certificate (PEM)', cert, setCert, certOk, '-----BEGIN CERTIFICATE-----')}
        {pemField('ci-key', t('proxy.certs.privateKeyPem') || 'Private key (PEM)', key, setKey, keyOk, '-----BEGIN PRIVATE KEY-----')}
        {pemField('ci-chain', t('proxy.certs.chainPem') || 'Intermediate chain (PEM, optional)', chain, setChain, chainOk, '-----BEGIN CERTIFICATE-----')}
        <p className="text-[11px] text-text-muted">{t('proxy.certs.importHint') || 'The names of the certificate must be verified domains of the account (or their sub-domains under a wildcard). The key is stored sealed and never shown again.'}</p>
        {tooBig && <p className="text-xs text-status-down">{t('proxy.certs.pemTooBig') || 'Each PEM field is limited to 64 KiB.'}</p>}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
