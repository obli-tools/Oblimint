import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';

// ─────────────────────────────────────────────────────────────────────────────
// REAL Docker check of the fixed container addresses (migration 031). Opt-in:
//   OBLIMINT_DOCKER_IT=1 DOCKER_HOST=tcp://127.0.0.1:2375 [OBLIMINT_DOCKER_IT_DIND=tcp://127.0.0.1:23750]
// Every resource is named oblimint-test-ip-<run>-* and removed at the end.
// Covers on the host engine: creation through dockerOps with the resolver's
// addresses on a network with an explicit subnet / IPRange / bridge name; stop
// + start in another order; a dynamic container stays in the IPRange (never
// takes a fixed address); pinEndpoint of a RUNNING dynamic container with a
// long TCP connection (the bytes before and after arrive); the probe and the
// support detection on a network whose subnet Docker chose. On the optional
// dind engine (Docker 24): the refusal is detected, connectNetwork falls back
// without address and pinEndpoint never leaves the container detached; the
// fixed addresses survive a restart of that daemon (the incident: a reboot).
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED = process.env.OBLIMINT_DOCKER_IT === '1';
const IMAGE = 'alpine:3.20';

function engine(url: string | undefined): Docker | null {
  if (!url) return null;
  const u = new URL(url.replace(/^tcp:/, 'http:'));
  return new Docker({ host: u.hostname, port: Number(u.port || 2375) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureImage(d: Docker, ref: string): Promise<void> {
  try { await d.getImage(ref).inspect(); return; } catch { /* pull */ }
  const stream = await d.pull(ref);
  await new Promise<void>((resolve, reject) => d.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve())));
}

async function ipOn(d: Docker, name: string, network: string): Promise<{ ip: string; static: string | null }> {
  const i = await d.getContainer(name).inspect();
  const ep = i.NetworkSettings.Networks[network] as { IPAddress?: string; IPAMConfig?: { IPv4Address?: string } | null } | undefined;
  return { ip: ep?.IPAddress ?? '', static: ep?.IPAMConfig?.IPv4Address ?? null };
}

async function cleanup(d: Docker, prefix: string): Promise<void> {
  for (const c of await d.listContainers({ all: true })) {
    if (c.Names.some((n) => n.replace(/^\//, '').startsWith(prefix))) await d.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
  }
  for (const n of await d.listNetworks()) if (n.Name.startsWith(prefix)) await d.getNetwork(n.Id).remove().catch(() => undefined);
}

test('fixed container addresses on a real Docker engine', { timeout: 600_000, skip: !ENABLED && 'OBLIMINT_DOCKER_IT=1 not set' }, async (t: TestContext) => {
  process.env.OBLIMINT_WORKERS = 'off';
  const ops = await import('../docker/dockerOps');
  const { defaultIpRange, layoutOf, addressAt, poolOffsets } = await import('./addressLayout');
  const { probeStaticIp, staticSupportOf, dockerMajorVersion } = await import('./addressResolver');
  const { listDockerSubnets } = await import('./allocator');
  const { formatCidr4, parseCidr4, pickFreeSubnet } = await import('./ipv4');

  const run = Math.random().toString(36).slice(2, 7);
  const prefix = `oblimint-test-ip-${run}`;
  const host = engine(process.env.DOCKER_HOST)!;
  assert.ok(host, 'DOCKER_HOST');
  t.after(async () => { ops.setEndpointAddressResolver(null); await cleanup(host, prefix); });
  await ensureImage(host, IMAGE);
  const major = await dockerMajorVersion(host);
  t.diagnostic(`host Docker major version ${major}`);

  // ── A. creation through dockerOps on a network the panel would create ─────
  const taken = (await listDockerSubnets(host)).flatMap((n) => n.subnets);
  const cidr = formatCidr4(pickFreeSubnet(parseCidr4('10.231.0.0/16')!, 24, taken)!);
  const NET = `${prefix}-fab`;
  await ops.createNetwork(host, NET, { 'oblimint.test': run }, { subnet: cidr, ipRange: defaultIpRange(cidr), bridgeName: `omp-t${run}` });
  const layout = layoutOf(cidr, defaultIpRange(cidr));
  const offsets = [...poolOffsets(layout)];
  const alloc = new Map<string, string>();
  ops.setEndpointAddressResolver({
    async resolve(req) {
      if (req.network !== NET) return null;
      let name = req.container;
      if (req.phase === 'connect') name = (await host.getContainer(req.container).inspect()).Name.replace(/^\//, '');
      if (!alloc.has(name)) alloc.set(name, addressAt(layout, offsets[alloc.size]));
      return alloc.get(name)!;
    },
  });
  const names = ['a', 'b', 'c'].map((s) => `${prefix}-${s}`);
  for (const n of names) {
    await ops.createContainer(host, { name: n, Image: IMAGE, Cmd: ['sleep', '600'], HostConfig: { NetworkMode: NET } });
    await ops.startContainer(host, n);
  }
  for (const n of names) assert.deepEqual(await ipOn(host, n, NET), { ip: alloc.get(n), static: alloc.get(n) }, `${n} has its allocation`);
  // A dynamic container (no resolver answer) stays inside the IPRange.
  ops.setEndpointAddressResolver(null);
  const dyn = `${prefix}-dyn`;
  await host.createContainer({ name: dyn, Image: IMAGE, Cmd: ['sleep', '600'], HostConfig: { NetworkMode: NET } });
  for (const n of names) await ops.stopContainer(host, n, 0);
  await ops.startContainer(host, dyn);
  const dynIp = (await ipOn(host, dyn, NET)).ip;
  assert.ok(dynIp.startsWith(cidr.split('.').slice(0, 3).join('.')) && Number(dynIp.split('.')[3]) >= 240, `dynamic address in the IPRange (${dynIp})`);
  for (const n of [...names].reverse()) await ops.startContainer(host, n);
  for (const n of names) assert.equal((await ipOn(host, n, NET)).ip, alloc.get(n), `${n} keeps its address across stop / start in another order`);
  await host.getContainer(names[0]).restart({ t: 0 });
  assert.equal((await ipOn(host, names[0], NET)).ip, alloc.get(names[0]), 'and across a restart');
  assert.equal(await staticSupportOf(host, (await host.getNetwork(NET).inspect()) as Docker.NetworkInspectInfo), 'supported', 'explicit subnet + panel bridge name');

  // ── B. pinEndpoint on a running dynamic container, long TCP connection ────
  const srv = `${prefix}-srv`;
  const cli = `${prefix}-cli`;
  await host.createContainer({ name: srv, Image: IMAGE, Cmd: ['sh', '-c', 'nc -l -p 9000 > /tmp/out; sleep 600'], HostConfig: { NetworkMode: NET } });
  await ops.startContainer(host, srv);
  const before = await ipOn(host, srv, NET);
  assert.equal(before.static, null, 'dynamic before');
  await host.createContainer({
    name: cli, Image: IMAGE, Cmd: ['sh', '-c', `(echo before; sleep 4; echo after; sleep 1) | nc ${before.ip} 9000; sleep 600`], HostConfig: { NetworkMode: NET },
  });
  await ops.startContainer(host, cli);
  await sleep(1500);
  const t0 = Date.now();
  assert.equal(await ops.pinEndpoint(host, NET, srv, before.ip), 'pinned');
  const blip = Date.now() - t0;
  t.diagnostic(`re-pin of a running container: ${blip} ms`);
  assert.deepEqual(await ipOn(host, srv, NET), { ip: before.ip, static: before.ip }, 'same address, now static');
  await sleep(6000);
  const exec = await host.getContainer(srv).exec({ Cmd: ['cat', '/tmp/out'], AttachStdout: true });
  const out = await new Promise<string>((resolve) => {
    void exec.start({}).then((s) => { let buf = ''; s.on('data', (c: Buffer) => { buf += c.toString(); }); s.on('end', () => resolve(buf)); });
  });
  assert.match(out, /before/);
  assert.match(out, /after/, 'the TCP connection survived the re-pin');
  await host.getContainer(srv).restart({ t: 0 });
  assert.equal((await ipOn(host, srv, NET)).ip, before.ip, 'pinned address kept after a restart');

  // ── C. network whose subnet Docker chose: probe + support ─────────────────
  const AUTO = `${prefix}-auto`;
  await host.createNetwork({ Name: AUTO, Driver: 'bridge' });
  process.env.OBLIMINT_SELF_CONTAINER = names[0]; // probe image = the "panel's"
  const autoNet = (await host.getNetwork(AUTO).inspect()) as Docker.NetworkInspectInfo;
  const probed = await probeStaticIp(host, autoNet);
  t.diagnostic(`probe on a Docker-chosen subnet (Docker ${major}): ${probed}`);
  assert.equal(probed, (major ?? 0) >= 29 ? 'supported' : 'refused');
  assert.ok(!(await host.listContainers({ all: true })).some((c) => c.Names.some((n) => n.includes('oblimint-ipprobe-'))), 'probe container removed');

  // ── D. optional Docker 24 (dind): refusal, fallbacks, daemon restart ──────
  const dind = engine(process.env.OBLIMINT_DOCKER_IT_DIND);
  if (!dind) { t.diagnostic('no dind engine: part D skipped'); return; }
  await ensureImage(dind, IMAGE);
  const dmajor = await dockerMajorVersion(dind);
  t.diagnostic(`dind Docker major version ${dmajor}`);
  const DAUTO = `${prefix}-dauto`;
  await dind.createNetwork({ Name: DAUTO, Driver: 'bridge' });
  const dAutoNet = (await dind.getNetwork(DAUTO).inspect()) as Docker.NetworkInspectInfo;
  const dSub = (dAutoNet.IPAM?.Config?.[0] as { Subnet: string }).Subnet;
  const dLayout = layoutOf(dSub, null);
  const holder = `${prefix}-dpanel`;
  await dind.createContainer({ name: holder, Image: IMAGE, Cmd: ['sleep', '3600'], HostConfig: { NetworkMode: DAUTO, RestartPolicy: { Name: 'unless-stopped' } } });
  await dind.getContainer(holder).start();
  if ((dmajor ?? 99) < 29) {
    process.env.OBLIMINT_SELF_CONTAINER = holder; // probe image = the "panel's" on that engine
    assert.equal(await probeStaticIp(dind, dAutoNet), 'refused', 'Docker < 29 refuses static addresses on a subnet it chose');
    assert.ok(!(await dind.listContainers({ all: true })).some((c) => c.Names.some((n) => n.includes('oblimint-ipprobe-'))), 'probe container removed');
    const refusals: string[] = [];
    ops.setEndpointAddressResolver({ resolve: async () => addressAt(dLayout, 40), refused: (_d, n) => { refusals.push(n); } });
    const extra = `${prefix}-dextra`;
    await dind.createContainer({ name: extra, Image: IMAGE, Cmd: ['sleep', '3600'], HostConfig: { NetworkMode: 'bridge' } });
    await dind.getContainer(extra).start();
    assert.equal(await ops.connectNetwork(dind, DAUTO, extra), true, 'connected without the refused address');
    assert.deepEqual(refusals, [DAUTO], 'refusal reported');
    assert.equal((await ipOn(dind, extra, DAUTO)).static, null);
    ops.setEndpointAddressResolver(null);
    const cur = (await ipOn(dind, holder, DAUTO)).ip;
    await assert.rejects(ops.pinEndpoint(dind, DAUTO, holder, cur, { retryDelayMs: 0 }), (e: unknown) => ops.isStaticIpRefused(e));
    assert.equal((await ipOn(dind, holder, DAUTO)).ip !== '', true, 'never left detached after a refused re-pin');
  }
  // Explicit subnet on the old engine: static addresses accepted, and they survive a daemon restart.
  const dTaken = (await listDockerSubnets(dind)).flatMap((n) => n.subnets);
  const dCidr = formatCidr4(pickFreeSubnet(parseCidr4('10.232.0.0/16')!, 24, dTaken)!);
  const DFAB = `${prefix}-dfab`;
  await ops.createNetwork(dind, DFAB, {}, { subnet: dCidr, ipRange: defaultIpRange(dCidr), bridgeName: `omp-d${run}` });
  const dl = layoutOf(dCidr, defaultIpRange(dCidr));
  const fixed = [`${prefix}-d1`, `${prefix}-d2`, `${prefix}-d3`];
  for (const [i, n] of fixed.entries()) {
    await ops.createContainer(dind, {
      name: n, Image: IMAGE, Cmd: ['sleep', '3600'], HostConfig: { NetworkMode: DFAB, RestartPolicy: { Name: 'unless-stopped' } },
      NetworkingConfig: { EndpointsConfig: { [DFAB]: { IPAMConfig: { IPv4Address: addressAt(dl, 32 + i) } } } },
    });
    await dind.getContainer(n).start();
  }
  const dindName = process.env.OBLIMINT_DOCKER_IT_DIND_CONTAINER;
  if (dindName) {
    await host.getContainer(dindName).restart({ t: 5 });
    const deadline = Date.now() + 120_000;
    for (;;) {
      try { await dind.ping(); break; } catch { if (Date.now() > deadline) throw new Error('dind did not come back'); await sleep(1000); }
    }
    for (let i = 0; i < 30; i++) {
      const states = await Promise.all(fixed.map((n) => dind.getContainer(n).inspect().then((x) => x.State.Running).catch(() => false)));
      if (states.every(Boolean)) break;
      await sleep(1000);
    }
    for (const [i, n] of fixed.entries()) assert.equal((await ipOn(dind, n, DFAB)).ip, addressAt(dl, 32 + i), `${n} keeps its fixed address across a daemon restart`);
    t.diagnostic('fixed addresses survived the dind daemon restart');

    // ── E. stolen fixed address on a network WITHOUT IPRange (the review's reboot case) and its repair ──
    // After a daemon restart Docker's allocator restarts from the bottom of the subnet: a dynamic container takes
    // the low static address of a container that is not running; that owner then cannot start ("Address already in
    // use" in State.Error). Repair (pinning.ts relocateIntruders / selfHeal.ts): the intruder is re-pinned elsewhere
    // (top of the subnet), the owner started again.
    const mTaken = (await listDockerSubnets(dind)).flatMap((n) => n.subnets);
    const mCidr = formatCidr4(pickFreeSubnet(parseCidr4('10.233.0.0/16')!, 24, mTaken)!);
    const DMIX = `${prefix}-dmix`;
    await ops.createNetwork(dind, DMIX, {}, { subnet: mCidr }); // explicit subnet, NO IPRange (like an adopted network)
    const ml = layoutOf(mCidr, null);
    const owner = `${prefix}-downer`;
    await dind.createContainer({
      name: owner, Image: IMAGE, Cmd: ['sleep', '3600'], HostConfig: { NetworkMode: DMIX, RestartPolicy: { Name: 'unless-stopped' } },
      NetworkingConfig: { EndpointsConfig: { [DMIX]: { IPAMConfig: { IPv4Address: addressAt(ml, 2) } } } },
    });
    await dind.getContainer(owner).start();
    const dyns = [1, 2, 3].map((i) => `${prefix}-ddyn-${i}`);
    for (const n of dyns) {
      await dind.createContainer({ name: n, Image: IMAGE, Cmd: ['sleep', '3600'], HostConfig: { NetworkMode: DMIX, RestartPolicy: { Name: 'unless-stopped' } } });
      await dind.getContainer(n).start();
    }
    await dind.getContainer(owner).stop({ t: 0 }); // not running at the restart (its address is not reserved)
    await host.getContainer(dindName).restart({ t: 5 });
    const back = Date.now() + 120_000;
    for (;;) {
      try { await dind.ping(); break; } catch { if (Date.now() > back) throw new Error('dind did not come back'); await sleep(1000); }
    }
    await sleep(3000);
    const lowIp = addressAt(ml, 2);
    const holderOfLow = async (): Promise<string | null> => {
      const n = await dind.getNetwork(DMIX).inspect() as Docker.NetworkInspectInfo;
      const e = Object.values(n.Containers ?? {}).find((c) => (c as { IPv4Address?: string }).IPv4Address?.split('/')[0] === lowIp) as { Name?: string } | undefined;
      return e?.Name ?? null;
    };
    let intruder = await holderOfLow();
    if (!intruder) {
      const late = `${prefix}-ddyn-late`;
      await dind.createContainer({ name: late, Image: IMAGE, Cmd: ['sleep', '3600'], HostConfig: { NetworkMode: DMIX, RestartPolicy: { Name: 'unless-stopped' } } });
      await dind.getContainer(late).start();
      intruder = await holderOfLow();
    }
    t.diagnostic(`after the daemon restart ${lowIp} (static address of the stopped owner) is held by ${intruder ?? 'nobody'}`);
    if (intruder) {
      await assert.rejects(dind.getContainer(owner).start(), (e: unknown) => ops.isAddressInUse(e), 'the owner cannot start on its stolen address');
      const stuck = await dind.getContainer(owner).inspect();
      t.diagnostic(`owner State.Error: ${stuck.State.Error}`);
      assert.ok(ops.isAddressInUse(String(stuck.State.Error ?? '')), 'State.Error says the address is in use (what the repair keys on)');
      const top = addressAt(ml, [...(await import('./addressLayout')).poolOffsetsFromTop(ml)][0]);
      assert.equal(await ops.pinEndpoint(dind, DMIX, intruder, top), 'pinned', 'intruder moved to the top of the subnet while running');
      await dind.getContainer(owner).start();
      assert.equal((await ipOn(dind, owner, DMIX)).ip, lowIp, 'owner started again on its fixed address');
      assert.deepEqual(await ipOn(dind, intruder, DMIX), { ip: top, static: top });
      // Everything static now: another daemon restart keeps every address.
      for (const n of dyns) {
        const cur = await ipOn(dind, n, DMIX);
        if (!cur.static && cur.ip) await ops.pinEndpoint(dind, DMIX, n, cur.ip);
      }
      const want = new Map<string, string>();
      for (const n of [owner, intruder, ...dyns]) want.set(n, (await ipOn(dind, n, DMIX)).ip);
      await host.getContainer(dindName).restart({ t: 5 });
      const again = Date.now() + 120_000;
      for (;;) {
        try { await dind.ping(); break; } catch { if (Date.now() > again) throw new Error('dind did not come back'); await sleep(1000); }
      }
      for (let i = 0; i < 30; i++) {
        const states = await Promise.all([...want.keys()].map((n) => dind.getContainer(n).inspect().then((x) => x.State.Running).catch(() => false)));
        if (states.every(Boolean)) break;
        await sleep(1000);
      }
      for (const [n, ip] of want) {
        const i = await dind.getContainer(n).inspect();
        assert.ok(i.State.Running, `${n} running after the restart (all pinned: nothing stolen)`);
        assert.equal((await ipOn(dind, n, DMIX)).ip, ip, `${n} kept ${ip}`);
      }
      t.diagnostic('network pinned whole: every container back on its address after the daemon restart');
    }
  }
  await cleanup(dind, prefix);
});
