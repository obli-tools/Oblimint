import type { TFunction } from 'i18next';
import type { HealthCenterComponentId, HealthCenterEvent, HealthTrackStatus } from '@oblimint/shared';
import type { Tone } from '@/components/common/Pill';

// Labels / tones shared by the dashboard card and the settings section of the health center.

export function componentLabel(t: TFunction, id: HealthCenterComponentId): string {
  const fallback: Record<HealthCenterComponentId, string> = { postgres: 'PostgreSQL', hostd: 'hostd', edge: 'Edge', dns: 'DNS', mail: 'Mail', workers: 'Workers' };
  return t(`healthCenter.comp.${id}`) || fallback[id];
}

export const STATUS_TONE: Record<HealthTrackStatus, Tone> = { ok: 'green', fail: 'red', skipped: 'muted', unknown: 'muted' };

export function statusLabel(t: TFunction, s: HealthTrackStatus, disk = false): string {
  if (disk && s === 'fail') return t('healthCenter.status.low') || 'low';
  const fallback: Record<HealthTrackStatus, string> = { ok: 'ok', fail: 'down', skipped: 'not deployed', unknown: 'unknown' };
  return t(`healthCenter.status.${s}`) || fallback[s];
}

/** i18n key of an event ('platform.componentDown' → 'platformComponentDown'). */
const eventKey = (e: HealthCenterEvent) => e.replace(/\.(\w)/, (_, c: string) => c.toUpperCase());

export function healthEventLabel(t: TFunction, e: HealthCenterEvent): string {
  const fallback: Record<HealthCenterEvent, string> = {
    'platform.componentDown': 'A component goes down',
    'platform.componentUp': 'A component recovers',
    'node.diskLow': 'Low disk space on the node',
    'node.diskOk': 'Disk space back to normal',
    'backup.failed': 'A backup fails (or is incomplete)',
    'backup.recovered': 'A backup succeeds again after a failure',
  };
  return t(`healthCenter.event.${eventKey(e)}`) || fallback[e];
}
