import type { AdvancedConfigLintResult } from '@oblimint/shared';
import { isScriptingDirective, NGINX_VARIABLE_RE, parseNginx, PASS_DIRECTIVES } from './nginxParse';

// Linter of the raw advancedConfig of proxy hosts (docs/P4b-PLAN.md §8.5) — PURE. OWNED BY MODULE
// `edge-robustness` (signature FROZEN: proxy-hosts calls it at save time, edge-robustness again before
// every sandbox test). Allow-list of server{}/location{}-level directives; never include, load_module,
// lua / perl / js, root / alias / any file path outside /etc/nginx/oblimint/aux/<unit>/, proxy_pass with a
// literal target, ssl_* key material, access_log / error_log to a file; balanced braces; ≤ 16 KiB.
// Issues carry 1-based line numbers. The sandbox `nginx -t` stays the final judge: the linter refuses
// what must never reach nginx (escape from the unit, file access, module loading, scripting).

type Issue = AdvancedConfigLintResult['issues'][number];

/** Hard cap of an advancedConfig (UTF-8 bytes). */
export const ADVANCED_CONFIG_MAX_BYTES = 16 * 1024;

/** Block directives allowed inside the server{} of a unit. */
const BLOCK_DIRECTIVES: ReadonlySet<string> = new Set(['location', 'if', 'limit_except']);

/** server{} / location{}-level directives accepted in an advancedConfig. */
const ALLOWED_DIRECTIVES: ReadonlySet<string> = new Set([
  ...BLOCK_DIRECTIVES,
  // rewrite module
  'set', 'return', 'rewrite', 'break', 'rewrite_log', 'uninitialized_variable_warn',
  // headers / responses
  'add_header', 'add_trailer', 'expires', 'etag', 'if_modified_since', 'charset', 'source_charset', 'override_charset',
  'default_type', 'error_page', 'recursive_error_pages', 'internal', 'try_files', 'index',
  'absolute_redirect', 'port_in_redirect', 'server_name_in_redirect', 'chunked_transfer_encoding', 'msie_padding',
  'log_not_found', 'log_subrequest', 'access_log' /* "off" only (refusalReason) */, 'ignore_invalid_headers', 'underscores_in_headers', 'merge_slashes',
  // access
  'allow', 'deny', 'satisfy', 'auth_basic', 'auth_basic_user_file', 'auth_request', 'auth_request_set',
  // limits / timeouts
  'client_max_body_size', 'client_body_buffer_size', 'client_body_timeout', 'client_header_timeout',
  'keepalive_timeout', 'keepalive_requests', 'send_timeout', 'limit_rate', 'limit_rate_after',
  'limit_req', 'limit_req_status', 'limit_req_log_level', 'limit_conn', 'limit_conn_status', 'limit_conn_log_level',
  // compression / filters
  'gzip', 'gzip_types', 'gzip_min_length', 'gzip_comp_level', 'gzip_proxied', 'gzip_vary', 'gzip_disable', 'gzip_http_version',
  'gzip_buffers', 'sub_filter', 'sub_filter_once', 'sub_filter_types', 'sub_filter_last_modified',
  // proxy
  'proxy_pass', 'proxy_set_header', 'proxy_hide_header', 'proxy_pass_header', 'proxy_ignore_headers', 'proxy_http_version',
  'proxy_buffering', 'proxy_buffer_size', 'proxy_buffers', 'proxy_busy_buffers_size', 'proxy_request_buffering',
  'proxy_max_temp_file_size', 'proxy_read_timeout', 'proxy_send_timeout', 'proxy_connect_timeout', 'proxy_redirect',
  'proxy_cookie_domain', 'proxy_cookie_path', 'proxy_cookie_flags', 'proxy_intercept_errors', 'proxy_next_upstream',
  'proxy_next_upstream_tries', 'proxy_next_upstream_timeout', 'proxy_method', 'proxy_pass_request_body',
  'proxy_pass_request_headers', 'proxy_set_body', 'proxy_socket_keepalive', 'proxy_cache', 'proxy_cache_key',
  'proxy_cache_valid', 'proxy_cache_bypass', 'proxy_no_cache', 'proxy_cache_methods', 'proxy_cache_min_uses',
  'proxy_cache_use_stale', 'proxy_cache_lock', 'proxy_cache_lock_timeout', 'proxy_cache_revalidate',
  'proxy_cache_background_update', 'proxy_ssl_server_name', 'proxy_ssl_name', 'proxy_ssl_verify', 'proxy_ssl_verify_depth',
  'proxy_ssl_protocols', 'proxy_ssl_ciphers', 'proxy_ssl_session_reuse', 'proxy_ssl_trusted_certificate',
  'grpc_pass', 'grpc_set_header', 'grpc_hide_header', 'grpc_read_timeout', 'grpc_send_timeout', 'grpc_connect_timeout',
  'grpc_ssl_server_name', 'grpc_ssl_name', 'grpc_ssl_verify',
]);

/** Directives whose arguments are files: only the unit's own aux directory. */
const FILE_DIRECTIVES: ReadonlySet<string> = new Set(['auth_basic_user_file', 'proxy_ssl_trusted_certificate']);

/** /etc/nginx/oblimint/aux/<unit>/<file> — <unit> checked against the unit id by unitCheck.ts. */
export const AUX_FILE_PATH_RE = /^\/etc\/nginx\/oblimint\/aux\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9._-]+(?:\/[a-z0-9._-]+)*)$/;

function forbidden(line: number, directive: string, message: string): Issue {
  return { line, directive, code: 'forbiddenDirective', message };
}

