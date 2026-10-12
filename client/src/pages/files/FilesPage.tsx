import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import type { HostingAccount } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { FileExplorer } from '@/components/files/FileExplorer';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';

const LAST_ACCOUNT = 'oblimint.files.account';

/**
 * « Fichiers »: the web file explorer of one hosting account (its SFTP tree).
 * The account and the folder live in the URL (?account=7&path=/staging/blog),
 * the last account opened is remembered.
 */
export function FilesPage() {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const tenant = useTenantStore((s) => s.currentTenantId);
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<HostingAccount[] | null>(null);

  useEffect(() => {
    let live = true;
    accountsApi.list().then((l) => { if (live) setAccounts(l); }).catch(() => { if (live) setAccounts([]); });
    return () => { live = false; };
  }, [tenant]);

  const usable = useMemo(() => (accounts ?? [])
    .filter((a) => can('files.manage', a.id))
    .sort((a, b) => (a.primaryDomain || a.username).localeCompare(b.primaryDomain || b.username)), [accounts, can]);

  const fromUrl = Number(params.get('account'));
  let remembered = 0;
  try { remembered = Number(localStorage.getItem(LAST_ACCOUNT)); } catch { /* private mode */ }
  const accountId = usable.some((a) => a.id === fromUrl) ? fromUrl
    : usable.some((a) => a.id === remembered) ? remembered
      : usable[0]?.id ?? null;
  const path = params.get('path') || '/staging';

  useEffect(() => {
    if (accountId === null) return;
    try { localStorage.setItem(LAST_ACCOUNT, String(accountId)); } catch { /* private mode */ }
    if (fromUrl !== accountId) setParams({ account: String(accountId), path }, { replace: true });
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (p: string, account = accountId) => setParams({ account: String(account), path: p });

  return (
    <PageContainer className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FolderOpen className="h-6 w-6 text-accent" />
        <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.files') || 'Files'}</h1>
        {usable.length > 0 && (
          <select
            value={accountId ?? ''}
            onChange={(e) => go('/staging', Number(e.target.value))}
            aria-label={t('files.account') || 'Account'}
            className="ml-auto max-w-full rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none ring-1 ring-white/[0.06] focus:ring-accent"
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>{a.primaryDomain ? `${a.primaryDomain} — ${a.username}` : a.username}</option>
            ))}
          </select>
        )}
      </div>
      {accounts === null ? (
        <div className="flex justify-center p-10"><LoadingSpinner /></div>
      ) : accountId === null ? (
        <div className="rounded-xl bg-bg-secondary p-10 text-center text-sm text-text-muted">
          {t('files.noAccount') || 'No hosting account whose files you can manage.'}
        </div>
      ) : (
        <FileExplorer key={accountId} accountId={accountId} path={path} onPathChange={(p) => go(p)} className="min-h-[60vh] flex-1" />
      )}
    </PageContainer>
  );
}
