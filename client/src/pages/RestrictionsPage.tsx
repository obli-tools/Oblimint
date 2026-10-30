import { useTranslation } from 'react-i18next';
import { PageContainer } from '@/components/common/PageContainer';
import { RestrictionsTab } from '@/components/restrictions/RestrictionsTab';

// Matrix of the protected actions for the workspace staff holding the
// `settings` capability (platform admins reach it as a tab of Users).
export function RestrictionsPage() {
  const { t } = useTranslation();
  return (
    <PageContainer>
      <div className="mb-4">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('restrictions.title') || 'Protected actions'}</h1>
        <p className="text-sm text-text-muted">{t('restrictions.subtitle') || 'Actions of this workspace that need a 2FA code or the approval of a second person.'}</p>
      </div>
      <RestrictionsTab />
    </PageContainer>
  );
}
