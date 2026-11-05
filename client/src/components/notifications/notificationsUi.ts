import type { TFunction } from 'i18next';
import type { AccountNotificationEvent, NotificationChannelType, NotificationEvent } from '@oblimint/shared';

export function channelTypeLabel(t: TFunction, type: NotificationChannelType): string {
  const fallback: Record<NotificationChannelType, string> = { smtp: 'E-mail (SMTP)', webhook: 'Webhook', discord: 'Discord', telegram: 'Telegram' };
  return t(`notifications.type.${type}`) || fallback[type];
}

/** i18n key of an event ('quota.warning' → 'quotaWarning'). */
function eventKey(e: NotificationEvent | AccountNotificationEvent): string {
  return e.replace(/\.(\w)/, (_, c: string) => c.toUpperCase());
}

export function eventLabel(t: TFunction, e: NotificationEvent | AccountNotificationEvent): string {
  const fallback: Record<NotificationEvent | AccountNotificationEvent, string> = {
    'quota.warning': 'Quota threshold reached (80 %)',
    'quota.exceeded': 'Quota exceeded (100 %)',
    'quota.action': 'Uploads blocked / account suspended',
    'certificate.failed': 'Certificate failure',
    'certificate.issued': 'Certificate issued (platform host name)',
    'dns.syncFailed': 'DNS synchronisation failure',
    'db.instanceFailed': 'Database instance failure',
    'cron.failed': 'Cron job failing',
    'security.banned': 'Address banned',
    'window.pendingReview': 'Modification window waiting for review',
    'window.autoValidated': 'Modification window validated automatically',
    'window.failed': 'Modification window failure',
    'scan.threat': 'Threat found by the scanner',
    'quarantine.added': 'File quarantined',
    'adapter.completed': 'Application update published',
    'adapter.failed': 'Application update failure',
    'supervision.digest': 'Supervision digest',
    'mail.outboundSuspended': 'Outbound mail suspended',
    'mail.serviceFailed': 'Mail service failure',
    'mail.quotaWarning': 'Mailbox almost full',
    // P4b
    'certificate.expiringSoon': 'Certificate expiring soon',
    'uptime.down': 'Monitor down',
    'uptime.up': 'Monitor recovered',
    'app.updateAvailable': 'Application update available',
    'app.updated': 'Application updated',
    'app.updateFailed': 'Application update failed',
    'app.deployFailed': 'Application deployment failed',
    'edge.unitQuarantined': 'Proxy configuration refused',
    'edge.rollback': 'Proxy configuration rolled back',
    'workflow.failed': 'Workflow failed',
    'platform.updateAvailable': 'Platform update available',
    'platform.updated': 'Platform updated',
    'platform.updateFailed': 'Platform update failed',
    'release.pendingApproval': 'Release waiting for approval',
    'release.approved': 'Release approved',
    'release.rejected': 'Release rejected',
    'release.decided': 'Decision on a proposal',
    'release.withdrawn': 'Proposal withdrawn',
    'release.degraded': 'Release degraded after going live',
    'release.failedObservation': 'Release failed after going live',
    'domain.verified': 'Domain ownership verified',
    'domain.reclaimed': 'Domain taken back by its owner',
    // Sensitive actions (family approvals)
    'action.confirmationRequired': 'Confirmation requested',
    'action.approvalRequired': 'Approval requested',
    'action.approved': 'Action authorised',
    'action.denied': 'Action denied',
    'action.expired': 'Request expired',
    'security.keyRegimeChanged': 'Access keys: security regime changed',
    'security.keyAbuse': 'Repeated invalid access keys',
    'account.contained': 'Account contained',
    'account.containmentLifted': 'Containment lifted',
    // Health center (platform admins)
    'platform.componentDown': 'Platform component down',
    'platform.componentUp': 'Platform component recovered',
    'node.diskLow': 'Low disk space on the node',
    'node.diskOk': 'Node disk space back to normal',
    'backup.failed': 'Backup failed',
    'backup.recovered': 'Backup recovered',
    // Personal notices (family account)
    'account.recoveryCodeUsed': 'Recovery code used',
    'account.passwordReset': 'Password reset',
    'account.emailChanged': 'E-mail address changed',
  };
  return t(`notifications.event.${eventKey(e)}`) || fallback[e];
}
