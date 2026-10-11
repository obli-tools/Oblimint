import Docker from 'dockerode';
import {
  clonePanelContainer, demuxDockerLogs, endpointConfig, HELPER_RESULT_PREFIX, healthVerdict, oldPanelName, parseHelperPlan, type HelperResult,
} from './selfUpdateSpec';

// ─────────────────────────────────────────────────────────────────────────────
// Self-update helper — entry point of the short-lived helper container
// (selfUpdateSpec.helperCreateOptions). Runs OUTSIDE the panel process, with
// the Docker socket only:
//   1. inspects the panel container + its image, clones its configuration
//      onto the new image (selfUpdateSpec.clonePanelContainer);
//   2. renames the panel container to <name>-old-<ts> and stops it (kept);
//   3. creates + starts the new container under the original name, connects
//      the other networks with their aliases;
//   4. waits until it is healthy (HEALTHCHECK of the image) for at most
//      healthTimeoutSec — then removes the old one; otherwise removes the new
//      one, renames the old one back and starts it (rollback).
// The result is printed as one line (HELPER_RESULT_PREFIX + JSON): the panel
// that runs afterwards (new or rolled back) reads it from the helper's logs.
// No Oblimint configuration / database is loaded here.
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function report(r: Omit<HelperResult, 'finishedAt'>): void {
  process.stdout.write(`${HELPER_RESULT_PREFIX}${JSON.stringify({ ...r, finishedAt: new Date().toISOString() })}\n`);
}

async function removeQuiet(docker: Docker, id: string): Promise<void> {
  try { await docker.getContainer(id).remove({ force: true }); } catch { /* gone */ }
}

/** Set once the panel container was renamed: the failure path restores it. */
let restore: { docker: Docker; id: string; name: string; newId: string | null } | null = null;

async function main(): Promise<void> {
  const plan = parseHelperPlan(process.env.OBLIMINT_SELF_UPDATE_PLAN);
  const docker = new Docker({ socketPath: '/var/run/docker.sock' });
  // Let the panel answer the HTTP request that started the update.
  await sleep(2_000);
  const old = await docker.getContainer(plan.target).inspect();
  const oldImage = await docker.getImage(old.Image).inspect().catch(() => null);
  const clone = clonePanelContainer(old, oldImage as never, plan.newImage);
  const keptName = oldPanelName(clone.name, Date.now());
  say(`self-update ${plan.runId}: ${clone.name} (${old.Config.Image}) → ${plan.newImage}`);

  await docker.getContainer(old.Id).rename({ name: keptName });
  restore = { docker, id: old.Id, name: clone.name, newId: null };
  say(`previous container renamed ${keptName}`);
  try {
    await docker.getContainer(old.Id).stop({ t: 30 });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 304) throw err;
  }

  let newId: string | null = null;
  let failure: string | null = null;
  try {
    const created = await docker.createContainer(clone.create);
    newId = created.id;
    if (restore) restore.newId = created.id;
    for (const n of clone.extraNetworks) {
      await docker.getNetwork(n.name).connect({ Container: created.id, EndpointConfig: endpointConfig(n) });
    }
    await created.start();
    say(`new container ${created.id.slice(0, 12)} started, waiting until it is healthy (${plan.healthTimeoutSec} s max)`);
    const started = Date.now();
    for (;;) {
      await sleep(3_000);
      const info = await created.inspect().catch(() => null);
      const verdict = healthVerdict(info?.State as never, Date.now() - started, { timeoutMs: plan.healthTimeoutSec * 1000, noHealthcheckStableMs: 20_000 });
      if (verdict === 'healthy') break;
      if (verdict === 'failed') {
        const st = info?.State;
        const restarts = (info as { RestartCount?: number } | null)?.RestartCount ?? 0;
        failure = !info ? 'the new container disappeared'
          : !st?.Running || restarts > 0 ? `the new container stopped (exit ${st?.ExitCode ?? '?'}${restarts ? `, ${restarts} restart(s)` : ''})`
          : st?.Health?.Status === 'unhealthy' ? 'the new container is unhealthy'
          : `the new container is not healthy after ${plan.healthTimeoutSec} s`;
        break;
      }
    }
  } catch (err) {
    failure = `creation of the new container failed: ${errText(err)}`;
  }

  if (!failure) {
    await removeQuiet(docker, old.Id);
    say('previous container removed');
    report({ outcome: 'succeeded', error: null, newImageId: (await docker.getContainer(newId!).inspect().catch(() => null))?.Image ?? null });
    return;
  }

  say(`rollback: ${failure}`);
  if (newId) {
    try {
      const logs = await docker.getContainer(newId).logs({ stdout: true, stderr: true, tail: 20 }) as unknown as Buffer;
      say(`last lines of the new container:\n${demuxDockerLogs(logs)}`);
    } catch { /* no logs */ }
    await removeQuiet(docker, newId);
  }
  await docker.getContainer(old.Id).rename({ name: clone.name });
  await docker.getContainer(old.Id).start();
  say('previous container restored and started');
  report({ outcome: 'rolledBack', error: failure, newImageId: null });
}

main().then(() => process.exit(0)).catch(async (err) => {
  say(`self-update failed: ${errText(err)}`);
  let outcome: HelperResult['outcome'] = 'failed';
  const r = restore as { docker: Docker; id: string; name: string; newId: string | null } | null;
  if (r) {
    // The panel container was renamed: never leave the node without a panel.
    if (r.newId) await removeQuiet(r.docker, r.newId);
    await r.docker.getContainer(r.id).rename({ name: r.name }).catch(() => undefined);
    await r.docker.getContainer(r.id).start().catch(() => undefined);
    outcome = 'rolledBack';
    say('previous container restored');
  }
  report({ outcome, error: errText(err), newImageId: null });
  process.exit(1);
});
