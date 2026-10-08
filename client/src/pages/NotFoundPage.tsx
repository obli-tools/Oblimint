import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh supports-[not(height:100dvh)]:min-h-screen flex-col items-center justify-center bg-bg-primary p-4 pt-[max(1rem,var(--safe-top))] pb-[max(1rem,var(--safe-bottom))]">
      <h1 className="text-6xl font-bold text-text-muted">{t('notFound.title') || '404'}</h1>
      <p className="mt-4 text-lg text-text-secondary">{t('notFound.message') || 'Page not found'}</p>
      <Link to="/" className="mt-6">
        <Button variant="secondary">{t('notFound.goToDashboard') || 'Go to dashboard'}</Button>
      </Link>
    </div>
  );
}
