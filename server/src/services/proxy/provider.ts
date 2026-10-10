import type { EdgeSettings } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { open } from '../../utils/secretBox';
import { localNodeId } from '../docker/engine';
import { edgeCertPaths } from '../edge/nginxConfig';
import type { EdgeConfigUnit, EdgeUnitContext, EdgeUnitProvider } from '../edge/units';
import { SERVED_ACCOUNT_STATUSES, certCovers, domainServerNames, isReservedPlatformName, type PlanCertificate } from '../edge/vhostPlan';
import { appServiceAlias, siteContainer } from '../hosting/naming';
import { json, planLimits } from '../hosting/rows';
import { localPaths } from '../hosting/paths';
import { edgeSettings } from './common';
import { proxyDeps } from './deps';
import { normalizeIp } from './targets';
import { fingerprintOf, forbiddenCidrs, pinnedNames, resolveExternal, type ExternalResolution } from './externalTargets';
import { importedCertificateFilesExist, writeImportedCertificateFiles } from './importedCerts';
import type { RenderAccessList } from './render/accessLists';
import { importedCertPaths } from './render/common';
import { PAGE_APP_NAME } from './lists.service';
import { ProxyRenderError, renderProxyHostUnit, type RenderDomain, type RenderTarget } from './render/proxyHost';
import { renderDeadHostUnit, renderRedirectionUnit } from './render/simpleHosts';
import { renderGlobalProxyUnit, renderStreamUnit } from './render/streamAndGlobal';
import {
  numberArray, stringArray, toAuthExtras, toHoneypot, toOptions, toRules, toSsl, toTarget, toUsers, type AccessListDbRow, type BoundDomainDbRow,
  type CustomPageDbRow, type DeadHostDbRow, type ImportedCertDbRow, type ProxyHostDbRow, type ProxyRouteDbRow, type RedirectionDbRow,
  type StreamDbRow,
} from './rows';
import type { AppTargetInfo } from '../apps/apps.service';
import type { EdgeUnitOwnerKind, ProxyTarget } from '@oblimint/shared';
import type { PipelineUnit } from '../edge/pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Edge unit provider 'proxy' (docs/P4b-PLAN.md §8.2, edge/units.ts): reads the
// proxy objects of the LOCAL node's served accounts and renders them with the
// pure renderers: g-proxy (global), ph-<id>, rd-<id>, dh-<id>, st-<id>.
// A server name already in ctx.claimed (P1 vhosts, contributors) or claimed
// by an earlier object is DROPPED and reported (log + renderProblems, shown
// on the object); an object whose rendering fails (invalid stored value,
// external target refused / unresolved) is still emitted, flagged
// `invalidReason` (pipeline contract): edge-robustness keeps its last good
// version (or the 503 stub keeping its names) and records the error on its
// state. Unverified domains are never served (D1). Suspended accounts, and
// external targets no longer allowed by the plan ∧ tenant policy (PX2,
// re-checked at every pass): units flagged disabled (503 stub keeping the
// names). External names are resolved and validated HERE and rendered as
// their address (DNS rebinding, externalTargets.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Last problems by unit id (dropped names, render errors, policy) — shown on the object. */
export interface RenderProblem {
  message: string;
  /** Safe to show to the account (else a generic label, A6). */
  public: boolean;
}
export const renderProblems = new Map<string, RenderProblem>();

/** The problem of a unit at the last provider pass (null = none). */
export function proxyUnitProblem(unitId: string): RenderProblem | null {
  return renderProblems.get(unitId) ?? null;
}

interface Loaded {
  settings: EdgeSettings;
  hosts: Array<ProxyHostDbRow & { account_status: string }>;
  redirections: Array<RedirectionDbRow & { account_status: string }>;
  deadHosts: Array<DeadHostDbRow & { account_status: string }>;
  streams: Array<StreamDbRow & { account_status: string | null }>;
  bindings: BoundDomainDbRow[];
  routes: ProxyRouteDbRow[];
  hostLists: Array<{ proxy_host_id: number; access_list_id: number }>;
  lists: Map<number, { accountId: number; list: RenderAccessList }>;
  pages: Map<number, CustomPageDbRow>;
  imported: Map<number, ImportedCertDbRow>;
  targets: Map<string, AppTargetInfo | null>;
  /** External targets: host|allowPrivate → resolution of this pass. */
  external: Map<string, ExternalResolution>;
  /** Account → external targets allowed (plan proxyExternalTargets ∧ tenant policy); an Error when the policy is unknown. */
  externalAllowed: Map<number, boolean | Error>;
}

