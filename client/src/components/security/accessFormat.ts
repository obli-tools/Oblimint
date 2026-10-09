// Pure helpers of the account security tab (no React): address / CIDR shape
// checks mirroring the server rules (docs/P2-PLAN.md §6.4 invalidCidr /
// cidrTooWide) and small formatting. The server stays the authority.

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(s: string): boolean {
  return IPV4_RE.test(s);
}

/** IPv6 shape check (hex groups, one "::" at most, optional trailing dotted IPv4). */
export function isIpv6(s: string): boolean {
  if (!s.includes(':') || /[^0-9a-f:.]/i.test(s)) return false;
  const parts = s.split('::');
  if (parts.length > 2) return false;
  let groups = 0;
  const countGroups = (part: string): boolean => {
    if (part === '') return true;
    const gs = part.split(':');
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (i === gs.length - 1 && g.includes('.')) {
        if (!isIpv4(g)) return false;
        groups += 2;
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return false;
      groups += 1;
    }
    return true;
  };
  if (!parts.every(countGroups)) return false;
  return parts.length === 2 ? groups <= 7 : groups === 8;
}

export type CidrIssue = 'invalid' | 'tooWide' | null;

/**
 * Why an address / CIDR is refused (null = acceptable): the server refuses a
 * prefix shorter than /8 in IPv4 and /32 in IPv6 (cidrTooWide).
 */
export function cidrIssue(input: string): CidrIssue {
  const s = input.trim();
  if (!s) return 'invalid';
  const [addr, prefix, extra] = s.split('/');
  if (extra !== undefined) return 'invalid';
  const v4 = isIpv4(addr);
  const v6 = !v4 && isIpv6(addr);
  if (!v4 && !v6) return 'invalid';
  if (prefix === undefined) return null;
  if (!/^\d{1,3}$/.test(prefix)) return 'invalid';
  const p = Number(prefix);
  if (p > (v4 ? 32 : 128)) return 'invalid';
  if (p < (v4 ? 8 : 32)) return 'tooWide';
  return null;
}

/** "45 min" / "4 h" / "1 h 30" for a TTL in minutes. */
export function formatMinutes(min: number, labels: { h: string; min: string }): string {
  if (!Number.isFinite(min) || min < 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} ${labels.min}`;
  return m === 0 ? `${h} ${labels.h}` : `${h} ${labels.h} ${String(m).padStart(2, '0')}`;
}

/** `datetime-local` value → ISO (null when empty / invalid). */
export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date → `datetime-local` value in the browser's time zone. */
export function isoToLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
