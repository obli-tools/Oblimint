import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import type { InfraComponentStatus, WebmailKind } from '@oblimint/shared';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { open, seal } from '../../../utils/secretBox';
import { appConfigService } from '../../appConfig.service';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import type { InfraComponentProvider } from '../../docker/extensions';
import { containerState, ensureImage, inspectContainer, labelHash, recreateContainer, removeContainer, startContainer } from '../../docker/dockerOps';
import { engineFor, localNodeId } from '../../docker/engine';
import { withLock } from '../../docker/locks';
import { specHashLabel } from '../../docker/specs';
import { PANEL_ALIAS, WEBMAIL_CONTAINER, webmailImage } from '../../hosting/naming';
import { hostPaths, localPaths } from '../../hosting/paths';
import { activeMailDriver } from '../registry';
import { ensureMailNetwork, mailNetworkSubnets } from '../network';
import { webmailHostRefusal } from './edgeContributor';
import { webmailKey } from './ssoTokens';
import { oblimintWebmailListening } from './oblimint/server';
import { WEBMAIL_GID, WEBMAIL_UID, webmailContainerSpec, type WebmailKindName } from './spec';

// ─────────────────────────────────────────────────────────────────────────────
// Infra component 'webmail' (docs/P4-PLAN.md §4 / §9.7): the shared
// oblimint-webmail container — Roundcube or SnappyMail per settings
// mail.webmail, one at a time (same container name: a kind change recreates
// it, 'none' removes it). MAIL_NETWORK only, no published port, state under
// paths.webmailData(kind) (owned by the image's www-data). wantedAtBoot =
// the active engine has mailboxes AND mail.webmail ≠ none.
// ─────────────────────────────────────────────────────────────────────────────

const DES_KEY_CONFIG = 'webmail_des_key';
const LOCK = 'infra:webmail';

/** Base URL of the panel's internal listener as seen from the mail network (alias oblimint-panel). */
export function webmailPanelUrl(): string {
  return `http://${PANEL_ALIAS}:${config.hosting.internalPort}/internal/mail/webmail`;
}

/**
 * Roundcube des_key (24 characters): generated once, stored sealed
 * (secretBox 'webmail') in app_config. A value that no longer opens
 * (SESSION_SECRET rotated) is replaced: only open webmail sessions are lost.
 */
export async function webmailDesKey(): Promise<string> {
  const sealed = await appConfigService.get(DES_KEY_CONFIG);
  if (sealed) {
    try {
      const v = open('webmail', sealed);
      if (/^[A-Za-z0-9_-]{24}$/.test(v)) return v;
    } catch (err) {
      logger.warn({ err: errText(err) }, 'webmail: des_key unreadable (session secret changed?), regenerated');
    }
  }
  const fresh = crypto.randomBytes(18).toString('base64url');
  await appConfigService.set(DES_KEY_CONFIG, seal('webmail', fresh));
  return fresh;
}

/** Creates the state directory (0700, owned by the image's www-data); refuses a symlink (R1). */
export function prepareStateDir(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o711 });
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    fs.chownSync(dir, WEBMAIL_UID, WEBMAIL_GID);
    fs.chmodSync(dir, 0o700);
  }
}

/** Is the webmail container running (SSO possible)? Never throws. */
export async function webmailRunning(): Promise<boolean> {
  try {
    const docker = await engineFor(await localNodeId());
    return !!(await inspectContainer(docker, WEBMAIL_CONTAINER))?.State?.Running;
  } catch {
    return false;
  }
}

/**
 * settings mail.webmail when the active engine can serve it, else null
 * ('oblimint' = the panel's own webmail: JMAP, Stalwart only). Never throws.
 */
export async function wantedWebmailKind(): Promise<Exclude<WebmailKind, 'none'> | null> {
  try {
    const s = await platformSettings.section('mail');
    if (s.webmail === 'none') return null;
    const driver = await activeMailDriver();
    if (!driver.capabilities.supported || !driver.capabilities.mailboxes) return null;
    if (s.webmail === 'oblimint' && driver.engine !== 'stalwart') return null;
    return s.webmail;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: settings / engine unreadable');
    return null;
  }
}