const externalKey = (t: ProxyTarget) => `${String(t.host ?? '').trim().toLowerCase().replace(/\.$/, '')}|${t.allowPrivate ? 1 : 0}`;

const targetKey = (stackId: number, service: string) => `${stackId}/${service}`;

async function load(): Promise<Loaded> {
  const nodeId = await localNodeId();
  const statuses = [...SERVED_ACCOUNT_STATUSES];
  const settings = await edgeSettings();
  const byAccount = (table: string, alias: string) => db(`${table} as ${alias}`).join('hosting_accounts as a', 'a.id', `${alias}.account_id`)
    .where('a.node_id', nodeId).whereIn('a.status', statuses).select(`${alias}.*`, 'a.status as account_status');
  const [hosts, redirections, deadHosts] = await Promise.all([
    byAccount('proxy_hosts', 'h').orderBy('h.id') as Promise<Loaded['hosts']>,
    byAccount('proxy_redirections', 'r').orderBy('r.id') as Promise<Loaded['redirections']>,
    byAccount('proxy_dead_hosts', 'x').orderBy('x.id') as Promise<Loaded['deadHosts']>,
  ]);
  const streams = await db('proxy_streams as s').leftJoin('hosting_accounts as a', 'a.id', 's.account_id')
    .where((b) => { b.whereNull('s.account_id').orWhere((c) => { c.where('a.node_id', nodeId).whereIn('a.status', statuses); }); })
    .select('s.*', 'a.status as account_status').orderBy('s.id') as Loaded['streams'];
  const bindings = await db('edge_domain_bindings as b').join('domains as d', 'd.id', 'b.domain_id')
    .select('b.domain_id', 'b.kind', 'b.ref_id', 'd.name', 'd.include_www', 'd.wildcard', 'd.tls_mode', 'd.verification_status', 'd.account_id', 'd.tenant_id')
    .orderBy('d.id') as BoundDomainDbRow[];
  const hostIds = hosts.map((h) => Number(h.id));
  const routes = hostIds.length
    ? await db('proxy_routes').whereIn('proxy_host_id', hostIds).orderBy([{ column: 'sort_order' }, { column: 'id' }]) as ProxyRouteDbRow[] : [];
  const hostLists = hostIds.length
    ? await db('proxy_host_access_lists').whereIn('proxy_host_id', hostIds).select('proxy_host_id', 'access_list_id') as Loaded['hostLists'] : [];
  const listIds = [...new Set([...hostLists.map((l) => Number(l.access_list_id)), ...routes.flatMap((r) => numberArray(r.access_list_ids))])];
  const lists: Loaded['lists'] = new Map();
  if (listIds.length) {
    for (const l of await db('access_lists').whereIn('id', listIds) as AccessListDbRow[]) {
      lists.set(Number(l.id), {
        accountId: Number(l.account_id),
        list: { id: Number(l.id), name: l.name, satisfyAny: !!l.satisfy_any, passAuth: !!l.pass_auth, rules: toRules(l.rules), users: toUsers(l.users) },
      });
    }
  }
  const pageIds = new Set<number>();
  for (const h of hosts) {
    const o = toOptions(h.options);
    if (o.errorPageId) pageIds.add(Number(o.errorPageId));
    if (o.wakingPageId) pageIds.add(Number(o.wakingPageId));
  }
  for (const d of deadHosts) if (d.custom_page_id) pageIds.add(Number(d.custom_page_id));
  if (settings.defaultErrorPageId) pageIds.add(settings.defaultErrorPageId);
  if (settings.defaultWakingPageId) pageIds.add(settings.defaultWakingPageId);

  // Target infos (apps-core): sleep / waking page; unavailable → plain proxying to the service alias.
  const targets = new Map<string, AppTargetInfo | null>();
  const allTargets: ProxyTarget[] = [...hosts.map((h) => toTarget(h.target)), ...routes.map((r) => toTarget(r.target))];
  for (const t of allTargets) {
    if (t.kind !== 'app' || !t.stackId || !t.service) continue;
    const key = targetKey(Number(t.stackId), t.service);
    if (targets.has(key)) continue;
    try {
      targets.set(key, await proxyDeps().targetInfo(Number(t.stackId), t.service));
    } catch {
      targets.set(key, null);
    }
  }
  for (const info of targets.values()) if (info?.wakingPageId) pageIds.add(info.wakingPageId);
  const pages = new Map<number, CustomPageDbRow>();
  if (pageIds.size) for (const p of await db('custom_pages').whereIn('id', [...pageIds]) as CustomPageDbRow[]) pages.set(Number(p.id), p);

  const certIds = [...new Set(hosts.map((h) => h.imported_certificate_id).filter((x): x is number => x !== null).map(Number))];
  const imported = new Map<number, ImportedCertDbRow>();
  if (certIds.length) for (const c of await db('imported_certificates').whereIn('id', certIds) as ImportedCertDbRow[]) imported.set(Number(c.id), c);

  // External targets: resolved + validated now (PX2), policy of their accounts re-checked (plan ∧ tenant).
  const externalTargets: Array<{ accountId: number | null; tenantId: number; target: ProxyTarget }> = [
    ...hosts.map((h) => ({ accountId: Number(h.account_id), tenantId: Number(h.tenant_id), target: toTarget(h.target) })),
    ...routes.map((r) => {
      const h = hosts.find((x) => Number(x.id) === Number(r.proxy_host_id))!;
      return { accountId: Number(h.account_id), tenantId: Number(h.tenant_id), target: toTarget(r.target) };
    }),
    ...streams.map((st) => ({ accountId: st.account_id === null ? null : Number(st.account_id), tenantId: Number(st.tenant_id), target: toTarget(st.target) })),
  ].filter((x) => x.target.kind === 'external');
  const external = new Map<string, ExternalResolution>();
  const externalAllowed = new Map<number, boolean | Error>();
  pinnedNames.clear();
  if (externalTargets.length) {
    const forbidden = forbiddenCidrs(await proxyDeps().dockerSubnets(), await proxyDeps().nodeAddresses());
    const cache = new Map<string, Promise<ExternalResolution>>();
    for (const x of externalTargets) {
      const key = externalKey(x.target);
      if (!external.has(key)) {
        const r = await resolveExternal(String(x.target.host ?? ''), !!x.target.allowPrivate, forbidden, proxyDeps().lookup, cache);
        external.set(key, r);
        const name = key.slice(0, key.lastIndexOf('|'));
        if (!normalizeIp(name)) pinnedNames.set(key, { name, allowPrivate: !!x.target.allowPrivate, fingerprint: fingerprintOf(r) });
      }
    }
    const accountIds = [...new Set(externalTargets.map((x) => x.accountId).filter((a): a is number => a !== null))];
    if (accountIds.length) {
      const plans = await db('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').whereIn('a.id', accountIds)
        .select('a.id', 'a.tenant_id', 'p.limits') as Array<{ id: number; tenant_id: number; limits: unknown }>;
      const tenantPolicy = new Map<number, boolean | Error>();
      for (const p of plans) {
        if (!planLimits(p.limits).proxyExternalTargets) { externalAllowed.set(Number(p.id), false); continue; }
        const tid = Number(p.tenant_id);
        if (!tenantPolicy.has(tid)) {
          try {
            tenantPolicy.set(tid, await proxyDeps().allowExternalTargets(tid));
          } catch (err) {
            tenantPolicy.set(tid, err instanceof Error ? err : new Error(String(err)));
          }
        }
        externalAllowed.set(Number(p.id), tenantPolicy.get(tid)!);
      }
    }
  }

  return { settings, hosts, redirections, deadHosts, streams, bindings, routes, hostLists, lists, pages, imported, targets, external, externalAllowed };
}

