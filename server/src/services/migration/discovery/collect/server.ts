import { DiscoveryContext, normFqdn } from './context';
import {
  parseCwpPro, parseCwpVersionPhp, parseMysqlUserPrefixes, parseSuphpHandlers, parseVhostsSslJson, parseWebServersConf,
  phpDigitsToVersion, phpVersionOfBinary,
} from '../parsers/cwpConf';
import { baseName, classifyIp, parseIpAddrs, parseOsRelease, parseRpmVersions } from '../parsers/system';

// ─────────────────────────────────────────────────────────────────────────────
// Phases connect + server (P5-PLAN §7.1, CWP-MAP §1): who we are, OS, CWP
// version / Pro, web stack, addresses, rpm versions (rsync required for the
// transfers), PHP default + FPM versions, suPHP handler map, SSL registry.
// ─────────────────────────────────────────────────────────────────────────────

export const CWP_PATHS = {
  versionPhp: '/usr/local/cwpsrv/htdocs/resources/admin/include/version.php',
  webServersConf: '/usr/local/cwp/.conf/web_servers.conf',
  cwpPro: '/usr/local/cwp/.conf/.cwp_pro.conf',
  mysqlUserPrefix: '/usr/local/cwp/.conf/mysql_user_prefix.conf',
  vhostsSsl: '/usr/local/cwp/.conf/vhosts-ssl.json',
  suphpConf: '/usr/local/etc/suphp.conf',
  templatesDir: '/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts',
} as const;

export const RPM_PACKAGES = [
  'cwpsrv', 'cwp-httpd', 'nginx', 'varnish', 'cwp-suphp', 'cwpphp', 'mariadb-server', 'MariaDB-server', 'mysql-server', 'postfix',
  'dovecot', 'opendkim', 'bind', 'pure-ftpd', 'rsync', 'nodejs', 'git', 'redis', 'memcached', 'python39', 'python3',
];

/**
 * suPHP / CLI default PHP. /usr/local/bin/php is compiled by CWP (no rpm, no template prints `php -v`): the
 * suphp.conf default handler gives it when it points to /opt/alt; otherwise CWP 1.x ships 8.3 by default
 * (CWP-MAP §1) and the assumption is reported (phpDefaultAssumed).
 */
export const CWP_ASSUMED_PHP_DEFAULT = '8.3';

export async function phaseConnect(ctx: DiscoveryContext): Promise<void> {
  const r = await ctx.tryRun('whoami', 'sys.whoami', {});
  const who = r?.stdout.trim() ?? '';
  if (r && who !== 'root') {
    ctx.warn('sudoRequired', 'warning', { kind: 'server', key: 'source' }, { user: who.slice(0, 64) });
  }
}

export async function phaseServer(ctx: DiscoveryContext): Promise<void> {
  const s = ctx.state.server;
  const host = await ctx.tryRun('hostname', 'sys.hostname', {});
  s.hostname = host ? normFqdn(host.stdout.split('\n')[0] ?? '') || null : null;
  const os = await ctx.tryRun('os-release', 'sys.osRelease', {}, { allowNonZeroExit: true });
  s.osRelease = os ? parseOsRelease(os.stdout) : null;

  const ips = await ctx.tryRun('ip addr', 'sys.ipAddrs', {});
  for (const a of ips ? parseIpAddrs(ips.stdout) : []) {
    ctx.state.sourceIps.add(a.address);
    const c = classifyIp(a.address);
    if (c === 'public' && !s.publicIps.includes(a.address)) s.publicIps.push(a.address);
    else if (c === 'private' && !s.privateIps.includes(a.address)) s.privateIps.push(a.address);
  }

  const rpm = await ctx.tryRun('rpm', 'sys.rpmVersions', { packages: RPM_PACKAGES }, { allowNonZeroExit: true });
  s.packages = rpm ? parseRpmVersions(rpm.stdout) : {};
  if (rpm && !s.packages.rsync) {
    ctx.warn('rsyncMissing', 'blocking', { kind: 'server', key: 'source' });
  }

  const files = await ctx.readFiles('CWP configuration', [
    CWP_PATHS.versionPhp, CWP_PATHS.webServersConf, CWP_PATHS.cwpPro, CWP_PATHS.mysqlUserPrefix, CWP_PATHS.vhostsSsl, CWP_PATHS.suphpConf,
  ]);
  const versionPhp = files.get(CWP_PATHS.versionPhp) ?? null;
  s.cwpVersion = versionPhp ? parseCwpVersionPhp(versionPhp) : null;
  if (!s.cwpVersion) ctx.warn('unknownCwpVersion', 'warning', { kind: 'server', key: 'source' });
  s.cwpPro = parseCwpPro(files.get(CWP_PATHS.cwpPro) ?? null);

  const ws = files.get(CWP_PATHS.webServersConf);
  if (ws) {
    const parsed = parseWebServersConf(ws);
    s.webserverSetup = parsed?.webserverSetup ?? null;
    if (!parsed) ctx.readFailed('web_servers.conf', new Error('JSON invalide'));
    // Shared / main IP CWP writes in its vhosts (proxy_pass http://<IP>:8181): a source address even if `ip addr` failed.
    for (const [k, v] of Object.entries(parsed?.raw ?? {})) {
      if (typeof v !== 'string' || !/ip/i.test(k)) continue;
      const ip = v.trim().toLowerCase();
      const c = classifyIp(ip);
      if (c === 'public' || c === 'private') ctx.state.sourceIps.add(ip);
    }
  }
  const prefixes = files.get(CWP_PATHS.mysqlUserPrefix);
  s.extraDbPrefixes = prefixes ? parseMysqlUserPrefixes(prefixes) : [];

  const ssl = files.get(CWP_PATHS.vhostsSsl);
  if (ssl) {
    const parsed = parseVhostsSslJson(ssl);
    if (parsed) ctx.state.vhostsSsl = parsed;
    else ctx.readFailed('vhosts-ssl.json', new Error('JSON invalide'));
  }

  const suphp = files.get(CWP_PATHS.suphpConf);
  ctx.state.suphp = suphp ? parseSuphpHandlers(suphp) : new Map();
  const defaultBin = ctx.state.suphp.get('x-httpd-php');
  const fromSuphp = defaultBin ? phpVersionOfBinary(defaultBin) : null;
  if (fromSuphp) s.phpDefault = fromSuphp;
  else {
    s.phpDefault = CWP_ASSUMED_PHP_DEFAULT;
    ctx.warn('phpDefaultAssumed', 'info', { kind: 'server', key: 'source' }, { version: CWP_ASSUMED_PHP_DEFAULT });
  }

  const alt = await ctx.find('/opt/alt', '/opt/alt', 1, 'd');
  const fpm = new Set<string>();
  for (const e of alt) {
    const m = /^php-fpm(\d{2,3})$/.exec(baseName(e.path));
    const v = m ? phpDigitsToVersion(m[1]) : null;
    if (v) fpm.add(v);
  }
  s.phpFpmVersions = [...fpm].sort(compareVersions);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
