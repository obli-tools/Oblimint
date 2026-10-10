import type { CwpDomain, CwpPhpInfo, CwpProxyTarget } from '@oblimint/shared';
import { parseAddonsWp, parseDomainWebConf, type DomainWebConf } from '../parsers/cwpConf';
import { parseApacheVhosts, type ApacheVhost } from '../parsers/apache';
import { isCwpServiceServer, parseNginxVhost, type NginxServer } from '../parsers/nginx';
import { parseVarnishBackends } from '../parsers/systemd';
import { baseName, classifyIp, isPrivateAddress } from '../parsers/system';
import type { HtaccessPhpSummary } from '../parsers/htaccess';
import { CWP_PATHS } from './server';
import { DiscoveryContext, normFqdn, type ApacheFile, type NginxFile, type PhpEvidence, type RawDomainRow } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phase vhosts (P5-PLAN §7.2, CWP-MAP §5–§6): the generated vhosts are the
// source of truth of what a domain SERVES (site / proxy / redirect /
// disabled), its docroot (vhost root / DocumentRoot first, DB path last) and
// the PHP evidence (Apache FPM SetHandler, nginx fastcgi_pass). The per-domain
// JSON (~/.conf/webservers/<fqdn>.conf) gives the templates and the proxy
// variant (custom-ip / custom-port).
// ─────────────────────────────────────────────────────────────────────────────

export const VHOST_DIRS = {
  nginx: '/etc/nginx/conf.d/vhosts',
  apache: '/usr/local/apache/conf.d/vhosts',
  varnish: '/etc/varnish/conf.d/vhosts',
} as const;

/** Local Apache (cwp-httpd) and Varnish ports behind nginx. */
export const APACHE_PORTS = new Set([8181, 8443]);
export const VARNISH_PORTS = new Set([82, 6081]);

/**
 * Stock CWP vhost templates (/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/<server>/*.tpl).
 * Anything else is a custom template (manual review: CWP-MAP §1 lists backbone, ws_proxy_agent,
 * proxy_websocket and one named after a domain on the real server). To be re-checked on the Linux test host.
 */
export const STOCK_TEMPLATES: Record<'nginx' | 'apache' | 'varnish', ReadonlySet<string>> = {
  nginx: new Set([
    'default', 'force-https', 'http2', 'force-https-http2', 'php-fpm', 'php-fpm-cache', 'force-https-php-fpm', 'cache',
    'force-https-cache', 'proxy', 'wordpress', 'wordpress-cache', 'wp-rocket', 'laravel', 'drupal', 'joomla', 'magento',
    'magento2', 'nextcloud', 'owncloud', 'prestashop', 'opencart', 'codeigniter', 'symfony', 'yii', 'moodle',
  ]),
  apache: new Set([
    'default', 'all_methods', 'force-https', 'force-ssl', 'php-fpm', 'suphp', 'php-cgi', 'mod_php', 'ruid2', 'itk', 'http2',
    'cache', 'wordpress', 'all_methods-force-https',
  ]),
  varnish: new Set(['default', 'wordpress', 'joomla', 'drupal', 'magento', 'magento2', 'prestashop', 'opencart']),
};

export function isStockTemplate(server: 'nginx' | 'apache' | 'varnish', name: string | null): boolean {
  return name === null || name === '' || STOCK_TEMPLATES[server].has(name);
}

/** File name → { fqdn, ssl, disabled } (`<fqdn>.conf`, `<fqdn>.ssl.conf`, `+ .disabled`). */
export function vhostFileInfo(path: string): { fqdn: string; ssl: boolean; disabled: boolean } | null {
  let name = baseName(path);
  let disabled = false;
  if (name.endsWith('.disabled')) { disabled = true; name = name.slice(0, -'.disabled'.length); }
  let ssl = false;
  if (name.endsWith('.ssl.conf')) { ssl = true; name = name.slice(0, -'.ssl.conf'.length); }
  else if (name.endsWith('.conf')) name = name.slice(0, -'.conf'.length);
  else if (name.endsWith('.vcl')) name = name.slice(0, -'.vcl'.length);
  else return null;
  const fqdn = normFqdn(name);
  return /^[a-z0-9*_.-]+$/.test(fqdn) && fqdn.includes('.') ? { fqdn, ssl, disabled } : null;
}

/** st.webConf key: a per-domain JSON only applies to a domain of the account whose home holds it. */
export function webConfKey(account: string, fqdn: string): string {
  return `${account}:${fqdn}`;
}

interface NginxHit { server: NginxServer; file: NginxFile }
interface ApacheHit { vhost: ApacheVhost; file: ApacheFile }

