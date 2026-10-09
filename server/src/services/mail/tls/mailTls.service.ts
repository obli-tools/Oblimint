import path from 'path';
import { db } from '../../../db';
import { logger } from '../../../utils/logger';
import { loadPlatformHosts } from '../../edge/edge.service';
import { hostPaths, localPaths } from '../../hosting/paths';
import type { DesiredTlsCertificate } from '../driver';
import { loadMailPlatformContext, type MailPlatformContext } from '../dns/domains';
import { activeMailDriver } from '../registry';
import { copiedCertificateExists, copyCertificate, listCopiedCertificates, removeCopiedCertificate } from './copy';
import { loadMailEdgeInput, mailCertificateNames } from './edgeContributor';

// ─────────────────────────────────────────────────────────────────────────────
// Mail TLS (docs/P4-PLAN.md §9.4) — module mail-dns-tls. Certificates come
// from the P1/P2 ACME service (platform rows wished through
// edge/contributors.ts: the mail host name via PlatformHosts.extra, one
// certificate per active mail domain). certificateInstalled (edge hook) copies
// fullchain/privkey from edge/certs/<name>/ into mail/certs/<name>/ (copy.ts:
// 0640, atomic, no link followed) and hot-reloads the engine's TLS.
// ─────────────────────────────────────────────────────────────────────────────

interface CertRow { primary_name: string; names: unknown; status: string; not_after: Date | string | null }

function rowNames(r: CertRow): string[] {
  let v: unknown = r.names;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  const list = Array.isArray(v) ? v.map((n) => String(n).toLowerCase()) : [];
  return list.length ? list : [r.primary_name];
}

/** A certificate row whose files may still be served (not expired). */
function servable(r: CertRow | undefined, now = Date.now()): r is CertRow {
  if (!r || r.status === 'expired' || r.status === 'pending') return false;
  return !r.not_after || new Date(r.not_after).getTime() > now;
}

/** Primary names the mail service uses: H, the panel's (fallback while H has none), one per active mail domain. */
async function wantedPrimaries(ctx: MailPlatformContext): Promise<{ host: string | null; panel: string | null; domains: string[] }> {
  if (!ctx.hasMailboxes) return { host: null, panel: null, domains: [] };
  const input = await loadMailEdgeInput(await loadPlatformHosts(), ctx);
  const domains = input.domains.map((d) => mailCertificateNames(d, input)[0]).filter((n): n is string => !!n);
  return { host: ctx.host, panel: ctx.panelHostname, domains: [...new Set(domains)].sort() };
}

/** Copies one certificate when its edge files differ. Returns true when the mail copy changed. Never throws. */
function syncCopy(name: string): boolean {
  try {
    return copyCertificate(localPaths.edgeCerts(), localPaths.mailCerts(), name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') logger.warn({ certificate: name, err: (err as Error)?.message }, 'mail tls: certificate copy failed');
    return false;
  }
}

/**
 * Names of the copies under mail/certs/ still needed: what the last
 * certificates() pass wanted ∪ what the configuration just applied references.
 * PURE (copy.test.ts).
 */
export function copiesToKeep(wanted: ReadonlySet<string>, applied: readonly DesiredTlsCertificate[], hostCertsDir: string): Set<string> {
  const keep = new Set(wanted);
  const root = hostCertsDir.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const c of applied ?? []) {
    for (const p of [c.certPath, c.keyPath]) {
      const f = String(p ?? '').replace(/\\/g, '/');
      if (!f.startsWith(`${root}/`)) continue;
      const name = f.slice(root.length + 1).split('/')[0];
      if (name) keep.add(name);
    }
  }
  return keep;
}

/** Names wanted by the last certificates() pass (null = none yet: nothing is purged). */
let lastWanted: Set<string> | null = null;

/**
 * Copies under mail/certs/ no longer wanted (mail domain deleted, disabled,
 * unverified, moved; engine without mailboxes): their private keys must not
 * stay in the tree the engine mounts. Called by mail-core AFTER the engine
 * accepted a configuration (driver.sync resolved) built from that pass: a
 * configuration still referencing a copy (sync failed, files restored) never
 * loses it — the engine would fail to compile at its next start. Never throws.
 */
