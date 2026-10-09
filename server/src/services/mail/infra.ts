import type Docker from 'dockerode';
import type { InfraComponentStatus } from '@oblimint/shared';
import { mailEngineHasMailboxes } from '@oblimint/shared';
import { errText } from '../setup/docker';
import type { InfraComponentProvider } from '../docker/extensions';
import { MailDriverError } from './driver';
import { ensureMailNetwork } from './network';
import { activeMailDriver, activeMailEngine } from './registry';
import { mailSyncInfo, recordMailSyncError, runMailExclusive } from './sync';

// ─────────────────────────────────────────────────────────────────────────────
// Infra component 'mail' (Nodes page, setup wizard step 'mail', boot) —
// module mail-core. Delegates to the active driver:
//   ensure()  → ensureMailNetwork + driver.ensure + first sync (a failing sync
//               is reported in the log and lastSyncError, the containers stay),
//               ALONE on the sync chain (runMailExclusive): never concurrent
//               with an engine change, and the engine is read once inside —
//               an ensure never redeploys an engine being replaced;
//   status()  → the driver's containers summed up (deployed = every container
//               exists, running = every one runs, details joined);
//   wantedAtBoot() = the engine hosts mailboxes and is supported.
// ─────────────────────────────────────────────────────────────────────────────

/** Several container statuses → the one 'mail' component (pure). */
export function summarizeMailComponents(parts: InfraComponentStatus[], fallbackDetail: string | null): InfraComponentStatus {
  if (parts.length === 0) {
    return { id: 'mail', deployed: false, running: false, image: null, version: null, detail: fallbackDetail };
  }
  const details = parts.map((p) => p.detail).filter((d): d is string => !!d);
  return {
    id: 'mail',
    deployed: parts.every((p) => p.deployed),
    running: parts.every((p) => p.running),
    image: parts[0].image,
    version: parts.find((p) => p.version)?.version ?? null,
    detail: details.length ? [...new Set(details)].join(' · ') : null,
  };
}

export const mailInfraComponent: InfraComponentProvider = {
  id: 'mail',

  async ensure(log: (line: string) => void): Promise<void> {
    await runMailExclusive(async (syncInline) => {
      const engine = await activeMailEngine();
      const driver = await activeMailDriver();
      if (!driver.capabilities.supported) throw new MailDriverError('notSupported', `The ${engine} mail engine is not supported yet`);
      if (!mailEngineHasMailboxes(engine)) {
        log('External mail engine: nothing to deploy (the panel manages the DNS records only)');
        return;
      }
      await ensureMailNetwork(log);
      try {
        await driver.ensure(log);
      } catch (err) {
        recordMailSyncError(`Déploiement du moteur ${engine} en échec : ${err instanceof MailDriverError ? err.message : errText(err)}`);
        throw err;
      }
      log('First synchronisation of the mail engine…');
      await syncInline('deploy');
      const { lastSyncError } = mailSyncInfo();
      log(lastSyncError ? `Synchronisation failed: ${lastSyncError}` : 'Mail engine synchronised');
    });
  },

  async status(_docker: Docker | null, dockerError: string | null): Promise<InfraComponentStatus> {
    try {
      const engine = await activeMailEngine();
      const driver = await activeMailDriver();
      if (!mailEngineHasMailboxes(engine)) return summarizeMailComponents([], 'External mail engine: nothing deployed');
      if (!driver.capabilities.supported) return summarizeMailComponents([], `${engine}: not supported yet`);
      const parts = await driver.status();
      return summarizeMailComponents(parts, dockerError ?? 'Not deployed');
    } catch (err) {
      return summarizeMailComponents([], dockerError ?? errText(err));
    }
  },

  async wantedAtBoot(): Promise<boolean> {
    try {
      const engine = await activeMailEngine();
      const driver = await activeMailDriver();
      return mailEngineHasMailboxes(engine) && driver.capabilities.supported;
    } catch {
      return false;
    }
  },
};
