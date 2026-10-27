import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AppGitSource, AppGitSourceInput } from '@oblimint/shared';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';

export interface GitDraft {
  repoUrl: string;
  branch: string;
  composePath: string;
  /** New token ('' = keep / none). */
  token: string;
  removeToken: boolean;
  build: boolean;
  /** Poll interval in seconds ('' = no polling). */
  poll: string;
  autoDeploy: boolean;
}

export function gitDraftFrom(g: AppGitSource | null): GitDraft {
  return {
    repoUrl: g?.repoUrl ?? '',
    branch: g?.branch ?? 'main',
    composePath: g?.composePath ?? 'docker-compose.yml',
    token: '',
    removeToken: false,
    build: g?.build ?? false,
    poll: g?.pollIntervalSec != null ? String(g.pollIntervalSec) : '',
    autoDeploy: g?.autoDeploy ?? false,
  };
}

/** https:// only, no credentials in the URL (the token is sealed apart). */
export function gitUrlProblem(t: TFunction, url: string): string | null {
  const s = url.trim();
  if (!s) return t('common.requiredField') || 'This field is required';
  let u: URL;
  try { u = new URL(s); } catch { return t('apps.git.urlInvalid') || 'Invalid URL.'; }
  if (u.protocol !== 'https:') return t('apps.git.httpsOnly') || 'Only https:// repositories are supported.';
  if (u.username || u.password) return t('apps.git.noCredentialsInUrl') || 'Do not put credentials in the URL: use the token field.';
  return null;
}

/** Problem of the whole draft (null = ok). */
export function gitDraftProblem(t: TFunction, d: GitDraft, minPollSec = 60): string | null {
  const url = gitUrlProblem(t, d.repoUrl);
  if (url) return url;
  if (!d.branch.trim()) return t('apps.git.branchRequired') || 'The branch is required.';
  if (!d.composePath.trim() || d.composePath.includes('..') || d.composePath.startsWith('/')) return t('apps.git.composePathInvalid') || 'Invalid compose path (relative to the repository root).';
  if (d.poll.trim()) {
    const n = Number(d.poll);
    if (!Number.isInteger(n) || n < minPollSec) return t('apps.git.pollTooShort', { min: minPollSec, defaultValue: 'Poll interval: at least {{min}} s.' });
  }
  return null;
}

/** Repository URL as the server stores it (lower-case host, no trailing slash); the raw text when unparsable. */
function normalizedRepoUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.trim();
  }
}

/**
 * The repository changes while a token is stored and no new token is given:
 * the server refuses (gitTokenRequired), the stored token never goes to
 * another repository.
 */
export function gitTokenMissing(d: GitDraft, stored: AppGitSource | null): boolean {
  if (!stored?.hasToken || d.token || d.removeToken) return false;
  return normalizedRepoUrl(d.repoUrl) !== stored.repoUrl;
}

export function gitDraftOut(d: GitDraft): AppGitSourceInput {
  return {
    repoUrl: d.repoUrl.trim(),
    branch: d.branch.trim(),
    composePath: d.composePath.trim(),
    ...(d.removeToken ? { token: null } : d.token ? { token: d.token } : {}),
    build: d.build,
    pollIntervalSec: d.poll.trim() ? Number(d.poll) : null,
    autoDeploy: d.autoDeploy,
  };
}

/** Git source fields (create page, settings tab). */
export function GitSourceForm({ value, onChange, buildAllowed, hasToken = false, stored = null, idPrefix = 'git' }: {
  value: GitDraft;
  onChange: (next: GitDraft) => void;
  buildAllowed: boolean;
  /** A token is already stored (edit). */
  hasToken?: boolean;
  /** Stored source (edit): a new repository needs its token again. */
  stored?: AppGitSource | null;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<GitDraft>) => onChange({ ...value, ...patch });
  const urlIssue = value.repoUrl.trim() ? gitUrlProblem(t, value.repoUrl) : null;
  const tokenMissing = !urlIssue && gitTokenMissing(value, stored);
  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls} htmlFor={`${idPrefix}-url`}>{t('apps.git.repoUrl') || 'Repository (https://)'}</label>
        <input id={`${idPrefix}-url`} value={value.repoUrl} onChange={(e) => set({ repoUrl: e.target.value })} placeholder="https://github.com/acme/app.git" className={cn(inputCls, 'font-mono', urlIssue && 'ring-1 ring-status-down')} autoCapitalize="off" spellCheck={false} />
        {urlIssue && <p className="mt-1 text-xs text-status-down">{urlIssue}</p>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`${idPrefix}-branch`}>{t('apps.git.branch') || 'Branch'}</label>
          <input id={`${idPrefix}-branch`} value={value.branch} onChange={(e) => set({ branch: e.target.value })} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
        </div>
        <div>
          <label className={labelCls} htmlFor={`${idPrefix}-path`}>{t('apps.git.composePath') || 'Compose file in the repository'}</label>
          <input id={`${idPrefix}-path`} value={value.composePath} onChange={(e) => set({ composePath: e.target.value })} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor={`${idPrefix}-token`}>{t('apps.git.token') || 'Access token (private repository)'}</label>
        <input
          id={`${idPrefix}-token`}
          type="password"
          value={value.token}
          disabled={value.removeToken}
          onChange={(e) => set({ token: e.target.value })}
          autoComplete="new-password"
          placeholder={hasToken ? (t('apps.git.tokenKeep') || 'A token is stored: leave empty to keep it') : (t('apps.git.tokenNone') || 'None (public repository)')}
          className={cn(inputCls, 'font-mono')}
        />
        <p className="mt-1 text-xs text-text-muted">{t('apps.git.tokenHint') || 'Stored encrypted, never written in the URL nor in the logs.'}</p>
        {tokenMissing && (
          <p className="mt-1 text-xs text-status-down">
            {t('apps.git.tokenRequired') || 'The repository changed: the stored token is not sent to another repository. Enter its access token again, or remove the stored token.'}
          </p>
        )}
        {hasToken && (
          <div className="mt-2">
            <ToggleSwitch size="sm" checked={value.removeToken} onChange={(c) => set({ removeToken: c, token: '' })} label={<span className="text-xs">{t('apps.git.removeToken') || 'Remove the stored token'}</span>} />
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`${idPrefix}-poll`}>{t('apps.git.poll') || 'Check for new commits every (s)'}</label>
          <input id={`${idPrefix}-poll`} type="number" min="0" inputMode="numeric" value={value.poll} onChange={(e) => set({ poll: e.target.value })} placeholder={t('apps.git.pollNone') || 'never (manual pull)'} className={cn(inputCls, 'font-mono')} />
        </div>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <ToggleSwitch checked={value.autoDeploy} onChange={(c) => set({ autoDeploy: c })} label={t('apps.git.autoDeploy') || 'Redeploy on a new commit'} description={t('apps.git.autoDeployHint') || 'Inside the maintenance window when one is set.'} />
        </div>
      </div>
      <ToggleSwitch
        checked={value.build && buildAllowed}
        disabled={!buildAllowed}
        onChange={(c) => set({ build: c })}
        label={t('apps.git.build') || 'Build the services that declare build:'}
        description={buildAllowed ? (t('apps.git.buildHint') || 'Images are built on the server with the limits of the plan.') : (t('apps.git.buildNotAllowed') || 'Building images is not allowed for this account (plan or platform policy).')}
      />
    </div>
  );
}
