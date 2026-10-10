import crypto, { X509Certificate } from 'crypto';
import { IMPORTED_CERT_ISSUER } from './renewal';

// ─────────────────────────────────────────────────────────────────────────────
// P5 — certificate imported from CWP for a SITE domain (docs/P5-PLAN.md §9.4,
// step cert:<fqdn>). OWNED BY MODULE `executor-web-db` (new file in edge/).
// Writes <edgeCerts>/<primary name>/{fullchain,privkey}.pem
// (acmeIssuer.writeCertificateFiles) and upserts the domain's `certificates`
// row with issuer IMPORTED_CERT_ISSUER ('imported', renewal.ts), status
// 'valid', dates / names READ FROM THE CERTIFICATE; then edgeService.scheduleSync.
// Refuses (installed: false) when: the key does not match the certificate,
// the certificate is expired or does not cover the domain names
// (domainCertificateNames), the domain is not verified (D1), or the row
// already holds a valid Let's Encrypt certificate (never downgraded).
// Renewal: planRenewals hands it over to Let's Encrypt in the 30-day window;
// the cutover switch requests the issuance explicitly.
// The private key is never logged; the edge / DB modules are loaded lazily
// (the pure checks below are unit-tested without them).
// ─────────────────────────────────────────────────────────────────────────────

export interface ImportedSiteCertificate {
  certificatePem: string;
  chainPem: string | null;
  /** Never logged, written 0600 only. */
  privateKeyPem: string;
}

export type ImportedSiteCertSkip = 'notVerified' | 'expired' | 'namesNotCovered' | 'keyMismatch' | 'letsencryptValid' | 'invalidPem';

export interface ParsedImportedCertificate {
  /** DNS names of the leaf (SAN, else CN), lower case. */
  names: string[];
  notBefore: Date;
  notAfter: Date;
  issuer: string;
  /** leaf + chain, PEM, newline terminated. */
  fullchain: string;
  keyMatches: boolean;
}

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Parses the bundle (no I/O). Throws on an unreadable PEM. */
export function parseImportedCertificate(cert: ImportedSiteCertificate): ParsedImportedCertificate {
  const leafPem = (cert.certificatePem.match(PEM_CERT_RE) ?? [])[0];
  if (!leafPem) throw new Error('no certificate in the PEM');
  const x509 = new X509Certificate(leafPem);
  const sans = (x509.subjectAltName ?? '').split(/,\s*/).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4).trim().toLowerCase());
  const cn = /(?:^|\n)CN=([^\n]+)/.exec(x509.subject)?.[1]?.trim().toLowerCase();
  const names = sans.length ? sans : cn ? [cn] : [];
  const key = crypto.createPrivateKey(cert.privateKeyPem);
  let keyMatches = false;
  try { keyMatches = x509.checkPrivateKey(key); } catch { keyMatches = false; }
  const chain = [...(cert.certificatePem.match(PEM_CERT_RE) ?? []).slice(1), ...((cert.chainPem ?? '').match(PEM_CERT_RE) ?? [])];
  const fullchain = `${[leafPem, ...chain.filter((c, i, all) => all.indexOf(c) === i && c !== leafPem)].join('\n')}\n`;
  return {
    names,
    notBefore: new Date(x509.validFrom),
    notAfter: new Date(x509.validTo),
    issuer: x509.issuer.replace(/\n/g, ', ').slice(0, 300),
    fullchain,
    keyMatches,
  };
}

/** Does one certificate name cover a host name? `*.a.tld` covers exactly one label below a.tld (never a.tld itself). */
export function certificateNameCovers(certName: string, host: string): boolean {
  const c = certName.toLowerCase().replace(/\.$/, '');
  const h = host.toLowerCase().replace(/\.$/, '');
  if (c === h) return true;
  if (!c.startsWith('*.') || h.startsWith('*.')) return false;
  const suffix = c.slice(1); // ".a.tld"
  if (!h.endsWith(suffix)) return false;
  const label = h.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}

/** Every wanted name covered by the certificate names (a wanted wildcard needs the same wildcard). */
export function certificateCoversAll(certNames: string[], wanted: string[]): boolean {
  return wanted.every((w) => certNames.some((c) => certificateNameCovers(c, w)));
}

/** Pure decision on a parsed bundle (no I/O): null = installable. */
export function importedCertificateRefusal(parsed: ParsedImportedCertificate, wanted: string[], now: Date = new Date()): ImportedSiteCertSkip | null {
  if (!parsed.keyMatches) return 'keyMismatch';
  if (!Number.isFinite(parsed.notAfter.getTime()) || parsed.notAfter.getTime() <= now.getTime()) return 'expired';
  if (!Number.isFinite(parsed.notBefore.getTime()) || parsed.notBefore.getTime() > now.getTime()) return 'expired';
  if (!certificateCoversAll(parsed.names, wanted)) return 'namesNotCovered';
  return null;
}

