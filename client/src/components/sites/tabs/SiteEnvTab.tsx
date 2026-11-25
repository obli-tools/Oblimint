import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { SiteEnvVar } from '@oblimint/shared';
import { reservedEnvName } from '@oblimint/shared';
import apiClient from '@/api/client';
import { Card, toastHostingError } from '@/components/hosting/hostingUi';
import { EnvVarsEditor } from '@/components/envVars/EnvVarsEditor';
import type { EnvVarSave, EnvVarView } from '@/components/envVars/envVarsLogic';
import { useHostingMe } from '@/store/hostingStore';
import type { SiteTabProps } from './types';

// Environment variables of the site: secrets out of the code (PHP getenv()
// / $_SERVER, cron, CLI). The whole set is saved at once; a change restarts
// the site's containers. A secret is write-only (left empty = unchanged);
// unchecking Secret on a stored one needs a new value (the server refuses to
// reveal the stored one). The editor itself is shared with the application
// .env (components/envVars/EnvVarsEditor).

export { parseDotEnv } from '@/components/envVars/envVarsLogic';

export function SiteEnvTab({ site }: SiteTabProps) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const manage = can('sites.manage', site.accountId);
  const [vars, setVars] = useState<EnvVarView[] | null>(null);

  useEffect(() => {
    if (!manage) return;
    apiClient.get<{ data: SiteEnvVar[] }>(`/sites/${site.id}/env`)
      .then((r) => setVars(r.data.data))
      .catch((err) => { toastHostingError(t, err, t('siteEnv.loadFailed') || 'The variables could not be loaded'); setVars([]); });
  }, [manage, site.id, t]);

  if (!manage) return <Card><p className="text-sm text-text-muted">{t('siteEnv.noRight') || 'Managing the variables needs the site settings right.'}</p></Card>;

  const save = async (body: EnvVarSave[]): Promise<EnvVarView[] | null> => {
    try {
      const res = await apiClient.put<{ data: { vars: SiteEnvVar[]; changed: boolean } }>(`/sites/${site.id}/env`, { vars: body });
      toast.success(res.data.data.changed ? (t('siteEnv.saved') || 'Saved: the site restarts with the new variables') : (t('siteEnv.unchanged') || 'Nothing changed'));
      return res.data.data.vars;
    } catch (err) {
      toastHostingError(t, err, t('siteEnv.saveFailed') || 'The variables could not be saved');
      return null;
    }
  };

  return (
    <EnvVarsEditor
      vars={vars}
      onSave={save}
      reserved={reservedEnvName}
      intro={t('siteEnv.intro') || 'Given to the site at start-up: getenv(\'NAME\') or $_SERVER[\'NAME\'] in PHP, also in the cron jobs. The right place for API keys and passwords: never in the code, never in the public folder. Saving restarts the site (a few seconds).'}
    />
  );
}
