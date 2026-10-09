import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import { MailDriverError, type MailDesiredState } from '../../driver';
import { MAIL_CONTAINER, MAIL_NETWORK, MAIL_REDIS_CONTAINER, MAIL_RSPAMD_CONTAINER, SCANNER_CONTAINER } from '../../../hosting/naming';
import { hostingLayout } from '../../../hosting/paths';
import type { ExecResult } from '../../../docker/engine';
import { createPostfixDovecotDriver, ensureCoreNetwork, mailNetworkTopology, type PostfixDovecotDeps } from './driver';
import { MAIL_CORE_NETWORK, MAIL_CTL, RSPAMD_CTL } from './layout';
import { baseState, lines, tempDir } from './testUtil';

// Driver behaviour with a fake Docker and a simulated `docker exec`
// (sync idempotence, reload only on change, rollback, mass-removal guard,
// scanner attachment, runtime commands).

interface FakeContainer { running: boolean; networks: string[]; labels?: Record<string, string>; env?: string[] }

function fakeDocker(containers: Record<string, FakeContainer>, calls: string[], opts: { network?: boolean; core?: boolean; restartFails?: string[] } = {}): Docker {
  const notFound = () => Object.assign(new Error('no such object'), { statusCode: 404 });
  return {
    getContainer: (name: string) => ({
      inspect: async () => {
        const c = containers[name];
        if (!c) throw notFound();
        return {
          Name: `/${name}`,
          State: { Running: c.running, Status: c.running ? 'running' : 'exited', ExitCode: c.running ? 0 : 1 },
          Config: { Labels: c.labels ?? {}, Image: `${name}:test`, Env: c.env ?? [] },
          NetworkSettings: { Networks: Object.fromEntries(c.networks.map((n) => [n, {}])) },
        };
      },
      stop: async () => { calls.push(`stop ${name}`); containers[name].running = false; },
      restart: async () => {
        calls.push(`restart ${name}`);
        if (opts.restartFails?.includes(name)) throw Object.assign(new Error("(HTTP code 500) server error - cannot restart"), { statusCode: 500 });
      },
      remove: async () => { calls.push(`remove ${name}`); delete containers[name]; },
    }),
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (name === MAIL_CORE_NETWORK && opts.core) return { Name: name, IPAM: { Config: [{ Subnet: '172.30.0.0/16' }] } };
        if (name !== MAIL_NETWORK || opts.network === false) throw notFound();
        return { Name: name, IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }, { Subnet: 'fd00:1::/64' }] } };
      },
      connect: async ({ Container }: { Container: string }) => { calls.push(`connect ${name} ${Container}`); containers[Container].networks.push(name); },
      remove: async () => { calls.push(`remove network ${name}`); },
      disconnect: async ({ Container }: { Container: string }) => {
        calls.push(`disconnect ${name} ${Container}`);
        containers[Container].networks = containers[Container].networks.filter((n) => n !== name);
      },
    }),
  } as unknown as Docker;
}

