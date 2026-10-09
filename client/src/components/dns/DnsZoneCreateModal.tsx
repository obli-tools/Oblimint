import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import { MASTER_TENANT_ID, type DnsTemplate, type DnsZone, type DnsZoneKind, type Domain, type HostingAccount } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { dnsApi } from '@/api/dns.api';
import { domainsApi } from '@/api/domains.api';
import { useHostingMe } from '@/store/hostingStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { normalizeDomainName } from '@/components/hosting/hostingFormat';
import { cn } from '@/utils/cn';
import { zoneKindLabel } from './DnsBadges';
import { dnsErrorMessage } from './dnsErrors';

/** '' = choose, 'platform' = platform zone (platform admin), else an account id. */
type Owner = '' | 'platform' | number;

/**
 * Create a zone: for a domain of the account that has none yet, or a manual
 * name (delegated sub-zone, must belong to a domain of the account), or a
 * platform zone (preview domain, DB admin host…) for a platform admin.
 */
export function DnsZoneCreateModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (z: DnsZone) => void;
}) {
  const { t } = useTranslation();
  const { me, can } = useHostingMe();
  // Platform admin = role admin in the master tenant (server: caps '*' && globalView).
  const platformAdmin = useIsMasterTenant();
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [owner, setOwner] = useState<Owner>('');
  const [domains, setDomains] = useState<Domain[]>([]);
  const [source, setSource] = useState<'domain' | 'name'>('domain');
  const [domainId, setDomainId] = useState<number | ''>('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DnsZoneKind>('hosted');
  const [templates, setTemplates] = useState<DnsTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOwner(''); setDomains([]); setSource('domain'); setDomainId(''); setName(''); setKind('hosted'); setTemplateId(''); setError(null);
    accountsApi.list()
      .then((list) => {
        const allowed = list.filter((a) => can('dns.manage', a.id));
        setAccounts(allowed);
        if (allowed.length === 1 && !platformAdmin) setOwner(allowed[0].id);
      })
      .catch(() => setAccounts([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Workspace the zone will belong to: the server only accepts a template of
  // that workspace (the god view would otherwise list every workspace's ones).
  const ownerTenantId = owner === 'platform'
    ? MASTER_TENANT_ID
    : typeof owner === 'number' ? (accounts.find((a) => a.id === owner)?.tenantId ?? null) : null;

  useEffect(() => {
    setTemplateId('');
    // Templates are a staff tool (clients get the tenant default automatically).
    if (!open || me?.kind !== 'staff' || ownerTenantId === null) { setTemplates([]); return; }
    let cancelled = false;
    dnsApi.listTemplates({ tenantId: ownerTenantId })
      .then((list) => { if (!cancelled) setTemplates(list.filter((tp) => tp.tenantId === ownerTenantId)); })
      .catch(() => { if (!cancelled) setTemplates([]); });
    return () => { cancelled = true; };
  }, [open, me?.kind, ownerTenantId]);

  useEffect(() => {
    if (!open || typeof owner !== 'number') { setDomains([]); return; }
    let cancelled = false;
    domainsApi.list({ accountId: owner })
      .then((list) => { if (!cancelled) setDomains(list.filter((d) => !d.zone)); })
      .catch(() => { if (!cancelled) setDomains([]); });
    setDomainId('');
    return () => { cancelled = true; };
  }, [open, owner]);

  const platform = owner === 'platform';
  const effectiveSource = platform ? 'name' : source;
  const normalized = normalizeDomainName(name);
  const canSubmit = !saving && owner !== '' && (effectiveSource === 'domain' ? domainId !== '' : normalized !== null);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await dnsApi.createZone({
        accountId: platform ? null : (owner as number),
        ...(effectiveSource === 'domain' ? { domainId: domainId as number } : { name: normalized }),
        kind,
        templateId: templateId === '' ? null : templateId,
      }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dnsErrorMessage(t, err, t('dns.zones.createFailed') || 'Failed to create the zone'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('dns.zones.createTitle') || 'New DNS zone'}
      icon={<Network className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="zone-owner">{t('domains.form.account') || 'Hosting account'}</label>
          <select
            id="zone-owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value === '' ? '' : e.target.value === 'platform' ? 'platform' : Number(e.target.value))}
            className={selectCls}
          >
            <option value="">{t('domains.form.chooseAccount') || 'Choose an account…'}</option>
            {platformAdmin && <option value="platform">{t('dns.zones.platformOwner') || 'Platform (preview domain, admin hosts…)'}</option>}
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
          </select>
        </div>
        {!platform && (
          <SegmentedTabs<'domain' | 'name'>
            size="sm"
            value={source}
            onChange={setSource}
            ariaLabel={t('dns.zones.createTitle') || 'New DNS zone'}
            tabs={[
              { id: 'domain', label: t('dns.zones.fromDomain') || 'For a domain of the account' },
              { id: 'name', label: t('dns.zones.fromName') || 'Manual name (sub-zone)' },
            ]}
          />
        )}
        {effectiveSource === 'domain' ? (
          <div>
            <label className={labelCls} htmlFor="zone-domain">{t('dns.zones.domain') || 'Domain'}</label>
            <select id="zone-domain" value={domainId} disabled={typeof owner !== 'number'} onChange={(e) => setDomainId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('dns.zones.chooseDomain') || 'Choose a domain…'}</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {typeof owner === 'number' && domains.length === 0 && (
              <p className="mt-1 text-xs text-text-muted">{t('dns.zones.noDomainWithoutZone') || 'Every domain of this account already has a zone.'}</p>
            )}
          </div>
        ) : (
          <div>
            <label className={labelCls} htmlFor="zone-name">{t('dns.zones.name') || 'Zone name'}</label>
            <input
              id="zone-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={platform ? 'preview.example.net' : 'eu.example.com'}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
              className={cn(inputCls, 'font-mono', name && !normalized && 'ring-2 ring-status-down')}
            />
            {name && !normalized && <p className="mt-1 text-xs text-status-down">{t('domains.form.nameInvalid') || 'Not a valid domain name.'}</p>}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="zone-kind">{t('dns.zone.kind') || 'Kind'}</label>
            <select id="zone-kind" value={kind} onChange={(e) => setKind(e.target.value as DnsZoneKind)} className={selectCls}>
              <option value="hosted">{zoneKindLabel(t, 'hosted')}</option>
              <option value="external">{zoneKindLabel(t, 'external')}</option>
            </select>
          </div>
          {templates.length > 0 && (
            <div>
              <label className={labelCls} htmlFor="zone-template">{t('dns.templates.template') || 'Template'}</label>
              <select id="zone-template" value={templateId} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
                <option value="">{t('dns.templates.defaultChoice') || 'Default template of the workspace'}</option>
                {templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <p className="text-xs text-text-muted">
          {kind === 'hosted'
            ? (t('dns.zones.hostedHint') || 'Served by our name servers once the domain ownership is verified.')
            : (t('dns.zones.externalHint') || 'Not published here: the panel lists the records to create at your DNS provider.')}
        </p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
