import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ClientCapability } from '@oblimint/shared';
import { CLIENT_CAPABILITIES } from '@oblimint/shared';
import { RightsChecklist } from '@/components/common/RightsChecklist';
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
    'mail.manage': 'Manage mail',
    'apps.manage': 'Manage applications',
    'apps.console': 'Application console',
    'proxy.manage': 'Manage proxy hosts',
    'monitoring.manage': 'Manage monitoring',
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
    'mail.manage': 'Create mail domains, mailboxes, aliases and forwards, manage DKIM and the site relay, open the webmail.',
    'apps.manage': 'Deploy Docker applications (compose, git, catalog), update them, declare network links.',
    'apps.console': 'Open an interactive console in the application containers (when the plan allows it).',
    'proxy.manage': 'Create proxy hosts, redirections, dead hosts, access lists, error pages and manage the bans of the account.',
    'monitoring.manage': 'Create uptime monitors, status pages, workflows, SFTP targets and maintenance windows.',
  };
  return t(`accounts.capabilities.${c.replace('.', '_')}_hint`) || fallback[c];
}

/** Checklist of the client capabilities (in CLIENT_CAPABILITIES order) — the common rights editor. */
export function CapabilityCheckboxes({ value, onChange, disabled = false }: {
  value: ClientCapability[]; onChange: (next: ClientCapability[]) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <RightsChecklist<ClientCapability>
      items={CLIENT_CAPABILITIES.map((c) => ({ id: c, label: capabilityLabel(t, c), hint: capabilityHint(t, c) }))}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** Read-only chips of a capability list. */
export function CapabilityChips({ value }: { value: ClientCapability[] }) {
  const { t } = useTranslation();
  if (value.length === 0) return <span className="text-xs text-text-muted">{t('accounts.users.readOnly') || 'read only'}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {value.map((c) => <Pill key={c} tone="accent">{capabilityLabel(t, c)}</Pill>)}
    </div>
  );
}
