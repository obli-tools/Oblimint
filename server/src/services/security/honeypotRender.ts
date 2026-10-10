import type { HoneypotPreset, ProxyHostHoneypot } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PURE nginx snippets of the honeypot + web bans (docs/P4b-PLAN.md §9.2) —
// module honeypot-bans (honeypotRender.test.ts). Consumed by proxy-hosts (its
// renderers) and edge-robustness (the P1/P2 vhosts rendered by
// nginxConfig.ts). Lines come WITHOUT trailing newline, already indented with
// `indent`.
//
// H5: nothing of a tenant reaches nginx without validation here — bait paths
// are checked against a strict character set (an invalid one is DROPPED, never
// escaped), ids are positive integers, the log kind a fixed lower-case token.
// The variables referenced ($oblimint_ban_p / $oblimint_ban_a) are defined by
// the global unit g-bans (bansUnit.ts; fallback: nobody banned) and the log
// variables by the default servers of the image (docs §8.7).
// ─────────────────────────────────────────────────────────────────────────────

export interface HoneypotRenderInput {
  proxyHostId: number;
  accountId: number;
  tenantId: number;
  honeypot: ProxyHostHoneypot;
  /** Paths of the host's sub-routes: a bait path equal to / under one of them is skipped (the route wins). */
  routePaths: string[];
  /** $oblimint_kind of the generated locations (proxy). */
  logKind: string;
}

/** Longest bait path accepted. */
export const MAX_BAIT_PATH = 200;
/** Most bait locations rendered for one host (the rest is ignored). */
export const MAX_BAIT_PATHS = 200;
const BAIT_PATH_RE = /^\/[A-Za-z0-9._~/-]{1,199}$/;
const LOG_KIND_RE = /^[a-z][a-z-]{0,31}$/;
/** Paths the renderers of the host own themselves: a bait there would duplicate their location (nginx -t fails). */
const RESERVED_PREFIXES = ['/.well-known/acme-challenge', '/oauth2'];
/**
 * Internal locations (/__oblimint_edge/, /__oblimint_px/, /__oblimint_fa/…):
 * reserved by RAW string prefix — a bait there would duplicate them or catch
 * the internal redirect of an error page (every 404 would then ban).
 */
const RESERVED_RAW_PREFIX = '/__oblimint';

/** A path the host's own locations own (never a bait). */
export function isReservedBaitPath(p: string): boolean {
  return p.startsWith(RESERVED_RAW_PREFIX) || RESERVED_PREFIXES.some((r) => isUnder(p, r));
}

const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2_147_483_647;

/**
 * A bait path as typed by a user: absolute, [A-Za-z0-9._~/-] only, ≤ 200
 * characters, no '..' segment, not '/' alone, no '//', not a reserved
 * location (isReservedBaitPath). Returns null when invalid (never "fixed":
 * the renderers drop it, the API refuses it).
 */
export function normalizeBaitPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const p = input.trim();
  if (!BAIT_PATH_RE.test(p) || p.length > MAX_BAIT_PATH) return null;
  if (p.includes('//')) return null;
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (isReservedBaitPath(p)) return null;
  return p;
}

/** `path` equal to, or under, `prefix` (a route '/api' covers '/api', '/api/x' but not '/apix'; '/api/' covers '/api/x'). */
function isUnder(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith('/') || path[prefix.length] === '/';
}

/**
 * nginx locations of one bait, segment-bounded: `/console` catches /console
 * and /console/… but never /consoles; `/admin/` catches /admin/…
 */
export function baitLocations(p: string): string[] {
  return p.endsWith('/') ? [`^~ ${p}`] : [`= ${p}`, `^~ ${p}/`];
}

/** Valid, deduplicated bait paths of a host that do not collide with a route or a reserved location. */
export function effectiveBaitPaths(honeypot: ProxyHostHoneypot | null | undefined, routePaths: readonly string[]): string[] {
  if (!honeypot?.enabled || !Array.isArray(honeypot.paths)) return [];
  // The root location ('/') is the host's default target: never a route a bait could collide with.
  const routes = (Array.isArray(routePaths) ? routePaths : [])
    .filter((r): r is string => typeof r === 'string' && r.startsWith('/') && r !== '/');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of honeypot.paths) {
    const p = normalizeBaitPath(raw);
    // Two baits never render the same location ('/admin' and '/admin/' share `^~ /admin/`).
    if (!p || baitLocations(p).some((l) => seen.has(l))) continue;
    // A route wins: equal / under it, or '/api' next to a route '/api/' (its `= /api` redirect and `^~ /api/`).
    if (routes.some((r) => isUnder(p, r) || r === `${p}/`)) continue;
    for (const l of baitLocations(p)) seen.add(l);
    out.push(p);
    if (out.length >= MAX_BAIT_PATHS) break;
  }
  return out;
}