function setup(t: { after: (fn: () => void) => void }, over: { exec?: PostfixDovecotDeps['exec']; containers?: Record<string, FakeContainer>; core?: boolean; restartFails?: string[] } = {}) {
  const root = tempDir(t);
  const local = hostingLayout(root);
  const calls: string[] = [];
  const containers: Record<string, FakeContainer> = over.containers ?? {
    [MAIL_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [MAIL_RSPAMD_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [MAIL_REDIS_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [SCANNER_CONTAINER]: { running: true, networks: ['oblimint'] },
  };
  const exec: PostfixDovecotDeps['exec'] = over.exec ?? (async (_d, container, cmd): Promise<ExecResult> => {
    calls.push(`exec ${container} ${cmd.slice(1).join(' ')}`);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const driver = createPostfixDovecotDriver({
    docker: async () => fakeDocker(containers, calls, { core: over.core, restartFails: over.restartFails }),
    exec: async (d, c, cmd, ms) => {
      if (over.exec) calls.push(`exec ${c} ${cmd.slice(1).join(' ')}`);
      return exec(d, c, cmd, ms);
    },
    ensureNetwork: async () => {},
    bootSettings: async () => ({ hostname: 'mail.oblimint.test', maxMessageSizeMb: 50, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: true }),
    local,
    host: hostingLayout('/srv/oblimint'),
    hostDataDir: () => '/srv/oblimint',
    bindAddresses: () => [],
    scannerMaxFileSizeMb: async () => 32,
    refreshScanner: async () => { calls.push('refresh scanner'); },
    setOwners: false,
    now: () => new Date('2026-10-09T12:00:00Z'),
    sleep: async () => {},
  });
  const configDir = local.mailEngineConfig('postfix-dovecot');
  return { driver, calls, containers, local, configDir, root };
}

const reloads = (calls: string[]) => calls.filter((c) => c.startsWith('exec ') || c.startsWith('restart '));

test('sync: writes the configuration, reloads Rspamd + engine after their checks, attaches the scanner', async (t) => {
  const { driver, calls, containers, configDir, local } = setup(t);
  const res = await driver.sync(baseState(), { reason: 'test' });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.deepEqual({ d: res.domains, m: res.mailboxes, a: res.aliases }, { d: 1, m: 5, a: 2 });
  assert.deepEqual(reloads(calls), [
    `exec ${MAIL_RSPAMD_CONTAINER} configtest`,
    `exec ${MAIL_CONTAINER} reload`,
    `restart ${MAIL_RSPAMD_CONTAINER}`,
  ]);
  // clamd on the core network only, never on MAIL_NETWORK (webmail / edge / relay)
  assert.ok(calls.includes(`connect ${MAIL_CORE_NETWORK} ${SCANNER_CONTAINER}`));
  assert.ok(containers[SCANNER_CONTAINER].networks.includes(MAIL_CORE_NETWORK));
  assert.ok(!containers[SCANNER_CONTAINER].networks.includes(MAIL_NETWORK));
  // ClamAV never gets more than the scanner accepts (scanner.maxFileSizeMb = 32)
  assert.match(fs.readFileSync(path.join(configDir, 'rspamd/antivirus.conf'), 'utf8'), /max_size = 33554432;/);
  for (const f of ['postfix/main.cf', 'postfix/master.cf', 'dovecot/dovecot.conf', 'dovecot/passwd', 'rspamd/dkim_signing.conf', 'sieve/104.sieve', 'manifest.json']) {
    assert.ok(fs.existsSync(path.join(configDir, f)), f);
  }
  assert.ok(fs.existsSync(path.join(local.mailDkim(), 'exemple.fr', 'om202610.key')));
  // trusted networks from the IPAM, gateway excluded
  const conf = fs.readFileSync(path.join(configDir, 'dovecot/dovecot.conf'), 'utf8');
  assert.match(conf, /^login_trusted_networks = .*fd00:1::\/128/m);
  assert.ok(!/172\.20\.0\.0\/16/.test(conf));
  // the manifest lists addresses, never a hash
  const manifest = fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8');
  assert.ok(manifest.includes('contact@exemple.fr'));
  assert.ok(!manifest.includes('$6$'));
});

test('sync: mail.clamav on but scanner not deployed / stopped ⇒ no ClamAV rule (Rspamd resolves AV servers at load)', async (t) => {
  for (const scanner of [null, { running: false, networks: ['oblimint'] }] as const) {
    const containers: Record<string, FakeContainer> = {
      [MAIL_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
      [MAIL_RSPAMD_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
      [MAIL_REDIS_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    };
    if (scanner) containers[SCANNER_CONTAINER] = { running: scanner.running, networks: [...scanner.networks] };
    const { driver, configDir } = setup(t, { containers });
    const state = baseState();
    assert.ok(state.settings.clamav && state.settings.clamdAddress, 'precondition: ClamAV wanted');
    const res = await driver.sync(state, { reason: 'test' });
    assert.equal(res.ok, true);
    const av = fs.readFileSync(path.join(configDir, 'rspamd/antivirus.conf'), 'utf8');
    assert.ok(!av.includes(SCANNER_CONTAINER), `no reference to ${SCANNER_CONTAINER} (${scanner ? 'stopped' : 'absent'})`);
    assert.ok(!/type = "clamav"/.test(av));
  }
});

test('sync: idempotent — same state,nothing written, nothing reloaded; one part changed ⇒ only that part reloaded', async (t) => {
  const { driver, calls, configDir } = setup(t);
  await driver.sync(baseState(), { reason: 'first' });
  const mtime = fs.statSync(path.join(configDir, 'postfix/main.cf')).mtimeMs;
  calls.length = 0;
  const again = await driver.sync(baseState(), { reason: 'again' });
  assert.equal(again.changed, false);
  assert.deepEqual(reloads(calls), []);
  assert.equal(fs.statSync(path.join(configDir, 'postfix/main.cf')).mtimeMs, mtime);

  const quota = baseState();
  quota.mailboxes[0].quotaMb = 4096;
  calls.length = 0;
  assert.equal((await driver.sync(quota, { reason: 'quota' })).changed, true);
  assert.deepEqual(reloads(calls), [`exec ${MAIL_CONTAINER} reload`], 'Dovecot userdb only');

  const spam = { ...quota, settings: { ...quota.settings, spamRejectScore: 20 } };
  calls.length = 0;
  await driver.sync(spam, { reason: 'spam' });
  assert.deepEqual(reloads(calls), [`exec ${MAIL_RSPAMD_CONTAINER} configtest`, `restart ${MAIL_RSPAMD_CONTAINER}`], 'Rspamd only');
});

test('sync: mass-removal guard (refused without allowMassRemoval, applied with it)', async (t) => {
  const { driver, calls, configDir } = setup(t);
  await driver.sync(baseState(), { reason: 'first' });
  const empty: MailDesiredState = { ...baseState(), mailboxes: [], aliases: [], appPasswords: [] };
  calls.length = 0;
  await assert.rejects(driver.sync(empty, { reason: 'db glitch' }), (e: unknown) => e instanceof MailDriverError && e.code === 'massRemoval' && !/\$6\$|[0-9a-f]{64}/.test(e.message));
  assert.deepEqual(reloads(calls), []);
  assert.equal(lines(fs.readFileSync(path.join(configDir, 'dovecot/passwd'), 'utf8')).length, 4, 'nothing removed');
  const res = await driver.sync(empty, { reason: 'staff', allowMassRemoval: true });
  assert.equal(res.changed, true);
  assert.equal(lines(fs.readFileSync(path.join(configDir, 'dovecot/passwd'), 'utf8')).length, 0);
});

test('sync: a refused configuration restores the previous files and is retried at the next sync', async (t) => {
  let fail = false;
  const { driver, calls, configDir } = setup(t, {
    exec: async (_d, _c, cmd) => (fail && cmd[1] === 'reload' && cmd[0] === MAIL_CTL
      ? { exitCode: 1, stdout: '', stderr: 'postfix: fatal: /run/oblimint-mail/gen-2/postfix/main.cf, line 3: missing \'=\'' }
      : { exitCode: 0, stdout: '', stderr: '' }),
  });
  await driver.sync(baseState(), { reason: 'first' });
  const before = fs.readFileSync(path.join(configDir, 'dovecot/users'), 'utf8');
  const manifest = fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8');
  const next = baseState();
  next.mailboxes[0].quotaMb = 9999;
  fail = true;
  await assert.rejects(driver.sync(next, { reason: 'bad' }), (e: unknown) => e instanceof MailDriverError && e.code === 'applyFailed' && /missing/.test(e.detail ?? ''));
  assert.equal(fs.readFileSync(path.join(configDir, 'dovecot/users'), 'utf8'), before, 'previous files restored');
  assert.equal(fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8'), manifest, 'manifest untouched');
  fail = false;
  calls.length = 0;
  const res = await driver.sync(next, { reason: 'retry' });
  assert.equal(res.changed, true);
  assert.ok(reloads(calls).includes(`exec ${MAIL_CONTAINER} reload`));
});

test('sync: Rspamd is applied by a container restart (never SIGHUP); a failed restart keeps the checked files and is retried', async (t) => {
  const restartFails: string[] = [];
  const { driver, calls, configDir } = setup(t, { restartFails });
  await driver.sync(baseState(), { reason: 'first' });
  assert.ok(!reloads(calls).some((c) => c === `exec ${MAIL_RSPAMD_CONTAINER} reload`), 'no in-place Rspamd reload');
  const spam = baseState();
  spam.settings = { ...spam.settings, spamRejectScore: 20 };
  spam.mailboxes[0].quotaMb = 4096;
  const usersBefore = fs.readFileSync(path.join(configDir, 'dovecot/users'), 'utf8');
  restartFails.push(MAIL_RSPAMD_CONTAINER);
  calls.length = 0;
  await assert.rejects(driver.sync(spam, { reason: 'restart fails' }),
    (e: unknown) => e instanceof MailDriverError && e.code === 'unavailable' && e.message.includes(MAIL_RSPAMD_CONTAINER));
  assert.deepEqual(reloads(calls), [`exec ${MAIL_RSPAMD_CONTAINER} configtest`, `exec ${MAIL_CONTAINER} reload`, `restart ${MAIL_RSPAMD_CONTAINER}`]);
  // the engine already runs the new generation: its files are NOT restored
  assert.match(fs.readFileSync(path.join(configDir, 'rspamd/actions.conf'), 'utf8'), /reject = 20;/);
  assert.notEqual(fs.readFileSync(path.join(configDir, 'dovecot/users'), 'utf8'), usersBefore, 'new userdb kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8')).unconfirmed, ['rspamd']);
  // next sync: same state, Rspamd checked + restarted again, then confirmed
  restartFails.length = 0;
  calls.length = 0;
  const res = await driver.sync(spam, { reason: 'retry' });
  assert.equal(res.changed, true);
  assert.deepEqual(reloads(calls), [`exec ${MAIL_RSPAMD_CONTAINER} configtest`, `exec ${MAIL_CONTAINER} reload`, `restart ${MAIL_RSPAMD_CONTAINER}`]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8')).unconfirmed, undefined);
});

test('sync: containers stopped ⇒ files written, reported, checked at the next sync; invalid state ⇒ invalidState; ClamAV off ⇒ scanner detached', async (t) => {
  const { driver, calls, containers, configDir } = setup(t, {
    containers: {
      [MAIL_CONTAINER]: { running: false, networks: [MAIL_NETWORK] },
      [MAIL_RSPAMD_CONTAINER]: { running: false, networks: [MAIL_NETWORK] },
      [SCANNER_CONTAINER]: { running: true, networks: ['oblimint', MAIL_NETWORK, MAIL_CORE_NETWORK] },
    },
  });
  const off = baseState();
  off.settings = { ...off.settings, clamav: false, clamdAddress: null };
  await assert.rejects(driver.sync(off, { reason: 'test' }),
    (e: unknown) => e instanceof MailDriverError && e.code === 'unavailable' && /not running.*not checked/.test(e.message));
  assert.deepEqual(reloads(calls), []);
  assert.ok(fs.existsSync(path.join(configDir, 'postfix/main.cf')), 'files written (the start compiles them)');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8')).unconfirmed, ['engine', 'rspamd']);
  // still down: same fingerprint is NOT "unchanged", still reported
  await assert.rejects(driver.sync(off, { reason: 'again' }), (e: unknown) => e instanceof MailDriverError && e.code === 'unavailable');
  // started: the same state is now checked + reloaded, then confirmed
  containers[MAIL_CONTAINER].running = true;
  containers[MAIL_RSPAMD_CONTAINER].running = true;
  const res = await driver.sync(off, { reason: 'started' });
  assert.equal(res.changed, true);
  assert.deepEqual(reloads(calls), [`exec ${MAIL_RSPAMD_CONTAINER} configtest`, `exec ${MAIL_CONTAINER} reload`, `restart ${MAIL_RSPAMD_CONTAINER}`]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'manifest.json'), 'utf8')).unconfirmed, undefined);
  assert.equal((await driver.sync(off, { reason: 'idle' })).changed, false);
  assert.ok(calls.includes(`disconnect ${MAIL_NETWORK} ${SCANNER_CONTAINER}`));
  assert.ok(calls.includes(`disconnect ${MAIL_CORE_NETWORK} ${SCANNER_CONTAINER}`));
  assert.ok(!containers[SCANNER_CONTAINER].networks.includes(MAIL_NETWORK));
  assert.ok(!containers[SCANNER_CONTAINER].networks.includes(MAIL_CORE_NETWORK));
  const bad = baseState();
  bad.settings.hostname = 'bad host';
  await assert.rejects(driver.sync(bad, { reason: 'x' }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
});

test('sync: partial errors are reported per domain, the rest is applied (ok=false)', async (t) => {
  const { driver } = setup(t);
  const s = baseState();
  s.aliases.push({ id: 7, accountId: 10, domainId: 1, address: 'x@exemple.fr', targets: ['not an address'] });
  const res = await driver.sync(s, { reason: 'x' });
  assert.equal(res.ok, false);
  assert.ok(res.domainErrors['exemple.fr']);
  assert.equal(res.mailboxes, 5);
});

test('runtime: queue / usage read the ctl outputs; queue actions validate the id; status never throws', async (t) => {
  let out = '';
  const ctx = setup(t, {
    exec: async (_d, _c, cmd) => {
      const stateCtl = path.join(ctx.local.mailEngineData('postfix-dovecot'), 'state', 'ctl');
      fs.mkdirSync(stateCtl, { recursive: true });
      if (cmd[1] === 'queue') fs.writeFileSync(path.join(stateCtl, 'queue.jsonl'), '{"queue_name":"deferred","queue_id":"7F00AA11BB","arrival_time":1,"message_size":5,"sender":"a@b.fr","recipients":[{"address":"c@d.fr"}]}\n');
      if (cmd[1] === 'usage') fs.writeFileSync(path.join(stateCtl, 'usage.json'), '[{"user":"contact@exemple.fr","type":"STORAGE","value":"10"}]');
      if (cmd[1] === 'delete' && cmd[2] === 'AAAAAAAAAA') return { exitCode: 3, stdout: '', stderr: 'postsuper: AAAAAAAAAA: no such queue file' };
      if (cmd[1] === 'version') return { exitCode: 0, stdout: 'postfix 3.9.1 / dovecot 2.3.21.1 (d492236fa0) / pigeonhole 0.5.21.1\n', stderr: '' };
      out = cmd.join(' ');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const q = await ctx.driver.queue({ limit: 5000 });
  assert.deepEqual(q.map((i) => i.queueId), ['7F00AA11BB']);
  assert.ok(ctx.calls.includes(`exec ${MAIL_CONTAINER} queue 1000`), 'limit capped');
  assert.deepEqual(await ctx.driver.usage(), [{ address: 'contact@exemple.fr', usedBytes: 10240, messages: null }]);
  await ctx.driver.queueAction('7F00AA11BB', 'retry');
  assert.equal(out, `${MAIL_CTL} retry 7F00AA11BB`);
  await assert.rejects(ctx.driver.queueAction('AAAAAAAAAA', 'delete'), (e: unknown) => e instanceof MailDriverError && e.code === 'notFound');
  ctx.calls.length = 0;
  for (const bad of ['7f00aa11bb', '7F00AA11BB; rm -rf /', '../x', '', 'ABC']) {
    await assert.rejects(ctx.driver.queueAction(bad, 'delete'), (e: unknown) => e instanceof MailDriverError && e.code === 'notFound', bad);
  }
  assert.deepEqual(reloads(ctx.calls), [], 'an invalid id never reaches the container');
  assert.equal(await ctx.driver.version(), 'postfix 3.9.1 / dovecot 2.3.21.1 (d492236fa0) / pigeonhole 0.5.21.1');

  const st = await ctx.driver.status();
  assert.equal(st.length, 3);
  assert.ok(st.every((s) => s.id === 'mail' && s.deployed && s.running));
  const down = createPostfixDovecotDriver({ docker: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); } });
  const st2 = await down.status();
  assert.equal(st2.length, 3);
  assert.ok(st2.every((s) => !s.deployed && /unreachable/.test(s.detail ?? '')));
  assert.equal(await down.version(), null);
  await assert.rejects(down.queue({ limit: 10 }), (e: unknown) => e instanceof MailDriverError && e.code === 'unavailable');
  // container missing ⇒ notDeployed
  delete ctx.containers[MAIL_CONTAINER];
  await assert.rejects(ctx.driver.usage(), (e: unknown) => e instanceof MailDriverError && e.code === 'notDeployed');
});

test('core network: created when missing (internal label, never an account network), account-labelled one refused', async () => {
  const created: Array<{ Name: string; Labels: Record<string, string> }> = [];
  const fake = (labels: Record<string, string> | null) => ({
    getNetwork: () => ({
      inspect: async () => {
        if (!labels) throw Object.assign(new Error('no such network'), { statusCode: 404 });
        return { Name: MAIL_CORE_NETWORK, Labels: labels };
      },
    }),
    createNetwork: async (o: { Name: string; Labels: Record<string, string> }) => { created.push(o); },
  }) as unknown as Docker;
  await ensureCoreNetwork(fake(null), () => {});
  assert.equal(created.length, 1);
  assert.equal(created[0].Name, MAIL_CORE_NETWORK);
  assert.equal(created[0].Labels['oblimint.internal'], 'true');
  assert.equal(created[0].Labels['oblimint.account'], undefined);
  await ensureCoreNetwork(fake({ 'oblimint.internal': 'true' }), () => {});
  assert.equal(created.length, 1, 'existing network kept');
  await assert.rejects(ensureCoreNetwork(fake({ 'oblimint.account': '7' }), () => {}), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
});

test('remove: containers removed, data kept, scanner detached; endpoints on the mail network', async (t) => {
  const { driver, calls, containers, local } = setup(t);
  await driver.sync(baseState(), { reason: 'x' });
  await driver.remove(() => {});
  assert.equal(containers[MAIL_CONTAINER], undefined);
  assert.equal(containers[MAIL_RSPAMD_CONTAINER], undefined);
  assert.equal(containers[MAIL_REDIS_CONTAINER], undefined);
  assert.ok(calls.includes(`disconnect ${MAIL_CORE_NETWORK} ${SCANNER_CONTAINER}`));
  assert.ok(calls.includes(`remove network ${MAIL_CORE_NETWORK}`));
  assert.ok(fs.existsSync(path.join(local.mailEngineConfig('postfix-dovecot'), 'manifest.json')), 'configuration kept');
  assert.deepEqual(driver.imapEndpoint(), { host: MAIL_CONTAINER, port: 143, tls: 'none' });
  assert.deepEqual(driver.submissionEndpoint(), { host: MAIL_CONTAINER, port: 587, tls: 'starttls' });
  assert.deepEqual(driver.sieveEndpoint(), { host: MAIL_CONTAINER, port: 4190, tls: 'none' });
  assert.deepEqual(driver.relayTarget(), { host: MAIL_CONTAINER, port: 10025, tls: 'none' });
  assert.equal(driver.capabilities.appPasswordNets, true);
  assert.equal(driver.capabilities.passwordSchemes.length, 7);
});

test('mail network topology: subnets + gateways (first host when IPAM has none), missing network', async () => {
  const calls: string[] = [];
  assert.deepEqual(await mailNetworkTopology(fakeDocker({}, calls)), { subnets: ['172.20.0.0/16', 'fd00:1::/64'], gateways: ['172.20.0.1', 'fd00:1::1'] });
  assert.deepEqual(await mailNetworkTopology(fakeDocker({}, calls, { network: false })), { subnets: [], gateways: [] });
});

test('ctl commands used by the driver exist in the image scripts', () => {
  const images = path.resolve(__dirname, '../../../../../../images');
  const mailCtl = fs.readFileSync(path.join(images, 'mail-postfix', 'oblimint-mail-ctl'), 'utf8');
  for (const sub of ['reload', 'ping', 'version', 'usage', 'queue', 'retry', 'delete']) assert.match(mailCtl, new RegExp(`^\\t${sub}\\)`, 'm'), sub);
  const rspamdCtl = fs.readFileSync(path.join(images, 'mail-rspamd', 'oblimint-rspamd-ctl'), 'utf8');
  for (const sub of ['configtest', 'ping']) assert.match(rspamdCtl, new RegExp(`^\\t${sub}\\)`, 'm'), sub);
  // Rspamd -f writes no pid file and 3.10 segfaults on SIGHUP: no in-place reload
  assert.doesNotMatch(rspamdCtl, /^\treload\)|kill\s+-HUP/m);
  // sievec must compile against the new generation (the default config only includes `live`)
  assert.match(mailCtl, /sievec -c "\$gen\/dovecot\/dovecot\.conf" "\$s"/);
  // relay: an empty `listen =` is refused by Dovecot 2.3.21
  assert.doesNotMatch(fs.readFileSync(path.join(images, 'mail-relay', 'conf', 'dovecot.conf'), 'utf8'), /^\s*listen\s*=\s*$/m);
  assert.equal(MAIL_CTL, '/usr/local/bin/oblimint-mail-ctl');
  assert.equal(RSPAMD_CTL, '/usr/local/bin/oblimint-rspamd-ctl');
});

test('scanner: clamd TCP redeployed only when its bound subnets differ from what the engine needs (R-CLAMD-TCP)', async (t) => {
  const tcpEnv = ['SCAND_CLAMAV=1', 'OBLIMINT_CLAMD_TCP=1', 'OBLIMINT_CLAMD_TCP_NETS=172.30.0.0/16'];
  const flush = () => new Promise((r) => setImmediate(r));
  // core network present, scanner without TCP ⇒ redeploy
  const a = setup(t, { core: true });
  await a.driver.sync(baseState(), { reason: 'test' });
  await flush();
  assert.equal(a.calls.filter((c) => c === 'refresh scanner').length, 1);
  // matching TCP subnets ⇒ nothing
  const b = setup(t, { core: true, containers: {
    [MAIL_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [MAIL_RSPAMD_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [MAIL_REDIS_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [SCANNER_CONTAINER]: { running: true, networks: ['oblimint', MAIL_CORE_NETWORK], env: tcpEnv },
  } });
  await b.driver.sync(baseState(), { reason: 'test' });
  await flush();
  assert.ok(!b.calls.includes('refresh scanner'));
  // ClamAV off ⇒ detached and the TCP socket closed by a redeploy
  const off = baseState();
  off.settings = { ...off.settings, clamav: false, clamdAddress: null };
  await b.driver.sync(off, { reason: 'test' });
  await flush();
  assert.ok(b.calls.includes(`disconnect ${MAIL_CORE_NETWORK} ${SCANNER_CONTAINER}`));
  assert.equal(b.calls.filter((c) => c === 'refresh scanner').length, 1);
  // remove(): the redeploy comes after the network is gone
  const c = setup(t, { core: true, containers: {
    [MAIL_CONTAINER]: { running: true, networks: [MAIL_NETWORK] },
    [SCANNER_CONTAINER]: { running: true, networks: ['oblimint', MAIL_CORE_NETWORK], env: tcpEnv },
  } });
  await c.driver.remove(() => {});
  await flush();
  const i = c.calls.indexOf(`remove network ${MAIL_CORE_NETWORK}`);
  assert.ok(i >= 0 && c.calls.indexOf('refresh scanner') > i);
});
