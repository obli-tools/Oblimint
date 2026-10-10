// ─────────────────────────────────────────────────────────────────────────────
// CWP configuration files (docs/cwp/CWP-MAP.md §1, §6, §10): version.php,
// web_servers.conf, vhosts-ssl.json, ~/.conf/webservers/<fqdn>.conf,
// ~/.conf/.addons_wp, /usr/local/etc/suphp.conf, mysql_user_prefix.conf.
// JSON parsers never throw: a malformed file yields null (the caller warns).
// ─────────────────────────────────────────────────────────────────────────────

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^(1|true|on|yes)$/i.test(v.trim());
  return false;
}

/** '74' → '7.4', '8' → null, '7.4' → '7.4'. */
export function phpDigitsToVersion(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const d = digits.trim();
  if (/^\d\.\d{1,2}$/.test(d)) return d;
  const m = /^(\d)(\d{1,2})$/.exec(d);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** /usr/local/cwpsrv/htdocs/resources/admin/include/version.php: `$webpanel_version = "1.18";`. */
export function parseCwpVersionPhp(text: string): string | null {
  const m = /webpanel_version["']?\s*(?:=>|=)\s*["']([0-9][0-9A-Za-z.\-_]{0,31})["']/.exec(text);
  return m ? m[1] : null;
}

/** /usr/local/cwp/.conf/.cwp_pro.conf contains 1 on CWP Pro. */
export function parseCwpPro(text: string | null): boolean {
  return text !== null && /^\s*1\s*$/.test(text);
}

export interface WebServersConf {
  webserverSetup: string | null;
  raw: Record<string, string | boolean | number | null>;
}

/** /usr/local/cwp/.conf/web_servers.conf (JSON). */
export function parseWebServersConf(text: string): WebServersConf | null {
  const j = safeJson(text);
  if (!isObj(j)) return null;
  const raw: WebServersConf['raw'] = {};
  for (const [k, v] of Object.entries(j)) {
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' || v === null) raw[k] = v;
  }
  return { webserverSetup: str(j.webserver_setup), raw };
}

export interface VhostSslEntry {
  user: string | null;
  installDate: string | null;
  expiryDate: string | null;
  san: string[];
  autossl: boolean;
}

/** /usr/local/cwp/.conf/vhosts-ssl.json: `{ fqdn: { user, install_date, expiry_date, san[], autossl } }`. */
export function parseVhostsSslJson(text: string): Map<string, VhostSslEntry> | null {
  const j = safeJson(text);
  if (!isObj(j)) return null;
  const out = new Map<string, VhostSslEntry>();
  for (const [fqdn, v] of Object.entries(j)) {
    if (!isObj(v)) continue;
    out.set(fqdn.toLowerCase(), {
      user: str(v.user),
      installDate: str(v.install_date),
      expiryDate: str(v.expiry_date),
      san: Array.isArray(v.san) ? v.san.map(str).filter((s): s is string => !!s) : [],
      autossl: bool(v.autossl),
    });
  }
  return out;
}

export interface DomainWebConf {
  nginxTemplateType: string | null;
  nginxTemplate: string | null;
  apacheTemplateType: string | null;
  apacheTemplate: string | null;
  varnishTemplate: string | null;
  /** '5.6'… (php-fpm_ver "56"). */
  phpFpmVersion: string | null;
  phpFpm: boolean;
  nginx: boolean;
  varnish: boolean;
  apache: boolean;
  /** Proxy variant: custom-ip / custom-port. */
  customIp: string | null;
  customPort: number | null;
}

/** ~/.conf/webservers/<fqdn>.conf (normal and proxy variants). */
export function parseDomainWebConf(text: string): DomainWebConf | null {
  const j = safeJson(text);
  if (!isObj(j)) return null;
  const port = str(j['custom-port']);
  const portNum = port !== null && /^\d{1,5}$/.test(port.trim()) ? Number(port.trim()) : null;
  const ip = str(j['custom-ip']);
  return {
    nginxTemplateType: str(j['nginx_template-type']),
    nginxTemplate: str(j['nginx_template-name']),
    apacheTemplateType: str(j['apache_template-type']),
    apacheTemplate: str(j['apache_template-name']),
    varnishTemplate: str(j['varnish_template-name']),
    phpFpmVersion: phpDigitsToVersion(str(j['php-fpm_ver'])),
    phpFpm: bool(j['php-fpm']),
    nginx: bool(j.nginx),
    varnish: bool(j.varnish),
    apache: bool(j['apache-additional']) || bool(j.apache),
    customIp: ip && ip.trim() !== '' ? ip.trim() : null,
    customPort: portNum !== null && portNum > 0 && portNum < 65536 ? portNum : null,
  };
}

export interface WpAddon {
  domain: string | null;
  /** Absolute path without trailing slash. */
  path: string;
  database: string | null;
  dbUser: string | null;
  version: string | null;
}

/** ~/.conf/.addons_wp: array of CWP WordPress installs (the footprint / credentials are not kept). */
export function parseAddonsWp(text: string): WpAddon[] | null {
  const j = safeJson(text);
  const arr = Array.isArray(j) ? j : isObj(j) ? Object.values(j) : null;
  if (!arr) return null;
  const out: WpAddon[] = [];
  for (const e of arr) {
    if (!isObj(e)) continue;
    const p = str(e.path);
    if (!p || !p.startsWith('/')) continue;
    out.push({
      domain: str(e.domain)?.toLowerCase() ?? null,
      path: p.length > 1 ? p.replace(/\/+$/, '') : p,
      database: str(e.wpbd),
      dbUser: str(e.wpuserdb),
      version: str(e.version),
    });
  }
  return out;
}

/**
 * /usr/local/etc/suphp.conf [handlers]: `application/x-httpd-php56="php:/opt/alt/php56/usr/bin/php-cgi"`
 * (also `x-httpd-php56=…`). Returns handler (without the application/ prefix, lower case) → binary path.
 */
export function parseSuphpHandlers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (l === '' || l.startsWith(';') || l.startsWith('#') || l.startsWith('[')) continue;
    const m = /^(?:application\/)?(x-httpd-[A-Za-z0-9._-]+)\s*=\s*"?(?:php|execute):([^"\s]+)"?/.exec(l);
    if (m) out.set(m[1].toLowerCase(), m[2]);
  }
  return out;
}

