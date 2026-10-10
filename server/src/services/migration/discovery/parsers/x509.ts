import { X509Certificate } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Public certificates (/etc/pki/tls/certs/<fqdn>.cert + .bundle) analysed with
// node:crypto X509Certificate: names (SAN DNS + CN), validity (ISO), issuer,
// self-signed (issuer = subject AND signed by its own key), key type.
// ─────────────────────────────────────────────────────────────────────────────

export interface CertFacts {
  names: string[];
  notBefore: string | null;
  notAfter: string | null;
  issuer: string | null;
  subject: string | null;
  selfSigned: boolean;
  keyType: 'rsa' | 'ec' | 'unknown';
  fingerprint256: string;
}

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Every CERTIFICATE block of a PEM text (other blocks ignored). */
export function pemCertificates(text: string): string[] {
  return (text.match(PEM_CERT) ?? []).map((b) => `${b.trim()}\n`);
}

function dnToString(dn: string): string {
  return dn.split('\n').map((s) => s.trim()).filter(Boolean).join(', ');
}

function iso(d: string): string | null {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Facts of the FIRST certificate of a PEM text; null when none parses. */
export function parseCertificate(pem: string): CertFacts | null {
  const first = pemCertificates(pem)[0];
  if (!first) return null;
  let x: X509Certificate;
  try {
    x = new X509Certificate(first);
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const part of (x.subjectAltName ?? '').split(',')) {
    const m = /^\s*DNS:(.+)$/.exec(part);
    if (m) names.add(m[1].trim().toLowerCase());
  }
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject);
  if (cn) names.add(cn[1].trim().toLowerCase());
  let selfSigned = false;
  if (x.issuer === x.subject) {
    try {
      selfSigned = x.checkIssued(x) && x.verify(x.publicKey);
    } catch {
      selfSigned = false;
    }
  }
  const kt = x.publicKey.asymmetricKeyType;
  return {
    names: [...names],
    notBefore: iso(x.validFrom),
    notAfter: iso(x.validTo),
    issuer: dnToString(x.issuer) || null,
    subject: dnToString(x.subject) || null,
    selfSigned,
    keyType: kt === 'rsa' || kt === 'rsa-pss' ? 'rsa' : kt === 'ec' ? 'ec' : 'unknown',
    fingerprint256: x.fingerprint256,
  };
}

/** A certificate name covers an fqdn (exact, or one-label wildcard). */
export function certCovers(names: string[], fqdn: string): boolean {
  const f = fqdn.toLowerCase();
  return names.some((n) => n === f || (n.startsWith('*.') && f.endsWith(n.slice(1)) && !f.slice(0, -n.length + 1).includes('.')));
}
