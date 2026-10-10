import {
  DB_ENGINE_VERSIONS, SITE_BASE_IDS, type MailEngine, type MailPasswordScheme, type MigrationObjectKind, type MigrationTargetCatalog,
} from '@oblimint/shared';
import { db } from '../../../db';
import { logger } from '../../../utils/logger';
import { appConfigService } from '../../appConfig.service';
import { planLimits } from '../../hosting/rows';
import { platformSettings } from '../../platformSettings';
import { migrationObjectMap } from '../objectMap';
import type { PlanTargetContext, TargetDbInstanceFact } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Reads the Oblimint side for the planner (docs/P5-PLAN.md §8.1): catalog of
// GET /targets + the facts computePlan checks against (names, domains, slugs,
// instances, object map of the source). Read-only; never throws for an
// optional fact (mail engine, tenant app policy): absent = conservative value.
// ─────────────────────────────────────────────────────────────────────────────

async function mailFacts(): Promise<{ engine: MailEngine | null; schemes: MailPasswordScheme[] }> {
  try {
    const { activeMailDriver } = await import('../../mail/registry');
    const driver = await activeMailDriver();
    return { engine: driver.engine, schemes: [...(driver.capabilities?.passwordSchemes ?? [])] };
  } catch (err) {
    logger.debug({ err }, 'migration planner: mail engine unavailable');
    return { engine: null, schemes: [] };
  }
}

async function externalTargetsPolicy(tenantIds: number[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  let effective: ((tenantId: number) => Promise<{ allowExternalProxyTargets?: boolean }>) | null = null;
  try {
    const { appPolicyService } = await import('../../apps/policy.service');
    effective = (tid) => appPolicyService.effective(tid);
  } catch (err) {
    logger.debug({ err }, 'migration planner: apps policy unavailable');
  }
  for (const id of tenantIds) {
    try {
      out[String(id)] = effective ? (await effective(id)).allowExternalProxyTargets === true : false;
    } catch {
      out[String(id)] = false;
    }
  }
  return out;
}

export async function loadTargetCatalog(): Promise<MigrationTargetCatalog> {
  const [tenants, plans, nodes, mail, ipv4, ipv6, dns] = await Promise.all([
    db('tenants').select('id', 'name').orderBy('id') as Promise<Array<{ id: number; name: string }>>,
    db('plans').select('id', 'tenant_id', 'name', 'limits').orderBy([{ column: 'tenant_id' }, { column: 'name' }]) as Promise<Array<{ id: number; tenant_id: number; name: string; limits: unknown }>>,
    db('nodes').select('id', 'name').orderBy('id') as Promise<Array<{ id: number; name: string }>>,
    mailFacts(),
    appConfigService.get('public_ipv4'),
    appConfigService.get('public_ipv6'),
    platformSettings.section('dns'),
  ]);
  return {
    tenants: tenants.map((t) => ({ id: Number(t.id), name: t.name })),
    plans: plans.map((p) => ({ id: Number(p.id), tenantId: Number(p.tenant_id), name: p.name, limits: planLimits(p.limits) })),
    nodes: nodes.map((n) => ({ id: Number(n.id), name: n.name })),
    bases: [...SITE_BASE_IDS],
    dbVersions: DB_ENGINE_VERSIONS.filter((v) => v.engine !== 'postgresql')
      .map((v) => ({ engine: v.engine, version: v.version, nativeHashes: v.engine === 'mariadb' })),
    mailEngine: mail.engine,
    mailPasswordSchemes: mail.schemes,
    platformIpv4: ipv4?.trim() || null,
    platformIpv6: ipv6?.trim() || null,
    nameservers: [...(dns.nameservers ?? [])],
    dnsEnabled: dns.enabled !== false,
  };
}

/** Catalog + platform facts + the object map of the source (objects of earlier runs are reused, not conflicts). */
export async function loadTargetContext(sourceId: number, now: Date = new Date()): Promise<PlanTargetContext> {
  const catalog = await loadTargetCatalog();
  const mapEntries = await migrationObjectMap.list(sourceId);
  const [accounts, domains, sites, instances, databases, externalTargetsByTenant] = await Promise.all([
    db('hosting_accounts').select('id', 'tenant_id', 'username', 'plan_id') as Promise<Array<{ id: number; tenant_id: number; username: string; plan_id: number }>>,
    db('domains').select('id', 'name', 'account_id', 'tenant_id') as Promise<Array<{ id: number; name: string; account_id: number; tenant_id: number }>>,
    db('sites').select('id', 'account_id', 'slug') as Promise<Array<{ id: number; account_id: number; slug: string }>>,
    db('db_instances').select('id', 'account_id', 'tenant_id', 'name', 'engine', 'version') as Promise<Array<{ id: number; account_id: number; tenant_id: number; name: string; engine: string; version: string }>>,
    db('db_databases').select('id', 'instance_id', 'name') as Promise<Array<{ id: number; instance_id: number; name: string }>>,
    externalTargetsPolicy(catalog.tenants.map((t) => t.id)),
  ]);
  const byInstance = new Map<number, Array<{ id: number; name: string }>>();
  for (const d of databases) {
    const list = byInstance.get(Number(d.instance_id)) ?? [];
    list.push({ id: Number(d.id), name: d.name });
    byInstance.set(Number(d.instance_id), list);
  }
  const dbInstances: TargetDbInstanceFact[] = instances.map((i) => ({
    id: Number(i.id), accountId: Number(i.account_id), tenantId: Number(i.tenant_id), name: i.name, engine: i.engine, version: i.version,
    databases: byInstance.get(Number(i.id)) ?? [],
  }));
  return {
    catalog,
    externalTargetsByTenant,
    accounts: accounts.map((a) => ({ id: Number(a.id), tenantId: Number(a.tenant_id), username: a.username, planId: Number(a.plan_id) })),
    domains: domains.map((d) => ({ id: Number(d.id), name: String(d.name).toLowerCase(), accountId: Number(d.account_id), tenantId: Number(d.tenant_id) })),
    sites: sites.map((s) => ({ id: Number(s.id), accountId: Number(s.account_id), slug: s.slug })),
    dbInstances,
    objectMap: mapEntries.map((e) => ({ kind: e.kind as MigrationObjectKind, sourceKey: e.sourceKey, targetId: e.targetId, cwpUsername: e.cwpUsername })),
    now: now.toISOString(),
  };
}
