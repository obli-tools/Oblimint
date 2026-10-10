import type { Knex } from 'knex';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { platformSettings } from '../platformSettings';
import { notify } from '../usage/notifications.service';

// ─────────────────────────────────────────────────────────────────────────────
// Certificate expiry notifications (docs/P4b-PLAN.md §10.5): a daily pass
// over the ACME certificates (P1 / P2 / P4 rows) and the imported ones
// (proxy-hosts) expiring within settings.monitoring.certExpiryWarningDays ⇒
// notify('certificate.expiringSoon'), at most once per certificate (and
// expiry date) per 7 days. The marks live in app_config
// `monitoring.certExpiryNotified` (JSON { "<kind>:<id>": ISO }) so a panel
// restart does not notify again.
// ─────────────────────────────────────────────────────────────────────────────

export const CERT_NOTIFIED_KEY = 'monitoring.certExpiryNotified';
export const RENOTIFY_MS = 7 * 86_400_000;
/** Certificates expired longer ago than this are no longer reported (renewal abandoned, row stale). */
const EXPIRED_GRACE_MS = 30 * 86_400_000;

export interface ExpiringCertificate {
  /** 'acme:<id>' | 'imported:<id>' */
  ref: string;
  name: string;
  notAfter: Date;
  tenantId: number;
  accountId: number | null;
}

/** Certificates to notify now (pure): not marked within RENOTIFY_MS. */
export function dueNotifications(certs: readonly ExpiringCertificate[], marks: Readonly<Record<string, string>>, now: Date): ExpiringCertificate[] {
  return certs.filter((c) => {
    const last = Date.parse(marks[c.ref] ?? '');
    return !Number.isFinite(last) || now.getTime() - last >= RENOTIFY_MS;
  });
}

/** Marks kept: certificates still expiring, marked within the last 30 days (pure). */
export function prunedMarks(marks: Readonly<Record<string, string>>, stillExpiring: ReadonlySet<string>, now: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, at] of Object.entries(marks)) {
    const t = Date.parse(at);
    if (stillExpiring.has(ref) && Number.isFinite(t) && now.getTime() - t < 30 * 86_400_000) out[ref] = at;
  }
  return out;
}

export async function expiringCertificates(warningDays: number, now: Date, conn: Knex = db): Promise<ExpiringCertificate[]> {
  const until = new Date(now.getTime() + Math.max(1, warningDays) * 86_400_000);
  const since = new Date(now.getTime() - EXPIRED_GRACE_MS);
  const acme = await conn('certificates as c')
    .leftJoin('domains as d', 'd.id', 'c.domain_id')
    .leftJoin('sites as s', 's.id', 'c.site_id')
    .whereIn('c.status', ['valid', 'expired'])
    .whereNotNull('c.not_after').andWhere('c.not_after', '<=', until).andWhere('c.not_after', '>', since)
    .select('c.id', 'c.primary_name', 'c.not_after', 'd.tenant_id as d_tenant', 'd.account_id as d_account', 's.tenant_id as s_tenant', 's.account_id as s_account') as
    Array<{ id: number; primary_name: string; not_after: Date | string; d_tenant: number | null; d_account: number | null; s_tenant: number | null; s_account: number | null }>;
  const imported = await conn('imported_certificates')
    .whereNotNull('not_after').andWhere('not_after', '<=', until).andWhere('not_after', '>', since)
    .select('id', 'name', 'not_after', 'tenant_id', 'account_id') as
    Array<{ id: number; name: string; not_after: Date | string; tenant_id: number; account_id: number }>;
  return [
    ...acme.map((c) => ({
      ref: `acme:${c.id}`,
      name: c.primary_name,
      notAfter: new Date(c.not_after),
      tenantId: Number(c.d_tenant ?? c.s_tenant ?? MASTER_TENANT_ID),
      accountId: c.d_account ?? c.s_account ?? null,
    })),
    ...imported.map((c) => ({
      ref: `imported:${c.id}`,
      name: c.name,
      notAfter: new Date(c.not_after),
      tenantId: Number(c.tenant_id),
      accountId: Number(c.account_id),
    })),
  ].map((c) => ({ ...c, accountId: c.accountId === null ? null : Number(c.accountId) }));
}

async function loadMarks(conn: Knex): Promise<Record<string, string>> {
  const row = await conn('app_config').where({ key: CERT_NOTIFIED_KEY }).first('value') as { value: string | null } | undefined;
  if (!row?.value) return {};
  try {
    const v = JSON.parse(row.value) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The daily pass. Returns the refs notified. Throws on database errors (the worker logs). */
export async function runCertExpiryPass(now: Date = new Date(), conn: Knex = db): Promise<string[]> {
  const { certExpiryWarningDays } = await platformSettings.section('monitoring');
  const certs = await expiringCertificates(certExpiryWarningDays, now, conn);
  const marks = await loadMarks(conn);
  const due = dueNotifications(certs, marks, now);
  const next = prunedMarks(marks, new Set(certs.map((c) => c.ref)), now);
  for (const c of due) {
    const days = Math.ceil((c.notAfter.getTime() - now.getTime()) / 86_400_000);
    notify('certificate.expiringSoon', {
      tenantId: c.tenantId,
      accountId: c.accountId,
      key: `cert:${c.ref}:${c.notAfter.toISOString()}`,
      title: days > 0 ? `Le certificat ${c.name} expire dans ${days} jour(s)` : `Le certificat ${c.name} a expiré`,
      message: `Le certificat ${c.name} ${days > 0 ? 'expire' : 'a expiré'} le ${c.notAfter.toISOString().slice(0, 10)}. `
        + 'Vérifiez son renouvellement (DNS, domaine vérifié) ou importez un certificat à jour.',
      severity: days <= 3 ? 'critical' : 'warning',
      platform: c.accountId === null,
      link: c.ref.startsWith('imported:') ? '/proxy?tab=certificates' : null,
    });
    next[c.ref] = now.toISOString();
  }
  await conn('app_config').insert({ key: CERT_NOTIFIED_KEY, value: JSON.stringify(next) }).onConflict('key').merge();
  if (due.length > 0) logger.info({ count: due.length }, 'Certificate expiry notifications queued');
  return due.map((c) => c.ref);
}
