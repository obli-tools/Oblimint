import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import type { HostingAccount } from '@oblimint/shared';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { AccountScopeBar, useAccountScope } from '@/components/common/AccountScope';
import { FileExplorer } from '@/components/files/FileExplorer';
import { useHostingMe } from '@/store/hostingStore';
import { SettingsLink } from '@/components/common/SettingsLink';

const LAST_ACCOUNT = 'oblimint.files.account';

/**
 * « Fichiers »: the web file explorer of one hosting account (its SFTP tree).
 * The account and the folder live in the URL (?account=7&path=/staging/blog),
 * the last account opened is remembered. Same account scope as the other
 * cross-account pages, without « every account » (one tree at a time). The
 * account Files picks by itself never becomes the session scope of the others.
 */
export function FilesPage() {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const usableFilter = useCallback((a: HostingAccount) => can('files.manage', a.id), [can]);
  const scope = useAccountScope({ accountFilter: usableFilter, remember: false });
  const { params, accountsLoaded } = scope;
  const [, setParams] = useSearchParams();
  const usable = scope.accounts;

  const fromUrl = scope.accountParam;
  let remembered = 0;
  try { remembered = Number(localStorage.getItem(LAST_ACCOUNT)); } catch { /* private mode */ }
  const accountId = fromUrl != null && usable.some((a) => a.id === fromUrl) ? fromUrl
    : usable.some((a) => a.id === remembered) ? remembered
      : [...usable].sort((a, b) => (a.primaryDomain || a.username).localeCompare(b.primaryDomain || b.username))[0]?.id ?? null;
  const path = params.get('path') || '/staging';

  useEffect(() => {
    if (accountId === null) return;
    try { localStorage.setItem(LAST_ACCOUNT, String(accountId)); } catch { /* private mode */ }
    if (fromUrl !== accountId) setParams((prev) => { const next = new URLSearchParams(prev); next.set('account', String(accountId)); next.set('path', path); return next; }, { replace: true });
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A folder change is a history entry (back = previous folder); the workspace chips stay.
  const go = (p: string, account = accountId) => setParams((prev) => { const next = new URLSearchParams(prev); if (account != null) next.set('account', String(account)); next.set('path', p); return next; });

  return (
    <PageContainer className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FolderOpen className="h-6 w-6 text-accent" />
        <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.files') || 'Files'}</h1>
        <div className="ml-auto"><SettingsLink anchor="settings-access" /></div>
      </div>
      <AccountScopeBar scope={scope} allowAll={false} value={accountId} onChange={(id) => { if (id != null) go('/staging', id); }} />
      {!accountsLoaded ? (
        <div className="flex justify-center p-10"><LoadingSpinner /></div>
      ) : accountId === null ? (
        <EmptyState icon={<FolderOpen />} text={t('files.noAccount') || 'No hosting account whose files you can manage.'} />
      ) : (
        <FileExplorer key={accountId} accountId={accountId} path={path} onPathChange={(p) => go(p)} className="min-h-[60vh] flex-1" />
      )}
    </PageContainer>
  );
}
