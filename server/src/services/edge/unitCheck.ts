import { EDGE_UNIT_OWNER_KINDS } from './unitTypes';
import { lintAdvancedConfig } from './lint';
import { isValidCertPath, isValidServerNameEntry } from './nginxConfig';
import { isScriptingDirective, NGINX_VARIABLE_RE, parseNginx, PASS_DIRECTIVES } from './nginxParse';
import { UNIT_ID_RE, type EdgeConfigUnit } from './units';

// ─────────────────────────────────────────────────────────────────────────────
// Re-check of every unit handed to the pipeline (docs/P4b-PLAN.md §8.2, H5,
// ED2, ED5) — PURE. Producers validate and sanitize their values; this is the
// edge's own defence in depth before a unit reaches even the sandbox: a unit
// that fails here is refused like one that fails `nginx -t` (last good
// version kept, or a 503 stub keeping its names).
// ─────────────────────────────────────────────────────────────────────────────

/** Caps of one unit. */
export const UNIT_MAX_CONFIG_BYTES = 512 * 1024;
export const UNIT_MAX_FILES = 32;
export const UNIT_MAX_FILES_BYTES = 2 * 1024 * 1024;
export const UNIT_MAX_SERVER_NAMES = 512;

/** Aux file name relative to aux/<unit>/: [a-z0-9._-] segments, never `..`, never hidden. */
export const AUX_NAME_RE = /^[a-z0-9_-][a-z0-9._-]{0,63}(?:\/[a-z0-9_-][a-z0-9._-]{0,63}){0,3}$/;

export function isValidAuxName(name: string): boolean {
  return typeof name === 'string' && AUX_NAME_RE.test(name) && !name.split('/').some((s) => s === '..' || s === '.');
}

/** Directives whose arguments are file paths (checked against the allowed prefixes). */
const FILE_ARG_DIRECTIVES: ReadonlySet<string> = new Set([
  'root', 'alias', 'ssl_certificate', 'ssl_certificate_key', 'ssl_trusted_certificate', 'ssl_client_certificate', 'ssl_dhparam',
  'ssl_crl', 'ssl_password_file', 'ssl_stapling_file', 'ssl_session_ticket_key', 'auth_basic_user_file',
  'proxy_ssl_certificate', 'proxy_ssl_certificate_key', 'proxy_ssl_trusted_certificate', 'proxy_ssl_crl', 'proxy_ssl_password_file',
  'proxy_cache_path', 'proxy_temp_path', 'client_body_temp_path', 'access_log', 'error_log', 'geoip_country', 'geoip_city',
  'geoip2', 'user_agent_file',
]);

/** Paths a unit may reference (in the edge container). The aux directory is further restricted to the unit's own. */
const ALLOWED_PATH_PREFIXES = ['/etc/nginx/oblimint/certs/', '/etc/nginx/oblimint/aux/', '/usr/share/oblimint/', '/var/www/acme/', '/var/cache/nginx/'];
const ALLOWED_PATHS = ['/var/www/acme', '/dev/stdout', '/dev/stderr'];

/** Keywords a file directive may take instead of a path as its FIRST argument. */
const FILE_ARG_KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  access_log: new Set(['off']),
  error_log: new Set(['stderr']),
};

/** root / alias: only the ACME webroot, the image's error pages and the unit's own aux tree (never certs, never cache). */
function isAllowedDocumentRoot(a: string, unitId: string): boolean {
  return a === '/var/www/acme' || a.startsWith('/var/www/acme/')
    || a === '/usr/share/oblimint/errors' || a.startsWith('/usr/share/oblimint/errors/')
    || a.startsWith(`/etc/nginx/oblimint/aux/${unitId}/`);
}

/** Port + protocol of a stream `listen` (null: not a plain port / addr:port, e.g. a unix socket). */
function streamListenOf(args: string[]): { port: number; protocol: 'tcp' | 'udp' } | null {
  const m = /^(?:(?:\[[0-9a-fA-F:.]+\]|[0-9.]+|\*):)?(\d{1,5})$/.exec(args[0] ?? '');
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, protocol: args.slice(1).includes('udp') ? 'udp' : 'tcp' };
}

/** What a server unit claims in its metadata: its configuration may serve / listen on nothing else. */
export interface UnitClaims {
  serverNames?: readonly string[];
  listen?: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
}

/** Path relative to aux/<unit>/: plain segments, optional trailing slash (directory). */
const AUX_REL_PATH_RE = /^[a-z0-9_-][a-z0-9._-]{0,63}(?:\/[a-z0-9_-][a-z0-9._-]{0,63}){0,3}\/?$/;

