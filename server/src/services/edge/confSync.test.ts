import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDebouncedRunner, EDGE_NOT_RUNNING, syncConfDir, type ConfSyncDeps, type EdgeExecResult } from './confSync';
import type { EdgeVhost } from './nginxConfig';

const quietLog = { info: () => {}, warn: () => {} };

function vhost(id: string, name: string): EdgeVhost {
  return {
    id, serverNames: [name], tls: null, forceHttps: false, suspended: false,
    locations: [{ pathPrefix: '/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }],
    extraHeaders: {}, clientMaxBodyMb: 512,
  };
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeDeps(confDir: string, opts: { running?: boolean; testExit?: number } = {}) {
  const calls: string[][] = [];
  const deps: ConfSyncDeps = {
    confDir,
    isRunning: async () => opts.running ?? true,
    exec: async (cmd): Promise<EdgeExecResult> => {
      calls.push(cmd);
      if (cmd[1] === '-t') return { exitCode: opts.testExit ?? 0, stdout: '', stderr: opts.testExit ? 'nginx: [emerg] unexpected "}"' : 'syntax is ok' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    log: quietLog,
  };
  return { deps, calls };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort()) out[f] = fs.readFileSync(path.join(dir, f)).toString('base64');
  return out;
}

test('sync success: files written, stale *.conf removed, other files untouched, nginx -t then reload', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'd-99.conf'), 'stale');
  fs.writeFileSync(path.join(dir, 'd-1.conf.tmp'), 'leftover');
  fs.writeFileSync(path.join(dir, 'README'), 'keep me');
  const { deps, calls } = fakeDeps(dir);
  const res = await syncConfDir([vhost('d-1', 'a.example'), vhost('p-2', 'b.example')], deps);
  assert.equal(res.ok, true);
  assert.equal(res.vhostCount, 2);
  assert.equal(res.error, null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['README', 'd-1.conf', 'p-2.conf']);
  assert.match(fs.readFileSync(path.join(dir, 'd-1.conf'), 'utf8'), /server_name a\.example;/);
  assert.deepEqual(calls, [['nginx', '-t'], ['nginx', '-s', 'reload']]);

  // Unchanged second pass: nothing written, no reload unless forced.
  const again = await syncConfDir([vhost('d-1', 'a.example'), vhost('p-2', 'b.example')], deps);
  assert.equal(again.changed, 0);
  assert.equal(calls.length, 2);
  await syncConfDir([vhost('d-1', 'a.example'), vhost('p-2', 'b.example')], deps, { force: true });
  assert.equal(calls.length, 4);
});

test('nginx -t failure restores the previous files byte-for-byte', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'd-1.conf'), Buffer.from([0x23, 0x20, 0xff, 0x00, 0x0a]));
  fs.writeFileSync(path.join(dir, 'd-3.conf'), '# old d-3\r\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const before = snapshot(dir);
  const { deps, calls } = fakeDeps(dir, { testExit: 1 });
  const res = await syncConfDir([vhost('d-1', 'a.example'), vhost('d-2', 'c.example')], deps);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /unexpected/);
  assert.deepEqual(snapshot(dir), before);
  assert.ok(calls.length >= 1 && calls.every((c) => c[1] === '-t'), 'no reload after a failed test');
});

/** exec whose `nginx -t` fails while a conf.d file contains `BAD` (optionally naming the file). */
function judgingDeps(confDir: string, opts: { goodDir?: string; nameFile?: boolean } = {}) {
  const calls: string[][] = [];
  const deps: ConfSyncDeps = {
    confDir,
    goodDir: opts.goodDir,
    isRunning: async () => true,
    exec: async (cmd): Promise<EdgeExecResult> => {
      calls.push(cmd);
      if (cmd[1] !== '-t') return { exitCode: 0, stdout: '', stderr: '' };
      const bad = fs.readdirSync(confDir).filter((f) => f.endsWith('.conf') && fs.readFileSync(path.join(confDir, f), 'utf8').includes('BAD'));
      if (!bad.length) return { exitCode: 0, stdout: '', stderr: 'syntax is ok' };
      return {
        exitCode: 1, stdout: '',
        stderr: opts.nameFile
          ? `nginx: [emerg] unknown directive "BAD" in /etc/nginx/oblimint/conf.d/${bad[0]}:3\nnginx: configuration file /etc/nginx/nginx.conf test failed`
          : 'nginx: [emerg] could not build server_names_hash, you should increase server_names_hash_bucket_size: 64',
      };
    },
    log: quietLog,
  };
  return { deps, calls };
}

