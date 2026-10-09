import { logger } from '../../utils/logger';
import type { EdgeVhost } from './nginxConfig';
import type { PlanCertificate, PlatformHosts } from './vhostPlan';

// ─────────────────────────────────────────────────────────────────────────────
// P4 extension points of the edge and of the certificate service
// (docs/P4-PLAN.md §7) — ARCHITECT FILE (frozen).
//
//  - vhosts: edge.service.buildVhosts() appends the contributed vhosts AFTER
//    planVhosts() (platform names and tenant domains are claimed first): a
//    contributed server name already served is dropped (a vhost left without
//    name is dropped); each vhost still goes through nginxConfig.validateVhost
//    (H5) at render time. Kinds 'mail' (autoconfig / autodiscover / MTA-STS
//    → panel, ACME for mail.<domain>) and 'webmail' (→ webmail container).
//  - certificates: certificate.service auxiliaryTargets() adds the wished
//    certificates as PLATFORM rows (domain_id and site_id null, tenant of the
//    wish), so the renewal pass keeps and renews them; a wish that disappears
//    is swept like any stale platform row.
//  - onCertificateInstalled: called after a successful issuance / renewal of
//    ANY certificate (primary name + covered names), so the mail service can
//    copy the files it uses and reload TLS (hot reload on renewal).
//
// Contributors: mail-dns-tls (services/mail/tls/edgeContributor.ts: mail.<d>,
// autoconfig.<d>, autodiscover.<d>, mta-sts.<d> + the mail certificates) and
// webmail (services/mail/webmail/edgeContributor.ts: platform webmail host +
// webmail.<d>). Registered by their module's start(). Never throw on purpose:
// a throw is logged and that contributor's part is skipped for this pass.
// ─────────────────────────────────────────────────────────────────────────────

export interface EdgeContributorContext {
  platform: PlatformHosts;
  /** e.g. https://oblimint-panel:8443 */
  panelUpstream: string;
  certificates: PlanCertificate[];
  /** Do fullchain.pem AND privkey.pem exist for this primary name? */
  certFilesExist: (primaryName: string) => boolean;
  /** Server names already served by planVhosts (and by earlier contributors). */
  claimed: ReadonlySet<string>;
}

export interface EdgeCertificateWish {
  /** names[0] = primary name (row key, files under edge/certs/<names[0]>/). */
  names: string[];
  /** DNS-01 first (zone hosted on our PowerDNS); HTTP-01 otherwise / as fallback. */
  preferDns01: boolean;
  /** Tenant / account of the audit + socket events (platform: MASTER_TENANT_ID, null). */
  tenantId: number;
  accountId: number | null;
}

export interface EdgeContributor {
  id: string;
  vhosts?(ctx: EdgeContributorContext): Promise<EdgeVhost[]>;
  certificates?(platform: PlatformHosts): Promise<EdgeCertificateWish[]>;
  onCertificateInstalled?(primaryName: string, names: string[]): void;
}

const contributors: EdgeContributor[] = [];

export function registerEdgeContributor(c: EdgeContributor): void {
  const i = contributors.findIndex((x) => x.id === c.id);
  if (i >= 0) contributors[i] = c;
  else contributors.push(c);
}

export function unregisterEdgeContributor(id: string): void {
  const i = contributors.findIndex((x) => x.id === id);
  if (i >= 0) contributors.splice(i, 1);
}

/** Tests. */
export function clearEdgeContributorsForTests(): void {
  contributors.splice(0, contributors.length);
}

/** Appends the contributed vhosts to `base` (names already claimed are dropped). Never throws. */
export async function withContributedVhosts(
  base: EdgeVhost[],
  ctx: Omit<EdgeContributorContext, 'claimed'>,
): Promise<EdgeVhost[]> {
  if (contributors.length === 0) return base;
  const claimed = new Set<string>();
  const ids = new Set<string>();
  for (const v of base) {
    ids.add(v.id);
    for (const n of v.serverNames) claimed.add(n);
  }
  const out = [...base];
  for (const c of contributors) {
    if (!c.vhosts) continue;
    let list: EdgeVhost[];
    try {
      list = await c.vhosts({ ...ctx, claimed });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, contributor: c.id }, 'edge contributor failed: its vhosts are skipped');
      continue;
    }
    for (const v of Array.isArray(list) ? list : []) {
      if (!v || typeof v.id !== 'string' || ids.has(v.id)) continue;
      const names = v.serverNames.filter((n) => !claimed.has(n));
      if (names.length === 0) continue;
      names.forEach((n) => claimed.add(n));
      ids.add(v.id);
      out.push({ ...v, serverNames: names });
    }
  }
  return out;
}

/**
 * Every contributed certificate wish + whether a contributor failed (its
 * wishes are then unknown for this pass: the renewal pass must not sweep
 * platform rows — they may be that contributor's). Never throws.
 */
export async function collectCertificateWishes(platform: PlatformHosts): Promise<{ wishes: EdgeCertificateWish[]; failed: string[] }> {
  const wishes: EdgeCertificateWish[] = [];
  const failed: string[] = [];
  for (const c of contributors) {
    if (!c.certificates) continue;
    try {
      const list = await c.certificates(platform);
      for (const w of Array.isArray(list) ? list : []) if (w && Array.isArray(w.names) && w.names.length > 0) wishes.push(w);
    } catch (err) {
      failed.push(c.id);
      logger.warn({ err: (err as Error)?.message, contributor: c.id }, 'edge contributor: certificate wishes skipped');
    }
  }
  return { wishes, failed };
}

/** Every contributed certificate wish. Never throws. */
export async function contributedCertificateWishes(platform: PlatformHosts): Promise<EdgeCertificateWish[]> {
  return (await collectCertificateWishes(platform)).wishes;
}

/** Announces an installed certificate to every contributor. Never throws. */
export function announceCertificateInstalled(primaryName: string, names: string[]): void {
  for (const c of contributors) {
    if (!c.onCertificateInstalled) continue;
    try {
      c.onCertificateInstalled(primaryName, names);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, contributor: c.id }, 'edge contributor: onCertificateInstalled failed');
    }
  }
}
