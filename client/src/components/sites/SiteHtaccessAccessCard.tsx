import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, ShieldAlert } from 'lucide-react';
import type { HtaccessAccessReport, Site } from '@oblimint/shared';
import { runtimeApi } from '@/api/runtime.api';
import { Pill } from '@/components/common/Pill';
import { cardCls } from './styles';

/**
 * litespeed bases: the access rules of the .htaccess files of the live release.
 * OpenLiteSpeed ignores them; the base reproduces the plain refusals (403) and
 * CLOSES (403) what it cannot reproduce (password, IP lists…): never public.
 */
export function SiteHtaccessAccessCard({ site }: { site: Site }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<HtaccessAccessReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    runtimeApi.htaccessAccess(site.id).then((r) => { if (!cancelled) setReport(r); }).catch(() => { if (!cancelled) setReport(null); });
    return () => { cancelled = true; };
  }, [site.id, site.base, site.currentReleaseId]);

  if (!report || !report.applies || report.rules.length === 0) return null;
  const closed = report.rules.filter((r) => r.action === 'closed').length;
  return (
    <div className={cardCls}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {closed > 0 ? <ShieldAlert className="h-4 w-4 text-amber-400" /> : <Lock className="h-4 w-4 text-accent" />}
        <h2 className="text-sm font-semibold text-text-primary">{t('runtime.htaccessAccess.title') || 'Access rules of the .htaccess files'}</h2>
      </div>
      <p className="mb-3 text-xs text-text-muted">
        {t('runtime.htaccessAccess.explain') || 'OpenLiteSpeed does not read the access rules of .htaccess files. This base refuses (403) what they refuse, and CLOSES (403) the places protected in a way it cannot reproduce (password, IP address list): they are never served publicly.'}
      </p>
      <ul className="space-y-1.5">
        {report.rules.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-text-primary">{r.dir ? `/${r.dir}/` : '/'}{r.files ? ` · ${r.files.pattern}` : ''}</span>
            <span className="font-mono text-xs text-text-muted">{r.directive}</span>
            {r.action === 'deny'
              ? <Pill tone="muted" className="text-[10px]">{t('runtime.htaccessAccess.deny') || '403 (reproduced)'}</Pill>
              : <Pill tone="amber" className="text-[10px]">{t('runtime.htaccessAccess.closed') || '403 (closed)'}</Pill>}
          </li>
        ))}
      </ul>
      {closed > 0 && (
        <p className="mt-3 text-xs text-amber-300/90">
          {t('runtime.htaccessAccess.closedHint') || 'Closed: OpenLiteSpeed cannot check a password or an IP list from a .htaccess. Oblimint offers no password / IP protection for a path of a site yet (access lists exist for the proxy hosts only): to keep this protection as it is, run the site on an Apache base.'}
        </p>
      )}
    </div>
  );
}
