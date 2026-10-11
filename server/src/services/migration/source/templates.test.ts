import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CAT_MANY_SCRIPT, DU_SCRIPT, GUARD_SCRIPT, LINE_COUNT_SCRIPT, STAT_SCRIPT, SYMLINK_EXIT, TEMPLATE_REGISTRY, TOOL_VERSIONS_SCRIPT, VERSION_TOOLS, renderCommand,
  shQuote, templateInfos,
} from './templates';
import { parseToolVersions } from '../discovery/parsers/system';
import { SqlGuardError, checkSql } from './sqlGuard';
import { parseCatManyFrames } from './session';

// ─────────────────────────────────────────────────────────────────────────────
// source-executor: rendering snapshots of EVERY template (with and without
// sudo) and exhaustive refusals (docs/P5-PLAN.md §5.2–§5.4, §15).
// ─────────────────────────────────────────────────────────────────────────────

/** [template, args, rendering, rendering with useSudo]. Reviewed by hand: any change here is a contract change. */
const SNAPSHOTS: Array<[string, unknown, string, string]> = [
  ["sys.osRelease", {},
    "LC_ALL=C cat /etc/os-release /etc/redhat-release",
    "sudo -n -- sh -c 'LC_ALL=C cat /etc/os-release /etc/redhat-release'"],
  ["sys.hostname", {},
    "LC_ALL=C hostname -f",
    "sudo -n -- sh -c 'LC_ALL=C hostname -f'"],
  ["sys.ipAddrs", {},
    "LC_ALL=C ip -o addr show",
    "sudo -n -- sh -c 'LC_ALL=C ip -o addr show'"],
  ["sys.whoami", {},
    "LC_ALL=C id -un",
    "sudo -n -- sh -c 'LC_ALL=C id -un'"],
  ["sys.passwd", {},
    "LC_ALL=C getent passwd",
    "sudo -n -- sh -c 'LC_ALL=C getent passwd'"],
  ["sys.toolVersions", {},
    "LC_ALL=C sh -c 'PATH=\"$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\"; for t in rsync mysqldump mysql named-checkzone postconf doveconf; do p=$(command -v \"$t\" 2>/dev/null) || p=; case \"$p\" in /*) ;; *) printf \"%s|-|\\n\" \"$t\"; continue ;; esac; case \"$t\" in named-checkzone) v=$(\"$p\" -v 2>&1 </dev/null | head -n 1) ;; postconf) v=$(\"$p\" -d mail_version 2>/dev/null </dev/null | head -n 1) ;; doveconf) d=$(command -v dovecot 2>/dev/null) || d=; v=; case \"$d\" in /*) v=$(\"$d\" --version 2>/dev/null </dev/null | head -n 1) ;; esac ;; *) v=$(\"$p\" --version 2>&1 </dev/null | head -n 1) ;; esac; printf \"%s|%s|%s\\n\" \"$t\" \"$p\" \"$(printf \"%s\" \"$v\" | tr -d \"|\\r\" | cut -c 1-200)\"; done; exit 0'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''PATH=\"$PATH:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\"; for t in rsync mysqldump mysql named-checkzone postconf doveconf; do p=$(command -v \"$t\" 2>/dev/null) || p=; case \"$p\" in /*) ;; *) printf \"%s|-|\\n\" \"$t\"; continue ;; esac; case \"$t\" in named-checkzone) v=$(\"$p\" -v 2>&1 </dev/null | head -n 1) ;; postconf) v=$(\"$p\" -d mail_version 2>/dev/null </dev/null | head -n 1) ;; doveconf) d=$(command -v dovecot 2>/dev/null) || d=; v=; case \"$d\" in /*) v=$(\"$d\" --version 2>/dev/null </dev/null | head -n 1) ;; esac ;; *) v=$(\"$p\" --version 2>&1 </dev/null | head -n 1) ;; esac; printf \"%s|%s|%s\\n\" \"$t\" \"$p\" \"$(printf \"%s\" \"$v\" | tr -d \"|\\r\" | cut -c 1-200)\"; done; exit 0'\\'''"],
  ["sys.unitFile", {"path":"/etc/systemd/system/app.service"},
    "LC_ALL=C sed -E 's/^([[:space:]]*Environment[[:space:]]*=).*/\\1<redacted>/' -- '/etc/systemd/system/app.service'",
    "sudo -n -- sh -c 'LC_ALL=C sed -E '\\''s/^([[:space:]]*Environment[[:space:]]*=).*/\\1<redacted>/'\\'' -- '\\''/etc/systemd/system/app.service'\\'''"],
  ["fs.cat", {"path":"/etc/nginx/nginx.conf"},
    "LC_ALL=C cat -- '/etc/nginx/nginx.conf'",
    "sudo -n -- sh -c 'LC_ALL=C cat -- '\\''/etc/nginx/nginx.conf'\\'''"],
  ["fs.cat", {"path":"/home/acct1/public_html/.htaccess","maxBytes":4096},
    "LC_ALL=C sh -c 'p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"' oblimint '/home/acct1/public_html/.htaccess' head -c 4096 -- '/home/acct1/public_html/.htaccess'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"'\\'' oblimint '\\''/home/acct1/public_html/.htaccess'\\'' head -c 4096 -- '\\''/home/acct1/public_html/.htaccess'\\'''"],
  ["fs.catMany", {"paths":["/etc/nginx/conf.d/vhosts/example.tld.conf","/home/acct1/.conf/webservers/it's.conf"],"maxBytesPerFile":1000},
    "LC_ALL=C sh -c 'm=$1; shift; for p do s=-1; if [ -f \"$p\" ] && [ -r \"$p\" ]; then case \"$p\" in /home/*|/var/vmail/*) if [ \"$(realpath -e -- \"$p\")\" = \"$p\" ]; then s=$(stat -c %s -- \"$p\" 2>/dev/null) || s=-1; fi ;; *) s=$(stat -L -c %s -- \"$p\" 2>/dev/null) || s=-1 ;; esac; fi; [ -n \"$s\" ] || s=-1; printf \"@@OBLIMINT-FILE@@ %s %s\\n\" \"$s\" \"$p\"; if [ \"$s\" -ge 0 ]; then n=$s; if [ \"$n\" -gt \"$m\" ]; then n=$m; fi; { head -c \"$n\" -- \"$p\" 2>/dev/null; cat /dev/zero; } | head -c \"$n\"; fi; printf \"\\n\"; done' oblimint 1000 '/etc/nginx/conf.d/vhosts/example.tld.conf' '/home/acct1/.conf/webservers/it'\\''s.conf'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''m=$1; shift; for p do s=-1; if [ -f \"$p\" ] && [ -r \"$p\" ]; then case \"$p\" in /home/*|/var/vmail/*) if [ \"$(realpath -e -- \"$p\")\" = \"$p\" ]; then s=$(stat -c %s -- \"$p\" 2>/dev/null) || s=-1; fi ;; *) s=$(stat -L -c %s -- \"$p\" 2>/dev/null) || s=-1 ;; esac; fi; [ -n \"$s\" ] || s=-1; printf \"@@OBLIMINT-FILE@@ %s %s\\n\" \"$s\" \"$p\"; if [ \"$s\" -ge 0 ]; then n=$s; if [ \"$n\" -gt \"$m\" ]; then n=$m; fi; { head -c \"$n\" -- \"$p\" 2>/dev/null; cat /dev/zero; } | head -c \"$n\"; fi; printf \"\\n\"; done'\\'' oblimint 1000 '\\''/etc/nginx/conf.d/vhosts/example.tld.conf'\\'' '\\''/home/acct1/.conf/webservers/it'\\''\\'\\'''\\''s.conf'\\'''"],
  ["fs.ls", {"path":"/home/acct1"},
    "LC_ALL=C sh -c 'p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"' oblimint '/home/acct1' ls -la --time-style=+%s -- '/home/acct1'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"'\\'' oblimint '\\''/home/acct1'\\'' ls -la --time-style=+%s -- '\\''/home/acct1'\\'''"],
  ["fs.ls", {"path":"/etc/nginx/conf.d"},
    "LC_ALL=C ls -la --time-style=+%s -- '/etc/nginx/conf.d'",
    "sudo -n -- sh -c 'LC_ALL=C ls -la --time-style=+%s -- '\\''/etc/nginx/conf.d'\\'''"],
  ["fs.stat", {"paths":["/var/vmail/example.tld/info","/etc/nginx"]},
    "LC_ALL=C sh -c 'for p do case \"$p\" in /home/*|/var/vmail/*) d=${p%/*}; [ \"$(realpath -e -- \"$d\" 2>/dev/null)\" = \"$d\" ] || continue ;; esac; stat -c \"%n|%F|%s|%u|%g|%a|%Y\" -- \"$p\" 2>/dev/null; done; exit 0' oblimint '/var/vmail/example.tld/info' '/etc/nginx'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''for p do case \"$p\" in /home/*|/var/vmail/*) d=${p%/*}; [ \"$(realpath -e -- \"$d\" 2>/dev/null)\" = \"$d\" ] || continue ;; esac; stat -c \"%n|%F|%s|%u|%g|%a|%Y\" -- \"$p\" 2>/dev/null; done; exit 0'\\'' oblimint '\\''/var/vmail/example.tld/info'\\'' '\\''/etc/nginx'\\'''"],
  ["fs.find", {"path":"/home/acct1","maxDepth":2,"type":"d","name":"*.php"},
    "LC_ALL=C sh -c 'p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"' oblimint '/home/acct1' find -P '/home/acct1' -maxdepth 2 -type d -name '*.php' -printf '%y|%m|%u|%g|%s|%T@|%p|%l\\n'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"'\\'' oblimint '\\''/home/acct1'\\'' find -P '\\''/home/acct1'\\'' -maxdepth 2 -type d -name '\\''*.php'\\'' -printf '\\''%y|%m|%u|%g|%s|%T@|%p|%l\\n'\\'''"],
  ["fs.find", {"path":"/var/named","maxDepth":1},
    "LC_ALL=C find -P '/var/named' -maxdepth 1 -printf '%y|%m|%u|%g|%s|%T@|%p|%l\\n'",
    "sudo -n -- sh -c 'LC_ALL=C find -P '\\''/var/named'\\'' -maxdepth 1 -printf '\\''%y|%m|%u|%g|%s|%T@|%p|%l\\n'\\'''"],
  ["fs.du", {"paths":["/home/acct1","/usr/local/apache/domlogs/example.tld.log"]},
    "LC_ALL=C sh -c 'for p do case \"$p\" in /home/*|/var/vmail/*) d=${p%/*}; [ \"$(realpath -e -- \"$d\" 2>/dev/null)\" = \"$d\" ] || continue ;; esac; du -sb -- \"$p\" 2>/dev/null; done; exit 0' oblimint '/home/acct1' '/usr/local/apache/domlogs/example.tld.log'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''for p do case \"$p\" in /home/*|/var/vmail/*) d=${p%/*}; [ \"$(realpath -e -- \"$d\" 2>/dev/null)\" = \"$d\" ] || continue ;; esac; du -sb -- \"$p\" 2>/dev/null; done; exit 0'\\'' oblimint '\\''/home/acct1'\\'' '\\''/usr/local/apache/domlogs/example.tld.log'\\'''"],
  ["fs.lineCount", {"paths":["/home/acct1/.ssh/authorized_keys"]},
    "LC_ALL=C sh -c 'for p do case \"$p\" in /home/*|/var/vmail/*) if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || continue; fi ;; esac; wc -l -- \"$p\" 2>/dev/null; done; exit 0' oblimint '/home/acct1/.ssh/authorized_keys'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''for p do case \"$p\" in /home/*|/var/vmail/*) if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || continue; fi ;; esac; wc -l -- \"$p\" 2>/dev/null; done; exit 0'\\'' oblimint '\\''/home/acct1/.ssh/authorized_keys'\\'''"],
  ["fs.grepHtaccess", {"root":"/home/acct1/public_html","maxDepth":6},
    "LC_ALL=C sh -c 'p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"' oblimint '/home/acct1/public_html' find -P '/home/acct1/public_html' -maxdepth 6 -name .htaccess -type f -size -1024k -exec grep -HinE '^[[:space:]]*(AddHandler|SetHandler|AddType)[[:space:]].*php' '{}' +",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"'\\'' oblimint '\\''/home/acct1/public_html'\\'' find -P '\\''/home/acct1/public_html'\\'' -maxdepth 6 -name .htaccess -type f -size -1024k -exec grep -HinE '\\''^[[:space:]]*(AddHandler|SetHandler|AddType)[[:space:]].*php'\\'' '\\''{}'\\'' +'"],
  ["fs.grepRefs", {"root":"/home/acct1/public_html","names":["private_html","config.php"],"home":"/home/acct1"},
    "LC_ALL=C sh -c 'p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"' oblimint '/home/acct1/public_html' find -P '/home/acct1/public_html' -maxdepth 6 '(' -name 'vendor' -o -name 'node_modules' -o -name '.git' ')' -prune -o -type f '(' -name '*.php' -o -name '*.inc' -o -name '*.phtml' -o -name '*.ini' -o -name '*.py' -o -name '*.pl' -o -name '*.cgi' -o -name '*.sh' -o -name '.htaccess' -o -name '.user.ini' ')' ! -name 'wp-config.php' ! -name '.env*' -size -1024k -exec grep -HoE -- '/(private_html|config\\.php)([/'\\''\"]|$)|['\\''\"](private_html|config\\.php)/|/home/acct1/' '{}' +",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''p=$1; shift; if [ -e \"$p\" ] || [ -L \"$p\" ]; then [ \"$(realpath -e -- \"$p\")\" = \"$p\" ] || { echo \"oblimint: path crosses a symbolic link\" >&2; exit 86; }; fi; exec \"$@\"'\\'' oblimint '\\''/home/acct1/public_html'\\'' find -P '\\''/home/acct1/public_html'\\'' -maxdepth 6 '\\''('\\'' -name '\\''vendor'\\'' -o -name '\\''node_modules'\\'' -o -name '\\''.git'\\'' '\\'')'\\'' -prune -o -type f '\\''('\\'' -name '\\''*.php'\\'' -o -name '\\''*.inc'\\'' -o -name '\\''*.phtml'\\'' -o -name '\\''*.ini'\\'' -o -name '\\''*.py'\\'' -o -name '\\''*.pl'\\'' -o -name '\\''*.cgi'\\'' -o -name '\\''*.sh'\\'' -o -name '\\''.htaccess'\\'' -o -name '\\''.user.ini'\\'' '\\'')'\\'' ! -name '\\''wp-config.php'\\'' ! -name '\\''.env*'\\'' -size -1024k -exec grep -HoE -- '\\''/(private_html|config\\.php)([/'\\''\\'\\'''\\''\"]|$)|['\\''\\'\\'''\\''\"](private_html|config\\.php)/|/home/acct1/'\\'' '\\''{}'\\'' +'"],
  ["mysql.query", {"sql":"SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'acct1!_%' ESCAPE '!';","header":true},
    "LC_ALL=C mysql --batch -e 'SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE '\\''acct1!_%'\\'' ESCAPE '\\''!'\\'''",
    "sudo -n -- sh -c 'LC_ALL=C mysql --batch -e '\\''SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE '\\''\\'\\'''\\''acct1!_%'\\''\\'\\'''\\'' ESCAPE '\\''\\'\\'''\\''!'\\''\\'\\'''\\'''\\'''"],
  ["mysql.query", {"sql":"SHOW DATABASES"},
    "LC_ALL=C mysql --batch --skip-column-names -e 'SHOW DATABASES'",
    "sudo -n -- sh -c 'LC_ALL=C mysql --batch --skip-column-names -e '\\''SHOW DATABASES'\\'''"],
  ["mysql.userMeta", {},
    "LC_ALL=C mysql --batch -e 'SELECT User, Host, plugin, CASE WHEN Password REGEXP '\\''^[*][0-9A-Fa-f]{40}$'\\'' OR authentication_string REGEXP '\\''^[*][0-9A-Fa-f]{40}$'\\'' THEN '\\''native'\\'' WHEN LENGTH(Password) = 16 THEN '\\''old-password'\\'' WHEN COALESCE(Password, '\\'''\\'') = '\\'''\\'' AND COALESCE(authentication_string, '\\'''\\'') = '\\'''\\'' THEN '\\''none'\\'' ELSE '\\''other'\\'' END AS hash_kind, max_user_connections FROM mysql.user ORDER BY User, Host'",
    "sudo -n -- sh -c 'LC_ALL=C mysql --batch -e '\\''SELECT User, Host, plugin, CASE WHEN Password REGEXP '\\''\\'\\'''\\''^[*][0-9A-Fa-f]{40}$'\\''\\'\\'''\\'' OR authentication_string REGEXP '\\''\\'\\'''\\''^[*][0-9A-Fa-f]{40}$'\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\''native'\\''\\'\\'''\\'' WHEN LENGTH(Password) = 16 THEN '\\''\\'\\'''\\''old-password'\\''\\'\\'''\\'' WHEN COALESCE(Password, '\\''\\'\\'''\\'''\\''\\'\\'''\\'') = '\\''\\'\\'''\\'''\\''\\'\\'''\\'' AND COALESCE(authentication_string, '\\''\\'\\'''\\'''\\''\\'\\'''\\'') = '\\''\\'\\'''\\'''\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\''none'\\''\\'\\'''\\'' ELSE '\\''\\'\\'''\\''other'\\''\\'\\'''\\'' END AS hash_kind, max_user_connections FROM mysql.user ORDER BY User, Host'\\'''"],
  ["mysql.dumpSchema", {"database":"acct1_wp"},
    "LC_ALL=C mysqldump --no-data --skip-lock-tables --single-transaction --skip-dump-date --routines --triggers --events -- 'acct1_wp'",
    "sudo -n -- sh -c 'LC_ALL=C mysqldump --no-data --skip-lock-tables --single-transaction --skip-dump-date --routines --triggers --events -- '\\''acct1_wp'\\'''"],
  ["mail.mailboxMeta", {},
    "LC_ALL=C mysql --batch -e 'SELECT username, local_part, domain, maildir, quota, uid, gid, active, name, CASE WHEN COALESCE(password, '\\'''\\'') = '\\'''\\'' THEN '\\'''\\'' WHEN password REGEXP '\\''^[{](SHA512-CRYPT|SHA256-CRYPT|MD5-CRYPT|BLF-CRYPT|SSHA512|SSHA256|SSHA)[}]'\\'' THEN UPPER(SUBSTRING_INDEX(SUBSTRING(password, 2), '\\''}'\\'', 1)) WHEN password LIKE '\\''$6$%'\\'' THEN '\\''SHA512-CRYPT*'\\'' WHEN password LIKE '\\''$5$%'\\'' THEN '\\''SHA256-CRYPT*'\\'' WHEN password LIKE '\\''$1$%'\\'' THEN '\\''MD5-CRYPT*'\\'' WHEN password REGEXP '\\''^[$]2[abxy]?[$]'\\'' THEN '\\''BLF-CRYPT*'\\'' ELSE '\\''other'\\'' END AS scheme FROM postfix.mailbox ORDER BY username'",
    "sudo -n -- sh -c 'LC_ALL=C mysql --batch -e '\\''SELECT username, local_part, domain, maildir, quota, uid, gid, active, name, CASE WHEN COALESCE(password, '\\''\\'\\'''\\'''\\''\\'\\'''\\'') = '\\''\\'\\'''\\'''\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\'''\\''\\'\\'''\\'' WHEN password REGEXP '\\''\\'\\'''\\''^[{](SHA512-CRYPT|SHA256-CRYPT|MD5-CRYPT|BLF-CRYPT|SSHA512|SSHA256|SSHA)[}]'\\''\\'\\'''\\'' THEN UPPER(SUBSTRING_INDEX(SUBSTRING(password, 2), '\\''\\'\\'''\\''}'\\''\\'\\'''\\'', 1)) WHEN password LIKE '\\''\\'\\'''\\''$6$%'\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\''SHA512-CRYPT*'\\''\\'\\'''\\'' WHEN password LIKE '\\''\\'\\'''\\''$5$%'\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\''SHA256-CRYPT*'\\''\\'\\'''\\'' WHEN password LIKE '\\''\\'\\'''\\''$1$%'\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\''MD5-CRYPT*'\\''\\'\\'''\\'' WHEN password REGEXP '\\''\\'\\'''\\''^[$]2[abxy]?[$]'\\''\\'\\'''\\'' THEN '\\''\\'\\'''\\''BLF-CRYPT*'\\''\\'\\'''\\'' ELSE '\\''\\'\\'''\\''other'\\''\\'\\'''\\'' END AS scheme FROM postfix.mailbox ORDER BY username'\\'''"],
  ["mail.postconf", {},
    "LC_ALL=C postconf -n",
    "sudo -n -- sh -c 'LC_ALL=C postconf -n'"],
  ["mail.doveconf", {},
    "LC_ALL=C doveconf -n",
    "sudo -n -- sh -c 'LC_ALL=C doveconf -n'"],
  ["dns.namedConf", {},
    "LC_ALL=C sed -E 's/(secret[[:space:]]+)\"[^\"]*\"/\\1\"<redacted>\"/g' /etc/named.conf",
    "sudo -n -- sh -c 'LC_ALL=C sed -E '\\''s/(secret[[:space:]]+)\"[^\"]*\"/\\1\"<redacted>\"/g'\\'' /etc/named.conf'"],
  ["dns.zoneDump", {"zone":"example.tld","file":"/var/named/example.tld.db"},
    "LC_ALL=C named-checkzone -j -D -o - 'example.tld' '/var/named/example.tld.db'",
    "sudo -n -- sh -c 'LC_ALL=C named-checkzone -j -D -o - '\\''example.tld'\\'' '\\''/var/named/example.tld.db'\\'''"],
  ["dns.axfr", {"zone":"example.tld"},
    "LC_ALL=C dig +noall +answer AXFR 'example.tld' @127.0.0.1",
    "sudo -n -- sh -c 'LC_ALL=C dig +noall +answer AXFR '\\''example.tld'\\'' @127.0.0.1'"],
  ["ftp.listUsers", {},
    "LC_ALL=C awk -F: 'NF >= 6 { h = $2; s = \"other\"; if (h ~ /^\\$2a\\$/) s = \"2a\"; else if (h ~ /^\\$2b\\$/) s = \"2b\"; else if (h ~ /^\\$2y\\$/) s = \"2y\"; else if (h ~ /^\\$6\\$/) s = \"6\"; else if (h ~ /^\\$5\\$/) s = \"5\"; else if (h ~ /^\\$1\\$/) s = \"1\"; print $1 \":\" $3 \":\" $4 \":\" $6 \":\" s }' /etc/pure-ftpd/pureftpd.passwd",
    "sudo -n -- sh -c 'LC_ALL=C awk -F: '\\''NF >= 6 { h = $2; s = \"other\"; if (h ~ /^\\$2a\\$/) s = \"2a\"; else if (h ~ /^\\$2b\\$/) s = \"2b\"; else if (h ~ /^\\$2y\\$/) s = \"2y\"; else if (h ~ /^\\$6\\$/) s = \"6\"; else if (h ~ /^\\$5\\$/) s = \"5\"; else if (h ~ /^\\$1\\$/) s = \"1\"; print $1 \":\" $3 \":\" $4 \":\" $6 \":\" s }'\\'' /etc/pure-ftpd/pureftpd.passwd'"],
  ["mysql.dumpData", {"database":"acct1_wp","charset":"utf8mb4","gzip":true},
    "LC_ALL=C sh -c 'set -o pipefail; \"$@\" | gzip -1c' oblimint mysqldump --single-transaction --skip-lock-tables --quick --routines --triggers --events --hex-blob --default-character-set=utf8mb4 --skip-dump-date -- 'acct1_wp'",
    "sudo -n -- sh -c 'LC_ALL=C sh -c '\\''set -o pipefail; \"$@\" | gzip -1c'\\'' oblimint mysqldump --single-transaction --skip-lock-tables --quick --routines --triggers --events --hex-blob --default-character-set=utf8mb4 --skip-dump-date -- '\\''acct1_wp'\\'''"],
  ["mysql.dumpData", {"database":"acct1_wp","charset":"latin1","gzip":false},
    "LC_ALL=C mysqldump --single-transaction --skip-lock-tables --quick --routines --triggers --events --hex-blob --default-character-set=latin1 --skip-dump-date -- 'acct1_wp'",
    "sudo -n -- sh -c 'LC_ALL=C mysqldump --single-transaction --skip-lock-tables --quick --routines --triggers --events --hex-blob --default-character-set=latin1 --skip-dump-date -- '\\''acct1_wp'\\'''"],
  ["secret.mailboxHashes", {"domain":"example.tld"},
    "LC_ALL=C mysql --batch -e 'SELECT username, password FROM postfix.mailbox WHERE domain = '\\''example.tld'\\'' ORDER BY username'",
    "sudo -n -- sh -c 'LC_ALL=C mysql --batch -e '\\''SELECT username, password FROM postfix.mailbox WHERE domain = '\\''\\'\\'''\\''example.tld'\\''\\'\\'''\\'' ORDER BY username'\\'''"],
  ["secret.mysqlUserHashes", {"users":["acct1_wp","acct1_ro"]},
    "LC_ALL=C mysql --batch -e 'SELECT User, Host, plugin, Password, authentication_string FROM mysql.user WHERE User IN ('\\''acct1_wp'\\'', '\\''acct1_ro'\\'') ORDER BY User, Host'",
    "sudo -n -- sh -c 'LC_ALL=C mysql --batch -e '\\''SELECT User, Host, plugin, Password, authentication_string FROM mysql.user WHERE User IN ('\\''\\'\\'''\\''acct1_wp'\\''\\'\\'''\\'', '\\''\\'\\'''\\''acct1_ro'\\''\\'\\'''\\'') ORDER BY User, Host'\\'''"],
  ["secret.dkimPrivateKey", {"domain":"example.tld","selector":"default"},
    "LC_ALL=C cat -- '/etc/opendkim/userkeys/example.tld/default.private'",
    "sudo -n -- sh -c 'LC_ALL=C cat -- '\\''/etc/opendkim/userkeys/example.tld/default.private'\\'''"],
  ["secret.certificateKey", {"fqdn":"www.example.tld"},
    "LC_ALL=C cat -- '/etc/pki/tls/private/www.example.tld.key'",
    "sudo -n -- sh -c 'LC_ALL=C cat -- '\\''/etc/pki/tls/private/www.example.tld.key'\\'''"],
  ["secret.ftpUserHash", {"login":"ftp@example.tld"},
    "LC_ALL=C awk -F: -v u='ftp@example.tld' '$1 == u { print $2; exit }' /etc/pure-ftpd/pureftpd.passwd",
    "sudo -n -- sh -c 'LC_ALL=C awk -F: -v u='\\''ftp@example.tld'\\'' '\\''$1 == u { print $2; exit }'\\'' /etc/pure-ftpd/pureftpd.passwd'"],
];

test('rendering snapshot of every template (plain and sudo)', () => {
  const covered = new Set<string>();
  for (const [t, args, plain, sudo] of SNAPSHOTS) {
    const r = renderCommand(t, args, 'transfer', false);
    assert.ok(r.ok, `${t} refused: ${!r.ok ? r.reason : ''}`);
    assert.equal(r.command, plain, t);
    const s = renderCommand(t, args, 'transfer', true);
    assert.ok(s.ok);
    assert.equal(s.command, sudo, `${t} (sudo)`);
    assert.equal(s.command, `sudo -n -- sh -c ${shQuote(plain)}`);
    assert.ok(plain.startsWith('LC_ALL=C '), `${t} must start with LC_ALL=C`);
    covered.add(t);
  }
  const publicIds = [...TEMPLATE_REGISTRY.values()].filter((s) => !s.internal).map((s) => s.id);
  for (const id of publicIds) assert.ok(covered.has(id), `no snapshot for ${id}`);
});

test('P6 / MG1: no template invokes a package manager or reads its database (rpm, dnf, yum, /var/lib/rpm)', () => {
  const pm = /\b(?:rpm|dnf|yum|rpmdb|repoquery)\b|\/var\/lib\/rpm/i;
  assert.ok(!TEMPLATE_REGISTRY.has('sys.rpmVersions' as never), 'the rpm template is gone');
  for (const [t, , plain, sudo] of SNAPSHOTS) {
    assert.doesNotMatch(plain, pm, t);
    assert.doesNotMatch(sudo, pm, `${t} (sudo)`);
  }
  for (const s of [GUARD_SCRIPT, CAT_MANY_SCRIPT, DU_SCRIPT, LINE_COUNT_SCRIPT, STAT_SCRIPT, TOOL_VERSIONS_SCRIPT]) assert.doesNotMatch(s, pm);
  // The tool list is closed and constant; the rendering takes no argument at all.
  assert.deepEqual([...VERSION_TOOLS], ['rsync', 'mysqldump', 'mysql', 'named-checkzone', 'postconf', 'doveconf']);
  const r = renderCommand('sys.toolVersions', {}, 'discovery', false);
  assert.ok(r.ok);
  assert.ok(r.ok && r.command.startsWith("LC_ALL=C sh -c 'PATH="));
  assert.ok(!TOOL_VERSIONS_SCRIPT.includes("'"));
});

test('internal templates render only for the executor itself', () => {
  assert.deepEqual(renderCommand('fs.realpath', { path: '/home/acct1/public_html' }, 'transfer', false, true),
    { ok: true, spec: TEMPLATE_REGISTRY.get('fs.realpath'), command: "LC_ALL=C realpath -e -- '/home/acct1/public_html'" });
  // /home pull: MG10 guard + exec in ONE shell, sender run as the CWP account (a swap after the check exposes
  // only what that user may read; review finding "rsync sender runs as root").
  const r = renderCommand('rsync.sender', { options: ['-ltre.iLsfxCIvu', '--bwlimit=500'], path: '/home/acct1/public_html/', runAs: 'acct1' }, 'transfer', false, true);
  assert.ok(r.ok);
  assert.equal(r.command, `LC_ALL=C sh -c '${GUARD_SCRIPT}' oblimint '/home/acct1/public_html' runuser -u 'acct1' -- rsync --server --sender '-ltre.iLsfxCIvu' '--bwlimit=500' . '/home/acct1/public_html/'`);
  // maildir: root (vmail tree), still behind the guard in the same shell.
  const m = renderCommand('rsync.sender', { options: ['-ltre.iLsfxC'], path: '/var/vmail/example.tld/info/', runAs: null }, 'transfer', false, true);
  assert.ok(m.ok);
  assert.equal(m.command, `LC_ALL=C sh -c '${GUARD_SCRIPT}' oblimint '/var/vmail/example.tld/info' rsync --server --sender '-ltre.iLsfxC' . '/var/vmail/example.tld/info/'`);
  // /home without a user, another user's home, root: refused.
  assert.equal(renderCommand('rsync.sender', { options: ['-ltre.'], path: '/home/acct1/x/' }, 'transfer', false, true).ok, false);
  assert.equal(renderCommand('rsync.sender', { options: ['-ltre.'], path: '/home/acct2/x/', runAs: 'acct1' }, 'transfer', false, true).ok, false);
  assert.equal(renderCommand('rsync.sender', { options: ['-ltre.'], path: '/home/root/x/', runAs: 'root' }, 'transfer', false, true).ok, false);
  assert.equal(renderCommand('rsync.sender', { options: ['-ltre.'], path: '/home/a/x/', runAs: "a' ; id" }, 'transfer', false, true).ok, false);
  for (const id of ['fs.realpath', 'rsync.sender']) {
    const x = renderCommand(id, { path: '/home/a/b', options: [] }, 'transfer', false);
    assert.equal(x.ok, false);
    assert.equal(!x.ok && x.reason, 'internal template');
  }
  assert.equal(renderCommand('rsync.sender', { options: ['-e', 'sh'], path: '/home/a/b/' }, 'transfer', false, true).ok, false);
  assert.equal(renderCommand('rsync.sender', { options: [], path: '/home/a/b' }, 'transfer', false, true).ok, false);
});

test('allow-list: public templates only, secret.* sensitive, transfer-only phases', () => {
  const infos = templateInfos();
  assert.ok(!infos.some((i) => i.id === 'rsync.sender' || i.id === 'fs.realpath'));
  for (const i of infos) {
    assert.equal(i.sensitive, i.id.startsWith('secret.'), i.id);
    assert.equal(i.description, i.id);
    const transferOnly = i.id.startsWith('secret.') || i.id === 'mysql.dumpData';
    assert.deepEqual(i.phases, transferOnly ? ['transfer'] : ['discovery', 'transfer'], i.id);
  }
  // contracts/source.ts CommandTemplateArgs, in order.
  assert.deepEqual(infos.map((i) => i.id), [
    'sys.osRelease', 'sys.hostname', 'sys.ipAddrs', 'sys.whoami', 'sys.passwd', 'sys.toolVersions', 'sys.unitFile',
    'fs.cat', 'fs.catMany', 'fs.ls', 'fs.stat', 'fs.find', 'fs.du', 'fs.lineCount', 'fs.grepHtaccess', 'fs.grepRefs',
    'mysql.query', 'mysql.userMeta', 'mysql.dumpSchema', 'mail.mailboxMeta', 'mail.postconf', 'mail.doveconf',
    'dns.namedConf', 'dns.zoneDump', 'dns.axfr', 'ftp.listUsers',
    'mysql.dumpData', 'secret.mailboxHashes', 'secret.mysqlUserHashes', 'secret.dkimPrivateKey', 'secret.certificateKey', 'secret.ftpUserHash',
  ]);
});

const refused = (t: string, args: unknown, phase: 'discovery' | 'transfer' = 'transfer') => {
  const r = renderCommand(t, args, phase, false);
  assert.equal(r.ok, false, `${t} ${JSON.stringify(args)} should be refused`);
  return r.ok ? '' : r.reason;
};

test('refusals: unknown template, phase rule', () => {
  assert.equal(refused('sys.exec', {}), 'unknown template');
  assert.equal(refused('', {}), 'unknown template');
  assert.equal(refused('__proto__', {}), 'unknown template');
  for (const t of ['mysql.dumpData', 'secret.mailboxHashes', 'secret.mysqlUserHashes', 'secret.dkimPrivateKey', 'secret.certificateKey', 'secret.ftpUserHash']) {
    assert.match(refused(t, {}, 'discovery'), /transfer-only/);
  }
  // Extra / unknown arguments.
  assert.match(refused('sys.whoami', { x: 1 }), /no argument/);
  assert.match(refused('fs.cat', { path: '/etc/nginx/nginx.conf', cmd: 'rm -rf /' }), /unknown argument/);
  assert.match(refused('fs.cat', 'cat /etc/shadow'), /object/);
});

test('refusals: path syntax', () => {
  const bad = [
    'etc/nginx/nginx.conf', '/etc/nginx/../shadow', '/etc/nginx/./nginx.conf', '/etc//nginx/nginx.conf', '/etc/nginx/',
    '/etc/nginx/nginx.conf\0', '/etc/nginx/nginx\n.conf', '/etc/nginx/nginx\r.conf', '/etc/nginx/\x1b.conf',
    '/etc/nginx/*.conf', '/etc/nginx/ngin?.conf', '/etc/nginx/[a].conf', '/etc/nginx/a\\b', `/etc/nginx/${'a'.repeat(1100)}`, '', '/',
  ];
  for (const p of bad) refused('fs.cat', { path: p });
  for (const p of bad) refused('fs.ls', { path: p });
  refused('fs.catMany', { paths: ['/etc/nginx/nginx.conf', '/etc/nginx/../x'] });
  refused('fs.catMany', { paths: [] });
  refused('fs.catMany', { paths: Array.from({ length: 201 }, (_, i) => `/etc/nginx/${i}.conf`) });
  refused('fs.stat', { paths: '/etc/nginx' });
});

test('refusals: outside the read roots / access not allowed by the root', () => {
  for (const p of ['/etc/passwd', '/etc/named.conf', '/var/log/messages', '/usr/local/cwpsrv/htdocs/index.php', '/tmp/x', '/proc/self/environ']) {
    assert.match(refused('fs.cat', { path: p }), /outside the read roots/, p);
  }
  assert.match(refused('fs.cat', { path: '/etc/systemd/system/app.service' }), /not allowed/);
  assert.match(refused('fs.cat', { path: '/usr/local/apache/domlogs/example.tld.log' }), /not allowed/);
  assert.match(refused('fs.ls', { path: '/usr/local/apache/domlogs' }), /not allowed/);
  assert.match(refused('fs.cat', { path: '/var/vmail/example.tld/info/cur/1.eml' }), /not allowed/);
  assert.match(refused('fs.grepHtaccess', { root: '/etc/nginx', maxDepth: 2 }), /not allowed|limited/);
  assert.match(refused('fs.du', { paths: ['/etc/shadow'] }), /outside/);
  assert.equal(renderCommand('fs.du', { paths: ['/usr/local/apache/domlogs'] }, 'discovery', false).ok, true);
  assert.equal(renderCommand('fs.find', { path: '/var/vmail/example.tld', maxDepth: 3 }, 'discovery', false).ok, true);
  assert.equal(renderCommand('fs.cat', { path: '/usr/local/cwpsrv/htdocs/resources/admin/include/version.php' }, 'discovery', false).ok, true);
});

test('refusals: every deny-list entry', () => {
  const denied = [
    '/etc/opendkim/keys/example.tld/default.private', '/etc/opendkim/userkeys/example.tld/default.private',
    '/etc/pure-ftpd/pureftpd.passwd', '/etc/pure-ftpd/pureftpd.pdb',
    '/home/acct1/.my.cnf', '/home/acct1/public_html/wp-config.php', '/home/acct1/public_html/.env',
    '/home/acct1/public_html/.env.local', '/home/acct1/.ssh/authorized_keys', '/home/acct1/.ssh/id_rsa',
    '/usr/local/cwp/.conf/mysql_manager/default_settings.json', '/usr/local/cwp/.conf/api_key.conf',
    '/usr/local/cwp/.conf/root_pass.conf', '/usr/local/cwp/.conf/secret.ini', '/usr/local/cwp/.conf/telegram_token',
    '/usr/local/cwp/.conf/Keys/x.json', '/etc/nginx/.my.cnf', '/opt/alt/php74/wp-config.php', '/etc/nginx/ssl/site.private',
  ];
  for (const p of denied) assert.match(refused('fs.cat', { path: p }), /denied/, p);
  for (const p of denied) refused('fs.catMany', { paths: [p] });
  // Outside the roots anyway, still never readable.
  for (const p of ['/etc/shadow', '/etc/gshadow', '/root/.my.cnf', '/etc/named/keys/rndc.key', '/etc/pki/tls/private/x.key']) {
    refused('fs.cat', { path: p });
    refused('fs.ls', { path: p });
  }
  // .ssh: line count only.
  assert.equal(renderCommand('fs.lineCount', { paths: ['/home/acct1/.ssh/authorized_keys'] }, 'discovery', false).ok, true);
  refused('fs.lineCount', { paths: ['/home/acct1/public_html/wp-config.php'] });
});

test('/home content allow-list', () => {
  const ok = [
    '/home/acct1/.conf/webservers/example.tld.conf', '/home/acct1/.conf/.addons_wp', '/home/acct1/public_html/.htaccess',
    '/home/acct1/public_html/php.ini', '/home/acct1/public_html/.user.ini', '/home/acct1/app/package.json',
    '/home/acct1/app/composer.json', '/home/acct1/py/requirements.txt', '/home/acct1/cron',
  ];
  for (const p of ok) assert.equal(renderCommand('fs.cat', { path: p }, 'discovery', false).ok, true, p);
  for (const p of ['/home/acct1/public_html/index.php', '/home/acct1/.bash_history', '/home/acct1/.conf/cwp.ini', '/home/acct1/.conf/webservers/x.json']) {
    assert.match(refused('fs.cat', { path: p }), /allow-list/, p);
  }
});

test('refusals: find name / depth / type, identifiers', () => {
  const base = { path: '/home/acct1', maxDepth: 2 };
  for (const name of ['a b', "a'b", 'a;b', '$(id)', 'a/b', '-delete', '', 'x'.repeat(65), '[ab]']) refused('fs.find', { ...base, name });
  for (const maxDepth of [0, 7, 1.5, -1, '2', null]) refused('fs.find', { path: '/home/acct1', maxDepth });
  refused('fs.find', { ...base, type: 'p' });
  refused('fs.grepHtaccess', { root: '/home/acct1/public_html', maxDepth: 9 });
  const badIds = ["a'b", 'a b', 'a;b', '$(id)', '`id`', 'a\nb', '', '-x', 'x'.repeat(65)];
  for (const v of badIds) refused('mysql.dumpSchema', { database: v });
  for (const v of badIds) refused('mysql.dumpData', { database: v, charset: 'utf8mb4', gzip: false });
  refused('mysql.dumpData', { database: 'db', charset: 'utf8; rm -rf /', gzip: false });
  refused('mysql.dumpData', { database: 'db', charset: 'utf8mb4', gzip: 'yes' });
  for (const v of [...badIds.filter((x) => x.length < 65), 'x'.repeat(81)]) refused('secret.mysqlUserHashes', { users: [v] });
  refused('secret.mysqlUserHashes', { users: Array.from({ length: 201 }, (_, i) => `u${i}`) });
  refused('secret.mysqlUserHashes', { users: [] });
  for (const d of ['Example.tld', 'example..tld', '.example.tld', 'example.tld.', '-a.tld', 'a-.tld', "a'.tld", 'a b.tld', 'a;b', '$(id).tld', '*.example.tld', 'x'.repeat(254)]) {
    refused('secret.mailboxHashes', { domain: d });
    refused('secret.certificateKey', { fqdn: d });
    refused('dns.axfr', { zone: d });
  }
  for (const s of ['a/b', '../x', '.hidden', 'a b', "a'b", '', 'x'.repeat(64)]) refused('secret.dkimPrivateKey', { domain: 'example.tld', selector: s });
  for (const l of ['a b', "a'b", 'a;b', '$(id)', 'a:b', '', '-v', 'x'.repeat(129)]) refused('secret.ftpUserHash', { login: l });
  // P6: the rpm template is gone; the tool list is constant (no caller value at all).
  assert.equal(refused('sys.rpmVersions', { packages: ['rsync'] }), 'unknown template');
  assert.match(refused('sys.toolVersions', { packages: ['rsync'] }), /no argument/);
  assert.match(refused('sys.toolVersions', { tools: ['sh'] }), /no argument/);
  refused('sys.unitFile', { path: '/etc/systemd/system/../shadow' });
  refused('sys.unitFile', { path: '/etc/systemd/system/app.conf' });
  refused('sys.unitFile', { path: '/usr/lib/systemd/system/sshd.service' });
  refused('dns.zoneDump', { zone: 'example.tld', file: '/etc/named.conf' });
  refused('dns.zoneDump', { zone: 'example.tld', file: '/var/named/../../etc/shadow' });
  refused('dns.zoneDump', { zone: 'example.tld', file: '/var/named/Kexample.tld.+008+12345.private' });
  refused('fs.cat', { path: '/etc/nginx/nginx.conf', maxBytes: 0 });
  refused('fs.catMany', { paths: ['/etc/nginx/nginx.conf'], maxBytesPerFile: 9 * 1024 * 1024 });
});

test('SQL guard: refusals', () => {
  const bad = [
    "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "REPLACE INTO t VALUES (1)", "DROP TABLE t",
    "ALTER TABLE t ADD c INT", "CREATE TABLE t (a INT)", "GRANT ALL ON *.* TO x", "REVOKE ALL ON *.* FROM x", "SET @a = 1",
    "SET GLOBAL general_log = 1", "CALL p()", "HANDLER t OPEN", "LOAD DATA INFILE '/etc/passwd' INTO TABLE t", "TRUNCATE t",
    "SELECT 1 INTO OUTFILE '/tmp/x'", "SELECT 1 INTO DUMPFILE '/tmp/x'", "SELECT 1 INTO @v", "SELECT LOAD_FILE('/etc/shadow')",
    "SELECT SLEEP(10)", "SELECT BENCHMARK(1000000, MD5(1))", "SELECT GET_LOCK('x', 1)", "SELECT RELEASE_LOCK('x')",
    "SELECT a FROM t FOR UPDATE", "SELECT a FROM t LOCK IN SHARE MODE", "SELECT 1 -- comment", "SELECT 1 #comment",
    "SELECT 1 /* c */", "SELECT /*!50000 1 */", "SELECT 1; SELECT 2", "SELECT 1; DROP TABLE t", "SELECT @a := 1",
    "SELECT a FROM t PROCEDURE ANALYSE()", "SELECT Password FROM mysql.user", "SELECT `Password` FROM mysql.user",
    "SELECT u.authentication_string FROM mysql.user u", "SELECT `authentication_string` FROM mysql.user",
    "SELECT token FROM postfix.mailbox", "SELECT `token` FROM postfix.mailbox", "SELECT password FROM postfix.mailbox",
    "SELECT src_password FROM postfix.fetchmail", "SELECT * FROM mysql.user", "SELECT u.* FROM mysql.user u",
    "SELECT DISTINCT * FROM postfix.mailbox", "SELECT Priv FROM mysql.global_priv", "SHOW GRANTS FOR root@localhost",
    "SHOW CREATE USER root", "SELECT \"Password\" FROM mysql.user", "SELECT NEXTVAL(s)", "SELECT NEXT VALUE FOR s",
    "", "   ", ";", "SELECT 'unterminated", "WITH x AS (SELECT 1) SELECT * FROM x", "(SELECT 1)", "EXPLAIN SELECT 1",
    "SELECT 1\0", `SELECT '${'a'.repeat(17000)}'`,
  ];
  for (const sql of bad) {
    assert.throws(() => checkSql(sql), SqlGuardError, sql.slice(0, 80));
    const r = renderCommand('mysql.query', { sql }, 'discovery', false);
    assert.equal(r.ok, false, sql.slice(0, 80));
    assert.match(!r.ok ? r.reason : '', /^sql: /);
  }
});

test('SQL guard: accepted statements (secret words inside literals are fine)', () => {
  const ok = [
    "SELECT User, Host FROM mysql.user",
    "SELECT username FROM postfix.mailbox WHERE local_part = 'password'",
    "SELECT 'token', 'authentication_string', 'Password' AS label",
    "SELECT COUNT(*) FROM root_cwp.user",
    "SELECT db, user FROM mysql.db WHERE db LIKE 'acct1!_%' ESCAPE '!';",
    "SHOW DATABASES",
    "SHOW CREATE TABLE root_cwp.user",
    "SELECT `user`, `domain` FROM root_cwp.`user` ORDER BY id",
    "SELECT @@version",
    "SELECT a FROM t WHERE b = 'x;y'",
    "SELECT a FROM t WHERE b = 'it''s' AND c = \"say \"\"hi\"\"\"",
    "SHOW TABLE STATUS FROM `acct1_wp`",
    "SELECT a\n  FROM t\r\n\tWHERE b = 'x'",
  ];
  for (const sql of ok) assert.doesNotThrow(() => checkSql(sql), sql);
  assert.equal(checkSql('SELECT 1 ;  '), 'SELECT 1');
  // Rendered on ONE line: the mysql client only recognises named commands at the start of a line.
  assert.equal(checkSql("SELECT a\n  FROM t\r\n\tWHERE b = 'x';\n"), "SELECT a   FROM t   WHERE b = 'x'");
});

test('SQL guard: mysql client commands (backslash / newline) are refused (MG1)', () => {
  const B = '\\';
  const bad = [
    `SELECT 1 ${B}! touch /tmp/pwned`, // com_shell
    `SELECT 1 ${B}T /etc/cron.d/x`, // tee: writes a file
    `SELECT 1 ${B}. /etc/shadow`, // source
    `SELECT 1 ${B}g DROP DATABASE foo`, // send + continue: second statement
    `SELECT 1\n${B}g\nsystem id`, // named command at the start of a line
    `SELECT 1 ${B}G`, `SELECT ${B}N`, `SELECT 1 ${B}c`,
    // NO_BACKSLASH_ESCAPES: the client would close the string at the quote → refused even inside a literal.
    `SELECT 'a${B}' ${B}! id '`, `SELECT 'a${B}_b'`, `SELECT \`a${B}b\``,
    // Control characters: never inside a literal, never anywhere else.
    "SELECT 'a\nb'", "SELECT 'a\rb'", "SELECT 'a\tb'", "SELECT `a\nb`", "SELECT 1\u0001", "SELECT 1\u001b", "SELECT 1\u007f",
  ];
  for (const sql of bad) {
    assert.throws(() => checkSql(sql), SqlGuardError, JSON.stringify(sql));
    const r = renderCommand('mysql.query', { sql }, 'discovery', false);
    assert.equal(r.ok, false, JSON.stringify(sql));
  }
});

test('dumps never touch the system / CWP schemas (hashes only via secret.*)', () => {
  const system = ['mysql', 'information_schema', 'performance_schema', 'sys', 'postfix', 'postfix_policyd', 'root_cwp', 'roundcube', 'oauthv2', 'root_cpmigrations', 'MySQL', 'ROOT_CWP'];
  for (const database of system) {
    for (const [t, args] of [
      ['mysql.dumpSchema', { database }], ['mysql.dumpData', { database, charset: 'utf8mb4', gzip: true }],
    ] as const) {
      const r = renderCommand(t, args, 'transfer', false);
      assert.equal(r.ok, false, `${t} ${database}`);
      assert.match(!r.ok ? r.reason : '', /system schema/);
    }
  }
  assert.ok(renderCommand('mysql.dumpData', { database: 'acct1_mysql', charset: 'utf8mb4', gzip: false }, 'transfer', false).ok);
});

// ── the constant scripts on a real POSIX shell (Git Bash on Windows, sh on Linux) ──

function findSh(): string | null {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']
    : ['/bin/sh'];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

test('fs.catMany script: real framing parsed back (binary-safe, missing, max bytes)', (t) => {
  const sh = findSh();
  if (!sh) { t.skip('no POSIX sh on this machine'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-catmany-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.conf').replace(/\\/g, '/');
  const b = path.join(dir, 'b.bin').replace(/\\/g, '/');
  const big = path.join(dir, 'big.txt').replace(/\\/g, '/');
  fs.writeFileSync(a, 'server {\n  listen 80;\n}\n');
  fs.writeFileSync(b, Buffer.from([0, 1, 2, 10, 255, 10, 64]));
  fs.writeFileSync(big, 'x'.repeat(50));
  const r = spawnSync(sh, ['-c', CAT_MANY_SCRIPT, 'oblimint', '20', a, `${dir.replace(/\\/g, '/')}/missing`, b, big, dir.replace(/\\/g, '/')]);
  if (r.status !== 0 && /stat|realpath/.test(String(r.stderr))) { t.skip('coreutils missing'); return; }
  assert.equal(r.status, 0, String(r.stderr));
  const frames = parseCatManyFrames(r.stdout as Buffer, 5, 20);
  assert.equal(frames[0]?.toString(), 'server {\n  listen 80');
  assert.equal(frames[1], null);
  assert.deepEqual([...frames[2]!], [0, 1, 2, 10, 255, 10, 64]);
  assert.equal(frames[3]?.toString(), 'x'.repeat(20));
  assert.equal(frames[4], null, 'a directory is not a regular file');
});

test('MG10 guard + line count scripts on a real shell (symlink → refused / skipped)', (t) => {
  const sh = findSh();
  if (!sh || process.platform === 'win32') { t.skip('needs a POSIX sh with symlinks (Linux / the Linux test host)'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-guard-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const secret = path.join(dir, 'secret');
  fs.writeFileSync(secret, 'TOP-SECRET\n');
  const link = path.join(dir, 'link');
  fs.symlinkSync(secret, link);
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(plain, 'ok\n');
  const viaLink = spawnSync(sh, ['-c', GUARD_SCRIPT, 'oblimint', link, 'cat', '--', link]);
  assert.equal(viaLink.status, SYMLINK_EXIT);
  assert.ok(!String(viaLink.stdout).includes('TOP-SECRET'));
  const direct = spawnSync(sh, ['-c', GUARD_SCRIPT, 'oblimint', plain, 'cat', '--', plain]);
  assert.equal(direct.status, 0);
  assert.equal(String(direct.stdout), 'ok\n');
  const missing = spawnSync(sh, ['-c', GUARD_SCRIPT, 'oblimint', `${dir}/nope`, 'cat', '--', `${dir}/nope`]);
  assert.notEqual(missing.status, SYMLINK_EXIT);
  // The scripts only guard /home and /var/vmail: emulate with a path list the case statement ignores.
  const wc = spawnSync(sh, ['-c', LINE_COUNT_SCRIPT, 'oblimint', plain, `${dir}/nope`]);
  assert.equal(wc.status, 0);
  assert.match(String(wc.stdout), /^1 /);
});

/** Symlink in a temp dir, or null when this machine cannot create one (Windows without the privilege). */
function trySymlink(target: string, link: string, type: 'file' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return fs.lstatSync(link).isSymbolicLink();
  } catch {
    return false;
  }
}

test('fs.catMany script: a symlinked config outside /home is read whole (stat -L, not the link size)', (t) => {
  const sh = findSh();
  if (!sh) { t.skip('no POSIX sh on this machine'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-catlink-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = path.join(dir, 'a-rather-long-real-vhost-file-name.conf');
  const content = `server {\n  listen 80;\n  server_name example.tld;\n${'  # padding\n'.repeat(20)}}\n`;
  fs.writeFileSync(real, content);
  const link = path.join(dir, 'l.conf');
  if (!trySymlink(real, link, 'file')) { t.skip('cannot create a symlink here'); return; }
  const p = link.replace(/\\/g, '/');
  const r = spawnSync(sh, ['-c', CAT_MANY_SCRIPT, 'oblimint', '100000', p], { env: { ...process.env, MSYS: 'winsymlinks:nativestrict' } });
  if (r.status !== 0 && /stat|realpath/.test(String(r.stderr))) { t.skip('coreutils missing'); return; }
  const frames = parseCatManyFrames(r.stdout as Buffer, 1, 100000);
  assert.equal(frames[0]?.toString(), content);
});

test('fs.stat / fs.du scripts: a path whose PARENT crosses a symlink is skipped (MG10, emulated root)', (t) => {
  const sh = findSh();
  if (!sh || process.platform === 'win32') { t.skip('needs a POSIX sh with symlinks (Linux / the Linux test host)'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-statguard-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'x'), 'secret');
  const home = path.join(dir, 'home', 'acct');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'ok'), 'ok');
  fs.symlinkSync(outside, path.join(home, 'lnk'));
  // The scripts guard `/home/*|/var/vmail/*`: point that pattern at the temp tree.
  const emulate = (s: string) => s.replace('/home/*|/var/vmail/*', `${dir}/home/*`);
  for (const script of [STAT_SCRIPT, DU_SCRIPT]) {
    const r: ReturnType<typeof spawnSync> = spawnSync(sh, ['-c', emulate(script), 'oblimint', `${home}/lnk/x`, `${home}/ok`, `${home}/lnk`]);
    assert.equal(r.status, 0);
    const out = String(r.stdout);
    assert.ok(!out.includes(`${home}/lnk/x`), 'intermediate symlink: skipped');
    assert.ok(out.includes(`${home}/ok`));
    assert.ok(out.includes(`${home}/lnk`), 'a final symlink is reported as a link (not followed)');
  }
});

test('sys.toolVersions script on a real shell: located tools, version line bounded and stripped of |, absent tools marked', (t) => {
  const sh = findSh();
  if (!sh) { t.skip('no POSIX sh on this machine'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool = (name: string, body: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };
  tool('rsync', 'echo "rsync  version 3.2.7  protocol version 31"; echo "Copyright (C) 1996-2022"');
  tool('mysqldump', `echo "mysqldump  Ver 10.19 Distrib 10.11.9-MariaDB, for Linux | ${'x'.repeat(400)}"`);
  tool('named-checkzone', '[ "$1" = -v ] && echo "9.18.28-1~deb12u2-Debian" || exit 3');
  tool('postconf', '[ "$1 $2" = "-d mail_version" ] && echo "mail_version = 3.7.11" || exit 3');
  tool('doveconf', 'exit 3');
  tool('dovecot', '[ "$1" = --version ] && echo "2.3.19.1 (9b53102964)" || exit 3');
  const r = spawnSync(sh, ['-c', TOOL_VERSIONS_SCRIPT], { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` }, input: '' });
  if (r.status !== 0 && /not found|cut|head|tr/.test(String(r.stderr))) { t.skip('coreutils missing'); return; }
  assert.equal(r.status, 0, String(r.stderr));
  const out = String(r.stdout).split('\n').filter(Boolean);
  assert.deepEqual(out.map((l) => l.split('|')[0]), [...VERSION_TOOLS], 'one line per tool, in order');
  for (const l of out) assert.equal(l.split('|').length, 3, l);
  const line = (name: string) => out.find((l) => l.startsWith(`${name}|`))!;
  assert.match(line('rsync'), /^rsync\|\/.+\|rsync {2}version 3\.2\.7 {2}protocol version 31$/);
  assert.ok(line('mysqldump').split('|')[2].length <= 200, 'version line bounded');
  assert.match(line('postconf'), /\|mail_version = 3\.7\.11$/);
  assert.match(line('doveconf'), /\|2\.3\.19\.1 \(9b53102964\)$/);
  assert.match(line('named-checkzone'), /\|9\.18\.28-1~deb12u2-Debian$/);
  const parsed = parseToolVersions(String(r.stdout));
  assert.equal(parsed.rsync, '3.2.7');
  assert.equal(parsed.mysqldump, '10.11.9-MariaDB');
  assert.equal(parsed.postconf, '3.7.11');
  assert.equal(parsed.doveconf, '2.3.19.1');
  assert.equal(parsed['named-checkzone'], '9.18.28-1~deb12u2-Debian');
});