function isLocalHost(ctx: DiscoveryContext, host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (ctx.state.sourceIps.has(h)) return true;
  if (ctx.state.server.hostname && h === ctx.state.server.hostname) return true;
  return classifyIp(h) === 'loopback';
}

function standardDocroot(row: RawDomainRow, home: string): string {
  return row.kind === 'main' || row.kind === 'parked' ? `${home}/public_html` : `${home}/${row.fqdn}`;
}

/** Picks the server block that decides what F serves: plain first, unless it only redirects to https of the same host. */
function mainServer(hits: NginxHit[], fqdn: string): NginxHit | null {
  if (hits.length === 0) return null;
  const plain = hits.filter((h) => !h.server.ssl);
  const ssl = hits.filter((h) => h.server.ssl);
  const first = plain[0] ?? ssl[0];
  const r = first.server.redirect;
  const sameHost = r && (r.host === null || r.host === fqdn || r.host === `www.${fqdn}` || `www.${r.host}` === fqdn);
  if (first === plain[0] && sameHost && /^https:/i.test(r?.target ?? '') && ssl.length > 0) return ssl[0];
  return first;
}

export async function phaseVhosts(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  // The addresses CWP itself assigns to the accounts are the source's own, even when `ip addr` could not be read:
  // nginx → http://<account IP>:8181 must stay a local Apache, never an external proxy back to the old server.
  for (const a of st.accounts) {
    const ip = a.ipAddress?.trim().toLowerCase();
    if (ip && classifyIp(ip) !== 'invalid') st.sourceIps.add(ip);
  }
  const nginxList = await ctx.find('nginx vhosts', VHOST_DIRS.nginx, 1, 'f');
  const apacheList = await ctx.find('apache vhosts', VHOST_DIRS.apache, 1, 'f');
  const varnishList = await ctx.find('varnish vhosts', VHOST_DIRS.varnish, 1, 'f');
  const files = await ctx.readFiles('vhosts', [...nginxList, ...apacheList, ...varnishList].map((e) => e.path));

  const nginxByName = new Map<string, NginxHit[]>();
  for (const e of nginxList) {
    const info = vhostFileInfo(e.path);
    if (!info) continue;
    const text = files.get(e.path) ?? null;
    if (text === null) { ctx.readFailed('nginx vhost', new Error(e.path), { kind: 'domain', key: info.fqdn }); continue; }
    const servers = parseNginxVhost(text);
    if (servers.length === 0 && text.trim() !== '') ctx.warn('vhostParseFailed', 'warning', { kind: 'domain', key: info.fqdn }, { file: e.path });
    const file: NginxFile = { path: e.path, disabled: info.disabled, servers };
    st.nginx.set(info.fqdn, [...(st.nginx.get(info.fqdn) ?? []), file]);
    for (const s of servers) {
      if (isCwpServiceServer(s, info.fqdn)) continue;
      const names = s.serverNames.length > 0 ? s.serverNames : [info.fqdn];
      for (const n of new Set(names)) nginxByName.set(n, [...(nginxByName.get(n) ?? []), { server: s, file }]);
    }
  }

  const apacheByName = new Map<string, ApacheHit[]>();
  for (const e of apacheList) {
    const info = vhostFileInfo(e.path);
    if (!info) continue;
    const text = files.get(e.path) ?? null;
    if (text === null) { ctx.readFailed('apache vhost', new Error(e.path), { kind: 'domain', key: info.fqdn }); continue; }
    const vhosts = parseApacheVhosts(text);
    if (vhosts.length === 0 && text.trim() !== '') ctx.warn('vhostParseFailed', 'warning', { kind: 'domain', key: info.fqdn }, { file: e.path });
    const file: ApacheFile = { path: e.path, disabled: info.disabled, vhosts };
    st.apache.set(info.fqdn, [...(st.apache.get(info.fqdn) ?? []), file]);
    for (const v of vhosts) {
      if (v.serverName && isCwpServiceServer({ serverNames: [v.serverName] }, info.fqdn)) continue;
      const names = new Set([...(v.serverName ? [v.serverName] : [info.fqdn]), ...v.aliases]);
      for (const n of names) apacheByName.set(n, [...(apacheByName.get(n) ?? []), { vhost: v, file }]);
    }
  }

  const varnishFiles = new Map<string, string>();
  for (const e of varnishList) {
    const info = vhostFileInfo(e.path);
    const text = files.get(e.path) ?? null;
    if (!info || text === null) continue;
    st.varnish.set(info.fqdn, parseVarnishBackends(text));
    varnishFiles.set(info.fqdn, e.path);
  }

  // Per-account JSON + WordPress registry. ~/.conf/webservers is CLIENT-WRITABLE (MG10): a file only describes a
  // domain of the account whose home holds it (keyed `<account>:<fqdn>`); any other file is ignored + warned.
  const domainsOf = new Map<string, Set<string>>();
  for (const r of st.domainRows) {
    if (!domainsOf.has(r.account)) domainsOf.set(r.account, new Set());
    (domainsOf.get(r.account) as Set<string>).add(r.fqdn);
  }
  const jsonPaths: Array<{ path: string; account: string }> = [];
  for (const a of st.accounts) {
    const list = await ctx.find(`webservers json of ${a.username}`, `${a.homeDir}/.conf/webservers`, 1, 'f', '*.conf');
    jsonPaths.push(...list.map((e) => ({ path: e.path, account: a.username })));
  }
  const jsonFiles = await ctx.readFiles('webservers json', jsonPaths.map((j) => j.path));
  for (const { path: p, account } of jsonPaths) {
    const text = jsonFiles.get(p) ?? null;
    if (text === null) continue;
    const fqdn = normFqdn(baseName(p).replace(/\.conf$/, ''));
    if (!domainsOf.get(account)?.has(fqdn)) {
      ctx.warn('webConfForeignDomain', 'warning', { kind: 'domain', key: fqdn, account }, { file: p });
      continue;
    }
    const conf = parseDomainWebConf(text);
    if (conf) st.webConf.set(webConfKey(account, fqdn), conf);
    else ctx.warn('vhostParseFailed', 'warning', { kind: 'domain', key: fqdn, account }, { file: p });
  }
  const wpFiles = await ctx.readFiles('.addons_wp', st.accounts.map((a) => `${a.homeDir}/.conf/.addons_wp`));
  for (const a of st.accounts) {
    const text = wpFiles.get(`${a.homeDir}/.conf/.addons_wp`) ?? null;
    if (text === null) continue;
    const wp = parseAddonsWp(text);
    if (wp) st.addonsWp.set(a.username, wp);
  }

  // Templates present on the server (custom ones are outside items).
  const tpl = await ctx.find('vhost templates', CWP_PATHS.templatesDir, 2, 'f');
  for (const e of tpl) {
    const m = /\/(nginx|apache|varnish)\/([^/]+)\.(?:tpl|stpl)$/.exec(e.path);
    if (!m) continue;
    const server = m[1] as 'nginx' | 'apache' | 'varnish';
    if (!st.templates[server].includes(m[2])) st.templates[server].push(m[2]);
  }
  for (const server of ['nginx', 'apache'] as const) {
    for (const name of st.templates[server]) {
      if (isStockTemplate(server, name)) continue;
      ctx.addOutside({
        kind: server === 'nginx' ? 'nginx-template' : 'apache-template', key: `${server}:${name}`, account: null, code: 'customTemplate',
        suggestion: 'manual', params: { server, template: name }, details: { server, template: name, dir: `${CWP_PATHS.templatesDir}/${server}` },
      });
    }
  }

  // Domains (main → addon / parked → subdomains; a duplicate fqdn is kept once).
  const home = new Map(st.accounts.map((a) => [a.username, `/home/${a.username}`]));
  const byFqdn = new Map<string, CwpDomain>();
  for (const row of st.domainRows) {
    const prev = byFqdn.get(row.fqdn);
    if (prev) {
      if (!prev.duplicateOf) prev.duplicateOf = row.kind;
      ctx.warn('domainDuplicate', 'info', { kind: 'domain', key: row.fqdn, account: prev.account }, { kind: row.kind, account: row.account });
      continue;
    }
    const d = buildDomain(ctx, row, home.get(row.account) ?? `/home/${row.account}`, nginxByName, apacheByName, varnishFiles);
    byFqdn.set(row.fqdn, d);
    st.domains.push(d);
  }

  // Varnish custom backends (not the local Apache).
  for (const [fqdn, backends] of st.varnish) {
    for (const b of backends) {
      if (isLocalHost(ctx, b.host) && APACHE_PORTS.has(b.port)) continue;
      const owner = byFqdn.get(fqdn)?.account ?? null;
      ctx.addOutside({
        kind: 'varnish-backend', key: `${fqdn}:${b.name}`, account: owner, code: 'varnishBackend', suggestion: 'proxy-host',
        params: { fqdn, host: b.host, port: b.port }, details: { fqdn, backend: b.name, host: b.host, port: b.port, file: varnishFiles.get(fqdn) ?? null },
      });
    }
  }
}

