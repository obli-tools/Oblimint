import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Self-heal of the panel network before the database (migration 031, incident 2026-11-01): the panel / PostgreSQL
// get back the addresses the restored policy (hostd-segments.json, enforce) or the snapshot expects, a container
// that took one of them is moved away, a PostgreSQL that failed on its stolen address is started again, a missing
// 'oblimint' network is recreated with the same subnet / bridge name. Nothing moves where Docker refuses static
// addresses, nor a container already pinned and running.

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-heal-test-'));
process.env.OBLIMINT_DATA_DIR = dataRoot;
process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';

const SNAP = path.join(dataRoot, 'config', 'network-addresses.json');
const HOSTD = path.join(dataRoot, 'run', 'hostd-segments.json');

function writeSnapshot(containers: Record<string, string> = { oblimint: '172.18.0.3', 'oblimint-postgres': '172.18.0.2' }): void {
  fs.mkdirSync(path.dirname(SNAP), { recursive: true });
  fs.writeFileSync(SNAP, JSON.stringify({
    version: 1, writtenAt: '2026-11-01T00:00:00Z', panel: 'oblimint',
    networks: {
      oblimint: {
        id: 'n-oblimint', subnet: '172.18.0.0/16', gateway: '172.18.0.1', ipRange: null, bridgeName: 'br-0123456789ab', explicitBridge: false,
        internal: false, labels: { 'oblimint.internal': 'true' }, containers, aliases: { oblimint: ['oblimint-panel'] },
      },
    },
  }));
}

function writeHostd(state: unknown): void {
  fs.mkdirSync(path.dirname(HOSTD), { recursive: true });
  fs.writeFileSync(HOSTD, JSON.stringify(state));
}

function clean(): void {
  fs.rmSync(SNAP, { force: true });
  fs.rmSync(HOSTD, { force: true });
}