/** PHP version of a CLI / CGI binary path (/opt/alt/php56/usr/bin/php-cgi → 5.6); null for /usr/local/bin/php*. */
export function phpVersionOfBinary(binary: string): string | null {
  const m = /\/opt\/alt\/php(\d{2,3})\/usr\/bin\/php(?:-cgi)?$/.exec(binary);
  return m ? phpDigitsToVersion(m[1]) : null;
}

/** Version of an Apache PHP handler name: x-httpd-php56 / x-httpd-ea-php74 → via suphp.conf, else the digits. */
export function phpVersionOfHandler(handler: string, suphp: Map<string, string>, defaultVersion: string | null): string | null {
  const h = handler.toLowerCase().replace(/^application\//, '');
  const bin = suphp.get(h);
  if (bin) {
    const v = phpVersionOfBinary(bin);
    if (v) return v;
    if (h === 'x-httpd-php') return defaultVersion;
  }
  const m = /^x-httpd-(?:ea-|alt-)?php(\d{2,3})$/.exec(h);
  if (m) return phpDigitsToVersion(m[1]);
  if (h === 'x-httpd-php') return defaultVersion;
  return null;
}

/** /usr/local/cwp/.conf/mysql_user_prefix.conf: additional prefixes (one per line / separated by spaces or commas). */
export function parseMysqlUserPrefixes(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/[#;].*$/, '').trim();
    if (!l) continue;
    for (const tok of l.split(/[\s,=:]+/)) {
      const t = tok.trim().replace(/_+$/, '');
      if (/^[A-Za-z0-9]{1,32}$/.test(t)) out.add(t);
    }
  }
  return [...out];
}
