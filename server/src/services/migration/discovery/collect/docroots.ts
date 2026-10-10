import { APP_PROFILES, detectAppProfile, type CwpAppDetection, type CwpDomain } from '@oblimint/shared';
import { parseHtaccessGrep, summarizeHtaccess, type HtaccessPhpLine } from '../parsers/htaccess';
import { baseName, dirName } from '../parsers/system';
import { DiscoveryContext, isCleanPath, isUnder, stripSlash } from './context';
import { effectivePhp } from './web';

// ─────────────────────────────────────────────────────────────────────────────
// Phase docroots: per effective docroot, existence (stat), PHP handlers of the
// .htaccess files (fs.grepHtaccess: root = site version, sub-dirs =
// overrides), application markers (APP_PROFILES, stat only — wp-config.php is
// never read), parent markers for public/ web/ www/ layouts (Laravel,
// Symfony), ~/.conf/.addons_wp WordPress registry; then the effective PHP
// (normative algorithm) and the account extra directories.
// ─────────────────────────────────────────────────────────────────────────────

export const HTACCESS_DEPTH = 4;
const PUBLIC_LAYOUT = new Set(['public', 'web', 'www']);
const EXTRA_MARKERS = ['.git', 'package.json', 'composer.json', '.htaccess', '.user.ini'];
export const CWP_HOME_INTERNALS = new Set(['.conf', 'backupcwp', 'cwp_stats', '.trash', '.pki', 'tmp', 'logs', 'public_html', 'mail', 'etc', 'ssl']);

export function appMarkers(): string[] {
  return [...new Set(APP_PROFILES.flatMap((p) => p.markers))];
}

const isSiteLike = (d: CwpDomain) => d.serving === 'site' || d.serving === 'unknown' || d.serving === 'disabled';

