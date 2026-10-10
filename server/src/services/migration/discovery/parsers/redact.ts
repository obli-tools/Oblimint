// ─────────────────────────────────────────────────────────────────────────────
// MG2: one redactor for every command line kept in the inventory (cron
// commands, systemd ExecStart). Only VALUES are replaced (`<redacted>`):
// binaries, paths and option names stay, which is all the planner's cron
// rewrite and the outside items need. Covered forms:
//   mysql / mysqldump / mariadb… `-p<value>`      sshpass `-p <value>`
//   `--password[=| ]v`, `--api-key v`, `--token=v`… (option names holding
//     pass / pwd / secret / token / key / auth)
//   `TOKEN=v`, `DB_PASS=v`, `MYSQL_PWD=v` (environment assignments)
//   curl / wget `-u user:pass`, `--user=user:pass`, `--http-password=v`
//   URL userinfo `scheme://user:pass@host`
//   query parameters named like pass / pwd / key / token / secret / auth / sig
// ─────────────────────────────────────────────────────────────────────────────

export const REDACTED_VALUE = '<redacted>';

const KW = '(?:pass|passwd|password|pwd|secret|token|apikey|api_key|api-key|key|auth|credential)';
const VALUE = `(?:"[^"]*"|'[^']*'|[^\\s"'&;|]+)`;
const NOT_REDACTED = '(?!<redacted>)';

/** `--password=x`, `--password x`, `-api-key x` (an option: starts with a dash). */
const OPTION = new RegExp(`((?:^|[\\s"'(])-{1,2}[A-Za-z0-9_.-]*${KW}[A-Za-z0-9_.-]*)(=|\\s+)${NOT_REDACTED}(${VALUE})`, 'gi');
/** `TOKEN=x`, `DB_PASS=x`, `MYSQL_PWD=x` (environment assignment, no dash). */
const ASSIGN = new RegExp(`((?:^|[\\s"';&|(])(?=[A-Za-z_])[A-Za-z0-9_]*${KW}[A-Za-z0-9_]*)=${NOT_REDACTED}(${VALUE})`, 'gi');
/** MySQL client family: `-pSecret` (value glued to -p; `-p` alone prompts and is kept). */
const MYSQL_P = new RegExp(`(\\b(?:mysql|mysqldump|mysqladmin|mysqlcheck|mysqlimport|mysqlshow|mysqlpump|mariadb|mariadb-dump|mariadb-admin|mariadb-check)\\b[^;|&\\n]*?\\s-p)${NOT_REDACTED}("[^"]*"|'[^']*'|[^\\s;|&"']+)`, 'g');
/** `sshpass -p secret`. */
const SSHPASS = new RegExp(`(\\bsshpass\\b[^;|&\\n]*?\\s-p\\s*)${NOT_REDACTED}("[^"]*"|'[^']*'|[^\\s;|&"']+)`, 'g');
/** curl / wget `-u user:pass`, `--user user:pass`, `--user=user:pass`. */
const USER_PASS = /((?:^|\s)(?:-u\s*|--user[=\s]+|--proxy-user[=\s]+)["']?[^\s:"']+:)(?!<redacted>)[^\s"']+/g;
/** URL userinfo. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"']+:)(?!<redacted>@)[^\s/@"']+@/gi;
/** Query parameters with a credential-looking name. */
const QUERY = new RegExp(`([?&;][A-Za-z0-9_.-]*(?:${KW.slice(3, -1)}|sig|signature|hash)[A-Za-z0-9_.-]*=)${NOT_REDACTED}[^&\\s"'#]+`, 'gi');

function untilStable(s: string, re: RegExp, fn: (...m: string[]) => string): string {
  let prev = s;
  for (let i = 0; i < 16; i += 1) {
    const next = prev.replace(re, fn as (substring: string, ...args: unknown[]) => string);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/** Redacts the credential VALUES of a command line (cron command, ExecStart). Idempotent. */
export function redactCommand(cmd: string): string {
  let s = cmd;
  s = s.replace(URL_USERINFO, (_m, head: string) => `${head}${REDACTED_VALUE}@`);
  s = s.replace(QUERY, (_m, head: string) => `${head}${REDACTED_VALUE}`);
  s = s.replace(USER_PASS, (_m, head: string) => `${head}${REDACTED_VALUE}`);
  s = untilStable(s, MYSQL_P, (_m, head) => `${head}${REDACTED_VALUE}`);
  s = untilStable(s, SSHPASS, (_m, head) => `${head}${REDACTED_VALUE}`);
  s = s.replace(OPTION, (_m, k: string, sep: string) => `${k}${sep}${REDACTED_VALUE}`);
  s = s.replace(ASSIGN, (_m, k: string) => `${k}=${REDACTED_VALUE}`);
  return s;
}