function buildDomain(
  ctx: DiscoveryContext, row: RawDomainRow, home: string,
  nginxByName: Map<string, NginxHit[]>, apacheByName: Map<string, ApacheHit[]>, varnishFiles: Map<string, string>,
): CwpDomain {
  const st = ctx.state;
  const F = row.fqdn;
  const nginxAll = nginxByName.get(F) ?? [];
  const nginxActive = nginxAll.filter((h) => !h.file.disabled);
  const apacheAll = apacheByName.get(F) ?? [];
  const apacheActive = apacheAll.filter((h) => !h.file.disabled);
  const ownFiles = [...(st.nginx.get(F) ?? []).map((f) => f.path), ...(st.apache.get(F) ?? []).map((f) => f.path)];
  const filesOfHits = [...nginxAll.map((h) => h.file.path), ...apacheAll.map((h) => h.file.path)];
  const vhostFiles = [...new Set([...ownFiles, ...filesOfHits, ...(varnishFiles.has(F) ? [varnishFiles.get(F) as string] : [])])].sort();
  const conf: DomainWebConf | undefined = st.webConf.get(webConfKey(row.account, F));

  let serving: CwpDomain['serving'] = 'unknown';
  let proxy: CwpProxyTarget | null = null;
  let redirectTo: string | null = null;
  let varnish = false;
  let viaApache = false;
  let docroot: string | null = null;
  let disabledProxy: { host: string; port: number } | null = null;

  const main = mainServer(nginxActive, F);
  const websocketTpl = /websocket|ws_/i.test(conf?.nginxTemplate ?? '');
  if (main) {
    const s = main.server;
    const r = s.redirect;
    const redirectsAway = r && r.host !== null && r.host !== F && r.host !== `www.${F}` && `www.${r.host}` !== F;
    if (redirectsAway && r) {
      serving = 'redirect';
      redirectTo = r.target;
    } else if (s.proxyPass) {
      const t = s.proxyPass;
      const local = isLocalHost(ctx, t.host);
      if (local && APACHE_PORTS.has(t.port)) { serving = 'site'; viaApache = true; }
      else if (local && VARNISH_PORTS.has(t.port)) {
        // P5-PLAN §7.2: nginx → local Varnish (:82) is a LOCAL site (Varnish → Apache serves the docroot). A custom
        // Varnish backend (VCL pointing elsewhere) does not make the domain a proxy: it is reported as an outside
        // 'varnish-backend' item (phaseWeb, suggestion proxy-host) — the VCL may route only some URLs there.
        varnish = true;
        serving = 'site';
        viaApache = true;
      } else {
        serving = 'proxy';
        proxy = { scheme: t.scheme, host: t.host, port: t.port, websocket: s.websocket || websocketTpl, via: 'nginx-vhost', isPrivate: isPrivateAddress(t.host) };
      }
    } else if (s.proxyPassRaw) {
      ctx.warn('vhostParseFailed', 'warning', { kind: 'domain', key: F, account: row.account }, { file: main.file.path, proxyPass: s.proxyPassRaw.slice(0, 200) });
    } else if (s.fastcgi || s.root) {
      serving = 'site';
    }
    if (serving === 'site' || serving === 'unknown') {
      docroot = s.root ?? nginxActive.map((h) => h.server.root).find((x) => !!x) ?? null;
    }
  } else if (nginxActive.length === 0 && apacheActive.length === 0 && (nginxAll.length > 0 || apacheAll.length > 0
    || [...(st.nginx.get(F) ?? []), ...(st.apache.get(F) ?? [])].some((f) => f.disabled))) {
    // Only disabled vhost files: CWP keeps the per-domain JSON of a disabled domain; its proxy target is information only.
    serving = 'disabled';
    if (conf?.customIp && conf.customPort) disabledProxy = { host: conf.customIp.toLowerCase(), port: conf.customPort };
  } else if (conf?.customIp && conf.customPort) {
    serving = 'proxy';
    proxy = { scheme: conf.customPort === 443 ? 'https' : 'http', host: conf.customIp.toLowerCase(), port: conf.customPort, websocket: websocketTpl, via: 'webservers-json', isPrivate: isPrivateAddress(conf.customIp) };
  } else if (apacheActive.length > 0) {
    serving = 'site';
    viaApache = true;
  }

  if (proxy && isLocalHost(ctx, proxy.host)) st.localProxies.push({ fqdn: F, account: row.account, host: proxy.host, port: proxy.port });

  const apacheMain = apacheActive.find((h) => !h.vhost.ssl) ?? apacheActive[0] ?? apacheAll[0];
  if (serving !== 'proxy' && serving !== 'redirect') {
    docroot = docroot ?? apacheMain?.vhost.documentRoot ?? row.dbPath;
  }
  if (apacheActive.length > 0 && serving === 'site') viaApache = true;

  const evidence: PhpEvidence = {
    apacheFpm: viaApache ? (apacheMain?.vhost.fpmVersion ?? null) : null,
    nginxFpm: main?.server.fpmVersion ?? null,
    apache: viaApache,
    jsonFpm: conf?.phpFpm ? conf.phpFpmVersion : null,
    vhostKnown: nginxActive.length > 0 || apacheActive.length > 0,
  };
  st.phpEvidence.set(F, evidence);

  const nginxTemplate = conf?.nginxTemplate ?? null;
  const apacheTemplate = conf?.apacheTemplate ?? null;
  const customTemplate = !isStockTemplate('nginx', nginxTemplate) || !isStockTemplate('apache', apacheTemplate)
    || !isStockTemplate('varnish', conf?.varnishTemplate ?? null);
  if (customTemplate) {
    ctx.warn('customTemplate', 'warning', { kind: 'domain', key: F, account: row.account }, { nginx: nginxTemplate, apache: apacheTemplate });
  }
  if (serving === 'disabled') {
    ctx.warn('disabledVhost', 'info', { kind: 'domain', key: F, account: row.account },
      disabledProxy ? { proxyHost: disabledProxy.host, proxyPort: disabledProxy.port } : undefined);
  }

  const allNames = [...nginxAll.flatMap((h) => h.server.serverNames), ...apacheAll.flatMap((h) => [h.vhost.serverName ?? '', ...h.vhost.aliases])];
  const ssl = nginxAll.some((h) => h.server.ssl) || apacheAll.some((h) => h.vhost.ssl) || (st.nginx.get(F) ?? []).some((f) => /\.ssl\.conf/.test(f.path));
  // Shared contract (CwpDomain.docroot): vhost root, else the DB path — also for a proxy / redirect domain (the
  // staff may turn it into a site). Consumers that only want SERVED docroots filter on `serving` (servedDocroot).
  const effectiveDocroot = serving === 'proxy' || serving === 'redirect' ? row.dbPath : docroot;
  const std = standardDocroot(row, home);

  return {
    fqdn: F,
    kind: row.kind,
    account: row.account,
    parent: row.parent,
    subLabel: row.subLabel,
    docroot: effectiveDocroot,
    docrootFromDb: row.dbPath,
    docrootNonStandard: (effectiveDocroot ?? row.dbPath ?? std) !== std,
    serving,
    proxy,
    redirectTo,
    php: null,
    varnish: varnish || (conf?.varnish === true && varnishFiles.has(F)),
    nginxTemplate,
    apacheTemplate,
    customTemplate,
    wwwAlias: allNames.includes(`www.${F}`),
    ssl,
    certificate: null,
    dnsZone: null,
    app: null,
    docrootBytes: null,
    vhostFiles,
    duplicateOf: null,
  };
}