export async function phaseDocroots(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const docroots = [...new Set(st.domains.filter((d) => isSiteLike(d) && d.docroot).map((d) => stripSlash(d.docroot as string)))].sort();

  const existing = await ctx.stat('docroots', docroots);
  for (const d of st.domains) {
    if (!isSiteLike(d) || !d.docroot) continue;
    const e = existing.get(stripSlash(d.docroot));
    if (!e || e.kind !== 'directory') {
      ctx.warn('docrootMissing', 'warning', { kind: 'domain', key: d.fqdn, account: d.account }, { docroot: d.docroot });
    }
  }
  const present = docroots.filter((p) => existing.get(p)?.kind === 'directory');

  // .htaccess PHP handlers.
  const htLines = new Map<string, HtaccessPhpLine[]>();
  for (const root of present.filter((p) => p.startsWith('/home/') && isCleanPath(p))) {
    ctx.checkAbort();
    const r = await ctx.tryRun(`.htaccess of ${root}`, 'fs.grepHtaccess', { root, maxDepth: HTACCESS_DEPTH }, { allowNonZeroExit: true });
    htLines.set(root, r ? parseHtaccessGrep(r.stdout, st.suphp, st.server.phpDefault) : []);
  }

  // Markers (docroot + parent of public/ web/ www/).
  const markers = [...appMarkers(), ...EXTRA_MARKERS];
  const statPaths: string[] = [];
  for (const root of present) {
    for (const m of markers) statPaths.push(`${root}/${m}`);
    if (PUBLIC_LAYOUT.has(baseName(root))) for (const m of markers) statPaths.push(`${dirName(root)}/${m}`);
  }
  const stats = await ctx.stat('application markers', statPaths);
  const has = (p: string) => stats.has(p);

  const detection = new Map<string, CwpAppDetection>();
  for (const root of present) {
    const account = st.domains.find((d) => d.docroot && stripSlash(d.docroot) === root)?.account ?? null;
    let det = detectAppProfile((rel) => has(`${root}/${rel}`));
    let markersFound = det.markers;
    if (PUBLIC_LAYOUT.has(baseName(root)) && (det.profile === null || det.profile === 'generic-php' || det.profile === 'static')) {
      const parent = dirName(root);
      const up = detectAppProfile((rel) => has(`${parent}/${rel}`));
      if (up.profile && up.profile !== 'generic-php' && up.profile !== 'static' && up.suggestedDocroot === baseName(root)) {
        det = up;
        markersFound = up.markers.map((m) => `../${m}`);
      }
    }
    const wp = (account ? st.addonsWp.get(account) ?? [] : []).find((w) => stripSlash(w.path) === root);
    const parent = PUBLIC_LAYOUT.has(baseName(root)) ? dirName(root) : null;
    detection.set(root, {
      profile: det.profile,
      markers: markersFound,
      wordpress: wp ? { path: wp.path, database: wp.database, dbUser: wp.dbUser, version: wp.version } : null,
      hasGit: has(`${root}/.git`) || (parent !== null && has(`${parent}/.git`)),
      hasPackageJson: has(`${root}/package.json`) || (parent !== null && has(`${parent}/package.json`)),
      hasComposerJson: has(`${root}/composer.json`) || (parent !== null && has(`${parent}/composer.json`)),
      htaccess: has(`${root}/.htaccess`),
      userIni: has(`${root}/.user.ini`),
    });
    if (has(`${root}/.git`) || (parent !== null && has(`${parent}/.git`))) {
      const repo = has(`${root}/.git`) ? root : (parent as string);
      ctx.addOutside({
        kind: 'git-repo', key: `${repo}/.git`, account, code: 'gitRepo', suggestion: 'manual',
        params: { path: repo }, details: { path: repo, inDocroot: true },
      });
    }
  }

  for (const d of st.domains) {
    if (!isSiteLike(d)) continue;
    const root = d.docroot ? stripSlash(d.docroot) : null;
    d.app = root ? detection.get(root) ?? null : null;
    const ev = st.phpEvidence.get(d.fqdn);
    const summary = root ? summarizeHtaccess(htLines.get(root) ?? [], root) : null;
    d.php = ev ? effectivePhp(ev, summary, st.server.phpDefault) : null;
    if (d.php && d.php.htaccessOverrides.length > 0) {
      ctx.warn('phpHtaccessOverride', 'info', { kind: 'domain', key: d.fqdn, account: d.account }, { paths: d.php.htaccessOverrides.map((o) => `${o.path}=${o.version}`).join(', ') });
    }
  }
  // Nested docroots (sub-domain pointing inside another site).
  for (const d of st.domains) {
    if (!isSiteLike(d) || !d.docroot) continue;
    const outer = st.domains.find((o) => o !== d && isSiteLike(o) && o.docroot && o.docroot !== d.docroot && isUnder(d.docroot as string, o.docroot));
    if (outer) ctx.warn('docrootNested', 'info', { kind: 'domain', key: d.fqdn, account: d.account }, { parent: outer.fqdn });
    if (d.docrootNonStandard) ctx.warn('docrootNonStandard', 'info', { kind: 'domain', key: d.fqdn, account: d.account }, { docroot: d.docroot });
  }

  // Extra directories of each home (scripts/, node/…).
  for (const a of st.accounts) {
    const own = st.domains.filter((d) => d.account === a.username);
    const roots = own.filter(isSiteLike).map((d) => d.docroot).filter((x): x is string => !!x);
    const fqdns = new Set(own.map((d) => d.fqdn));
    a.extraDirs = (st.homeEntries.get(a.username) ?? [])
      .filter((e) => e.type === 'd')
      .map((e) => baseName(e.path))
      .filter((n) => !n.startsWith('.') && !CWP_HOME_INTERNALS.has(n) && !fqdns.has(n))
      .filter((n) => !roots.some((r) => isUnder(r, `${a.homeDir}/${n}`) || isUnder(`${a.homeDir}/${n}`, r)))
      .sort();
  }
}
