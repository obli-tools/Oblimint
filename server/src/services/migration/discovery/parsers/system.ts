import ipaddr from 'ipaddr.js';

// ─────────────────────────────────────────────────────────────────────────────
// Parsers of the sys.* / fs.* template outputs (docs/P5-PLAN.md §5.2): getent
// passwd, os-release, `ip -o addr show`, tool versions, `find -printf`, stat -c,
// du -sb, wc -l. Pure functions; unknown / malformed lines are skipped.
// ─────────────────────────────────────────────────────────────────────────────

function lines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.trim() !== '');
}

// ── passwd ──────────────────────────────────────────────────────────────────

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export function parsePasswd(text: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  for (const l of lines(text)) {
    const f = l.split(':');
    if (f.length < 7) continue;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!f[0] || !Number.isInteger(uid) || !Number.isInteger(gid)) continue;
    // gecos may contain ':' only in broken files: home / shell are the last two fields.
    out.push({ name: f[0], uid, gid, gecos: f.slice(4, f.length - 2).join(':'), home: f[f.length - 2], shell: f[f.length - 1] });
  }
  return out;
}

const NON_INTERACTIVE = /(^|\/)(nologin|false|sync|shutdown|halt|true)$/;

/** Login shell usable interactively (not nologin / false / sync…). */
export function isInteractiveShell(shell: string | null | undefined): boolean {
  if (!shell) return false;
  const s = shell.trim();
  return s !== '' && !NON_INTERACTIVE.test(s);
}

// ── os-release ──────────────────────────────────────────────────────────────

/** `cat /etc/os-release /etc/redhat-release` → PRETTY_NAME, else the redhat-release line. */
export function parseOsRelease(text: string): string | null {
  let pretty: string | null = null;
  let name: string | null = null;
  let version: string | null = null;
  let other: string | null = null;
  for (const l of lines(text)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
    if (m) {
      const v = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (m[1] === 'PRETTY_NAME') pretty = v;
      else if (m[1] === 'NAME') name = v;
      else if (m[1] === 'VERSION_ID') version = v;
    } else if (!other && /release/i.test(l)) {
      other = l.trim();
    }
  }
  if (pretty) return pretty;
  if (name) return version ? `${name} ${version}` : name;
  return other;
}

// ── addresses ───────────────────────────────────────────────────────────────

export interface IpAddr {
  iface: string;
  family: 'inet' | 'inet6';
  address: string;
  prefix: number;
  scope: string | null;
}

/** `ip -o addr show`: `2: eth0    inet 203.0.113.10/27 brd … scope global eth0\       valid_lft …`. */
export function parseIpAddrs(text: string): IpAddr[] {
  const out: IpAddr[] = [];
  for (const l of lines(text)) {
    const m = /^\d+:\s+(\S+?)(?:@\S+)?\s+(inet6?)\s+([0-9a-fA-F.:]+)\/(\d+)(.*)$/.exec(l.trim());
    if (!m) continue;
    const scope = /\bscope\s+(\S+)/.exec(m[5]);
    out.push({ iface: m[1], family: m[2] as 'inet' | 'inet6', address: m[3].toLowerCase(), prefix: Number(m[4]), scope: scope ? scope[1] : null });
  }
  return out;
}

export type IpClass = 'public' | 'private' | 'loopback' | 'link-local' | 'invalid';

/** Parses an IP literal (IPv4-mapped IPv6 → IPv4); null when not an IP. */
export function parseIpLiteral(text: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  const raw = text.trim().replace(/^\[(.*)\]$/, '$1');
  if (raw === '' || raw.includes('%') || !ipaddr.isValid(raw)) return null;
  if (!raw.includes(':') && !ipaddr.IPv4.isValidFourPartDecimal(raw)) return null;
  let a = ipaddr.parse(raw);
  if (a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress()) a = (a as ipaddr.IPv6).toIPv4Address();
  return a;
}

export function classifyIp(text: string): IpClass {
  const a = parseIpLiteral(text);
  if (!a) return 'invalid';
  const r = a.range();
  if (r === 'loopback' || r === 'unspecified') return 'loopback';
  if (r === 'linkLocal') return 'link-local';
  if (r === 'private' || r === 'carrierGradeNat' || r === 'uniqueLocal') return 'private';
  // unicast, and the reserved / documentation ranges (192.0.2.0/24, 203.0.113.0/24…): public addresses.
  return 'public';
}

/** RFC 1918 / ULA / loopback / CGNAT / link-local (CwpProxyTarget.isPrivate). Host names are not private. */
export function isPrivateAddress(host: string): boolean {
  if (/^localhost\.?$/i.test(host.trim())) return true;
  const c = classifyIp(host);
  return c === 'private' || c === 'loopback' || c === 'link-local';
}

// ── tool versions (sys.toolVersions, P6: no rpm) ────────────────────────────