async function panelHostName(): Promise<string | null> {
  return (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
}

function reportHost(webmailHostname: string | null, perDomain: boolean, log: (line: string) => void, panelHost: string | null): void {
  const refusal = webmailHostRefusal(webmailHostname, panelHost);
  if (refusal) log(refusal);
  if (!webmailHostname && !perDomain) log('No webmail host (mail.webmailHostname unset, webmail.<domain> off): no SSO session can be opened');
}

async function ensureContainer(docker: Docker, spec: Docker.ContainerCreateOptions, log: (line: string) => void): Promise<void> {
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

/** Removes the webmail container (settings 'none', engine without mailboxes). State is kept. */
export async function removeWebmail(log: (line: string) => void): Promise<void> {
  await withLock(LOCK, async () => {
    const docker = await engineFor(await localNodeId());
    if (!(await inspectContainer(docker, WEBMAIL_CONTAINER))) return;
    log(`Removing ${WEBMAIL_CONTAINER}`);
    await removeContainer(docker, WEBMAIL_CONTAINER);
  });
}

export const webmailInfraComponent: InfraComponentProvider = {
  id: 'webmail',

  async ensure(log: (line: string) => void): Promise<void> {
    const settings = await platformSettings.section('mail');
    const driver = await activeMailDriver();
    if (settings.webmail === 'none' || !driver.capabilities.supported || !driver.capabilities.mailboxes) {
      log(settings.webmail === 'none' ? 'Webmail disabled (settings mail.webmail = none)' : `The mail engine ${driver.engine} has no mailboxes: no webmail`);
      await removeWebmail(log);
      return;
    }
    if (settings.webmail === 'oblimint') {
      // The panel's own webmail: no container (served by the panel's webmail listener).
      await removeWebmail(log);
      if (driver.engine !== 'stalwart') throw new Error(`the Oblimint webmail needs the Stalwart mail engine (active engine: ${driver.engine})`);
      if (!oblimintWebmailListening()) log('The Oblimint webmail listener is not running (OBLIMINT_WEBMAIL_PORT = 0?)');
      else log('Oblimint webmail served by the panel');
      reportHost(settings.webmailHostname, settings.webmailPerDomain, log, await panelHostName());
      return;
    }
    const kind: WebmailKindName = settings.webmail;
    const imap = driver.imapEndpoint();
    if (!imap) throw new Error(`the mail engine ${driver.engine} exposes no IMAP endpoint`);
    await withLock(LOCK, async () => {
      const docker = await engineFor(await localNodeId());
      await ensureMailNetwork(log);
      prepareStateDir(localPaths.webmailData(kind));
      const spec = webmailContainerSpec({
        kind,
        image: webmailImage(kind),
        stateDir: hostPaths.webmailData(kind),
        key: webmailKey(),
        panelUrl: webmailPanelUrl(),
        imap,
        submission: driver.submissionEndpoint(),
        sieve: driver.capabilities.sieve ? driver.sieveEndpoint() : null,
        desKey: await webmailDesKey(),
        trustedProxies: await mailNetworkSubnets(),
        maxMessageSizeMb: settings.maxMessageSizeMb,
      });
      await ensureContainer(docker, spec, log);
    });
    reportHost(settings.webmailHostname, settings.webmailPerDomain, log, await panelHostName());
  },

  async status(docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    const base: InfraComponentStatus = { id: 'webmail', deployed: false, running: false, image: null, version: null, detail: null };
    if (!docker) return { ...base, detail: dockerError };
    try {
      const problems: string[] = [];
      const notes: string[] = [];
      // Intended state = what ensure() deploys (settings AND an engine with mailboxes).
      const wanted = await wantedWebmailKind();
      try {
        const s = await platformSettings.section('mail');
        if (s.webmail === 'none') notes.push('disabled (settings mail.webmail = none)');
        else if (!wanted) notes.push('no webmail for this engine (no mailboxes)');
        else {
          const panelHost = (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
          const refusal = webmailHostRefusal(s.webmailHostname, panelHost);
          if (refusal) problems.push(refusal);
        }
      } catch { /* settings unreadable: container state only */ }
      if (wanted === 'oblimint') {
        // No container: the panel's listener serves it.
        const up = oblimintWebmailListening();
        if (!up) problems.push('Oblimint webmail listener not running');
        const detail = [...problems, ...notes];
        return { ...base, deployed: true, running: up, image: 'oblimint (panel)', version: null, detail: detail.length ? detail.join(' · ') : null };
      }
      const info = await inspectContainer(docker, WEBMAIL_CONTAINER);
      if (!info && wanted) problems.push(`${WEBMAIL_CONTAINER}: absent`);
      else if (info && !info.State?.Running) {
        problems.push(`${WEBMAIL_CONTAINER}: ${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}`);
      }
      const detail = [...problems, ...notes];
      return {
        ...base,
        deployed: !!info,
        running: !!info?.State?.Running,
        image: info?.Config?.Image ?? null,
        version: info?.Config?.Labels?.['org.opencontainers.image.version'] ?? null,
        detail: detail.length ? detail.join(' · ') : null,
      };
    } catch (err) {
      return { ...base, detail: errText(err) };
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    return (await wantedWebmailKind()) !== null;
  },
};
