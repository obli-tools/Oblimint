import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Globe } from 'lucide-react';
import type { Domain, DomainKind, HostingAccount, Site, TlsMode } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { cn } from '@/utils/cn';
import { hostingErrorMessage, inputCls, isStepUpHandled, labelCls, selectCls } from './hostingUi';
import { normalizeDomainName } from './hostingFormat';

export const DOMAIN_KINDS: DomainKind[] = ['primary', 'addon', 'alias', 'subdomain'];

export function domainKindLabel(t: TFunction, k: DomainKind): string {
  const fallback: Record<DomainKind, string> = { primary: 'Primary', addon: 'Add-on', alias: 'Alias', subdomain: 'Subdomain' };
  return t(`domains.kind.${k}`) || fallback[k];
}

export function tlsModeLabel(t: TFunction, m: TlsMode): string {
  return m === 'letsencrypt' ? (t('domains.tls.letsencrypt') || "Let's Encrypt") : (t('domains.tls.none') || 'None (HTTP only)');
}

/** Create a domain (optionally routed at '/' to a site of the account). */
export function DomainCreateModal({ open, onClose, onCreated, accountId: fixedAccountId }: {
  open: boolean;
  onClose: () => void;
  onCreated: (d: Domain) => void;
  /** Fixed account (account detail page); otherwise an account select is shown. */
  accountId?: number;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [sites, setSites] = useState<Site[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DomainKind>('primary');
  const [includeWww, setIncludeWww] = useState(true);
  const [tlsMode, setTlsMode] = useState<TlsMode>('letsencrypt');
  const [forceHttps, setForceHttps] = useState(true);
  const [siteId, setSiteId] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(''); setKind('primary'); setIncludeWww(true); setTlsMode('letsencrypt'); setForceHttps(true);
    setSiteId(''); setError(null); setSites([]);
    setAccountId(fixedAccountId ?? '');
    if (fixedAccountId == null) {
      accountsApi.list()
        .then((list) => {
          const allowed = list.filter((a) => can('domains.manage', a.id));
          setAccounts(allowed);
          if (allowed.length === 1) setAccountId(allowed[0].id);
        })
        .catch(() => setAccounts([]));
    }
  }, [open, fixedAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || accountId === '') { setSites([]); return; }
    let cancelled = false;
    sitesApi.list({ accountId })
      .then((list) => { if (!cancelled) setSites(list); })
      .catch(() => { if (!cancelled) setSites([]); });
    setSiteId('');
    return () => { cancelled = true; };
  }, [open, accountId]);

  const normalized = normalizeDomainName(name);
  const canSubmit = normalized !== null && accountId !== '' && !saving;

  const submit = async () => {
    if (!canSubmit || typeof accountId !== 'number' || !normalized) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await domainsApi.create({
        accountId,
        name: normalized,
        kind,
        includeWww: kind === 'subdomain' ? false : includeWww,
        tlsMode,
        forceHttps: tlsMode === 'none' ? false : forceHttps,
        siteId: siteId === '' ? null : siteId,
      }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('domains.createFailed') || 'Failed to add the domain'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('domains.form.createTitle') || 'Add a domain'}
      icon={<Globe className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {fixedAccountId == null && (
          <div>
            <label className={labelCls} htmlFor="dom-account">{t('domains.form.account') || 'Hosting account'}</label>
            <select id="dom-account" value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('domains.form.chooseAccount') || 'Choose an account…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="dom-name">{t('domains.form.name') || 'Domain name'}</label>
          <input
            id="dom-name"
            value={name}
            autoFocus
            autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            placeholder="example.com"
            className={cn(inputCls, 'font-mono', name && !normalized && 'ring-2 ring-status-down')}
          />
          {name && !normalized && <p className="mt-1 text-xs text-status-down">{t('domains.form.nameInvalid') || 'Not a valid domain name.'}</p>}
          {normalized && normalized !== name.trim().toLowerCase() && (
            <p className="mt-1 font-mono text-xs text-text-muted">{t('domains.form.normalized', { name: normalized, defaultValue: 'Stored as {{name}}' })}</p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dom-kind">{t('domains.form.kind') || 'Kind'}</label>
            <select id="dom-kind" value={kind} onChange={(e) => setKind(e.target.value as DomainKind)} className={selectCls}>
              {DOMAIN_KINDS.map((k) => <option key={k} value={k}>{domainKindLabel(t, k)}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="dom-tls">{t('domains.form.tls') || 'TLS'}</label>
            <select id="dom-tls" value={tlsMode} onChange={(e) => setTlsMode(e.target.value as TlsMode)} className={selectCls}>
              <option value="letsencrypt">{tlsModeLabel(t, 'letsencrypt')}</option>
              <option value="none">{tlsModeLabel(t, 'none')}</option>
            </select>
          </div>
        </div>
        <div className="space-y-2">
          {kind !== 'subdomain' && (
            <ToggleSwitch checked={includeWww} onChange={setIncludeWww} label={t('domains.form.includeWww') || 'Also serve www.'} description={normalized ? `www.${normalized}` : undefined} />
          )}
          <ToggleSwitch
            checked={tlsMode !== 'none' && forceHttps}
            disabled={tlsMode === 'none'}
            onChange={setForceHttps}
            label={t('domains.forceHttps') || 'Force HTTPS'}
            description={t('domains.form.forceHttpsHint') || 'Redirect HTTP to HTTPS once the certificate is valid.'}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="dom-site">{t('domains.form.site') || 'Route "/" to a site (optional)'}</label>
          <select id="dom-site" value={siteId} disabled={accountId === ''} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
            <option value="">{t('domains.form.noSite') || 'No route for now'}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
          </select>
        </div>
        {tlsMode === 'letsencrypt' && (
          <p className="text-xs text-text-muted">{t('domains.form.dnsHint') || 'Point the DNS (A / AAAA) of the domain to this server first: the certificate is requested through HTTP-01.'}</p>
        )}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
