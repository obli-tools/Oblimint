import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { headerBtnCls } from '@/components/hosting/hostingUi';

/**
 * « Settings » button of an operation page (coherence plan C11): opens the
 * single Settings page on the section of this module (`/settings#<anchor>`).
 * Platform admin only — the platform sections of Settings are theirs.
 */
export function SettingsLink({ anchor }: { anchor: string }) {
  const { t } = useTranslation();
  const admin = useAuthStore((s) => s.user?.role === 'admin');
  if (!admin) return null;
  const label = t('nav.settings') || 'Settings';
  return (
    <Link to={`/settings#${anchor}`} className={headerBtnCls} title={t('settings.sectionLink') || 'Settings of this module'}>
      <Settings size={14} />
      <span className="max-sm:sr-only">{label}</span>
    </Link>
  );
}