/** Version printed by a tool when it cannot be parsed (the tool is there: rsyncMissing must not fire). */
export const UNKNOWN_TOOL_VERSION = 'unknown';

/**
 * Version out of the first line a tool prints:
 *   rsync  version 3.1.3  protocol version 31                       → 3.1.3
 *   mysqldump  Ver 10.19 Distrib 10.3.39-MariaDB, for Linux (x86_64) → 10.3.39-MariaDB
 *   mysql from 11.4.2-MariaDB, client 15.2 for linux-systemd (x86_64) → 11.4.2-MariaDB
 *   mysql  Ver 8.0.36 for Linux on x86_64 (MySQL Community Server)   → 8.0.36
 *   9.11.36-RedHat-9.11.36-11.el8_9 (named-checkzone -v)             → 9.11.36-RedHat-9.11.36-11.el8_9
 *   mail_version = 3.5.8 (postconf -d mail_version)                  → 3.5.8
 *   2.3.16 (7e2e900c1a) (dovecot --version)                          → 2.3.16
 */
export function toolVersionOf(line: string): string | null {
  const l = line.trim();
  if (!l) return null;
  const tok = '(\\d+(?:\\.\\d+)+[A-Za-z0-9._+~-]*)';
  for (const re of [
    new RegExp(`\\bDistrib\\s+${tok}`), new RegExp(`\\bfrom\\s+${tok}`), new RegExp(`\\bversion\\s+${tok}`, 'i'),
    new RegExp(`^mail_version\\s*=\\s*${tok}`), new RegExp(`\\bVer\\s+${tok}`), new RegExp(`(?:^|\\s)v?${tok}`),
  ]) {
    const m = re.exec(l);
    if (m) return m[1].replace(/[.,;:]+$/, '').slice(0, 64);
  }
  return null;
}

/**
 * `sys.toolVersions` output (`<tool>|<path>|<version line>` per line, `<tool>|-|` when absent) → tool → version.
 * Absent tools are left out; a present tool whose version cannot be read maps to UNKNOWN_TOOL_VERSION.
 */
export function parseToolVersions(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(text)) {
    const m = /^([a-z][a-z0-9-]{0,31})\|([^|]*)\|(.*)$/.exec(l.replace(/\r$/, ''));
    if (!m || !m[2].startsWith('/')) continue;
    out[m[1]] = toolVersionOf(m[3]) ?? UNKNOWN_TOOL_VERSION;
  }
  return out;
}

// ── find -printf '%y|%m|%u|%g|%s|%T@|%p|%l' ─────────────────────────────────

export interface FindEntry {
  /** f, d, l, … */
  type: string;
  mode: string;
  user: string;
  group: string;
  size: number;
  mtime: number;
  path: string;
  /** Symlink target ('' for other types). */
  link: string;
}

export function parseFind(text: string): FindEntry[] {
  const out: FindEntry[] = [];
  for (const l of lines(text)) {
    const f = l.split('|');
    if (f.length < 8) continue;
    const rest = f.slice(6).join('|');
    // %l is empty except for symlinks: the LAST '|' separates path and target.
    const cut = rest.lastIndexOf('|');
    const p = rest.slice(0, cut);
    if (!p.startsWith('/')) continue;
    out.push({
      type: f[0], mode: f[1], user: f[2], group: f[3], size: Number(f[4]) || 0, mtime: Number(f[5]) || 0,
      path: p, link: rest.slice(cut + 1),
    });
  }
  return out;
}

/** Last path component. */
export function baseName(p: string): string {
  const s = p.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

export function dirName(p: string): string {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

// ── stat -c '%n|%F|%s|%u|%g|%a|%Y' ─────────────────────────────────────────

export interface StatEntry {
  path: string;
  /** 'regular file', 'directory', 'symbolic link'… */
  kind: string;
  size: number;
  uid: number;
  gid: number;
  mode: string;
  mtime: number;
}

export function parseStat(text: string): Map<string, StatEntry> {
  const out = new Map<string, StatEntry>();
  for (const l of lines(text)) {
    const f = l.split('|');
    if (f.length < 7) continue;
    // The name may contain '|': the six last fields are fixed.
    const tail = f.slice(-6);
    const p = f.slice(0, f.length - 6).join('|');
    if (!p.startsWith('/')) continue;
    out.set(p, {
      path: p, kind: tail[0], size: Number(tail[1]) || 0, uid: Number(tail[2]), gid: Number(tail[3]), mode: tail[4],
      mtime: Number(tail[5]) || 0,
    });
  }
  return out;
}

// ── du -sb / wc -l ──────────────────────────────────────────────────────────

/** `du -sb`: `<bytes>\t<path>`. */
export function parseDu(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines(text)) {
    const m = /^(\d+)\s+(\/.*)$/.exec(l);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

/** `wc -l`: `  <n> <path>` (+ a `total` line with several files, ignored). */
export function parseLineCount(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines(text)) {
    const m = /^\s*(\d+)\s+(\/.*)$/.exec(l);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}
