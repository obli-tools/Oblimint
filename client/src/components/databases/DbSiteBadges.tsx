import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, Crown, Globe, Share2 } from 'lucide-react';
import type { DbSiteRef, DbSiteRole } from '@oblimint/shared';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Tip } from '@/components/common/Tip';
import { Pill, TONES } from '@/components/common/Pill';
import { siteHref } from '@/utils/links';
import { cn } from '@/utils/cn';

// Databases ↔ sites (migration 030), one visual code everywhere:
//   owner site    = accent chip with a crown, links to the site;
//   shared        = blue chip / « +N shared » (popover listing the sites);
//   account-wide  = neutral chip « Account (unattached) » (no owner: every site of the account reaches it).

const chipCls = 'inline-flex max-w-[14rem] items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium';

/** A site chip (link to the site's Databases tab). */
export function DbSiteChip({ site, role = 'owner', className }: { site: DbSiteRef; role?: DbSiteRole; className?: string }) {
  const { t } = useTranslation();
  const owner = role === 'owner';
  return (
    <Link
      to={siteHref(site.id, 'databases')}
      onClick={(e) => e.stopPropagation()}
      title={owner
        ? t('databases.sites.ownerTitle', { site: site.name, defaultValue: 'Owned by the site {{site}}' })
        : t('databases.sites.sharedTitle', { site: site.name, defaultValue: 'Shared with the site {{site}}' })}
      className={cn(chipCls, owner ? TONES.accent : TONES.blue, 'hover:brightness-125', className)}
    >
      {owner ? <Crown size={11} className="shrink-0" /> : <Share2 size={11} className="shrink-0" />}
      <span className="truncate">{site.name}</span>
    </Link>
  );
}

/** Neutral chip of a database without owner site (shared across the account). */
export function DbAccountWideBadge({ short = false }: { short?: boolean }) {
  const { t } = useTranslation();
  return (
    <Tip content={t('databases.sites.accountWideHint') || 'No owner site: the database is shared across the account, every site of the account reaches its server.'}>
      <span className="cursor-help">
        <Pill tone="muted"><Building2 size={11} />{short ? (t('databases.sites.accountShort') || 'Account') : (t('databases.sites.accountWide') || 'Account (unattached)')}</Pill>
      </span>
    </Tip>
  );
}

/** « +N shared »: a popover listing the sites (each opens its site). */
export function DbSharedSitesBadge({ sites, plus = true }: { sites: DbSiteRef[]; plus?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!sites.length) return null;
  const label = plus
    ? t('databases.sites.sharedCount', { count: sites.length, defaultValue: '+{{count}} shared' })
    : t('databases.sites.sharedWith', { count: sites.length, defaultValue: 'Shared with {{count}} site(s)' });
  return (
    <ActionMenu
      label={t('databases.sites.sharedList') || 'Sites it is shared with'}
      sheetTitle={t('databases.sites.sharedList') || 'Sites it is shared with'}
      align="start"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          onClick={(e) => { e.stopPropagation(); p.onClick(); }}
          title={sites.map((s) => s.name).join(', ')}
          className={cn(chipCls, TONES.blue, 'hover:brightness-125')}
        >
          <Share2 size={11} className="shrink-0" />{label}
        </button>
      )}
      items={sites.map((s) => ({ key: String(s.id), icon: <Globe className="h-4 w-4" />, label: s.name, description: s.slug, onClick: () => navigate(siteHref(s.id, 'databases')) }))}
    />
  );
}

/**
 * The « Site(s) » cell of a database: owner chip (or « Account (unattached) »)
 * then « +N shared ». At a glance: crown = owned, blue = shared, grey = account.
 */
export function DbSitesCell({ ownerSite, sharedSites, className }: {
  ownerSite?: DbSiteRef | null;
  sharedSites?: DbSiteRef[] | null;
  className?: string;
}) {
  const shared = sharedSites ?? [];
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {ownerSite ? <DbSiteChip site={ownerSite} /> : <DbAccountWideBadge short={shared.length > 0} />}
      <DbSharedSitesBadge sites={shared} />
    </span>
  );
}

/** Role of a database for ONE site (site detail): « Owner » or « Shared ». */
export function DbSiteRoleBadge({ role }: { role: DbSiteRole }) {
  const { t } = useTranslation();
  return role === 'owner' ? (
    <Tip content={t('databases.sites.roleOwnerHint') || 'The database belongs to this site.'}>
      <span className="cursor-help"><Pill tone="accent"><Crown size={11} />{t('databases.sites.roleOwner') || 'Owner'}</Pill></span>
    </Tip>
  ) : (
    <Tip content={t('databases.sites.roleSharedHint') || 'Another site\'s (or the account\'s) database, shared with this site.'}>
      <span className="cursor-help"><Pill tone="blue"><Share2 size={11} />{t('databases.sites.roleShared') || 'Shared'}</Pill></span>
    </Tip>
  );
}
