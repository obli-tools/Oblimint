import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ArrowUpCircle, Code2, FolderArchive, GitBranch, LayoutGrid, Moon } from 'lucide-react';
import type {
  AppDeploymentAction, AppDeploymentStatus, AppTemplateCategory, AppDeploymentTrigger, AppSourceType, AppStackStatus, ContainerState, UptimeStatus,
} from '@oblimint/shared';
import { Pill } from '@/components/hosting/hostingUi';
import { Tip } from '@/components/common/Tip';
import { containerStateTone, deploymentStatusTone, stackStatusTone, uptimeStatusTone } from './appsFormat';

// Labels + pills of the ui-apps screens (literal keys: the scratchpad extractor
// builds the en dictionary from them). OWNED BY MODULE `ui-apps`.

export function stackStatusLabel(t: TFunction, s: AppStackStatus): string {
  switch (s) {
    case 'draft': return t('apps.status.draft') || 'Draft';
    case 'deploying': return t('apps.status.deploying') || 'Deploying';
    case 'running': return t('apps.status.running') || 'Running';
    case 'partial': return t('apps.status.partial') || 'Partial';
    case 'stopped': return t('apps.status.stopped') || 'Stopped';
    case 'sleeping': return t('apps.status.sleeping') || 'Sleeping';
    case 'error': return t('apps.status.error') || 'Error';
    case 'deleting': return t('apps.status.deleting') || 'Deleting';
    default: return s;
  }
}

export function AppStatusBadge({ status, message }: { status: AppStackStatus; message?: string | null }) {
  const { t } = useTranslation();
  const pill = (
    <Pill tone={stackStatusTone(status)}>
      {status === 'sleeping' && <Moon size={10} />}
      {stackStatusLabel(t, status)}
    </Pill>
  );
  return message ? <Tip content={message}><span className="cursor-help">{pill}</span></Tip> : pill;
}

export function UpdateAvailableBadge() {
  const { t } = useTranslation();
  return <Pill tone="blue"><ArrowUpCircle size={10} />{t('apps.status.updateAvailable') || 'Update'}</Pill>;
}

export function sourceTypeLabel(t: TFunction, s: AppSourceType): string {
  switch (s) {
    case 'editor': return t('apps.source.editor') || 'Editor';
    case 'git': return t('apps.source.git') || 'Git';
    case 'zip': return t('apps.source.zip') || 'ZIP';
    case 'catalog': return t('apps.source.catalog') || 'Catalog';
    default: return s;
  }
}

export function SourceTypeIcon({ type, size = 14 }: { type: AppSourceType; size?: number }) {
  switch (type) {
    case 'git': return <GitBranch size={size} />;
    case 'zip': return <FolderArchive size={size} />;
    case 'catalog': return <LayoutGrid size={size} />;
    default: return <Code2 size={size} />;
  }
}

export function containerStateLabel(t: TFunction, s: ContainerState): string {
  switch (s) {
    case 'running': return t('apps.container.state.running') || 'Running';
    case 'stopped': return t('apps.container.state.stopped') || 'Stopped';
    case 'missing': return t('apps.container.state.missing') || 'Missing';
    case 'restarting': return t('apps.container.state.restarting') || 'Restarting';
    case 'error': return t('apps.container.state.error') || 'Error';
    default: return t('apps.container.state.unknown') || 'Unknown';
  }
}

export function ContainerStateBadge({ state, health }: { state: ContainerState; health?: 'healthy' | 'unhealthy' | 'starting' | null }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone={containerStateTone(state)}>{containerStateLabel(t, state)}</Pill>
      {health === 'healthy' && <Pill tone="green">{t('apps.container.health.healthy') || 'healthy'}</Pill>}
      {health === 'unhealthy' && <Pill tone="red">{t('apps.container.health.unhealthy') || 'unhealthy'}</Pill>}
      {health === 'starting' && <Pill tone="amber">{t('apps.container.health.starting') || 'starting'}</Pill>}
    </span>
  );
}

