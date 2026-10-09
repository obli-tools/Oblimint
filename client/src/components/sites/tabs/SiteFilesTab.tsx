import { useTranslation } from 'react-i18next';
import { Code2, HardDrive } from 'lucide-react';
import { FileAccessPanel } from '@/components/hosting/FileAccessPanel';
import type { SiteTabProps } from './types';

export function SiteFilesTab({ site }: SiteTabProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2">
            <Code2 className="h-4 w-4 text-accent" />
            <code className="break-all font-mono text-sm text-text-primary">/staging/{site.slug}/</code>
          </div>
          <p className="text-xs text-text-muted">
            {t('sites.files.staging') || 'The code of the site. Upload it here: nothing is live until it is published as a release (automatically or with the "Publish" button). The live code can never be modified in place.'}
          </p>
        </div>
        <div className="rounded-xl bg-bg-secondary p-4">
          <div className="mb-1 flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-accent" />
            <code className="break-all font-mono text-sm text-text-primary">/data/{site.slug}/</code>
          </div>
          <p className="text-xs text-text-muted">
            {t('sites.files.data') || 'The writable data of the site (uploads, caches…), one folder per data path. Changes here are live immediately, but PHP is never executed from it.'}
          </p>
        </div>
      </div>
      <FileAccessPanel accountId={site.accountId} siteSlug={site.slug} />
    </div>
  );
}
