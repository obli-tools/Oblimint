import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';

interface ComingSoonPageProps {
  /** Lucide icon of the future feature (same as its sidebar entry). */
  icon: ReactNode;
  /** i18n key of the page title (e.g. `nav.sites`) + its English fallback. */
  titleKey: string;
  titleFallback: string;
  /** i18n key of the one-sentence description + its English fallback. */
  descriptionKey: string;
  descriptionFallback: string;
}

/**
 * Placeholder of a P1+ feature: icon, title and one sentence describing
 * what the page will do. Same page header as the Obliance pages
 * (font-display title + mono subtitle).
 */
export function ComingSoonPage({ icon, titleKey, titleFallback, descriptionKey, descriptionFallback }: ComingSoonPageProps) {
  const { t } = useTranslation();
  const title = t(titleKey) || titleFallback;
  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{title}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('comingSoon.badge') || 'Coming soon'}
        </span>
      </div>

      <div className="flex flex-col items-center justify-center gap-4 rounded-xl bg-bg-secondary px-6 py-16 text-center shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/12 text-accent [&>svg]:h-8 [&>svg]:w-8">
          {icon}
        </div>
        <h2 className="font-display text-xl font-semibold tracking-wide text-text-primary">{title}</h2>
        <p className="max-w-lg text-sm text-text-secondary">{t(descriptionKey) || descriptionFallback}</p>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-bg-hover px-3 py-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">
          <Clock size={12} />
          {t('comingSoon.badge') || 'Coming soon'}
        </span>
      </div>
    </PageContainer>
  );
}