export function purgeUnusedCertificateCopies(applied: readonly DesiredTlsCertificate[]): void {
  if (!lastWanted) return;
  try {
    const root = localPaths.mailCerts();
    const keep = copiesToKeep(lastWanted, applied, hostPaths.mailCerts());
    for (const name of listCopiedCertificates(root).filter((n) => !keep.has(n))) {
      try {
        if (removeCopiedCertificate(root, name)) logger.info({ certificate: name }, 'mail tls: copy of an unused certificate removed');
      } catch (err) {
        logger.warn({ certificate: name, err: (err as Error)?.message }, 'mail tls: unused certificate copy not removed');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'mail tls: purge of unused certificate copies failed');
  }
}

/** Tests. */
export function resetMailTlsPurgeForTests(): void {
  lastWanted = null;
}

function reloadEngine(reason: string): void {
  activeMailDriver()
    .then((d) => d.reloadTls())
    .catch((err) => logger.warn({ err: (err as Error)?.message, reason }, 'mail tls: engine TLS reload failed'));
}

function desired(name: string, row: CertRow | undefined, isDefault: boolean): DesiredTlsCertificate {
  const dir = hostPaths.mailCertDir(name);
  return {
    names: row ? rowNames(row) : [name],
    certPath: path.posix.join(dir, 'fullchain.pem'),
    keyPath: path.posix.join(dir, 'privkey.pem'),
    isDefault,
  };
}

/**
 * Edge hook (edgeContributor.onCertificateInstalled): a certificate the mail
 * service uses was issued / renewed → copy, reload the engine's TLS, resync.
 */
export async function certificateInstalled(primaryName: string, _names: string[]): Promise<void> {
  const primary = String(primaryName ?? '').toLowerCase();
  const ctx = await loadMailPlatformContext();
  const w = await wantedPrimaries(ctx);
  const isPanelFallback = primary === w.panel && (w.host === w.panel || !copiedCertificateExists(localPaths.mailCerts(), w.host ?? ''));
  if (primary !== w.host && !isPanelFallback && !w.domains.includes(primary)) return;
  if (!syncCopy(primary)) return;
  logger.info({ certificate: primary }, 'mail tls: certificate copied for the mail service');
  try {
    await (await activeMailDriver()).reloadTls();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, certificate: primary }, 'mail tls: engine TLS reload failed');
  }
  try {
    (await import('../mail.service')).mailService.requestSync('tls');
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'mail tls: engine resync request failed');
  }
}

export const mailTlsService = {
  /**
   * Certificates the engine serves (host paths under paths.mailCerts()):
   * default = the node mail host name (falls back to the panel's when the
   * mail host has none yet), + one SNI entry per mail domain certificate.
   * Only certificates whose files exist are returned. Copies missing / stale
   * files from the edge on the way (a missed installation hook heals here).
   */
  async certificates(): Promise<DesiredTlsCertificate[]> {
    const ctx = await loadMailPlatformContext();
    const w = await wantedPrimaries(ctx);
    const names = [w.host, w.panel, ...w.domains].filter((n): n is string => !!n);
    lastWanted = new Set(names);
    if (names.length === 0) return [];
    const rows = new Map((await db('certificates').whereIn('primary_name', [...new Set(names)])
      .select('primary_name', 'names', 'status', 'not_after') as CertRow[]).map((r) => [r.primary_name, r]));
    const root = localPaths.mailCerts();
    let changed = false;
    const ready = (name: string): boolean => {
      const row = rows.get(name);
      if (!servable(row)) return false;
      if (syncCopy(name)) changed = true;
      return copiedCertificateExists(root, name);
    };

    const out: DesiredTlsCertificate[] = [];
    if (w.host && ready(w.host)) out.push(desired(w.host, rows.get(w.host), true));
    else if (w.panel && ready(w.panel)) out.push(desired(w.panel, rows.get(w.panel), true));
    const taken = new Set(out.map((c) => c.names[0]));
    for (const d of w.domains) {
      if (taken.has(d) || !ready(d)) continue;
      out.push(desired(d, rows.get(d), false));
      taken.add(d);
    }
    if (changed) reloadEngine('certificate files refreshed');
    return out;
  },
};
