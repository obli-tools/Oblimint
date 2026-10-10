import { phpDigitsToVersion } from './cwpConf';

// ─────────────────────────────────────────────────────────────────────────────
// crontab files (/var/spool/cron/<owner>, ~/cron): environment lines
// (`MAILTO=…`), comments, `@reboot` / `@daily`… specials, commented-out cron
// lines (→ disabled), PHP CLI detection (/usr/local/bin/php = the default
// version, /opt/alt/phpXX/usr/bin/php = X.Y). Key `<owner>:<lineNo>` (1-based).
// ─────────────────────────────────────────────────────────────────────────────

export interface CrontabLine {
  lineNo: number;
  schedule: string;
  command: string;
  disabled: boolean;
  phpBinary: string | null;
  phpVersion: string | null;
}

const SPECIALS = new Set(['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);
const FIELD = /^[0-9A-Za-z*/,\-?LW#]+$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

function parseCronBody(body: string): { schedule: string; command: string } | null {
  const t = body.trim();
  if (t === '' || ENV.test(t)) return null;
  const toks = t.split(/\s+/);
  if (SPECIALS.has(toks[0].toLowerCase())) {
    const command = t.slice(toks[0].length).trim();
    return command ? { schedule: toks[0].toLowerCase(), command } : null;
  }
  if (toks.length < 6 || !toks.slice(0, 5).every((f) => FIELD.test(f))) return null;
  // At least one field must look numeric / star (rejects prose comments like "# This file is managed by…").
  if (!toks.slice(0, 5).some((f) => /[0-9*]/.test(f))) return null;
  let rest = t;
  for (let i = 0; i < 5; i += 1) rest = rest.replace(/^\S+\s+/, '');
  return { schedule: toks.slice(0, 5).join(' '), command: rest.trim() };
}

/** PHP CLI named in a command → binary + version (defaultVersion for /usr/local/bin/php). */
export function detectCronPhp(command: string, defaultVersion: string | null): { phpBinary: string | null; phpVersion: string | null } {
  const alt = /(\/opt\/alt\/php(\d{2,3})\/usr\/bin\/php(?:-cli|-cgi)?)(?=\s|$|;|\||&)/.exec(command);
  if (alt) return { phpBinary: alt[1], phpVersion: phpDigitsToVersion(alt[2]) };
  const local = /(\/usr\/local\/bin\/php(?:-cli|-cgi)?)(?=\s|$|;|\||&)/.exec(command);
  if (local) return { phpBinary: local[1], phpVersion: defaultVersion };
  const usr = /(\/usr\/bin\/php(\d{2})?)(?=\s|$|;|\||&)/.exec(command);
  if (usr) return { phpBinary: usr[1], phpVersion: usr[2] ? phpDigitsToVersion(usr[2]) : defaultVersion };
  const bare = /(?:^|[\s;|&(])(php(?:-cli)?)(?=\s)/.exec(command);
  if (bare) return { phpBinary: bare[1], phpVersion: defaultVersion };
  return { phpBinary: null, phpVersion: null };
}

export function parseCrontab(text: string, defaultPhpVersion: string | null): CrontabLine[] {
  const out: CrontabLine[] = [];
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  rows.forEach((raw, idx) => {
    const line = raw.trim();
    if (line === '') return;
    let disabled = false;
    let body = line;
    if (line.startsWith('#')) {
      disabled = true;
      body = line.replace(/^#+\s*/, '');
    }
    const parsed = parseCronBody(body);
    if (!parsed) return;
    const php = detectCronPhp(parsed.command, defaultPhpVersion);
    out.push({ lineNo: idx + 1, schedule: parsed.schedule, command: parsed.command, disabled, ...php });
  });
  return out;
}