/** Normative PHP algorithm (P5-PLAN §7.3). Proxy / redirect domains have no PHP (null). */
export function effectivePhp(e: PhpEvidence, htaccess: HtaccessPhpSummary | null, phpDefault: string | null): CwpPhpInfo {
  const overridesFor = (version: string | null) => (htaccess?.overrides ?? []).filter((o) => o.version !== version);
  if (e.apacheFpm) {
    return { version: e.apacheFpm, handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: overridesFor(e.apacheFpm) };
  }
  if (e.nginxFpm) return { version: e.nginxFpm, handler: 'nginx-fpm', source: 'nginx-vhost', htaccessOverrides: [] };
  if (e.apache) {
    if (htaccess?.root) return { version: htaccess.root, handler: 'suphp', source: 'htaccess', htaccessOverrides: overridesFor(htaccess.root) };
    return { version: phpDefault, handler: 'suphp', source: 'default', htaccessOverrides: overridesFor(phpDefault) };
  }
  if (!e.vhostKnown) {
    if (e.jsonFpm) return { version: e.jsonFpm, handler: 'php-fpm', source: 'webservers-json', htaccessOverrides: [] };
    if (htaccess?.root) return { version: htaccess.root, handler: 'suphp', source: 'htaccess', htaccessOverrides: overridesFor(htaccess.root) };
    return { version: phpDefault, handler: 'suphp', source: 'default', htaccessOverrides: overridesFor(phpDefault) };
  }
  // nginx serves the docroot itself without PHP (static).
  return { version: null, handler: 'none', source: 'default', htaccessOverrides: [] };
}