function badVhost(id: string): EdgeVhost {
  // A valid vhost whose rendering contains BAD (the fake nginx -t refuses it).
  return vhost(id, 'bad.example');
}

function markBad(dir: string, file: string): void {
  fs.appendFileSync(path.join(dir, file), '# BAD\n');
}

test('nginx -t naming a vhost file: that vhost is isolated, the others are reloaded', async (t) => {
  const dir = tempDir(t);
  const good = tempDir(t);
  const { deps, calls } = judgingDeps(dir, { goodDir: good, nameFile: true });
  // First pass, all good → recorded as last-known-good.
  const first = await syncConfDir([vhost('d-1', 'a.example'), vhost('d-2', 'b.example')], deps);
  assert.equal(first.ok, true);
  assert.deepEqual(fs.readdirSync(good).filter((f) => f.endsWith('.conf')).sort(), ['d-1.conf', 'd-2.conf']);

  // d-2 changes and becomes invalid, d-3 is new and valid.
  const vhosts = [vhost('d-1', 'a.example'), badVhost('d-2'), vhost('d-3', 'c.example')];
  const exec = deps.exec;
  deps.exec = async (cmd) => {
    // The rendered d-2 (bad.example) is what nginx refuses.
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.conf') && fs.readFileSync(path.join(dir, f), 'utf8').includes('bad.example') && !fs.readFileSync(path.join(dir, f), 'utf8').includes('BAD')) markBad(dir, f);
    }
    return exec(cmd);
  };
  calls.length = 0;
  const res = await syncConfDir(vhosts, deps);
  assert.equal(res.ok, false);
  assert.equal(res.reloaded, true);
  assert.deepEqual(res.rejected.map((r) => r.id), ['d-2']);
  assert.match(res.error ?? '', /d-2/);
  // d-2 back to its last good version, d-3 served.
  assert.match(fs.readFileSync(path.join(dir, 'd-2.conf'), 'utf8'), /server_name b\.example;/);
  assert.match(fs.readFileSync(path.join(dir, 'd-3.conf'), 'utf8'), /server_name c\.example;/);
  assert.deepEqual(calls.at(-1), ['nginx', '-s', 'reload']);
  assert.equal(fs.existsSync(path.join(good, 'd-3.conf')), true, 'new good copy recorded');
});

test('nginx -t naming a NEW vhost file: it is removed, the others are reloaded', async (t) => {
  const dir = tempDir(t);
  const { deps } = judgingDeps(dir, { nameFile: true });
  await syncConfDir([vhost('d-1', 'a.example')], deps);
  const exec = deps.exec;
  deps.exec = async (cmd) => {
    if (fs.existsSync(path.join(dir, 'd-9.conf')) && !fs.readFileSync(path.join(dir, 'd-9.conf'), 'utf8').includes('BAD')) markBad(dir, 'd-9.conf');
    return exec(cmd);
  };
  const res = await syncConfDir([vhost('d-1', 'a.example'), vhost('d-9', 'z.example')], deps);
  assert.equal(res.reloaded, true);
  assert.deepEqual(res.rejected.map((r) => r.id), ['d-9']);
  assert.deepEqual(fs.readdirSync(dir), ['d-1.conf']);
  assert.equal(res.vhostCount, 1);
});