/** Why `name` is refused outright (null = not on the explicit refusal list). */
function refusalReason(name: string, args: string[]): string | null {
  if (name === 'include') return 'include is not allowed (the unit must be self-contained)';
  if (name === 'load_module') return 'load_module is not allowed';
  if (isScriptingDirective(name)) return `${name}: embedded scripting is not allowed`;
  if (name === 'root' || name === 'alias') return `${name} is not allowed (no file serving from the edge)`;
  if (name.startsWith('ssl_')) return `${name} is not allowed (TLS is managed by the panel)`;
  if (/^proxy_ssl_(certificate|certificate_key|password_file|crl)$/.test(name)) return `${name} is not allowed (no key material)`;
  if (name === 'error_log') return 'error_log is not allowed';
  if (name === 'access_log' && !(args.length === 1 && args[0] === 'off')) return 'access_log is only allowed as "access_log off;"';
  if ((name === 'set' || name === 'auth_request_set') && /^\$\{?oblimint_/.test(args[0] ?? '')) return `${args[0]} is reserved (access log attribution)`;
  if (name === 'server' || name === 'http' || name === 'stream' || name === 'events' || name === 'upstream') return `${name} block is not allowed here`;
  if (name === 'listen' || name === 'server_name') return `${name} is managed by the panel`;
  if (name === 'resolver' || name === 'resolver_timeout') return 'the resolver is managed by the edge';
  return null;
}

/** A try_files fallback (last argument): =code, @named location or a URI (internal redirect, not a file). */
const TRY_FILES_FALLBACK_RE = /^(?:=\d{3}|@[A-Za-z0-9_-]+|\/\S*)$/;
/** File-test operators of `if` (existence of files on the edge must not leak). */
const IF_FILE_OPERATOR_RE = /^\(?!?-[fdexFDEX]$/;

/**
 * No file access from the edge (§8.5): try_files / index resolve their
 * arguments as root + argument WITHOUT normalising a literal or variable
 * "..", and `if (-f …)` reveals what exists. try_files only tests the
 * (normalised) $uri; index takes plain file names; if never tests files.
 */
function fileServingIssue(name: string, args: string[]): string | null {
  if (name === 'try_files') {
    if (args.some((a) => a.includes('..'))) return 'try_files: ".." is not allowed';
    const files = args.slice(0, -1);
    const fallback = args[args.length - 1] ?? '';
    if (files.some((a) => a !== '$uri' && a !== '$uri/')) return 'try_files may only test $uri / $uri/ (no file paths on the edge)';
    if (!TRY_FILES_FALLBACK_RE.test(fallback)) return 'try_files: the last argument must be =code, @location or a URI';
    return null;
  }
  if (name === 'index') {
    if (args.some((a) => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(a) || a.includes('..'))) return 'index: plain file names only';
    return null;
  }
  if (name === 'if' && args.some((a) => IF_FILE_OPERATOR_RE.test(a))) return 'if: file tests (-f, -d, -e, -x) are not allowed';
  return null;
}

/** Lints a raw advancedConfig snippet (server{} level). PURE, never throws. */
export function lintAdvancedConfig(text: string): AdvancedConfigLintResult {
  const src = typeof text === 'string' ? text : '';
  const issues: Issue[] = [];
  if (Buffer.byteLength(src, 'utf8') > ADVANCED_CONFIG_MAX_BYTES) {
    return { ok: false, issues: [{ line: 1, directive: null, code: 'tooLong', message: `advancedConfig exceeds ${ADVANCED_CONFIG_MAX_BYTES} bytes` }] };
  }
  // eslint-disable-next-line no-control-regex
  const ctl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.exec(src);
  if (ctl) {
    const line = src.slice(0, ctl.index).split('\n').length;
    issues.push({ line, directive: null, code: 'syntax', message: 'control characters are not allowed' });
  }

  const parsed = parseNginx(src);
  for (const p of parsed.issues) issues.push({ line: p.line, directive: null, code: p.code, message: p.message });

  for (const st of parsed.statements) {
    const name = st.directive;
    const refused = refusalReason(name, st.args);
    if (refused) { issues.push(forbidden(st.line, name, refused)); continue; }
    if (!ALLOWED_DIRECTIVES.has(name)) {
      issues.push(forbidden(st.line, name, `${name} is not in the list of allowed directives`));
      continue;
    }
    if (BLOCK_DIRECTIVES.has(name) !== st.block) {
      issues.push({ line: st.line, directive: name, code: 'syntax', message: st.block ? `${name} does not take a block` : `${name} needs a block` });
      continue;
    }
    if (PASS_DIRECTIVES.has(name) && !(st.args.length === 1 && NGINX_VARIABLE_RE.test(st.args[0]))) {
      issues.push(forbidden(st.line, name, `${name} must target a variable set in the same location (e.g. set $up http://host:port; ${name} $up;)`));
      continue;
    }
    const fileIssue = fileServingIssue(name, st.args);
    if (fileIssue) {
      issues.push({ line: st.line, directive: name, code: 'forbiddenPath', message: fileIssue });
      continue;
    }
    if (FILE_DIRECTIVES.has(name)) {
      for (const a of st.args) {
        if (a === 'off') continue;
        if (a.includes('..') || !AUX_FILE_PATH_RE.test(a)) {
          issues.push({ line: st.line, directive: name, code: 'forbiddenPath', message: `${name}: only files under /etc/nginx/oblimint/aux/<unit>/ are allowed` });
        }
      }
    }
  }
  issues.sort((a, b) => a.line - b.line);
  return { ok: issues.length === 0, issues };
}