test('self-heal of the panel network before the database', async (t) => {
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { selfHealPanelNetwork, expectedFromHostdState } = await import('./selfHeal');
  type Fake = InstanceType<typeof FakeDocker>;
  const engine = (version: string): Fake => {
    const f = new FakeDocker();
    f.engineVersion = version;
    f.networks.set('oblimint', { name: 'oblimint', labels: {}, subnet: '172.18.0.0/16' });
    return f;
  };
  // FakeDocker network ids are `n-<name>` padded with 0: Docker's bridge name br-<12 first chars>.
  const BRIDGE = 'br-n-oblimint00';

  // ── Docker 29: the panel back on its recorded address (incident: panel .3 → .8) ──
  clean();
  writeSnapshot();
  {
    const fake = engine('29.3.1');
    const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], addr: '172.18.0.8' }]]) });
    const pg = fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.2' }]]) });
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.equal(report.source, 'snapshot');
    assert.deepEqual(report.repinned, ['oblimint'], 'only the panel moved; PostgreSQL already has its address');
    assert.deepEqual(panel.networks.get('oblimint'), { Aliases: ['oblimint-panel'], IPv4: '172.18.0.3' });
    assert.equal(pg.networks.get('oblimint')!.IPv4, undefined, 'PostgreSQL left as is');
    assert.equal(report.networkRecreated, false);
  }

  // ── the expected address held by another container: that one is moved to the top of the subnet ──
  {
    const fake = engine('29.3.1');
    const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], addr: '172.18.0.8' }]]) });
    const scanner = fake.addContainer({ name: 'oblimint-scanner', networks: new Map([['oblimint', { Aliases: ['scanner'], addr: '172.18.0.3' }]]) });
    fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.2' }]]) });
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.deepEqual(report.relocated, ['oblimint-scanner: 172.18.0.3 → 172.18.255.254']);
    assert.equal(scanner.networks.get('oblimint')!.IPv4, '172.18.255.254');
    assert.deepEqual(scanner.networks.get('oblimint')!.Aliases, ['scanner'], 'aliases of the moved container kept');
    assert.equal(panel.networks.get('oblimint')!.IPv4, '172.18.0.3');
  }

  // ── stolen at boot: PostgreSQL pinned on .2, stopped (address in use), a dynamic container on .2 ──
  {
    const fake = engine('29.3.1');
    fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], IPv4: '172.18.0.3' }]]) });
    const thief = fake.addContainer({ name: 'oblimint-edge', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.2' }]]) });
    const pg = fake.addContainer({ name: 'oblimint-postgres', state: 'exited', networks: new Map([['oblimint', { Aliases: [], IPv4: '172.18.0.2' }]]) });
    await assert.rejects(fake.asDocker().getContainer('oblimint-postgres').start(), /Address already in use/);
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.deepEqual(report.relocated, ['oblimint-edge: 172.18.0.2 → 172.18.255.254']);
    assert.notEqual(thief.networks.get('oblimint')!.IPv4, '172.18.0.2');
    assert.equal(pg.state, 'running', 'PostgreSQL started again on its address');
    assert.equal(pg.networks.get('oblimint')!.IPv4, '172.18.0.2');
    assert.deepEqual(report.started, ['oblimint-postgres']);
    assert.ok(!report.repinned.includes('oblimint'), 'the panel, pinned and running, is never moved');
  }

  // ── Docker 28 + subnet chosen by Docker: nothing moved (a disconnect would only reconnect dynamic) ──
  {
    const fake = engine('28.5.2');
    const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], addr: '172.18.0.8' }]]) });
    fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.2' }]]) });
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.deepEqual(report.repinned, []);
    assert.ok(report.skipped.some((s) => /refuses fixed addresses/.test(s)));
    assert.ok(!fake.calls.some((c) => /^(disconnect|connect)/.test(c)), `no disconnect / connect (${fake.calls.join(' | ')})`);
    assert.equal(panel.networks.get('oblimint')!.IPv4 ?? null, null);
  }

  // ── a pinned running panel the snapshot contradicts: kept (the policy was pushed from its real address) ──
  {
    const fake = engine('29.3.1');
    const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], IPv4: '172.18.0.9' }]]) });
    fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], IPv4: '172.18.0.2' }]]) });
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.deepEqual(report.repinned, []);
    assert.equal(panel.networks.get('oblimint')!.IPv4, '172.18.0.9');
    assert.ok(report.skipped.some((s) => /pinned on 172\.18\.0\.9, kept/.test(s)));
  }

  // ── the policy hostd restored wins over the snapshot; first boot of 031 (no snapshot) works from it alone ──
  writeHostd({
    mode: 'enforce',
    bridges: [{ name: BRIDGE, accountId: 0, fabric: 'platform', isolation: 'listed' }],
    allow: [{ bridge: BRIDGE, src: '172.18.0.5', dst: '172.18.0.2', protocol: 'tcp', port: 5432 }, { bridge: 'omf1', src: '10.224.1.4', dst: '10.224.1.32', protocol: 'tcp', port: 5432 }],
  });
  assert.deepEqual(expectedFromHostdState(BRIDGE, HOSTD), { panel: '172.18.0.5', postgres: '172.18.0.2' });
  assert.equal(expectedFromHostdState('br-other', HOSTD), null);
  {
    const fake = engine('29.3.1');
    const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], addr: '172.18.0.8' }]]) });
    fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.2' }]]) });
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.equal(report.source, 'hostd');
    assert.equal(panel.networks.get('oblimint')!.IPv4, '172.18.0.5', 'the address the rule in force names (not the snapshot .3)');
  }
  fs.rmSync(SNAP, { force: true });
  {
    const fake = engine('29.3.1');
    const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], addr: '172.18.0.8' }]]) });
    fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.2' }]]) });
    const report = await selfHealPanelNetwork({ docker: fake.asDocker() });
    assert.equal(report.source, 'hostd');
    assert.deepEqual(panel.networks.get('oblimint'), { Aliases: ['oblimint-panel'], IPv4: '172.18.0.5' }, 'first deployment: no snapshot, the alias still put back');
  }
  // Mode monitor / off: nothing is blocked, the hostd file is not a source.
  writeHostd({ mode: 'monitor', bridges: [], allow: [{ bridge: BRIDGE, src: '172.18.0.5', dst: '172.18.0.2', protocol: 'tcp', port: 5432 }] });
  assert.equal(expectedFromHostdState(BRIDGE, HOSTD), null);

  // ── network gone: recreated with the recorded subnet + bridge name, panel and a STOPPED PostgreSQL reconnected ──
  clean();
  writeSnapshot();
  {
    const gone = new FakeDocker(); // Docker 28: the recreated network has an explicit subnet, static addresses accepted
    const p3 = gone.addContainer({ name: 'oblimint' });
    const pg3 = gone.addContainer({ name: 'oblimint-postgres', state: 'exited' });
    const r3 = await selfHealPanelNetwork({ docker: gone.asDocker() });
    assert.equal(r3.networkRecreated, true);
    assert.equal(gone.networks.get('oblimint')!.subnet, '172.18.0.0/16');
    assert.equal(gone.networks.get('oblimint')!.options?.['com.docker.network.bridge.name'], 'br-0123456789ab', 'same bridge: the rules hostd restored stay valid');
    assert.deepEqual(p3.networks.get('oblimint'), { Aliases: ['oblimint-panel'], IPv4: '172.18.0.3' });
    assert.equal(pg3.networks.get('oblimint')!.IPv4, '172.18.0.2');
  }
});
