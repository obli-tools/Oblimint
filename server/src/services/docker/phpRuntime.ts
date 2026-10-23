import type Docker from 'dockerode';
import { phpAdvisoriesForVersion, phpBranchOf, PHP_ADVISORIES, type SitePhpRuntime } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { LABELS } from '../hosting/naming';
import { errText } from '../setup/docker';
import { engineFor } from './engine';

// Exact PHP version of the running site containers: PHP_VERSION of the image
// the container was CREATED from (official php images), not of the tag. A
// container started before an image update keeps the old version until it is
// recreated (Nodes > Updates, site images).

const SITE_ROLES = new Set(['site', 'site-secondary', 'site-preview']);

/** PHP_VERSION=8.2.35 in an image / container environment. */
export function phpVersionOfEnv(env: readonly string[] | null | undefined): string | null {
  const v = env?.find((e) => e.startsWith('PHP_VERSION='))?.slice('PHP_VERSION='.length).trim();
  return v && /^\d+\.\d+(\.\d+)?/.test(v) ? v : null;
}

export function phpRuntimeOf(siteId: number, role: SitePhpRuntime['role'], container: string, version: string | null): SitePhpRuntime {
  const advisories = version ? phpAdvisoriesForVersion(version).map((a) => a.id) : [];
  const branch = version ? phpBranchOf(version) : null;
  const fixable = advisories.length > 0 && advisories.every((id) => !!PHP_ADVISORIES.find((a) => a.id === id)?.fixed[branch!]);
  return { siteId, role, container, version, advisories, fixable };
}

/** Site containers of the given sites (node of their account), with the exact PHP version. Never throws. */
export async function sitesPhpRuntime(sites: ReadonlyArray<{ id: number; accountId: number }>): Promise<SitePhpRuntime[]> {
  if (!sites.length) return [];
  const wanted = new Set(sites.map((s) => s.id));
  const accounts = [...new Set(sites.map((s) => s.accountId))];
  const nodes = [...new Set((await db('hosting_accounts').whereIn('id', accounts).pluck('node_id') as number[]).map(Number))];
  const out: SitePhpRuntime[] = [];
  for (const nodeId of nodes) {
    let docker: Docker;
    try { docker = await engineFor(nodeId); } catch (err) { logger.debug({ nodeId, err: errText(err) }, 'php runtime: no engine'); continue; }
    try {
      const list = await docker.listContainers({ all: true, filters: { label: [LABELS.site] } });
      const versions = new Map<string, string | null>();
      for (const c of list) {
        const role = c.Labels?.[LABELS.role] ?? '';
        const siteId = Number(c.Labels?.[LABELS.site]);
        if (!SITE_ROLES.has(role) || !wanted.has(siteId)) continue;
        if (!versions.has(c.ImageID)) {
          const info = await docker.getImage(c.ImageID).inspect().catch(() => null);
          versions.set(c.ImageID, phpVersionOfEnv(info?.Config?.Env));
        }
        out.push(phpRuntimeOf(siteId, role as SitePhpRuntime['role'], (c.Names?.[0] ?? '').replace(/^\//, ''), versions.get(c.ImageID) ?? null));
      }
    } catch (err) {
      logger.debug({ nodeId, err: errText(err) }, 'php runtime: listing failed');
    }
  }
  return out;
}