function certNamesOf(c: PlanCertificate): string[] {
  const v = json<unknown>(c.names, []);
  return Array.isArray(v) ? v.map((n) => String(n).toLowerCase()) : [];
}

/** Imported certificate files present (re-written from the database when they vanished). */
function importedReady(c: ImportedCertDbRow): boolean {
  const dir = localPaths.edgeCerts();
  if (importedCertificateFilesExist(dir, Number(c.id))) return true;
  try {
    const key = open('proxy-cert', c.private_key_sealed);
    writeImportedCertificateFiles(dir, Number(c.id), `${c.certificate_pem.trim()}\n${c.chain_pem ?? ''}`, key);
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message, id: c.id }, 'proxy: imported certificate files cannot be restored');
    return false;
  }
}

export async function buildProxyUnits(ctx: EdgeUnitContext): Promise<EdgeConfigUnit[]> {
  const data = await load();
  const s = data.settings;
  const claimed = new Set(ctx.claimed);
  renderProblems.clear();
  const units: EdgeConfigUnit[] = [];
  const problem = (unitId: string, message: string, isPublic: boolean) => {
    const prev = renderProblems.get(unitId);
    renderProblems.set(unitId, prev ? { message: `${prev.message}; ${message}`, public: prev.public && isPublic } : { message, public: isPublic });
  };

  const domainsOf = (kind: string, refId: number, accountId: number, unitId: string,
    tlsFor: (b: BoundDomainDbRow, names: string[]) => { tls: RenderDomain['tls']; coversAll: boolean }): RenderDomain[] => {
    const out: RenderDomain[] = [];
    const dropped: string[] = [];
    for (const b of data.bindings.filter((x) => x.kind === kind && Number(x.ref_id) === refId)) {
      // Defence in depth: a binding of another account or an unverified domain is never served (PX1, D1).
      if (Number(b.account_id) !== accountId || b.verification_status !== 'verified') continue;
      const names = domainServerNames({ name: b.name, include_www: b.include_www, wildcard: !!b.wildcard }, { wildcard: !!b.wildcard })
        .filter((n) => n.startsWith('*.') || !isReservedPlatformName(n, ctx.platform))
        .filter((n) => {
          if (claimed.has(n)) { dropped.push(n); return false; }
          return true;
        });
      if (!names.length || (names.length === 1 && names[0].startsWith('*.'))) continue;
      names.forEach((n) => claimed.add(n));
      const { tls, coversAll } = tlsFor(b, names);
      out.push({ domainId: Number(b.domain_id), name: b.name, serverNames: names, tls, tlsCoversAll: coversAll });
    }
    if (dropped.length) {
      problem(unitId, `server names already served elsewhere: ${dropped.join(', ')}`, true);
      logger.warn({ unitId, dropped }, 'proxy: server names already claimed, dropped from the unit');
    }
    return out;
  };

  const acmeTls = (b: BoundDomainDbRow, names: string[]) => {
    if (b.tls_mode !== 'letsencrypt') return { tls: null, coversAll: false };
    const cert = ctx.certificates.find((c) => Number(c.domain_id) === Number(b.domain_id));
    if (!cert || cert.status !== 'valid' || !ctx.certFilesExist(cert.primary_name)) return { tls: null, coversAll: false };
    const covered = certNamesOf(cert);
    return { tls: edgeCertPaths(cert.primary_name), coversAll: names.every((n) => certCovers(covered, n)) };
  };

  interface UnitBase {
    unitId: string;
    scope: 'http' | 'stream';
    owner: { kind: EdgeUnitOwnerKind; id: number; accountId: number | null; tenantId: number; label: string };
    domains: RenderDomain[];
    listen: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
  }

  /**
   * The unit of an object that cannot be rendered as configured: disabled (503 stub keeping the names, nothing
   * for a stream) or invalid (pipeline `invalidReason`: last good version kept, else the stub). The names /
   * ports stay claimed: the object never silently leaves the edge.
   */
  const placeholder = (b: UnitBase, mode: 'disabled' | 'invalid', reason: string): EdgeConfigUnit | null => {
    const serverNames = b.domains.flatMap((d) => d.serverNames);
    if (b.scope === 'http' && !serverNames.length) return null;
    if (b.scope === 'stream' && !b.listen.length) return null;
    const unit: PipelineUnit = {
      id: b.unitId,
      scope: b.scope,
      level: 'server',
      owner: { ...b.owner, label: b.scope === 'http' ? serverNames[0] : b.owner.label },
      serverNames: b.scope === 'http' ? serverNames : [],
      listen: b.scope === 'stream' ? b.listen : [],
      tls: b.domains.map((d) => d.tls).find((t) => !!t) ?? null,
      config: '',
      files: {},
      upstreams: [],
      rawSnippets: [],
      ...(mode === 'disabled' ? { disabled: true } : { invalidReason: reason.slice(0, 500) }),
    };
    return unit;
  };

  const render = (b: UnitBase, fn: () => EdgeConfigUnit | null) => {
    try {
      const u = fn();
      if (u) units.push(u);
    } catch (err) {
      const msg = err instanceof ProxyRenderError ? err.message : `render failed: ${(err as Error)?.message}`;
      problem(b.unitId, msg, false);
      logger.warn({ unitId: b.unitId, err: msg }, 'proxy: unit not rendered (last good version kept)');
      const u = placeholder(b, 'invalid', msg);
      if (u) units.push(u);
    }
  };

  /**
   * External targets of an object (PX2, at every pass): policy (plan + tenant) first, refused = disabled;
   * then the resolution, refused / unresolved = invalid (last good version, pinned to its old address).
   */
  const externalGate = (b: UnitBase, accountId: number | null, targets: ProxyTarget[]): 'ok' | 'disabled' | 'invalid' => {
    const ext = targets.filter((t) => t.kind === 'external');
    if (!ext.length) return 'ok';
    if (accountId !== null) {
      const allowed = data.externalAllowed.get(accountId);
      if (allowed instanceof Error || allowed === undefined) {
        problem(b.unitId, 'external target policy unavailable (retried at the next pass)', true);
        return 'invalid';
      }
      if (!allowed) {
        problem(b.unitId, 'external targets are no longer allowed for this account (plan / tenant policy)', true);
        return 'disabled';
      }
    }
    for (const t of ext) {
      const r = data.external.get(externalKey(t));
      if (!r || r.problem || !r.address) {
        problem(b.unitId, r?.problem ?? 'external target not resolved', true);
        return 'invalid';
      }
    }
    return 'ok';
  };

  const gated = (b: UnitBase, accountId: number | null, targets: ProxyTarget[], disabled: boolean, fn: () => EdgeConfigUnit | null) => {
    const gate = disabled ? 'ok' : externalGate(b, accountId, targets);
    if (gate !== 'ok') {
      const reason = renderProblems.get(b.unitId)?.message ?? gate;
      logger.warn({ unitId: b.unitId, gate, reason }, 'proxy: external target not served');
      const u = placeholder(b, gate, reason);
      if (u) units.push(u);
      return;
    }
    render(b, fn);
  };

  const renderTarget = (t: ProxyTarget): RenderTarget => {
    if (t.kind === 'app') {
      const info = data.targets.get(targetKey(Number(t.stackId), String(t.service))) ?? null;
      return {
        scheme: t.scheme, host: info?.alias ?? appServiceAlias(Number(t.stackId), String(t.service)), port: t.port, internal: true,
        appStackId: Number(t.stackId), sleepEnabled: !!info?.sleepEnabled,
      };
    }
    if (t.kind === 'site') return { scheme: 'http', host: siteContainer(Number(t.siteId)), port: t.port, internal: true, appStackId: null, sleepEnabled: false };
    // External: the address validated at this pass (never a name nginx would resolve again).
    return {
      scheme: t.scheme, host: String(t.host ?? ''), address: data.external.get(externalKey(t))?.address ?? null, port: t.port, internal: false,
      appStackId: null, sleepEnabled: false,
    };
  };

  // Lists of another account are ignored (defence in depth: checked at save time).
  const listsFor = (ids: number[], accountId: number): RenderAccessList[] => ids
    .map((id) => data.lists.get(id))
    .filter((l): l is { accountId: number; list: RenderAccessList } => !!l && l.accountId === accountId)
    .map((l) => l.list);

  const page = (id: number | null | undefined, accountId: number, tenantId: number): CustomPageDbRow | null => {
    if (!id) return null;
    const p = data.pages.get(Number(id));
    if (!p) return null;
    // Own page, or a platform page of the tenant / of the platform.
    if (p.account_id !== null ? Number(p.account_id) === accountId : [tenantId, 1].includes(Number(p.tenant_id))) return p;
    return null;
  };

  // ── proxy hosts ──
  const rateLimited: Array<{ hostId: number; rps: number }> = [];
  for (const h of data.hosts) {
    const id = Number(h.id);
    const accountId = Number(h.account_id);
    const tenantId = Number(h.tenant_id);
    const unitId = `ph-${id}`;
    const ssl = toSsl(h.ssl, h.imported_certificate_id === null ? null : Number(h.imported_certificate_id));
    const imported = ssl.mode === 'imported' && ssl.importedCertificateId ? data.imported.get(ssl.importedCertificateId) : undefined;
    const importedOk = !!imported && Number(imported.account_id) === accountId && importedReady(imported);
    const tlsFor = (b: BoundDomainDbRow, names: string[]) => {
      if (ssl.mode === 'none') return { tls: null, coversAll: false };
      if (ssl.mode === 'imported') {
        if (!importedOk || !imported) return { tls: null, coversAll: false };
        const covered = stringArray(imported.names);
        return { tls: importedCertPaths(Number(imported.id)), coversAll: names.every((n) => certCovers(covered, n)) };
      }
      return acmeTls(b, names);
    };
    const domains = domainsOf('proxy', id, accountId, unitId, tlsFor);
    const options = toOptions(h.options);
    const hostRoutes = data.routes.filter((r) => Number(r.proxy_host_id) === id);
    const rawTarget = toTarget(h.target);
    const target = renderTarget(rawTarget);
    const info = target.appStackId ? data.targets.get(targetKey(target.appStackId, String(rawTarget.service))) ?? null : null;
    const errorPage = page(options.errorPageId ?? s.defaultErrorPageId, accountId, tenantId);
    const wakingPage = page(options.wakingPageId ?? info?.wakingPageId ?? s.defaultWakingPageId, accountId, tenantId);
    const extras = toAuthExtras(h.auth);
    if (options.rateLimit && options.rateLimit.rps > 0) rateLimited.push({ hostId: id, rps: options.rateLimit.rps });
    const disabled = !h.enabled || h.account_status === 'suspended';
    const base: UnitBase = { unitId, scope: 'http', owner: { kind: 'proxy-host', id, accountId, tenantId, label: h.name }, domains, listen: [] };
    gated(base, accountId, [rawTarget, ...hostRoutes.map((r) => toTarget(r.target))], disabled, () => renderProxyHostUnit({
      id, accountId, tenantId, name: h.name,
      disabled,
      domains,
      target,
      ssl,
      options,
      bodySizeMb: Math.min(options.bodySizeMb ?? s.defaultBodySizeMb, s.maxBodySizeMb),
      accessLists: listsFor(data.hostLists.filter((l) => Number(l.proxy_host_id) === id).map((l) => Number(l.access_list_id)), accountId),
      authProviderId: h.auth_provider_id === null ? null : Number(h.auth_provider_id),
      allowedGroups: extras.allowedGroups,
      allowedEmails: extras.allowedEmails,
      honeypot: toHoneypot(h.honeypot),
      routes: hostRoutes.map((r) => ({
        path: r.path,
        rewritePrefix: r.rewrite_prefix,
        target: renderTarget(toTarget(r.target)),
        authMode: r.auth_mode === 'none' ? 'none' : 'inherit',
        accessListMode: r.access_list_mode === 'none' || r.access_list_mode === 'override' ? r.access_list_mode : 'inherit',
        accessLists: r.access_list_mode === 'override' ? listsFor(numberArray(r.access_list_ids), accountId) : [],
        websocket: r.websocket,
        buffering: r.buffering,
      })),
      errorPage: errorPage ? { html: errorPage.html, codes: numberArray(errorPage.codes) } : null,
      wakingPage: wakingPage ? { html: wakingPage.html } : null,
      wakeEtaSec: info?.wakeEtaSec ?? null,
      advancedConfig: s.allowAdvancedConfig ? h.advanced_config : null,
      appName: PAGE_APP_NAME,
    }));
  }

  // ── redirections ──
  for (const r of data.redirections) {
    const id = Number(r.id);
    const ssl = json<{ forceSsl?: boolean; http2?: boolean; hsts?: boolean }>(r.ssl, {});
    const domains = domainsOf('redirect', id, Number(r.account_id), `rd-${id}`, acmeTls);
    const base: UnitBase = {
      unitId: `rd-${id}`, scope: 'http', owner: { kind: 'redirection', id, accountId: Number(r.account_id), tenantId: Number(r.tenant_id), label: `rd-${id}` },
      domains, listen: [],
    };
    render(base, () => renderRedirectionUnit({
      id, accountId: Number(r.account_id), tenantId: Number(r.tenant_id), disabled: !r.enabled || r.account_status === 'suspended', domains,
      targetScheme: r.target_scheme === 'http' || r.target_scheme === 'https' ? r.target_scheme : 'auto', targetDomain: r.target_domain,
      targetPath: r.target_path, preservePath: !!r.preserve_path, statusCode: Number(r.status_code) as 301 | 302 | 307 | 308,
      ssl: { forceSsl: ssl.forceSsl ?? true, http2: ssl.http2 ?? true, hsts: ssl.hsts ?? false },
    }));
  }

  // ── dead hosts ──
  for (const d of data.deadHosts) {
    const id = Number(d.id);
    const ssl = json<{ forceSsl?: boolean; http2?: boolean }>(d.ssl, {});
    const domains = domainsOf('dead', id, Number(d.account_id), `dh-${id}`, acmeTls);
    const p = page(d.custom_page_id ?? s.defaultErrorPageId, Number(d.account_id), Number(d.tenant_id));
    const base: UnitBase = {
      unitId: `dh-${id}`, scope: 'http', owner: { kind: 'dead-host', id, accountId: Number(d.account_id), tenantId: Number(d.tenant_id), label: `dh-${id}` },
      domains, listen: [],
    };
    render(base, () => renderDeadHostUnit({
      id, accountId: Number(d.account_id), tenantId: Number(d.tenant_id), disabled: !d.enabled || d.account_status === 'suspended', domains,
      ssl: { forceSsl: ssl.forceSsl ?? false, http2: ssl.http2 ?? true }, page: p ? { html: p.html } : null,
      appName: PAGE_APP_NAME,
    }));
  }

  // ── streams ──
  for (const st of data.streams) {
    const id = Number(st.id);
    const t = toTarget(st.target);
    if (t.kind === 'site') continue;
    const accountId = st.account_id === null ? null : Number(st.account_id);
    const port = Number(st.incoming_port);
    const listen = (['tcp', 'udp'] as const).filter((p) => (p === 'tcp' ? !!st.tcp : !!st.udp))
      .filter((p) => ctx.streamPorts.some((a) => a.port === port && a.protocol === p)).map((protocol) => ({ port, protocol }));
    const disabled = !st.enabled || st.account_status === 'suspended';
    const base: UnitBase = {
      unitId: `st-${id}`, scope: 'stream', owner: { kind: 'stream', id, accountId, tenantId: Number(st.tenant_id), label: `${port}` },
      domains: [], listen,
    };
    gated(base, accountId, [t], disabled, () => renderStreamUnit({
      id, accountId, tenantId: Number(st.tenant_id), name: st.name,
      disabled, incomingPort: port, tcp: !!st.tcp, udp: !!st.udp,
      target: t.kind === 'app'
        ? { scheme: 'http', host: appServiceAlias(Number(t.stackId), String(t.service)), port: t.port, internal: true, appStackId: Number(t.stackId), sleepEnabled: false }
        : renderTarget(t),
      approvedPorts: ctx.streamPorts,
    }));
  }

  return [renderGlobalProxyUnit(rateLimited), ...units];
}

export const proxyEdgeUnitProvider: EdgeUnitProvider = {
  id: 'proxy',
  units: (ctx) => buildProxyUnits(ctx),
};