test('nginx -t error naming no file: changed vhosts re-applied one by one, the failing one kept out', async (t) => {
  const dir = tempDir(t);
  const { deps, calls } = judgingDeps(dir, { nameFile: false });
  await syncConfDir([vhost('d-1', 'a.example')], deps);
  const exec = deps.exec;
  deps.exec = async (cmd) => {
    if (fs.existsSync(path.join(dir, 'd-5.conf')) && !fs.readFileSync(path.join(dir, 'd-5.conf'), 'utf8').includes('BAD')) markBad(dir, 'd-5.conf');
    return exec(cmd);
  };
  calls.length = 0;
  const res = await syncConfDir([vhost('d-1', 'a.example'), vhost('d-4', 'd.example'), vhost('d-5', 'e.example'), vhost('d-6', 'f.example')], deps);
  assert.equal(res.reloaded, true);
  assert.deepEqual(res.rejected.map((r) => r.id), ['d-5']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['d-1.conf', 'd-4.conf', 'd-6.conf']);
  assert.ok(calls.filter((c) => c[1] === '-t').length <= 5);
});

test('restore uses the last-known-good copy, not untested files left on disk (crash / edge stopped)', async (t) => {
  const dir = tempDir(t);
  const good = tempDir(t);
  const { deps } = judgingDeps(dir, { goodDir: good, nameFile: false });
  assert.equal((await syncConfDir([vhost('d-1', 'a.example')], deps)).ok, true);
  const goodSnapshot = fs.readFileSync(path.join(dir, 'd-1.conf'));
  // Untested broken content written while the panel crashed before the test.
  fs.writeFileSync(path.join(dir, 'd-1.conf'), 'server { BAD }\n');
  fs.writeFileSync(path.join(dir, 'd-7.conf'), 'server { BAD }\n');
  // Desired state also broken for every file → nothing passes → last good restored.
  const exec = deps.exec;
  deps.exec = async (cmd) => {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.conf') && f !== 'd-1.conf' && !fs.readFileSync(path.join(dir, f), 'utf8').includes('BAD')) markBad(dir, f);
    return exec(cmd);
  };
  const res = await syncConfDir([vhost('d-1', 'a.example'), vhost('d-8', 'h.example')], deps, { force: true });
  assert.equal(res.reloaded, true);
  assert.deepEqual(res.rejected.map((r) => r.id), ['d-8']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['d-1.conf']);
  assert.ok(fs.readFileSync(path.join(dir, 'd-1.conf')).equals(goodSnapshot));
});

test('edge not running: files written, nothing executed, error reported', async (t) => {
  const dir = tempDir(t);
  const { deps, calls } = fakeDeps(dir, { running: false });
  const res = await syncConfDir([vhost('d-1', 'a.example')], deps);
  assert.equal(res.ok, false);
  assert.equal(res.error, EDGE_NOT_RUNNING);
  assert.deepEqual(fs.readdirSync(dir), ['d-1.conf']);
  assert.equal(calls.length, 0);
});

test('an invalid vhost is skipped, the others are still served', async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir);
  const res = await syncConfDir([vhost('d-1', 'a.example'), vhost('d-2', 'evil.example; }')], deps);
  assert.equal(res.ok, true);
  assert.equal(res.vhostCount, 1);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].id, 'd-2');
  assert.deepEqual(fs.readdirSync(dir), ['d-1.conf']);
});

test('the conf.d directory itself is never replaced (bind mount)', async (t) => {
  const dir = tempDir(t);
  const inoBefore = fs.statSync(dir).ino;
  const { deps } = fakeDeps(dir);
  await syncConfDir([vhost('d-1', 'a.example')], deps);
  await syncConfDir([], deps);
  assert.equal(fs.statSync(dir).ino, inoBefore);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('debounced runner: coalesces bursts, single-flight, one rerun when requested during a run', async () => {
  let runs = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let release: (() => void) | null = null;
  const runner = createDebouncedRunner(async () => {
    runs++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (runs === 1) await new Promise<void>((r) => { release = r; });
    concurrent--;
  }, 10, () => {});

  runner.run(); runner.run(); runner.run();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(runs, 1, 'burst coalesced');
  runner.run(); runner.run(); // during the run
  release!();
  await runner.idle();
  assert.equal(runs, 2, 'exactly one rerun');
  assert.equal(maxConcurrent, 1);

  let errors = 0;
  const failing = createDebouncedRunner(async () => { throw new Error('boom'); }, 5, () => { errors++; });
  assert.doesNotThrow(() => failing.run());
  await failing.idle();
  assert.equal(errors, 1);
});