/**
 * Ban check, placed right after server_name in EVERY server block of a unit
 * (sites and proxy objects): platform bans ($oblimint_ban_p) and the bans of
 * `accountId` ($oblimint_ban_a, list of account ids "|12|15|") → `return 444`
 * (connection closed without a response). accountId null (platform vhosts:
 * panel, dbadmin…): platform bans only. An invalid id renders the platform
 * check only (never a regex built from garbage).
 */
export function banCheckLines(accountId: number | null, indent = '    '): string[] {
  const lines = [`${indent}if ($oblimint_ban_p) { return 444; }`];
  if (accountId !== null && isId(accountId)) lines.push(`${indent}if ($oblimint_ban_a ~ "\\|${accountId}\\|") { return 444; }`);
  return lines;
}

/** The access-log variables of a honeypot location (docs §8.7), $oblimint_hp last. */
function logVarLines(input: HoneypotRenderInput, hp: 'path' | 'acl', indent: string): string[] | null {
  if (!isId(input.proxyHostId) || !isId(input.accountId) || !isId(input.tenantId)) return null;
  const kind = typeof input.logKind === 'string' && LOG_KIND_RE.test(input.logKind) ? input.logKind : 'proxy';
  return [
    `${indent}set $oblimint_kind ${kind};`,
    `${indent}set $oblimint_site "";`,
    `${indent}set $oblimint_account ${input.accountId};`,
    `${indent}set $oblimint_tenant ${input.tenantId};`,
    `${indent}set $oblimint_host ${input.proxyHostId};`,
    `${indent}set $oblimint_app "";`,
    `${indent}set $oblimint_hp ${hp};`,
  ];
}

/**
 * The locations of every enabled bait path (baitLocations: `= <p>` +
 * `^~ <p>/`, or `^~ <p>` for a path ending in '/' — segment-bounded, never a
 * raw string prefix), skipping route paths and the host's own ACME /
 * forward-auth / internal locations: they set the log variables
 * ($oblimint_host = proxyHostId, $oblimint_hp = path…) and return 404 (the
 * host's custom 404 page, if any, still applies). `=` / `^~` beat every regex
 * location; a longer route prefix still wins for its own paths. To place
 * BEFORE the access-list checks and the routes. Honeypot disabled → none.
 */
export function honeypotLocationBlocks(input: HoneypotRenderInput, indent = '    '): string[] {
  const paths = effectiveBaitPaths(input?.honeypot, input?.routePaths ?? []);
  if (paths.length === 0) return [];
  const vars = logVarLines(input, 'path', `${indent}    `);
  if (!vars) return [];
  const out: string[] = [];
  for (const p of paths) {
    for (const l of baitLocations(p)) out.push(`${indent}location ${l} {`, ...vars, `${indent}    return 404;`, `${indent}}`);
  }
  return out;
}

/**
 * ACL trap (honeypot.banAclViolations): `error_page 403 = @oblimint_acl_trap;`
 * + the named location that sets the log variables with $oblimint_hp acl and
 * returns 404 (disguise; the edge log then makes the ban). THE CALLER decides
 * when to use it: only for a host whose access lists carry IP rules (a 403 of
 * a basic-auth-only list never happens — it answers 401 — but a host without
 * IP rules must not arm a trap that an upstream 403 could ever reach), and
 * the caller then renders no other `error_page 403`. Server-level lines.
 * banAclViolations off → none.
 *
 * Only the 403 of the allow / deny rules may ban: the other 403 sources of a
 * proxy host are passed through as a plain 403 (no error_page recursion, no
 * $oblimint_hp), never as an offence —
 *   - the blockExploits answer ($oblimint_exploit, map of the global unit
 *     g-proxy that every proxy host unit already depends on);
 *   - a forward-auth refusal (oauth2-proxy answers 403 to a signed-in user
 *     outside allowed_groups / allowed_emails): its status is captured here by
 *     a server-level auth_request_set (evaluated only where auth_request runs;
 *     initialised empty so a host without forward-auth never reads it unset).
 * A `return 403` of the host's own advancedConfig stays trapped (staff
 * choice, documented in the UI).
 */
