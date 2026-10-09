import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClientCapability } from '@oblimint/shared';
import { CLIENT_CAPABILITIES } from '@oblimint/shared';
import { Pill } from './hostingUi';

export function capabilityLabel(t: TFunction, c: ClientCapability): string {
  const fallback: Record<ClientCapability, string> = {
    'sites.manage': 'Manage sites',
    'releases.publish': 'Publish releases',
    'releases.approve': 'Approve releases',
    'domains.manage': 'Manage domains',
    'files.manage': 'Manage file access',
    'databases.manage': 'Manage databases',
    'dns.manage': 'Manage DNS zones',
  };
  return t(`accounts.capabilities.${c.replace('.', '_')}`) || fallback[c];
}

function capabilityHint(t: TFunction, c: ClientCapability): string {
  const fallback: Record<ClientCapability, string> = {
    'sites.manage': 'Create, configure and delete the sites of the account.',
    'releases.publish': 'Publish the staging and roll back releases.',
    'releases.approve': 'Approve or reject releases waiting for approval.',
    'domains.manage': 'Add domains and edit their routes.',
    'files.manage': 'Open the SFTP access, set its password and SSH keys, and the access allow-list.',
    'databases.manage': 'Create database instances, databases and users, open phpMyAdmin / Adminer.',
    'dns.manage': 'Edit the DNS records of the account zones.',
  };
  return t(`accounts.capabilities.${c.replace('.', '_')}_hint`) || fallback[c];
}

/** Checkbox list of the client capabilities (in CLIENT_CAPABILITIES order). */
export function CapabilityCheckboxes({ value, onChange, disabled = false }: {
  value: ClientCapability[]; onChange: (next: ClientCapability[]) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const toggle = (c: ClientCapability) => {
    const set = new Set(value);
    if (set.has(c)) set.delete(c); else set.add(c);
    onChange(CLIENT_CAPABILITIES.filter((x) => set.has(x)));
  };
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {CLIENT_CAPABILITIES.map((c) => (
        <label key={c} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 coarse:py-2">
          <input type="checkbox" className="mt-0.5 accent-accent" checked={value.includes(c)} disabled={disabled} onChange={() => toggle(c)} />
          <span className="min-w-0">
            <span className="block text-sm text-text-primary">{capabilityLabel(t, c)}</span>
            <span className="block text-[11px] text-text-muted">{capabilityHint(t, c)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Read-only chips of a capability list. */
export function CapabilityChips({ value }: { value: ClientCapability[] }) {
  const { t } = useTranslation();
  if (value.length === 0) return <span className="text-xs text-text-muted">{t('accounts.users.readOnly') || 'read only'}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {value.map((c) => <Pill key={c} tone="accent" className="normal-case tracking-normal">{capabilityLabel(t, c)}</Pill>)}
    </div>
  );
}
