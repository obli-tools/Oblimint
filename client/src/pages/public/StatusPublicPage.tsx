import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { PublicStatusPage, UptimeStatus } from '@oblimint/shared';
import { publicStatusApi } from '@/api/uptime.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { UptimeBars } from '@/components/apps/charts';
import { formatMs, formatPct, safeCss } from '@/components/apps/appsFormat';
import { cn } from '@/utils/cn';

const REFRESH_MS = 60_000;

/**
 * Own palette of the public page, light / dark from prefers-color-scheme
 * (independent of the panel themes: a visitor has no session). Stable
 * `om-status-*` class names are the hooks of the custom CSS.
 */
const BASE_CSS = `
.om-status { --om-bg:#f4f6fa; --om-card:#ffffff; --om-border:#e3e8f0; --om-text:#1d2433; --om-muted:#6b7591; --om-up:#10a360; --om-down:#e5484d; --om-degraded:#d98a0b; --om-unknown:#8b93a7; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  .om-status { --om-bg:#0b0d1a; --om-card:#131728; --om-border:#252b45; --om-text:#f0f4fc; --om-muted:#8c96b8; --om-up:#1edd8a; --om-down:#ff6b6b; --om-degraded:#f5b544; --om-unknown:#6b7399; color-scheme: dark; }
}
`;

function statusColor(s: UptimeStatus | PublicStatusPage['overall']): string {
  switch (s) {
    case 'up': return 'var(--om-up)';
    case 'down': return 'var(--om-down)';
    case 'degraded':
    case 'pending': return 'var(--om-degraded)';
    default: return 'var(--om-unknown)';
  }
}

function overallText(t: TFunction, o: PublicStatusPage['overall']): string {
  switch (o) {
    case 'up': return t('statusPage.overall.up') || 'All systems operational';
    case 'degraded': return t('statusPage.overall.degraded') || 'Partial outage';
    case 'down': return t('statusPage.overall.down') || 'Major outage';
    default: return t('statusPage.overall.unknown') || 'Status unknown';
  }
}

function monitorText(t: TFunction, s: UptimeStatus): string {
  switch (s) {
    case 'up': return t('statusPage.monitor.up') || 'Operational';
    case 'down': return t('statusPage.monitor.down') || 'Down';
    case 'pending': return t('statusPage.monitor.pending') || 'Checking';
    default: return t('statusPage.monitor.paused') || 'Paused';
  }
}

/**
 * /status/:slug — PUBLIC status page (no session, outside ProtectedRoute /
 * AppLayout), GET /api/public/status-pages/:slug: overall state, monitors with
 * their 90-day bars, custom CSS of the page (sanitised), refreshed every
 * minute (docs/P4b-PLAN.md §10.3). OWNED BY MODULE `ui-apps`.
 */
export function StatusPublicPage() {
  const { t, i18n } = useTranslation();
  const { slug } = useParams();
  const [page, setPage] = useState<PublicStatusPage | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'notFound' | 'error'>('loading');

  const load = useCallback(async () => {
    if (!slug) { setState('notFound'); return; }
    try {
      setPage(await publicStatusApi.get(slug));
      setState('ok');
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 404) { setPage(null); setState('notFound'); } else setState((s) => (s === 'ok' ? 'ok' : 'error'));
    }
  }, [slug]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (page) document.title = page.title;
  }, [page]);

  const lang = i18n.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';

  return (
    <div className="om-status min-h-dvh bg-[var(--om-bg)] px-4 py-8 text-[var(--om-text)] sm:py-12">
      <style>{BASE_CSS}</style>
      {page?.customCss && <style>{safeCss(page.customCss)}</style>}
      <div className="om-status-container mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex justify-end gap-1 text-xs">
          {(['fr', 'en'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => { void i18n.changeLanguage(l); }}
              className={cn('rounded px-2 py-1 font-mono uppercase', lang === l ? 'bg-[var(--om-card)] text-[var(--om-text)]' : 'text-[var(--om-muted)] hover:text-[var(--om-text)]')}
            >
              {l}
            </button>
          ))}
        </div>

        {state === 'loading' && <div className="flex justify-center py-20"><LoadingSpinner /></div>}
        {(state === 'notFound' || (state === 'error' && !page)) && (
          <div className="om-status-empty rounded-xl border border-[var(--om-border)] bg-[var(--om-card)] px-6 py-16 text-center">
            <h1 className="text-xl font-semibold">{state === 'notFound' ? (t('statusPage.notFound') || 'This status page does not exist.') : (t('statusPage.error') || 'The status page cannot be loaded right now.')}</h1>
            <p className="mt-2 font-mono text-xs text-[var(--om-muted)]">{slug}</p>
          </div>
        )}

        {page && (
          <>
            <header className="om-status-header">
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{page.title}</h1>
              {page.description && <p className="mt-2 whitespace-pre-line text-[var(--om-muted)]">{page.description}</p>}
            </header>

            <div className="om-status-overall flex items-center gap-3 rounded-xl px-5 py-4 text-white" style={{ background: statusColor(page.overall) }}>
              <span className="h-3 w-3 shrink-0 rounded-full bg-white/90" />
              <span className="text-lg font-semibold">{overallText(t, page.overall)}</span>
            </div>

            <section className="om-status-monitors overflow-hidden rounded-xl border border-[var(--om-border)] bg-[var(--om-card)]">
              {page.monitors.length === 0 && <p className="px-5 py-8 text-center text-sm text-[var(--om-muted)]">{t('statusPage.noMonitor') || 'No service listed.'}</p>}
              {page.monitors.map((m, i) => (
                <div key={`${m.name}-${i}`} className={cn('om-status-monitor px-5 py-4', i > 0 && 'border-t border-[var(--om-border)]')}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: statusColor(m.status) }} />
                    <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                    <span className="text-sm" style={{ color: statusColor(m.status) }}>{monitorText(t, m.status)}</span>
                  </div>
                  <div className="mt-3"><UptimeBars days={m.history} lang={i18n.language} height={28} /></div>
                  <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--om-muted)]">
                    <span>{t('statusPage.daysAgo', { count: m.history.length || 90, defaultValue: '{{count}} days ago' })}</span>
                    <span>
                      {t('statusPage.uptime24h', { value: formatPct(m.uptime24h), defaultValue: '24 h: {{value}}' })}
                      {' · '}
                      {t('statusPage.uptime30d', { value: formatPct(m.uptime30d), defaultValue: '30 days: {{value}}' })}
                      {m.latencyMs != null && <> · {formatMs(m.latencyMs)}</>}
                    </span>
                    <span>{t('statusPage.today') || 'Today'}</span>
                  </div>
                </div>
              ))}
            </section>

            <footer className="om-status-footer flex flex-wrap justify-between gap-2 text-xs text-[var(--om-muted)]">
              <span>{t('statusPage.updated', { date: new Date(page.generatedAt).toLocaleString(i18n.language), defaultValue: 'Updated {{date}}' })}</span>
              <span>{t('statusPage.poweredBy') || 'Powered by Oblimint'}</span>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