export function aclTrapLines(input: HoneypotRenderInput, indent = '    '): string[] {
  if (!input?.honeypot?.banAclViolations) return [];
  const vars = logVarLines(input, 'acl', `${indent}    `);
  if (!vars) return [];
  return [
    `${indent}set $oblimint_fa_status "";`,
    `${indent}auth_request_set $oblimint_fa_status $upstream_status;`,
    `${indent}error_page 403 = @oblimint_acl_trap;`,
    `${indent}location @oblimint_acl_trap {`,
    `${indent}    if ($oblimint_exploit) { return 403; }`,
    `${indent}    if ($oblimint_fa_status ~ "403") { return 403; }`,
    ...vars,
    `${indent}    return 404;`,
    `${indent}}`,
  ];
}

/**
 * "Add the common exploit URLs" button: the scanner targets of Oblihub's
 * preset (WordPress, admin panels, leaked secrets / VCS, Java actuators, PHP
 * tooling, IoT) + a few frequent ones. None of them is a path a site served
 * through a proxy host is expected to use: the UI still shows the list
 * before adding it.
 */
export const HONEYPOT_PRESETS: readonly HoneypotPreset[] = Object.freeze([
  // WordPress
  { path: '/wp-login.php', category: 'wordpress' },
  { path: '/wp-admin', category: 'wordpress' },
  { path: '/xmlrpc.php', category: 'wordpress' },
  { path: '/wp-config.php', category: 'wordpress' },
  { path: '/wp-content/debug.log', category: 'wordpress' },
  // secrets
  { path: '/.env', category: 'secrets' },
  { path: '/.env.local', category: 'secrets' },
  { path: '/.env.production', category: 'secrets' },
  { path: '/.aws/credentials', category: 'secrets' },
  { path: '/.aws/config', category: 'secrets' },
  { path: '/config.php', category: 'secrets' },
  { path: '/config.yml', category: 'secrets' },
  { path: '/config.json', category: 'secrets' },
  { path: '/.ssh', category: 'secrets' },
  { path: '/.DS_Store', category: 'secrets' },
  { path: '/backup.zip', category: 'secrets' },
  { path: '/backup.tar.gz', category: 'secrets' },
  { path: '/backup.sql', category: 'secrets' },
  // version control
  { path: '/.git/config', category: 'vcs' },
  { path: '/.git/HEAD', category: 'vcs' },
  { path: '/.svn', category: 'vcs' },
  { path: '/.hg', category: 'vcs' },
  { path: '/.bzr', category: 'vcs' },
  // admin panels
  { path: '/admin.php', category: 'admin' },
  { path: '/administrator', category: 'admin' },
  { path: '/phpmyadmin', category: 'admin' },
  { path: '/pma', category: 'admin' },
  { path: '/myadmin', category: 'admin' },
  { path: '/mysql', category: 'admin' },
  { path: '/dbadmin', category: 'admin' },
  { path: '/adminer.php', category: 'admin' },
  { path: '/server-status', category: 'admin' },
  { path: '/server-info', category: 'admin' },
  // Java / app servers
  { path: '/actuator', category: 'java' },
  { path: '/api/actuator', category: 'java' },
  { path: '/manager/html', category: 'java' },
  { path: '/manager/status', category: 'java' },
  { path: '/console', category: 'java' },
  { path: '/jmx-console', category: 'java' },
  { path: '/api/jsonws/invoke', category: 'java' },
  // PHP tooling
  { path: '/vendor/phpunit', category: 'php' },
  { path: '/phpinfo.php', category: 'php' },
  { path: '/telescope', category: 'php' },
  { path: '/horizon', category: 'php' },
  { path: '/_ignition/execute-solution', category: 'php' },
  // IoT / appliances
  { path: '/HNAP1', category: 'iot' },
  { path: '/boaform', category: 'iot' },
  { path: '/cgi-bin/luci', category: 'iot' },
  { path: '/GponForm', category: 'iot' },
  // other
  { path: '/owa/auth/logon.aspx', category: 'other' },
  { path: '/autodiscover/autodiscover.xml', category: 'other' },
] as HoneypotPreset[]);
