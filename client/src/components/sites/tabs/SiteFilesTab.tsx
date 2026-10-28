import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, HardDrive } from 'lucide-react';
import { FileAccessPanel } from '@/components/hosting/FileAccessPanel';
import { FileExplorer } from '@/components/files/FileExplorer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { useHostingMe } from '@/store/hostingStore';
import type { SiteTabProps } from './types';

type Root = 'staging' | 'data';

/**
 * Files of a site (coherence plan 1.3 / D6): the explorer on the code
 * (/staging/<slug>) or the data (/data/<slug>) of the site, and the SFTP
 * connection read only — the SFTP access belongs to the account (Files tab
 * of the account), it is never reset from a site.
 */
export function SiteFilesTab({ site }: SiteTabProps) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const rootOf = (r: Root) => `/${r}/${site.slug}`;
  const [root, setRoot] = useState<Root>('staging');
  const [path, setPath] = useState(rootOf('staging'));
  const switchRoot = (r: Root) => { setRoot(r); setPath(rootOf(r)); };

  return (
    <div className="space-y-4">
      {can('files.manage', site.accountId) && (
        <>
          <SegmentedTabs<Root>
            tabs={[
              { id: 'staging', label: t('sites.files.stagingTab') || 'Code (staging)', icon: <Code2 size={14} /> },
              { id: 'data', label: t('sites.files.dataTab') || 'Data', icon: <HardDrive size={14} /> },
            ]}
            value={root}
            onChange={switchRoot}
            size="sm"
            fill={false}
            className="self-start"
            ariaLabel={t('sites.tabs.files') || 'Files'}
          />
          <FileExplorer accountId={site.accountId} path={path} onPathChange={setPath} className="h-[65vh] min-h-[420px]" />
        </>
      )}
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
      <FileAccessPanel accountId={site.accountId} siteSlug={site.slug} variant="site" />
    </div>
  );
}
