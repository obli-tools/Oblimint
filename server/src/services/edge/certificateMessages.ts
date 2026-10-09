import type { CertificateLogLine, CertificateSummary } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// What a CLIENT user may read of a certificate (invariant A6, docs/P1-PLAN.md
// §14). OWNED BY MODULE `edge`.
//
// An issuance failure carries raw text: Node fs errors with host paths
// (/srv/oblimint/edge/...), acme-client / axios network errors (internal
// addresses, proxies), self-test output of the edge container, platform
// settings names. The raw text stays in the row (last_error, log `detail`)
// for the staff and the server log; a client gets:
//   - lastError → one fixed, categorised sentence (clientCertificateError);
//   - log lines → the `message` only (written client-safe by construction:
//     the raw part of a line goes to its `detail`), scrubbed again as defence
//     in depth (rows written before this rule: "FAILED: <raw>" lines, paths,
//     IP addresses).
// The staff sees `message (detail)`.
// ─────────────────────────────────────────────────────────────────────────────

export type CertificateViewer = 'staff' | 'client';

/** A log line as stored in certificates.log: `detail` = raw text, staff only. */
export interface StoredCertificateLogLine extends CertificateLogLine {
  detail?: string;
}

const CATEGORIES: Array<{ re: RegExp; message: string }> = [
  {
    re: /rateLimited|rate[- ]limit|too many (?:certificates|failed|requests|new orders|registrations)/i,
    message: "Let's Encrypt rate limit reached for this name; a new attempt will be made automatically later.",
  },
  {
    re: /\bcaa\b/i,
    message: "A CAA record of the domain does not allow Let's Encrypt to issue a certificate for it.",
  },
  {
    re: /rejectedIdentifier|policy forbids|not publicly resolvable|invalid certificate names|cannot issue for/i,
    message: "Let's Encrypt does not issue certificates for this name (reserved or non-public name).",
  },
  {
    // P2: DNS-01 (wildcard certificates) through the platform's DNS servers.
    re: /dns-01|_acme-challenge|No usable DNS-01/i,
    message: "Let's Encrypt could not validate the DNS-01 challenge: the zone of the domain must be hosted and delegated to this platform's DNS servers.",
  },
  {
    re: /\bdns\b|NXDOMAIN|SERVFAIL|no valid (?:A|AAAA)|no (?:A|AAAA) records?|looking up (?:A|AAAA|CAA)/i,
    message: 'DNS problem: the name does not resolve to this server (check its A / AAAA records).',
  },
  {
    re: /challenge|unauthorized|incorrect|invalid response|connection refused|timeout during connect|fetching http|port 80|ECONNREFUSED|EHOSTUNREACH|connection reset/i,
    message: "Let's Encrypt could not validate the name over HTTP: check that it points to this server, that port 80 is reachable from the internet and that no CDN proxy is in front during the validation.",
  },
  {
    re: /timed out|timeout|ETIMEDOUT|aborted/i,
    message: 'The certificate request timed out; a new attempt will be made automatically later.',
  },
  {
    re: /acme_email|contact email/i,
    message: 'Certificates are not configured on this platform yet; contact your hosting provider.',
  },
];

const GENERIC = 'The certificate could not be issued (details visible to the administrators).';

/** A client-safe, categorised sentence for a raw issuance error (null stays null). */
export function clientCertificateError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (!text.trim()) return null;
  for (const c of CATEGORIES) if (c.re.test(text)) return c.message;
  return GENERIC;
}

// Legacy lines (written before `detail` existed) embedded the raw text after these prefixes.
const LEGACY_RAW_SUFFIX = /^(FAILED: |\[[^\]]{1,260}\] Challenge failed: |\[[^\]]{1,260}\] Internal self-test (?:failed|error): )(.*)$/s;
const ABS_PATH = /(?:^|(?<=[\s'"(=:,]))\/(?:srv|var|etc|run|tmp|proc|sys|home|root|usr|opt|app|data|mnt)(?:\/[^\s'"),;]*)?/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;

/** Defence in depth: host paths and IP addresses never reach a client. */
export function scrubForClient(text: string): string {
  return text.replace(ABS_PATH, '[…]').replace(IPV4, '[…]').replace(IPV6, '[…]');
}

function clientLine(l: StoredCertificateLogLine): string {
  const message = typeof l.message === 'string' ? l.message : '';
  if (l.detail === undefined) {
    const m = LEGACY_RAW_SUFFIX.exec(message);
    if (m) {
      const label = m[1].startsWith('FAILED') ? `FAILED: ${clientCertificateError(m[2]) ?? GENERIC}` : m[1].replace(/: $/, '');
      return scrubForClient(label);
    }
  }
  return scrubForClient(message);
}

/** The log as `viewer` may read it. */
export function certificateLogView(lines: StoredCertificateLogLine[], viewer: CertificateViewer): CertificateLogLine[] {
  return (Array.isArray(lines) ? lines : []).map((l) => ({
    at: l.at,
    level: l.level,
    message: viewer === 'staff'
      ? (l.detail ? `${l.message} (${l.detail})` : l.message)
      : clientLine(l),
  }));
}

/** The summary (lastError) as `viewer` may read it. */
export function certificateSummaryView<T extends CertificateSummary>(summary: T, viewer: CertificateViewer): T {
  return viewer === 'staff' ? summary : { ...summary, lastError: clientCertificateError(summary.lastError) };
}

/** HostingActor → viewer (a client user of an account, or the staff). */
export function viewerOf(actor: { kind: string }): CertificateViewer {
  return actor.kind === 'staff' ? 'staff' : 'client';
}
