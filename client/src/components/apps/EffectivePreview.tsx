import { useTranslation } from 'react-i18next';
import { AlertTriangle, Hammer } from 'lucide-react';
import type { EffectiveStackConfig } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { Pill, sectionTitleCls, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { cn } from '@/utils/cn';
import { CodeEditor } from './CodeEditor';
import { trimNum } from './appsFormat';

/**
 * What the panel will deploy (EffectiveStackConfig of POST /apps/validate):
 * per-service limits, fabrics, exposed ports, capabilities, then the rewritten
 * compose read-only (docs/P4b-PLAN.md §5.2).
 */
export function EffectivePreview({ effective, effectiveYaml }: { effective: EffectiveStackConfig | null; effectiveYaml: string | null }) {
  const { t } = useTranslation();
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  if (!effective && !effectiveYaml) {
    return <p className="py-6 text-center text-sm text-text-muted">{t('apps.effective.none') || 'Validate the compose file to see what will be deployed.'}</p>;
  }
  return (
    <div className="space-y-4">
      {effective && (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-text-secondary">
            <span>{t('apps.effective.totalContainers', { count: effective.totals.containers, defaultValue: '{{count}} container(s)' })}</span>
            <span>{t('apps.effective.totalCpu', { value: trimNum(effective.totals.cpus), defaultValue: '{{value}} CPU' })}</span>
            <span>{t('apps.effective.totalMemory', { value: formatMb(effective.totals.memoryMb, units), defaultValue: '{{value}} of memory' })}</span>
            {effective.networks.length > 0 && <span>{t('apps.effective.networks', { value: effective.networks.map((n) => n.name).join(', '), defaultValue: 'private networks: {{value}}' })}</span>}
            {effective.volumes.length > 0 && <span>{t('apps.effective.volumes', { value: effective.volumes.join(', '), defaultValue: 'volumes: {{value}}' })}</span>}
          </div>
          <TableScroll className="bg-bg-primary" stickyFirstCol stickyBg="rgb(var(--c-bg-primary))">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('apps.effective.service') || 'Service'}</th>
                  <th className={thCls}>{t('apps.effective.image') || 'Image'}</th>
                  <th className={thCls}>{t('apps.effective.limits') || 'Limits'}</th>
                  <th className={thCls}>{t('apps.effective.fabrics') || 'Networks'}</th>
                  <th className={thCls}>{t('apps.effective.ports') || 'Exposed ports'}</th>
                  <th className={thCls}>{t('apps.effective.caps') || 'Capabilities'}</th>
                </tr>
              </thead>
              <tbody>
                {effective.services.map((s) => (
                  <tr key={s.name} className="border-t border-border/40 align-top">
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-[13px] text-text-primary">{s.name}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.healthcheck && <Pill tone="green">{t('apps.effective.healthcheck') || 'healthcheck'}</Pill>}
                        {s.readOnlyRootfs && <Pill tone="muted">{t('apps.effective.readOnly') || 'read-only'}</Pill>}
                        {(s.user == null || s.user === 'root' || s.user === '0' || s.user.startsWith('0:')) && (
                          <Pill tone="amber" title={t('apps.effective.rootHint') || 'Processes run as root inside the container (no user namespace).'}><AlertTriangle size={9} />root</Pill>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-text-secondary">
                      {s.build ? <span className="inline-flex items-center gap-1"><Hammer size={11} />{t('apps.effective.build') || 'built from source'}</span> : <span className="break-all">{s.image}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-text-secondary">
                      {trimNum(s.limits.cpus)} CPU · {formatMb(s.limits.memoryMb, units)} · {s.limits.pids} PID
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {s.fabric.front && <Pill tone="blue" title={t('apps.effective.frontHint') || 'Reachable by the edge (proxy hosts) on its exposed ports.'}>front</Pill>}
                        {s.fabric.back && <Pill tone="accent" title={t('apps.effective.backHint') || 'Takes part in a declared network link.'}>back</Pill>}
                        {s.networks.map((n) => <Pill key={n} tone="muted">{n}</Pill>)}
                        {!s.fabric.front && !s.fabric.back && s.networks.length === 0 && <span className="text-text-muted">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-text-secondary">
                      {s.exposedPorts.length ? s.exposedPorts.map((p) => `${p.port}/${p.protocol}`).join(', ') : '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-text-secondary">{s.capAdd.length ? s.capAdd.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      {effectiveYaml && (
        <div>
          <div className={cn(sectionTitleCls, 'mb-2')}>{t('apps.effective.yaml') || 'Rewritten compose (deployed by the panel)'}</div>
          <CodeEditor value={effectiveYaml} readOnly minHeight="160px" maxHeight="480px" ariaLabel={t('apps.effective.yaml') || 'Rewritten compose'} />
        </div>
      )}
    </div>
  );
}
