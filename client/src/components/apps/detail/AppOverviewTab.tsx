import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Rocket } from 'lucide-react';
import type { AppDeployment, AppDeploymentStatus, AppStackDetail } from '@oblimint/shared';
import { Card, InfoRow, Pill } from '@/components/hosting/hostingUi';
import { ContainerStateBadge, sourceTypeLabel } from '../AppBadges';
import { DeployOutput } from '../DeployOutput';
import { formatDateTime, shortSha } from '../appsFormat';

/** Overview: source, policies, services at a glance, last deployment (live output while it runs). */
export function AppOverviewTab({ stack, lastDeployment, canManage, onDeploymentFinished }: {
  stack: AppStackDetail;
  lastDeployment: AppDeployment | null;
  canManage: boolean;
  onDeploymentFinished: (s: AppDeploymentStatus) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const yes = t('apps.common.yes') || 'yes';
  const no = t('apps.common.no') || 'no';
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
      <div className="min-w-0 space-y-4">
        <Card title={t('apps.overview.lastDeployment') || 'Last deployment'}>
          {lastDeployment
            ? <DeployOutput key={lastDeployment.id} stackId={stack.id} deployment={lastDeployment} canManage={canManage} onFinished={onDeploymentFinished} />
            : <p className="flex items-center gap-2 py-4 text-sm text-text-muted"><Rocket size={15} />{t('apps.overview.neverDeployed') || 'Never deployed yet.'}</p>}
        </Card>
        <Card title={t('apps.overview.services') || 'Services'}>
          {stack.services.length === 0 ? <p className="text-sm text-text-muted">{t('apps.overview.noServices') || 'No service deployed yet.'}</p> : (
            <ul className="divide-y divide-border/40">
              {stack.services.map((s) => (
                <li key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-mono text-[13px] text-text-primary">{s.name}</span>
                  <ContainerStateBadge state={s.state} health={s.health} />
                  {s.updateAvailable && <Pill tone="blue">{t('apps.status.updateAvailable') || 'Update'}</Pill>}
                  <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-text-muted">{s.image ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="min-w-0 space-y-4">
        <Card title={t('apps.overview.source') || 'Source'}>
          <div className="grid grid-cols-2 gap-3">
            <InfoRow label={t('apps.list.source') || 'Source'}>{stack.catalog ? `${stack.catalog.name}` : sourceTypeLabel(t, stack.sourceType)}</InfoRow>
            {stack.catalogSource && <InfoRow label={t('apps.overview.templateVersion') || 'Template version'} mono>{stack.catalogSource.templateVersion}</InfoRow>}
            {stack.git && (
              <>
                <div className="col-span-2"><InfoRow label={t('apps.overview.repository') || 'Repository'} mono>{stack.git.repoUrl}</InfoRow></div>
                <InfoRow label={t('apps.git.branch') || 'Branch'} mono>{stack.git.branch}</InfoRow>
                <InfoRow label={t('apps.overview.commit') || 'Commit'} mono>{shortSha(stack.git.lastCommit)}</InfoRow>
                {stack.git.lastError && <div className="col-span-2 text-xs text-status-down">{stack.git.lastError}</div>}
              </>
            )}
            <InfoRow label={t('apps.overview.created') || 'Created'}>{formatDateTime(stack.createdAt, lang)}</InfoRow>
            <InfoRow label={t('apps.list.lastDeploy') || 'Last deployment'}>{formatDateTime(stack.lastDeployedAt, lang)}</InfoRow>
          </div>
        </Card>
        <Card title={t('apps.overview.policies') || 'Policies'}>
          <div className="grid grid-cols-2 gap-3">
            <InfoRow label={t('apps.settings.autoUpdate') || 'Automatic updates'}>{stack.updatePolicy.autoUpdate ? yes : no}</InfoRow>
            <InfoRow label={t('apps.settings.checkEvery') || 'Check every'} mono>{t('apps.overview.minutes', { value: stack.updatePolicy.checkIntervalMin, defaultValue: '{{value}} min' })}</InfoRow>
            <InfoRow label={t('apps.settings.sleep') || 'Sleep when idle'}>
              {stack.sleepPolicy.enabled ? t('apps.overview.sleepAfter', { value: stack.sleepPolicy.idleMinutes, defaultValue: 'after {{value}} min' }) : no}
            </InfoRow>
            <InfoRow label={t('apps.overview.proxyHosts') || 'Proxy hosts'}>
              {stack.proxyHosts.length ? <Link to="?tab=proxy" className="text-accent hover:underline">{stack.proxyHosts.length}</Link> : '0'}
            </InfoRow>
          </div>
        </Card>
      </div>
    </div>
  );
}
