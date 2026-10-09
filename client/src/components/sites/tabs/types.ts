import type { Site } from '@oblimint/shared';

/** Props shared by every tab of the site detail page. */
export interface SiteTabProps {
  site: Site;
  /** Replace the page's site (after a PUT / action that returns the site). */
  onSiteChange: (site: Site) => void;
  /** Refetch the site quietly. */
  reloadSite: () => Promise<void>;
  /** Open the publish modal. */
  onPublish: () => void;
}