const AUX_REF_RE = /\/etc\/nginx\/oblimint\/aux\/([^/\s"';]*)/g;

/** Problems of a configuration text of unit `unitId` (null = acceptable). */
export function checkUnitConfigText(text: string, unitId: string, placement: 'server' | 'global', scope: 'http' | 'stream', claims: UnitClaims = {}): string | null {
  if (typeof text !== 'string') return 'configuration missing';
  if (Buffer.byteLength(text, 'utf8') > UNIT_MAX_CONFIG_BYTES) return `configuration larger than ${UNIT_MAX_CONFIG_BYTES} bytes`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return 'configuration contains control characters';
  for (const m of text.matchAll(AUX_REF_RE)) {
    if (m[1] !== unitId) return `reference to the aux files of another unit (${m[1].slice(0, 64)})`;
  }
  const parsed = parseNginx(text);
  if (parsed.issues.length) return `line ${parsed.issues[0].line}: ${parsed.issues[0].message}`;
  for (const st of parsed.statements) {
    const at = `line ${st.line}: ${st.directive}`;
    if (st.directive === 'include' || st.directive === 'load_module') return `${at} is not allowed in a unit`;
    if (isScriptingDirective(st.directive)) return `${at}: embedded scripting is not allowed`;
    if (PASS_DIRECTIVES.has(st.directive) && !(st.args.length === 1 && NGINX_VARIABLE_RE.test(st.args[0]))) {
      return `${at} must target a variable (resolved per request)`;
    }
    if (FILE_ARG_DIRECTIVES.has(st.directive)) {
      // The first argument IS the path (a relative one would resolve against the nginx prefix /etc/nginx/ and
      // escape every check below); later arguments (log format, levels=, keys_zone=…) are checked when path-like.
      const first = st.args[0] ?? '';
      if (!first.startsWith('/') && !FILE_ARG_KEYWORDS[st.directive]?.has(first)) return `${at}: the path must be absolute`;
      if (first.startsWith('/') && first.includes('$')) return `${at}: no variable in a path`;
      if ((st.directive === 'root' || st.directive === 'alias') && !isAllowedDocumentRoot(first, unitId)) {
        return `${at}: only the ACME webroot, the error pages or the unit's own aux directory`;
      }
      for (const a of st.args) {
        if (!a.startsWith('/')) continue;
        if (a.split('/').includes('..')) return `${at}: ".." in a path`;
        if (!ALLOWED_PATHS.includes(a) && !ALLOWED_PATH_PREFIXES.some((p) => a.startsWith(p))) return `${at}: path outside the edge directories`;
        if (a.startsWith('/etc/nginx/oblimint/aux/')) {
          // A file or a directory (alias …/pages/) of the unit's own aux tree.
          const own = `/etc/nginx/oblimint/aux/${unitId}/`;
          const rest = a.startsWith(own) ? a.slice(own.length) : null;
          if (rest === null || !(rest === '' || AUX_REL_PATH_RE.test(rest))) return `${at}: invalid aux path`;
        }
      }
    }
    if (st.depth === 0) {
      const isServer = st.directive === 'server' && st.block;
      if (placement === 'server' && !isServer) return `${at}: a server unit holds server{} blocks only`;
      if (placement === 'global' && isServer) return `${at}: a global unit holds no server{} block`;
    }
    if (scope === 'http' && st.directive === 'listen' && st.depth === 1) {
      // http server units listen on the public web ports only (streams have their own units).
      const port = /(?:^|:)(\d+)$/.exec(st.args[0] ?? '')?.[1];
      if (port !== '80' && port !== '443') return `${at}: http units listen on 80 / 443 only`;
    }
    if (scope === 'stream' && st.directive === 'listen') {
      // A stream unit listens on its declared (platform-approved) ports only — never 80 / 443 / anything else.
      const l = streamListenOf(st.args);
      if (!l) return `${at}: invalid stream listen`;
      if (placement !== 'server' || !(claims.listen ?? []).some((c) => c.port === l.port && c.protocol === l.protocol)) {
        return `${at}: port ${l.port}/${l.protocol} is not a declared port of the unit`;
      }
    }
    if (st.directive === 'server_name') {
      // The names served are exactly the declared ones (collision detection relies on them): no regex, no catch-all.
      if (scope !== 'http' || placement !== 'server') return `${at} outside an http server unit`;
      const declared = new Set(claims.serverNames ?? []);
      for (const a of st.args) {
        if (!declared.has(a)) return `${at}: ${JSON.stringify(a.slice(0, 80))} is not a declared server name of the unit`;
      }
    }
  }
  return null;
}

export interface UnitCheckContext {
  streamPorts: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
}

/** Every problem of a unit that must keep it away from the sandbox (null = acceptable). Never throws. */
export function checkUnit(u: EdgeConfigUnit, ctx: UnitCheckContext): string | null {
  try {
    if (!u || typeof u.id !== 'string' || !UNIT_ID_RE.test(u.id)) return 'invalid unit id';
    if (u.scope !== 'http' && u.scope !== 'stream') return 'invalid scope';
    if (u.level !== 'global' && u.level !== 'server') return 'invalid level';
    if (!u.owner || !EDGE_UNIT_OWNER_KINDS.includes(u.owner.kind)) return 'invalid owner';
    for (const v of [u.owner.id, u.owner.accountId, u.owner.tenantId]) {
      if (v !== null && v !== undefined && !(Number.isInteger(v) && v > 0)) return 'invalid owner ids';
    }
    const names = Array.isArray(u.serverNames) ? u.serverNames : [];
    const listen = Array.isArray(u.listen) ? u.listen : [];
    if (u.scope === 'http' && u.level === 'server') {
      if (names.length === 0) return 'no server name';
      if (names.length > UNIT_MAX_SERVER_NAMES) return 'too many server names';
      const seen = new Set<string>();
      for (const n of names) {
        if (!isValidServerNameEntry(n)) return `invalid server name ${JSON.stringify(String(n).slice(0, 80))}`;
        if (seen.has(n)) return `duplicate server name ${n}`;
        seen.add(n);
      }
      if (listen.length) return 'an http unit declares no stream port';
    } else if (names.length) {
      return 'server names on a non-http-server unit';
    }
    if (u.scope === 'stream' && u.level === 'server') {
      if (listen.length === 0) return 'stream unit without port';
      for (const l of listen) {
        if (!l || !Number.isInteger(l.port) || (l.protocol !== 'tcp' && l.protocol !== 'udp')) return 'invalid stream port';
        if (!ctx.streamPorts.some((p) => p.port === l.port && p.protocol === l.protocol)) return `stream port ${l.port}/${l.protocol} is not approved by the platform`;
      }
    } else if (u.scope !== 'stream' && listen.length) {
      return 'stream ports on a non-stream unit';
    } else if (u.level === 'global' && listen.length) {
      return 'stream ports on a global unit';
    }
    if (u.tls !== null && u.tls !== undefined) {
      if (u.scope !== 'http' || u.level !== 'server') return 'certificate on a non-http-server unit';
      if (!isValidCertPath(u.tls.certPath) || !isValidCertPath(u.tls.keyPath)) return 'invalid certificate path';
    }
    const files = u.files ?? {};
    if (typeof files !== 'object') return 'invalid aux files';
    const entries = Object.entries(files);
    if (entries.length > UNIT_MAX_FILES) return 'too many aux files';
    let bytes = 0;
    for (const [name, content] of entries) {
      if (!isValidAuxName(name)) return `invalid aux file name ${JSON.stringify(String(name).slice(0, 80))}`;
      if (typeof content !== 'string') return `invalid aux file ${name}`;
      bytes += Buffer.byteLength(content, 'utf8');
    }
    if (bytes > UNIT_MAX_FILES_BYTES) return 'aux files too large';
    for (const ref of Array.isArray(u.upstreams) ? u.upstreams : []) {
      if (!ref || typeof ref.host !== 'string' || !Number.isInteger(ref.port) || ref.port < 1 || ref.port > 65535) return 'invalid upstream';
    }
    const placement = u.level === 'server' ? 'server' : 'global';
    const configError = checkUnitConfigText(u.config, u.id, placement, u.scope, { serverNames: names, listen });
    if (configError) return configError;
    if (u.fallbackConfig !== undefined && u.fallbackConfig !== null) {
      if (u.level !== 'global') return 'fallbackConfig on a server unit';
      const fbError = checkUnitConfigText(u.fallbackConfig, u.id, 'global', u.scope);
      if (fbError) return `fallbackConfig: ${fbError}`;
    }
    for (const snippet of Array.isArray(u.rawSnippets) ? u.rawSnippets : []) {
      const lint = lintAdvancedConfig(snippet);
      if (!lint.ok) {
        const first = lint.issues[0];
        return `advancedConfig line ${first.line}: ${first.message}`;
      }
      for (const m of String(snippet).matchAll(AUX_REF_RE)) {
        if (m[1] !== u.id) return 'advancedConfig references the aux files of another unit';
      }
    }
    return null;
  } catch (err) {
    return `invalid unit: ${(err as Error).message}`;
  }
}
