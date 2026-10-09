import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import type { InfraComponentProvider } from '../docker/extensions';
import { containerState, ensureImage, inspectContainer, labelHash, recreateContainer, startContainer } from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { withLock } from '../docker/locks';
import { specHashLabel } from '../docker/specs';
import { PANEL_ALIAS } from '../hosting/naming';
import { platformSettings } from '../platformSettings';
import { dbAdminContainerName, dbAdminContainerSpec, type DbAdminKind } from './spec';
import { dbAdminKey, phpMyAdminBlowfishSecret } from './ssoTokens';

// ─────────────────────────────────────────────────────────────────────────────
// phpMyAdmin + Adminer infra component (module databases, docs/P2-PLAN.md
// §9.3). Two shared containers (PHPMYADMIN_CONTAINER, ADMINER_CONTAINER) on
// the panel network, no published port: the edge serves them on settings
// dbAdmin.hostname (/phpmyadmin/, /adminer/). Single sign-on only (no login
// form): the panel issues a one-time token, the container redeems it on the
// internal listener (/internal/dbadmin/redeem, internalRoutes.ts) with the
// key it receives as env (OBLIMINT_DBADMIN_KEY). Images: images/dbadmin/.
// ─────────────────────────────────────────────────────────────────────────────

const KINDS: readonly DbAdminKind[] = ['phpmyadmin', 'adminer'];

export function dbAdminRedeemUrl(): string {
  return `http://${PANEL_ALIAS}:${config.hosting.internalPort}/internal/dbadmin/redeem`;
}

export function dbAdminSpecs(): Docker.ContainerCreateOptions[] {
  const common = { key: dbAdminKey(), redeemUrl: dbAdminRedeemUrl() };
  return KINDS.map((k) => dbAdminContainerSpec(k, k === 'phpmyadmin' ? { ...common, blowfishSecret: phpMyAdminBlowfishSecret() } : common));
}

async function ensureOne(docker: Docker, spec: Docker.ContainerCreateOptions, log: (line: string) => void): Promise<void> {
  const name = spec.name!;
  await ensureImage(docker, spec.Image!, log);
  const info = await inspectContainer(docker, name);
  if (!info) {
    log(`Creating ${name} (${spec.Image})`);
    await recreateContainer(docker, spec, true);
    return;
  }
  if (labelHash(info.Config?.Labels) !== specHashLabel(spec)) {
    log(`${name}: specification changed, recreating`);
    await recreateContainer(docker, spec, true);
    return;
  }
  if (!info.State?.Running) {
    log(`Starting ${name}`);
    await startContainer(docker, name);
    return;
  }
  log(`${name} is up to date and running`);
}

/** Is the admin UI of `kind` running (SSO possible)? Never throws. */
export async function dbAdminRunning(docker: Docker, kind: DbAdminKind): Promise<boolean> {
  try {
    return !!(await inspectContainer(docker, dbAdminContainerName(kind)))?.State?.Running;
  } catch {
    return false;
  }
}

export const dbAdminInfraComponent: InfraComponentProvider = {
  id: 'dbadmin',
  async ensure(log: (line: string) => void): Promise<void> {
    await withLock('infra:dbadmin', async () => {
      const docker = await engineFor(await localNodeId());
      for (const spec of dbAdminSpecs()) await ensureOne(docker, spec, log);
      const hostname = (await platformSettings.section('dbAdmin')).hostname;
      if (!hostname) log('dbAdmin.hostname is not set: the admin UIs are deployed but no SSO session can be opened');
    });
  },

  async status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    if (!docker) return { id: 'dbadmin', deployed: false, running: false, image: null, version: null, detail: dockerError };
    try {
      const infos = await Promise.all(KINDS.map((k) => inspectContainer(docker, dbAdminContainerName(k))));
      const problems: string[] = [];
      infos.forEach((info, i) => {
        const name = dbAdminContainerName(KINDS[i]);
        if (!info) problems.push(`${name}: absent`);
        else if (!info.State?.Running) problems.push(`${name}: ${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}`);
      });
      let hostname: string | null = null;
      try { hostname = (await platformSettings.section('dbAdmin')).hostname; } catch { /* settings unreadable */ }
      if (!hostname) problems.push('dbAdmin.hostname not set');
      const first = infos[0] ?? infos[1];
      return {
        id: 'dbadmin',
        deployed: infos.every((i) => !!i),
        running: infos.every((i) => !!i?.State?.Running),
        image: infos.map((i) => i?.Config?.Image).filter(Boolean).join(', ') || null,
        version: first?.Config?.Labels?.['org.opencontainers.image.version'] ?? null,
        detail: problems.length ? problems.join(' · ') : null,
      };
    } catch (err) {
      return { id: 'dbadmin', deployed: false, running: false, image: null, version: null, detail: errText(err) };
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    try {
      return !!(await platformSettings.section('dbAdmin')).hostname;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'dbadmin: settings unreadable at boot');
      return false;
    }
  },
};
