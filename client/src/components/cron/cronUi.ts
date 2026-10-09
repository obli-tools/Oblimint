import { useTranslation } from 'react-i18next';
import type { CronRunStatus } from '@oblimint/shared';

/** Translated label of a run status. */
export function useRunStatusLabel(): (s: CronRunStatus | null) => string {
  const { t } = useTranslation();
  const fallback: Record<CronRunStatus, string> = { running: 'running', success: 'success', failed: 'failed', timeout: 'timeout', skipped: 'skipped' };
  return (s) => (s == null ? (t('cron.status.never') || 'never run') : (t(`cron.status.${s}`) || fallback[s]));
}
