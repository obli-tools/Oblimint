import { useTranslation } from 'react-i18next';
import { AlertTriangle, Star } from 'lucide-react';
import { dbEngineVersionDef, type DbEngine, type DbInstanceStatus } from '@oblimint/shared';
import { Tip } from '@/components/common/Tip';
import { Pill } from '@/components/hosting/hostingUi';
import { dbStatusLabel, engineLabel } from './dbFormat';

export function DbStatusBadge({ status, message }: { status: DbInstanceStatus; message?: string | null }) {
  const { t } = useTranslation();
  const tone = ({ provisioning: 'blue', running: 'green', stopped: 'muted', error: 'red', deleting: 'amber' } as const)[status];
  const pill = <Pill tone={tone}>{dbStatusLabel(t, status)}</Pill>;
  return message ? <Tip content={message}><span className="cursor-help">{pill}</span></Tip> : pill;
}

/** « MariaDB 11.4 » (+ « unmaintained » when the version is end-of-life). */
export function DbEngineBadge({ engine, version }: { engine: DbEngine; version: string }) {
  const { t } = useTranslation();
  const eol = dbEngineVersionDef(engine, version)?.eol ?? false;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone={engine === 'postgresql' ? 'blue' : 'accent'}>{engineLabel(engine)} {version}</Pill>
      {eol && (
        <Tip content={t('databases.eolHint') || 'This version no longer receives security updates: plan a migration.'}>
          <span className="cursor-help"><Pill tone="amber"><AlertTriangle size={10} />{t('databases.eol') || 'unmaintained'}</Pill></span>
        </Tip>
      )}
    </span>
  );
}

export function DbDefaultBadge() {
  const { t } = useTranslation();
  return (
    <Tip content={t('databases.defaultHint') || 'Default instance of the account: its socket is mounted at the standard path in every site (DB_HOST=localhost).'}>
      <span className="cursor-help"><Pill tone="green"><Star size={10} />{t('databases.default') || 'default'}</Pill></span>
    </Tip>
  );
}