/** An existing row we must not replace: a valid, unexpired certificate issued by Let's Encrypt. */
export function isValidLetsEncrypt(row: { status: string; issuer: string; not_after: Date | string | null } | undefined, now: Date = new Date()): boolean {
  if (!row || row.status !== 'valid' || !row.issuer.startsWith('letsencrypt') || !row.not_after) return false;
  const t = new Date(row.not_after).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

export async function installImportedDomainCertificate(
  domainId: number,
  cert: ImportedSiteCertificate,
): Promise<{ installed: boolean; reason: ImportedSiteCertSkip | null; certificateId: number | null; notAfter: string | null }> {
  const skip = (reason: ImportedSiteCertSkip, notAfter: Date | null = null) =>
    ({ installed: false, reason, certificateId: null, notAfter: notAfter ? notAfter.toISOString() : null });

  const [{ db }, { AppError }] = await Promise.all([import('../../db'), import('../../middleware/errorHandler')]);
  const domain = await db('domains').where({ id: domainId }).first('id', 'name', 'include_www', 'wildcard', 'verification_status') as
    { id: number; name: string; include_www: boolean; wildcard: boolean | null; verification_status: string | null } | undefined;
  if (!domain) throw new AppError(404, 'Domain not found', 'notFound');
  // D1: nothing is served for a name whose ownership is not proven.
  if (domain.verification_status !== 'verified') return skip('notVerified');

  let parsed: ParsedImportedCertificate;
  try {
    parsed = parseImportedCertificate(cert);
  } catch {
    return skip('invalidPem');
  }
  const [{ domainCertificateNames }, { loadPlatformHosts, edgeService }, { writeCertificateFiles }, { localPaths }, { logger }] = await Promise.all([
    import('./certificate.service'), import('./edge.service'), import('./acmeIssuer'), import('../hosting/paths'), import('../../utils/logger'),
  ]);
  let platform;
  try {
    platform = await loadPlatformHosts();
  } catch {
    platform = { panel: null, previewDomain: null, dbAdmin: null, probeV4: null, probeV6: null };
  }
  const { names } = await domainCertificateNames(domain, platform);
  const refusal = importedCertificateRefusal(parsed, names);
  if (refusal) return skip(refusal, parsed.notAfter);

  const existing = await db('certificates').where({ domain_id: domain.id }).first('id', 'status', 'issuer', 'not_after', 'primary_name') as
    { id: number; status: string; issuer: string; not_after: Date | string | null; primary_name: string } | undefined;
  if (isValidLetsEncrypt(existing)) return skip('letsencryptValid', parsed.notAfter);
  const primary = names[0];
  const clash = await db('certificates').where({ primary_name: primary }).whereNot('domain_id', domain.id).orWhere((q) => {
    q.where({ primary_name: primary }).whereNull('domain_id');
  }).first('id') as { id: number } | undefined;
  if (clash) throw new AppError(409, `${primary} is already covered by another certificate`, 'certificateNameTaken');

  writeCertificateFiles(localPaths.edgeCerts(), primary, parsed.fullchain, cert.privateKeyPem);
  const logLine = {
    at: new Date().toISOString(), level: 'info',
    message: `Certificat importé depuis CWP (émetteur : ${parsed.issuer}, valable jusqu'au ${parsed.notAfter.toISOString()})`,
  };
  const certificateId = await db.transaction(async (trx) => {
    const values = {
      domain_id: domain.id,
      site_id: null,
      primary_name: primary,
      names: JSON.stringify(names),
      status: 'valid',
      issuer: IMPORTED_CERT_ISSUER,
      not_before: parsed.notBefore,
      not_after: parsed.notAfter,
      last_error: null,
      failure_count: 0,
      log: JSON.stringify([logLine]),
      updated_at: trx.fn.now(),
    };
    const row = await trx('certificates').where({ domain_id: domain.id }).forUpdate().first('id') as { id: number } | undefined;
    if (row) {
      await trx('certificates').where({ id: row.id }).update(values);
      return Number(row.id);
    }
    const [inserted] = await trx('certificates').insert(values).returning('id') as Array<{ id: number }>;
    return Number(inserted.id);
  });
  if (existing && existing.primary_name !== primary) {
    try { (await import('./acmeIssuer')).removeCertificateFiles(localPaths.edgeCerts(), existing.primary_name); } catch { /* stale files only */ }
  }
  try { edgeService.scheduleSync('migration certificate'); } catch (err) { logger.warn({ err: (err as Error).message, domainId }, 'edgeService.scheduleSync failed'); }
  logger.info({ domainId, certificateId, primary, notAfter: parsed.notAfter.toISOString() }, 'imported CWP certificate installed');
  return { installed: true, reason: null, certificateId, notAfter: parsed.notAfter.toISOString() };
}