export function deploymentStatusLabel(t: TFunction, s: AppDeploymentStatus): string {
  switch (s) {
    case 'queued': return t('apps.deployment.status.queued') || 'Queued';
    case 'running': return t('apps.deployment.status.running') || 'Running';
    case 'succeeded': return t('apps.deployment.status.succeeded') || 'Succeeded';
    case 'failed': return t('apps.deployment.status.failed') || 'Failed';
    case 'cancelled': return t('apps.deployment.status.cancelled') || 'Cancelled';
    default: return s;
  }
}

export function DeploymentStatusPill({ status }: { status: AppDeploymentStatus }) {
  const { t } = useTranslation();
  return <Pill tone={deploymentStatusTone(status)}>{deploymentStatusLabel(t, status)}</Pill>;
}

export function deploymentActionLabel(t: TFunction, a: AppDeploymentAction): string {
  switch (a) {
    case 'deploy': return t('apps.actions.deploy') || 'Deploy';
    case 'redeploy': return t('apps.actions.redeploy') || 'Redeploy';
    case 'recreate': return t('apps.actions.recreate') || 'Recreate';
    case 'pull': return t('apps.actions.pull') || 'Pull images';
    case 'start': return t('apps.actions.start') || 'Start';
    case 'stop': return t('apps.actions.stop') || 'Stop';
    case 'restart': return t('apps.actions.restart') || 'Restart';
    case 'down': return t('apps.actions.down') || 'Remove containers';
    case 'update': return t('apps.actions.update') || 'Image update';
    case 'rollback': return t('apps.actions.rollback') || 'Roll back';
    case 'sleep': return t('apps.actions.sleep') || 'Put to sleep';
    case 'wake': return t('apps.actions.wake') || 'Wake up';
    case 'delete': return t('apps.actions.delete') || 'Delete';
    default: return a;
  }
}

export function deploymentTriggerLabel(t: TFunction, tr: AppDeploymentTrigger): string {
  switch (tr) {
    case 'user': return t('apps.deployment.trigger.user') || 'user';
    case 'git': return t('apps.deployment.trigger.git') || 'git';
    case 'auto-update': return t('apps.deployment.trigger.autoUpdate') || 'automatic update';
    case 'rollback': return t('apps.deployment.trigger.rollback') || 'rollback';
    case 'workflow': return t('apps.deployment.trigger.workflow') || 'workflow';
    case 'wake': return t('apps.deployment.trigger.wake') || 'wake-up';
    case 'sleep': return t('apps.deployment.trigger.sleep') || 'idle';
    case 'catalog': return t('apps.deployment.trigger.catalog') || 'catalog';
    case 'system': return t('apps.deployment.trigger.system') || 'system';
    default: return tr;
  }
}

export function uptimeStatusLabel(t: TFunction, s: UptimeStatus): string {
  switch (s) {
    case 'up': return t('uptime.status.up') || 'Up';
    case 'down': return t('uptime.status.down') || 'Down';
    case 'pending': return t('uptime.status.pending') || 'Pending';
    case 'paused': return t('uptime.status.paused') || 'Paused';
    default: return s;
  }
}

export function UptimeStatusPill({ status }: { status: UptimeStatus }) {
  const { t } = useTranslation();
  return <Pill tone={uptimeStatusTone(status)}>{uptimeStatusLabel(t, status)}</Pill>;
}

export function categoryLabel(t: TFunction, c: AppTemplateCategory): string {
  switch (c) {
    case 'cms': return t('apps.catalog.categories.cms') || 'Websites & CMS';
    case 'productivity': return t('apps.catalog.categories.productivity') || 'Productivity';
    case 'devtools': return t('apps.catalog.categories.devtools') || 'Developer tools';
    case 'security': return t('apps.catalog.categories.security') || 'Security';
    case 'monitoring': return t('apps.catalog.categories.monitoring') || 'Monitoring';
    case 'automation': return t('apps.catalog.categories.automation') || 'Automation';
    case 'database': return t('apps.catalog.categories.database') || 'Databases';
    case 'media': return t('apps.catalog.categories.media') || 'Media';
    case 'obli': return t('apps.catalog.categories.obli') || 'Obli apps';
    default: return t('apps.catalog.categories.other') || 'Other';
  }
}
