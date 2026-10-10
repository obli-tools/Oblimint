import type { Request } from 'express';
import type { CertificateListItem, CertificateStatus, ImportedCertificate, ImportedCertificateInput } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { seal } from '../../utils/secretBox';
import { clientCertificateError } from '../edge/certificateMessages';
import { assertNeedSomewhere, loadAccount, scopeToActor, type HostingActor } from '../hosting/access';
import { localPaths } from '../hosting/paths';
import { loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { auditProxy, emitProxy, lockAccount } from './common';
import { proxyDeps } from './deps';
import { namesNotOwned, parseImportedCertificate, removeImportedCertificateFiles, writeImportedCertificateFiles } from './importedCerts';
import { isoNow, iso, stringArray, type ImportedCertDbRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Certificates seen by the proxy objects (docs/P4b-PLAN.md §6.3, §8.1):
// GET lists the ACME rows (P1/P2) of the visible domains + the imported
// certificates; import / delete of imported certificates (proxy.manage).
// ─────────────────────────────────────────────────────────────────────────────

export interface CertificateListQuery {
  accountId?: number | null;
  tenantId?: number | null;
  status?: CertificateStatus | null;
}

const importedStatus = (notAfter: Date | string | null): CertificateStatus =>
  (notAfter && new Date(notAfter).getTime() > Date.now() ? 'valid' : 'expired');

async function importedUsage(ids: number[]): Promise<Map<number, Array<{ id: number; name: string }>>> {
  const out = new Map<number, Array<{ id: number; name: string }>>();
  if (!ids.length) return out;
  const rows = await db('proxy_hosts').whereIn('imported_certificate_id', ids).select('id', 'name', 'imported_certificate_id') as
    Array<{ id: number; name: string; imported_certificate_id: number }>;
  for (const r of rows) {
    const list = out.get(Number(r.imported_certificate_id)) ?? [];
    list.push({ id: Number(r.id), name: r.name });
    out.set(Number(r.imported_certificate_id), list);
  }
  return out;
}

function toImported(r: ImportedCertDbRow, usedBy: number): ImportedCertificate {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    name: r.name,
    names: stringArray(r.names),
    issuer: r.issuer,
    notBefore: iso(r.not_before),
    notAfter: iso(r.not_after),
    usedBy,
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  };
}

export const proxyCertificatesService = {
  async list(actor: HostingActor, q: CertificateListQuery): Promise<CertificateListItem[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    // ACME rows of the visible domains.
    const acmeQ = db('certificates as c').join('domains as d', 'd.id', 'c.domain_id').join('hosting_accounts as a', 'a.id', 'd.account_id')
      .select('c.id', 'c.domain_id', 'c.primary_name', 'c.names', 'c.status', 'c.issuer', 'c.not_after', 'c.last_error', 'd.name as domain_name',
        'd.account_id', 'd.tenant_id', 'd.served_by', 'a.username as account_username');
    scopeToActor(actor, acmeQ, { tenant: 'd.tenant_id', account: 'd.account_id' }, q.tenantId ?? null);
    if (q.accountId) acmeQ.where('d.account_id', q.accountId);
    if (q.status) acmeQ.where('c.status', q.status);
    const acme = await acmeQ.orderBy('c.primary_name') as Array<{
      id: number; domain_id: number; primary_name: string; names: unknown; status: CertificateStatus; issuer: string | null; not_after: Date | string | null;
      last_error: string | null; domain_name: string; account_id: number; tenant_id: number; served_by: string; account_username: string;
    }>;
    const domainIds = acme.map((c) => Number(c.domain_id));
    const bindings = domainIds.length
      ? await db('edge_domain_bindings').whereIn('domain_id', domainIds).select('domain_id', 'kind', 'ref_id') as Array<{ domain_id: number; kind: string; ref_id: number }>
      : [];
    const hostIds = bindings.filter((b) => b.kind === 'proxy').map((b) => Number(b.ref_id));
    const hostNames = new Map<number, string>();
    if (hostIds.length) for (const h of await db('proxy_hosts').whereIn('id', hostIds).select('id', 'name') as Array<{ id: number; name: string }>) hostNames.set(Number(h.id), h.name);
    const items: CertificateListItem[] = acme.map((c) => {
      const b = bindings.find((x) => Number(x.domain_id) === Number(c.domain_id));
      const usedBy: CertificateListItem['usedBy'] = !b
        ? [{ kind: 'site-domain', id: Number(c.domain_id), name: c.domain_name }]
        : [{
          kind: b.kind === 'proxy' ? 'proxy-host' : b.kind === 'redirect' ? 'redirection' : 'dead-host',
          id: Number(b.ref_id),
          name: b.kind === 'proxy' ? (hostNames.get(Number(b.ref_id)) ?? c.domain_name) : c.domain_name,
        }];
      return {
        kind: 'acme',
        id: Number(c.id),
        tenantId: Number(c.tenant_id),
        accountId: Number(c.account_id),
        accountUsername: c.account_username,
        primaryName: c.primary_name,
        names: stringArray(c.names),
        status: c.status,
        issuer: c.issuer,
        notAfter: iso(c.not_after),
        lastError: actor.kind === 'client' ? clientCertificateError(c.last_error) : c.last_error,
        domainId: Number(c.domain_id),
        usedBy,
      };
    });
    // Imported certificates.
    const impQ = db('imported_certificates as i').join('hosting_accounts as a', 'a.id', 'i.account_id').select('i.*', 'a.username as account_username');
    scopeOwned(actor, impQ, 'i', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) impQ.where('i.account_id', q.accountId);
    const imported = await impQ.orderBy('i.name') as Array<ImportedCertDbRow & { account_username: string }>;
    const usage = await importedUsage(imported.map((r) => Number(r.id)));
    for (const r of imported) {
      const status = importedStatus(r.not_after);
      if (q.status && q.status !== status) continue;
      const names = stringArray(r.names);
      items.push({
        kind: 'imported',
        id: Number(r.id),
        tenantId: Number(r.tenant_id),
        accountId: Number(r.account_id),
        accountUsername: r.account_username,
        primaryName: names[0] ?? r.name,
        names,
        status,
        issuer: r.issuer,
        notAfter: iso(r.not_after),
        lastError: null,
        domainId: null,
        usedBy: (usage.get(Number(r.id)) ?? []).map((h) => ({ kind: 'proxy-host' as const, id: h.id, name: h.name })),
      });
    }
    return items;
  },

  async import(req: Request, actor: HostingActor, body: ImportedCertificateInput): Promise<ImportedCertificate> {
    const account = await loadAccount(actor, body.accountId, 'proxy.manage');
    const parsed = parseImportedCertificate(body.certificatePem, body.privateKeyPem, body.chainPem ?? null);
    const verified = await db('domains').where({ account_id: account.id, verification_status: 'verified' }).pluck('name') as string[];
    const foreign = namesNotOwned(parsed.names, verified);
    if (foreign.length) {
      throw new AppError(403, 'The certificate covers names that are not verified domains of this account', 'certificateNamesNotOwned', { names: foreign });
    }
    const [row] = await db('imported_certificates').insert({
      tenant_id: account.tenant_id, account_id: account.id, name: body.name.trim(), names: JSON.stringify(parsed.names),
      certificate_pem: parsed.leafPem, chain_pem: parsed.chainPem, private_key_sealed: seal('proxy-cert', parsed.privateKey),
      issuer: parsed.issuer, not_before: parsed.notBefore, not_after: parsed.notAfter,
    }).returning('id') as Array<{ id: number }>;
    const id = Number(row.id);
    try {
      writeImportedCertificateFiles(localPaths.edgeCerts(), id, parsed.fullchain, parsed.privateKey);
    } catch (err) {
      // Re-written from the database by the edge unit provider (files missing ⇒ restored before use).
      logger.warn({ err: (err as Error).message, id }, 'proxy: imported certificate files not written yet');
    }
    await auditProxy(req, account.tenant_id, 'proxy.certificate.import', 'imported_certificate', id, {
      accountId: account.id, name: body.name, names: parsed.names, notAfter: parsed.notAfter.toISOString(),
    });
    emitProxy('certificate', id, { tenantId: account.tenant_id, accountId: account.id }, 'created');
    proxyDeps().scheduleEdgeSync(`imported certificate ${id}`);
    return toImported(await db('imported_certificates').where({ id }).first() as ImportedCertDbRow, 0);
  },

  async removeImported(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadOwned(actor, 'imported_certificates', id, 'proxy.manage', 'Certificate');
    // Under the account lock (host saves re-check their certificate FOR SHARE in the same lock): never an
    // ON DELETE SET NULL leaving a host in ssl mode 'imported' without its certificate.
    await db.transaction(async (trx) => {
      await lockAccount(trx, Number(row.account_id));
      await trx('imported_certificates').where({ id }).forUpdate().first('id');
      const used = Number(((await trx('proxy_hosts').where({ imported_certificate_id: id }).count('* as c').first()) as { c: unknown }).c);
      if (used > 0) throw new AppError(409, 'This certificate is used by proxy hosts', 'certificateInUse', { usedBy: used });
      await trx('imported_certificates').where({ id, tenant_id: row.tenant_id }).del();
    });
    try { removeImportedCertificateFiles(localPaths.edgeCerts(), id); } catch (err) { logger.warn({ err: (err as Error).message, id }, 'proxy: certificate files not removed'); }
    await auditProxy(req, Number(row.tenant_id), 'proxy.certificate.delete', 'imported_certificate', id, { accountId: row.account_id });
    emitProxy('certificate', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'deleted');
  },
};
