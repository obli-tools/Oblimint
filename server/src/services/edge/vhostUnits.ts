import type { EdgeUnitOwnerKind } from '@oblimint/shared';
import { renderVhost, type EdgeVhost } from './nginxConfig';
import type { PipelineUnit } from './pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// P1/P2 vhosts (planVhosts + edge contributors) as edge units (docs/P4b-PLAN.md
// §8.2) — PURE. id = vhost id, rendered by nginxConfig.renderVhost; a vhost
// refused by validateVhost (H5) becomes an invalid unit (its last good
// version, or a stub keeping its valid names, is served instead).
//   d-<domainId>  site / placeholder   owner site-domain (id = domain id)
//   p-<siteId>    preview              owner site-domain (id null: no domain row)
//   pv-<previewId> release preview     owner site-domain (id null) — feature B; a kept
//                                      pv-<old> (last valid version) proxies to the
//                                      container of THAT preview only (gone: 502)
//   panel, dbadmin, probe-*            owner platform
//   m-*, w-* …    mail / webmail       owner contributed
// No upstream is declared: site containers may be stopped (P1 behaviour,
// request-time resolution), they are never probed before activation.
// ─────────────────────────────────────────────────────────────────────────────

function ownerKindOf(v: EdgeVhost): EdgeUnitOwnerKind {
  if (v.kind === 'panel' || v.kind === 'dbadmin' || v.kind === 'probe') return 'platform';
  if (v.kind === 'site' || v.kind === 'placeholder' || v.kind === 'preview') return 'site-domain';
  return 'contributed';
}

const positive = (n: unknown): number | null => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : null);

export function vhostToUnit(v: EdgeVhost): PipelineUnit {
  const ownerKind = ownerKindOf(v);
  const domainId = ownerKind === 'site-domain' && typeof v.id === 'string' ? /^d-(\d{1,10})$/.exec(v.id)?.[1] : undefined;
  let config = '';
  let invalidReason: string | null = null;
  try {
    config = renderVhost(v);
  } catch (err) {
    invalidReason = (err as Error).message.slice(0, 500);
  }
  const names = Array.isArray(v.serverNames) ? v.serverNames.filter((n) => typeof n === 'string') : [];
  return {
    id: String(v.id),
    scope: 'http',
    level: 'server',
    owner: {
      kind: ownerKind,
      id: domainId ? positive(Number(domainId)) : null,
      accountId: positive(v.accountId),
      tenantId: positive(v.tenantId),
      label: names[0] ?? String(v.id),
    },
    serverNames: names,
    listen: [],
    tls: v.tls,
    config,
    files: {},
    upstreams: [],
    rawSnippets: [],
    invalidReason,
  };
}
