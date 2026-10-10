import { siteBaseDef, type CwpPhpInfo, type MigrationSeverity, type SiteBaseId } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// D-PHP (docs/P5-PLAN.md §4): site base from the EFFECTIVE PHP version of the
// vhost (discovery §7.3). Apache by default (.htaccess are live on CWP); nginx
// only by an explicit staff choice (nginxBaseHtaccess when .htaccess exist).
//   8.4 / 8.3 / 8.2 → apache-php<v>
//   8.1             → apache-php8.1 + phpUnmaintained
//   8.0             → apache-php8.1 + phpUpgrade
//   7.4             → apache-php7.4 + phpUnmaintained
//   7.0 – 7.3       → apache-php7.4 + phpUpgrade
//   5.x (D-PHP56)   → apache-php7.4 + phpNoBase (no 5.6 image)
//   none / static   → apache-php8.3
// ─────────────────────────────────────────────────────────────────────────────

export interface BaseMessage {
  severity: MigrationSeverity;
  code: string;
  params: Record<string, string | number | boolean | null>;
}

export interface SelectBaseOptions {
  /** Staff choice: wins over the mapping. */
  choice?: SiteBaseId | null;
  /** The docroot holds .htaccess files (discovery app.htaccess). */
  htaccess?: boolean;
  /** Plan restriction (null = the whole catalog). */
  allowedBases?: readonly SiteBaseId[] | null;
}

export interface SelectedBase {
  base: SiteBaseId;
  unmaintained: boolean;
  warnings: BaseMessage[];
}

/** 'X.Y' from '8.3', '83', '8.3.21', 'php83'… (null when unreadable). */
export function normalizePhpVersion(v: string | null | undefined): string | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/^php-?/, '');
  let m = /^(\d)\.(\d{1,2})/.exec(s);
  if (m) return `${m[1]}.${Number(m[2])}`;
  m = /^(\d)(\d)$/.exec(s);
  if (m) return `${m[1]}.${m[2]}`;
  return null;
}

/** Mapping of a PHP version to its Apache base (pure table D-PHP). */
export function mapPhpVersion(version: string | null): { base: SiteBaseId; code: 'phpUnmaintained' | 'phpUpgrade' | 'phpNoBase' | null } {
  const v = normalizePhpVersion(version);
  if (!v) return { base: 'apache-php8.3', code: null };
  const [major, minor] = v.split('.').map(Number);
  if (major >= 9 || (major === 8 && minor >= 4)) return { base: 'apache-php8.4', code: null };
  if (major === 8 && minor >= 2) return { base: `apache-php8.${minor}` as SiteBaseId, code: null };
  if (major === 8 && minor === 1) return { base: 'apache-php8.1', code: 'phpUnmaintained' };
  if (major === 8) return { base: 'apache-php8.1', code: 'phpUpgrade' };
  if (major === 7 && minor >= 4) return { base: 'apache-php7.4', code: 'phpUnmaintained' };
  if (major === 7) return { base: 'apache-php7.4', code: 'phpUpgrade' };
  return { base: 'apache-php7.4', code: 'phpNoBase' };
}

export function selectBase(php: CwpPhpInfo | null, opts: SelectBaseOptions = {}): SelectedBase {
  const warnings: BaseMessage[] = [];
  const source = normalizePhpVersion(php?.version ?? null);
  let base: SiteBaseId;
  if (opts.choice) {
    base = opts.choice;
  } else {
    const mapped = mapPhpVersion(source);
    base = mapped.base;
    if (mapped.code === 'phpUnmaintained') warnings.push({ severity: 'info', code: 'phpUnmaintained', params: { version: source, base } });
    else if (mapped.code === 'phpUpgrade') warnings.push({ severity: 'warning', code: 'phpUpgrade', params: { version: source, base } });
    else if (mapped.code === 'phpNoBase') warnings.push({ severity: 'warning', code: 'phpNoBase', params: { version: source, base } });
  }
  const def = siteBaseDef(base);
  if (opts.choice && def.unmaintained) warnings.push({ severity: 'info', code: 'phpUnmaintained', params: { version: source, base } });
  if (def.engine === 'nginx' && opts.htaccess) warnings.push({ severity: 'warning', code: 'nginxBaseHtaccess', params: { base } });
  if (opts.allowedBases && !opts.allowedBases.includes(base)) {
    warnings.push({ severity: 'blocking', code: 'planLimitExceeded', params: { dimension: 'allowedBases', base } });
  }
  return { base, unmaintained: def.unmaintained, warnings };
}
