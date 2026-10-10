import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EdgeExecResult } from './confSync';
import { GOOD_MARKER, parseUnitHeader, readSnapshot, type EdgeDirs } from './edgeTree';
import {
  CANARY_HOLD_RETRY_MS, HOLD_PREFIX, MAX_SANDBOX_TESTS, PROBE_CONCURRENCY, REFUSED_RETEST_MS, rollbackToPrevious, runPipeline, type PipelineInput, type PipelineOutcome, type PipelineUnit, type PriorUnitState,
} from './pipeline';
import { edgeCertPaths } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Apply pipeline with a temp directory and a FAKE edge: `nginx -t` (sandbox or
// live) really reads the files written by the pipeline and fails on markers:
//   BROKEN          → error naming the file and line (like "unknown directive")
//   UNNAMED_BROKEN  → error naming no file (like a server_names_hash failure)
//   $need_var       → "unknown variable" (no file) unless a global unit says
//                     "define need_var"
//   an aux path     → "open() failed" when the file does not exist (checks the
//                     sandbox copy + path rewriting)
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER = '/etc/nginx/oblimint/';
const quiet = { info: () => {}, warn: () => {} };

function tempDirs(t: TestContext): EdgeDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-edge-pipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = (n: string) => path.join(root, n);
  return { confD: d('conf.d'), globalD: d('global.d'), streamD: d('stream.d'), aux: d('aux'), sandbox: d('sandbox'), good: d('good'), goodPrev: d('good.prev') };
}

interface FakeEdge {
  calls: string[][];
  sandboxTests: number;
  globalTests: number;
  reloads: number;
  running: boolean;
  reloadExit: number;
  reachable: Set<string>;
  sleeping: Set<number>;
  /** Canary: status of a host by phase (number of reloads done so far). */
  httpStatus: (host: string, reloads: number) => number | null | 'slow';
  /** Certificate paths nginx cannot load (error naming the unit file that references them). */
  badCerts: Set<string>;
  /** docker exec failures (thrown) of the sandbox / global tests. */
  failExec: { sandbox: boolean; global: boolean };
  /** The sandbox mount is missing (old edge container): every sandbox run fails on its own nginx.conf. */
  sandboxMissing: boolean;
  /** Sandbox trees seen by nginx -t -c (host paths of every file + nginx.conf). */
  sandboxSeen: Array<{ main: string; files: Record<string, string> }>;
  exec: (cmd: string[]) => Promise<EdgeExecResult>;
}

function listConf(dir: string): Array<{ name: string; content: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.conf')).sort().map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function fakeEdge(dirs: EdgeDirs): FakeEdge {
  const toHost = (p: string): string => {
    if (p.startsWith(`${CONTAINER}sandbox/`)) return path.join(dirs.sandbox, p.slice(`${CONTAINER}sandbox/`.length));
    if (p.startsWith(`${CONTAINER}aux/`)) return path.join(dirs.aux, p.slice(`${CONTAINER}aux/`.length));
    throw new Error(`unmapped path ${p}`);
  };
  const check = (prefix: string, hostRoot: { global: string; conf: string; stream: string }): string | null => {
    const files = [
      ...listConf(hostRoot.global).map((f) => ({ ...f, c: `${prefix}global.d/${f.name}`, global: true })),
      ...listConf(hostRoot.conf).map((f) => ({ ...f, c: `${prefix}conf.d/${f.name}`, global: false })),
      ...listConf(hostRoot.stream).map((f) => ({ ...f, c: `${prefix}stream.d/${f.name}`, global: false })),
    ];
    const defined = files.some((f) => f.global && f.content.includes('define need_var'));
    for (const f of files) {
      const lines = f.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/\bBROKEN\b/.test(lines[i]) && !lines[i].includes('UNNAMED_BROKEN')) return `nginx: [emerg] unknown directive "BROKEN" in ${f.c}:${i + 1}\nnginx: configuration file ${prefix}nginx.conf test failed`;
        const cert = /ssl_certificate (\S+);/.exec(lines[i])?.[1];
        if (cert && fake.badCerts.has(cert)) return `nginx: [emerg] cannot load certificate "${cert}": BIO_new_file() failed in ${f.c}:${i + 1}`;
        for (const m of lines[i].matchAll(/(\/etc\/nginx\/oblimint\/(?:sandbox\/[a-z0-9-]+\/)?aux\/[a-z0-9-]+\/[a-z0-9._/-]+)/g)) {
          if (!fs.existsSync(toHost(m[1]))) return `nginx: [emerg] open() "${m[1]}" failed (2: No such file or directory) in ${f.c}:${i + 1}`;
        }
      }
    }
    if (files.some((f) => f.content.includes('UNNAMED_BROKEN'))) return 'nginx: [emerg] could not build server_names_hash, you should increase server_names_hash_bucket_size: 512';
    if (!defined && files.some((f) => f.content.includes('$need_var'))) return 'nginx: [emerg] unknown "need_var" variable';
    return null;
  };
  const fake: FakeEdge = {
    calls: [], sandboxTests: 0, globalTests: 0, reloads: 0, running: true, reloadExit: 0,
    reachable: new Set(), sleeping: new Set(), httpStatus: () => 200, sandboxSeen: [],
    badCerts: new Set(), failExec: { sandbox: false, global: false }, sandboxMissing: false,
    async exec(cmd) {
      fake.calls.push(cmd);
      const ok = (stdout = ''): EdgeExecResult => ({ exitCode: 0, stdout, stderr: '' });
      if (cmd[0] === 'nginx' && cmd[1] === '-t' && cmd[2] === '-c') {
        fake.sandboxTests++;
        if (fake.failExec.sandbox) throw new Error('docker exec timed out');
        if (fake.sandboxMissing) {
          return { exitCode: 1, stdout: '', stderr: `nginx: [emerg] open() "${cmd[3]}" failed (2: No such file or directory)\nnginx: configuration file ${cmd[3]} test failed` };
        }
        const runDir = path.dirname(toHost(cmd[3]));
        const main = fs.readFileSync(path.join(runDir, 'nginx.conf'), 'utf8');
        const seen: Record<string, string> = {};
        const walk = (d: string, rel: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r); else seen[r] = fs.readFileSync(path.join(d, e.name), 'utf8');
          }
        };
        walk(runDir, '');
        fake.sandboxSeen.push({ main, files: seen });
        const prefix = cmd[3].replace(/nginx\.conf$/, '');
        const err = check(prefix, { global: path.join(runDir, 'global.d'), conf: path.join(runDir, 'conf.d'), stream: path.join(runDir, 'stream.d') });
        return err ? { exitCode: 1, stdout: '', stderr: err } : ok();
      }
      if (cmd[0] === 'nginx' && cmd[1] === '-t') {
        fake.globalTests++;
        if (fake.failExec.global) throw new Error('docker exec timed out');
        const err = check(CONTAINER, { global: dirs.globalD, conf: dirs.confD, stream: dirs.streamD });
        return err ? { exitCode: 1, stdout: '', stderr: err } : ok();
      }
      if (cmd[0] === 'oblimint-edge-reload') {
        if (fake.reloadExit === 0) fake.reloads++;
        return { exitCode: fake.reloadExit, stdout: '', stderr: fake.reloadExit ? 'nginx: [error] invalid PID number "" in "/run/nginx.pid"' : '' };
      }
      if (cmd[0] === 'oblimint-edge-probe') {
        if (cmd[1] === 'tcp') return { exitCode: fake.reachable.has(`${cmd[2]}:${cmd[3]}`) ? 0 : 1, stdout: '', stderr: '' };
        if (cmd[1] === 'ping') return ok('200\n');
        if (cmd[1] === 'http') {
          const s = fake.httpStatus(cmd[2], fake.reloads);
          return ok(`${s === null ? '000' : s}\n`);
        }
      }
      throw new Error(`unexpected exec ${cmd.join(' ')}`);
    },
  };
  return fake;
}

function unit(id: string, opts: Partial<PipelineUnit> & { body?: string; name?: string } = {}): PipelineUnit {
  const name = opts.name ?? `${id}.example.com`;
  const { body, name: _n, ...over } = opts;
  return {
    id,
    scope: 'http',
    level: 'server',
    owner: { kind: 'proxy-host', id: Number(/\d+/.exec(id)?.[0] ?? 1), accountId: 7, tenantId: 2, label: name },
    serverNames: [name],
    listen: [],
    tls: null,
    config: `server {\n    listen 80;\n    server_name ${name};\n    location / {\n        set $up_0 http://app-1-web:80;\n        proxy_pass $up_0;\n${body ?? ''}\n    }\n}\n`,
    files: {},
    upstreams: [],
    rawSnippets: [],
    ...over,
  };
}

function globalUnit(id: string, config: string, fallbackConfig?: string): PipelineUnit {
  return {
    id, scope: 'http', level: 'global', owner: { kind: 'global', id: null, accountId: null, tenantId: null, label: id },
    serverNames: [], listen: [], tls: null, config, files: {}, upstreams: [], rawSnippets: [], fallbackConfig,
  };
}

const SETTINGS = { probeUpstreams: true, canary: false, canarySampleSize: 3, streamPorts: [{ port: 5432, protocol: 'tcp' as const }] };

/** Simulates edge_units between passes. */
function priorOf(out: PipelineOutcome, previous: Map<string, PriorUnitState> = new Map(), now = new Date()): Map<string, PriorUnitState> {
  const m = new Map<string, PriorUnitState>();
  for (const u of out.units) {
    m.set(u.unitId, {
      status: u.status, error: u.error, desiredHash: u.desiredHash, activeHash: u.activeHash, upstreams: u.upstreams,
      checkedAt: u.checked ? now : (previous.get(u.unitId)?.checkedAt ?? null),
    });
  }
  return m;
}

function run(dirs: EdgeDirs, fake: FakeEdge, units: PipelineUnit[], over: Partial<PipelineInput> = {}) {
  let seq = 0;
  return runPipeline({ units, prior: new Map(), settings: SETTINGS, force: false, ...over }, {
    dirs, exec: fake.exec, isRunning: async () => fake.running, isAppSleeping: async (id) => fake.sleeping.has(id),
    log: quiet, sleep: async () => {}, runId: () => `t${++seq}`,
  });
}

const live = (dirs: EdgeDirs, id: string, dir: 'confD' | 'globalD' | 'streamD' = 'confD') => {
  const f = path.join(dirs[dir], `${id}.conf`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const status = (out: PipelineOutcome, id: string) => out.units.find((u) => u.unitId === id)?.status;

test('first apply: every unit accepted in one sandbox test, written with a header, reloaded, good copy recorded', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const out = await run(dirs, fake, [unit('ph-1'), unit('ph-2'), globalUnit('g-proxy', 'map $host $need_var { default 0; } # define need_var')]);
  assert.equal(out.result, 'ok');
  assert.equal(out.error, null);
  assert.equal(fake.sandboxTests, 1, 'fast path: all candidates together');
  assert.equal(fake.globalTests, 1);
  assert.equal(fake.reloads, 1);
  assert.equal(out.reloaded, true);
  for (const id of ['ph-1', 'ph-2']) {
    assert.equal(status(out, id), 'active');
    const header = parseUnitHeader(Buffer.from(live(dirs, id)!));
    assert.equal(header?.kind, 'unit');
    assert.equal(header?.hash, out.units.find((u) => u.unitId === id)?.desiredHash);
  }
  assert.ok(live(dirs, 'g-proxy', 'globalD'));
  assert.ok(fs.existsSync(path.join(dirs.good, GOOD_MARKER)));
  assert.ok(readSnapshot(dirs.good, { goodPaths: true })?.conf['conf.d'].has('ph-1'));

  // Unchanged second pass: no test, no reload.
  const again = await run(dirs, fake, [unit('ph-1'), unit('ph-2'), globalUnit('g-proxy', 'map $host $need_var { default 0; } # define need_var')], { prior: priorOf(out) });
  assert.equal(again.result, 'ok');
  assert.equal(fake.sandboxTests, 1);
  assert.equal(fake.reloads, 1);
  assert.equal(again.reloaded, false);
});

test('a unit failing nginx -t never blocks the others: quarantined keeps its last good version, a new failing unit gets a 503 stub with its names', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const first = await run(dirs, fake, [unit('ph-1'), unit('ph-2')]);
  const goodPh1 = live(dirs, 'ph-1');
  const tls = edgeCertPaths('ph-3.example.com');
  const out = await run(dirs, fake, [
    unit('ph-1', { body: '        BROKEN;' }), // changed, broken → quarantined
    unit('ph-2', { body: '        add_header X-New 1;' }), // changed, fine
    unit('ph-3', { body: '        BROKEN;', tls }), // new, broken → stub
  ], { prior: priorOf(first) });
  assert.equal(out.result, 'partial');
  assert.equal(status(out, 'ph-1'), 'quarantined');
  assert.match(out.units.find((u) => u.unitId === 'ph-1')!.error!, /unknown directive "BROKEN" in conf\.d\/ph-1\.conf:8/); // line 1 = unit header
  assert.equal(live(dirs, 'ph-1'), goodPh1, 'last good version kept live');
  assert.equal(out.units.find((u) => u.unitId === 'ph-1')!.activeHash, first.units.find((u) => u.unitId === 'ph-1')!.desiredHash);
  assert.equal(status(out, 'ph-2'), 'active');
  assert.match(live(dirs, 'ph-2')!, /X-New/);
  assert.equal(status(out, 'ph-3'), 'stub');
  const stub = live(dirs, 'ph-3')!;
  assert.equal(parseUnitHeader(Buffer.from(stub))?.kind, 'stub');
  assert.match(stub, /server_name ph-3\.example\.com;/);
  assert.match(stub, /return 503;/);
  assert.match(stub, /set \$oblimint_kind stub;/);
  assert.match(stub, /set \$oblimint_host "3";/);
  assert.match(stub, /listen 443 ssl;[\s\S]*ssl_certificate \/etc\/nginx\/oblimint\/certs\/ph-3\.example\.com\/fullchain\.pem;/, 'certificate kept');
  assert.match(stub, /location \^~ \/\.well-known\/acme-challenge\//, 'ACME still served');
  assert.doesNotMatch(stub, /BROKEN/);
  assert.equal(fake.reloads, 2, 'the other changes were reloaded');
  assert.equal(out.quarantined, 2);
});

test('a refused version is not re-tested until it changes, a retry (forceUnits) or a forced sync', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1')]);
  const p2 = await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })], { prior: priorOf(p1) });
  assert.equal(status(p2, 'ph-1'), 'quarantined');
  const tests = fake.sandboxTests;
  const p3 = await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })], { prior: priorOf(p2) });
  assert.equal(status(p3, 'ph-1'), 'quarantined');
  assert.match(p3.units[0].error!, /BROKEN/, 'previous error kept');
  assert.equal(fake.sandboxTests, tests, 'not re-tested');
  await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })], { prior: priorOf(p3), forceUnits: new Set(['ph-1']) });
  assert.equal(fake.sandboxTests, tests + 1, 'retry re-tests');
  await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })], { prior: priorOf(p3), force: true });
  assert.equal(fake.sandboxTests, tests + 2, 'forced sync re-tests');
  const fixed = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-Fixed 1;' })], { prior: priorOf(p3) });
  assert.equal(status(fixed, 'ph-1'), 'active');
  assert.match(live(dirs, 'ph-1')!, /X-Fixed/);
});

test('global unit refused: last good version kept, or its fallbackConfig so that the server units still find their variables', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const user = unit('ph-1', { body: '        set $x $need_var;' });
  // Never passed + broken: the fallback defines the variable, the server unit still goes live.
  const out = await run(dirs, fake, [globalUnit('g-bans', 'geo $remote_addr $need_var { default 0; BROKEN; } # define need_var', 'geo $remote_addr $need_var { default 0; } # define need_var'), user]);
  assert.equal(status(out, 'g-bans'), 'quarantined');
  assert.equal(parseUnitHeader(Buffer.from(live(dirs, 'g-bans', 'globalD')!))?.kind, 'fallback');
  assert.equal(status(out, 'ph-1'), 'active');
  assert.equal(out.reloaded, true);
  // A good version exists: kept when the next one breaks.
  const ok = await run(dirs, fake, [globalUnit('g-bans', 'geo $remote_addr $need_var { default 0; 10.1.1.1 1; } # define need_var', 'geo $remote_addr $need_var { default 0; } # define need_var'), user], { prior: priorOf(out) });
  assert.equal(status(ok, 'g-bans'), 'active');
  const good = live(dirs, 'g-bans', 'globalD');
  const broken = await run(dirs, fake, [globalUnit('g-bans', 'geo $remote_addr $need_var { BROKEN; } # define need_var', 'geo $remote_addr $need_var { default 0; } # define need_var'), user], { prior: priorOf(ok) });
  assert.equal(status(broken, 'g-bans'), 'quarantined');
  assert.equal(live(dirs, 'g-bans', 'globalD'), good);
  assert.equal(status(broken, 'ph-1'), 'active');
});

test('isolation: failures naming no file are isolated one by one, at most MAX_SANDBOX_TESTS per pass, the rest stays pending', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const units = Array.from({ length: 70 }, (_, i) => unit(`ph-${i + 1}`, { body: i % 2 === 0 ? '        # UNNAMED_BROKEN' : '' }));
  const out = await run(dirs, fake, units);
  assert.equal(fake.sandboxTests, MAX_SANDBOX_TESTS);
  assert.equal(out.tests, MAX_SANDBOX_TESTS);
  const by = (s: string) => out.units.filter((u) => u.status === s).length;
  assert.equal(by('active') + by('stub') + by('pending'), 70);
  assert.equal(by('pending'), 70 - (MAX_SANDBOX_TESTS - 2), 'one fast-path test, one empty-sandbox check (error naming no unit), then one test per unit');
  assert.ok(by('stub') > 0 && by('active') > 0);
  assert.ok(out.pending > 0, 'the caller schedules another pass');
  for (const u of out.units.filter((x) => x.status === 'pending')) assert.equal(live(dirs, u.unitId), null, 'a new untested unit is not served');
  // The next pass finishes the job.
  const next = await run(dirs, fake, units, { prior: priorOf(out) });
  assert.equal(next.units.filter((u) => u.status === 'pending').length, 0);
});

test('an error naming the failing file isolates it directly (no one-by-one pass)', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const units = Array.from({ length: 10 }, (_, i) => unit(`ph-${i + 1}`, { body: i === 3 ? '        BROKEN;' : '' }));
  const out = await run(dirs, fake, units);
  assert.equal(fake.sandboxTests, 2, 'all → culprit named → the rest together (an HTTP-only stub needs no test)');
  assert.equal(status(out, 'ph-4'), 'stub');
  assert.equal(out.units.filter((u) => u.status === 'active').length, 9);
});

test('sandbox layout: image building blocks + candidate only, aux copied and its paths rewritten; run removed afterwards', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const u = unit('ph-5', {
    body: '        auth_basic "x";\n        auth_basic_user_file /etc/nginx/oblimint/aux/ph-5/htpasswd;',
    files: { htpasswd: 'bob:$6$abc$def\n', 'errors/404.html': '<p>404</p>' },
  });
  const out = await run(dirs, fake, [globalUnit('g-proxy', 'limit_req_zone $binary_remote_addr zone=ph_5:10m rate=5r/s;'), u]);
  assert.equal(out.result, 'ok', out.error ?? '');
  const seen = fake.sandboxSeen[0];
  assert.match(seen.main, /include \/etc\/nginx\/oblimint-base\/main\.conf;/);
  assert.match(seen.main, /http \{\n {4}include \/etc\/nginx\/oblimint-base\/http\.conf;\n {4}include \/etc\/nginx\/oblimint\/sandbox\/t1-1\/global\.d\/\*\.conf;\n {4}include \/etc\/nginx\/oblimint\/sandbox\/t1-1\/conf\.d\/\*\.conf;/);
  assert.match(seen.main, /stream \{\n {4}include \/etc\/nginx\/oblimint-base\/stream\.conf;\n {4}include \/etc\/nginx\/oblimint\/sandbox\/t1-1\/stream\.d\/\*\.conf;/);
  assert.deepEqual(Object.keys(seen.files).sort(), ['aux/ph-5/errors/404.html', 'aux/ph-5/htpasswd', 'conf.d/ph-5.conf', 'global.d/g-proxy.conf', 'nginx.conf']);
  assert.match(seen.files['conf.d/ph-5.conf'], /auth_basic_user_file \/etc\/nginx\/oblimint\/sandbox\/t1-1\/aux\/ph-5\/htpasswd;/);
  assert.equal(fs.readdirSync(dirs.sandbox).length, 0, 'sandbox runs cleaned');
  // Live: the original path, aux written; good copy: paths pointing to good/aux.
  assert.match(live(dirs, 'ph-5')!, /auth_basic_user_file \/etc\/nginx\/oblimint\/aux\/ph-5\/htpasswd;/);
  assert.equal(fs.readFileSync(path.join(dirs.aux, 'ph-5', 'errors', '404.html'), 'utf8'), '<p>404</p>');
  assert.match(fs.readFileSync(path.join(dirs.good, 'conf.d', 'ph-5.conf'), 'utf8'), /\/etc\/nginx\/oblimint\/good\/aux\/ph-5\/htpasswd/);
  assert.ok(fs.existsSync(path.join(dirs.good, 'aux', 'ph-5', 'htpasswd')));
  // Missing aux file (only referenced): refused, never live.
  const missing = unit('ph-6', { body: '        auth_basic_user_file /etc/nginx/oblimint/aux/ph-6/htpasswd;' });
  const out2 = await run(dirs, fake, [u, missing], { prior: priorOf(out) });
  assert.equal(status(out2, 'ph-6'), 'stub');
  assert.match(out2.units.find((x) => x.unitId === 'ph-6')!.error!, /open\(\) "aux\/ph-6\/htpasswd" failed/);
  // Removed unit: its file and aux directory go.
  await run(dirs, fake, [], { prior: priorOf(out2) });
  assert.equal(live(dirs, 'ph-5'), null);
  assert.equal(fs.existsSync(path.join(dirs.aux, 'ph-5')), false);
});

test('reload exit code != 0: failed, the last good configuration is restored', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1')]);
  const good = live(dirs, 'ph-1');
  fake.reloadExit = 1;
  const out = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-New 1;' })], { prior: priorOf(p1) });
  assert.equal(out.result, 'failed');
  assert.match(out.error!, /reload failed: .*invalid PID/);
  assert.equal(live(dirs, 'ph-1'), good);
  assert.equal(status(out, 'ph-1'), 'pending');
  assert.ok(!out.units[0].error?.startsWith(HOLD_PREFIX), 'retried at the next pass (not held)');
});

test('canary failure: the whole previous good configuration is restored and reloaded, changed units are held back', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const settings = { ...SETTINGS, canary: true, canarySampleSize: 5 };
  const p1 = await run(dirs, fake, [unit('ph-1'), unit('ph-2')], { settings });
  assert.equal(p1.result, 'ok');
  assert.equal(p1.canary?.ok, true);
  assert.equal(p1.canary?.checked, 3);
  const snapshot = { a: live(dirs, 'ph-1'), b: live(dirs, 'ph-2') };
  // After the second reload, ph-2 no longer answers at all.
  fake.httpStatus = (host, reloads) => (host === 'ph-2.example.com' && reloads >= 2 ? null : 200);
  const out = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-A 1;' }), unit('ph-2')], { settings, prior: priorOf(p1) });
  assert.equal(out.result, 'rolledBack');
  assert.equal(out.canary?.ok, false);
  assert.deepEqual(out.canary?.failures.map((f) => f.host), ['ph-2.example.com']);
  assert.match(out.error!, /canary failed/);
  assert.deepEqual({ a: live(dirs, 'ph-1'), b: live(dirs, 'ph-2') }, snapshot);
  assert.equal(fake.reloads, 3, 'the restored configuration was reloaded');
  assert.equal(status(out, 'ph-1'), 'quarantined');
  assert.ok(out.units.find((u) => u.unitId === 'ph-1')!.error!.startsWith(HOLD_PREFIX));
  // Held: not re-applied by the next (non-forced) pass.
  fake.httpStatus = () => 200;
  const tests = fake.sandboxTests;
  const next = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-A 1;' }), unit('ph-2')], { settings, prior: priorOf(out) });
  assert.equal(fake.sandboxTests, tests);
  assert.equal(status(next, 'ph-1'), 'quarantined');
  assert.equal(live(dirs, 'ph-1'), snapshot.a);
});

test('upstream probes: unreachable keeps the previous version, new unit → stub, sleeping app proceeds, UDP not probed, no upstream never probed', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const up = (host: string, port: number, extra: object = {}) => ({ internal: true, host, port, protocol: 'tcp' as const, where: 'location /', ...extra });
  fake.reachable.add('app-1-web:80');
  const p1 = await run(dirs, fake, [unit('ph-1', { upstreams: [up('app-1-web', 80)] })]);
  assert.equal(status(p1, 'ph-1'), 'active');
  assert.deepEqual(p1.units[0].upstreams, [{ where: 'location /', target: 'app-1-web:80', reachable: true, error: null }]);
  assert.deepEqual(fake.calls.find((c) => c[0] === 'oblimint-edge-probe'), ['oblimint-edge-probe', 'tcp', 'app-1-web', '80']);
  const good = live(dirs, 'ph-1');

  // Target changed to an unreachable one: previous version kept, status upstreamUnreachable.
  const p2 = await run(dirs, fake, [
    unit('ph-1', { upstreams: [up('app-2-web', 80)], body: '        add_header X-T 2;' }),
    unit('ph-2', { upstreams: [up('app-9-web', 80)] }),
    unit('ph-3', { upstreams: [up('app-4-web', 80, { appStackId: 4 })] }),
    unit('ph-4', { upstreams: [{ ...up('10.0.0.5', 53), protocol: 'udp' as const }] }),
    unit('ph-5', { upstreams: [] }),
  ], { prior: priorOf(p1) });
  assert.equal(status(p2, 'ph-1'), 'upstreamUnreachable');
  assert.match(p2.units[0].error!, /upstream location \/ \(app-2-web:80\) unreachable/);
  assert.equal(live(dirs, 'ph-1'), good);
  assert.equal(status(p2, 'ph-2'), 'upstreamUnreachable', 'new unit');
  assert.equal(parseUnitHeader(Buffer.from(live(dirs, 'ph-2')!))?.kind, 'stub');
  fake.sleeping.add(4);
  // ph-3 was probed before the stack was known sleeping: retried once the 1-minute delay is over.
  const later = new Map([...priorOf(p2)].map(([k, v]) => [k, { ...v, checkedAt: new Date(Date.now() - 120_000) }]));
  const p3 = await run(dirs, fake, [
    unit('ph-1', { upstreams: [up('app-2-web', 80)], body: '        add_header X-T 2;' }),
    unit('ph-3', { upstreams: [up('app-4-web', 80, { appStackId: 4 })] }),
    unit('ph-4', { upstreams: [{ ...up('10.0.0.5', 53), protocol: 'udp' as const }] }),
    unit('ph-5', { upstreams: [] }),
  ], { prior: later });
  assert.equal(status(p3, 'ph-3'), 'active', 'sleeping app target: activation proceeds');
  assert.equal(p3.units.find((u) => u.unitId === 'ph-3')!.upstreams[0].reachable, false);
  assert.match(p3.units.find((u) => u.unitId === 'ph-3')!.upstreams[0].error!, /sleeping/);
  assert.equal(status(p3, 'ph-4'), 'active');
  assert.equal(p3.units.find((u) => u.unitId === 'ph-4')!.upstreams[0].reachable, null, 'UDP not probed');
  assert.equal(status(p3, 'ph-5'), 'active');
  assert.ok(!fake.calls.some((c) => c[0] === 'oblimint-edge-probe' && c[2] === '10.0.0.5'));
  // Within the minute, an unreachable unit is not re-probed.
  const probesBefore = fake.calls.filter((c) => c[0] === 'oblimint-edge-probe').length;
  const p4 = await run(dirs, fake, [unit('ph-1', { upstreams: [up('app-2-web', 80)], body: '        add_header X-T 2;' })], { prior: priorOf(p3, later) });
  assert.equal(status(p4, 'ph-1'), 'upstreamUnreachable');
  assert.equal(fake.calls.filter((c) => c[0] === 'oblimint-edge-probe').length, probesBefore, 'retry only after a minute');
  // probeUpstreams disabled: activation without probe.
  const p5 = await run(dirs, fake, [unit('ph-1', { upstreams: [up('app-2-web', 80)], body: '        add_header X-T 2;' })], { prior: priorOf(p3, later), settings: { ...SETTINGS, probeUpstreams: false }, forceUnits: new Set(['ph-1']) });
  assert.equal(status(p5, 'ph-1'), 'active');
});

test('a unit left pending (edge down / probe budget) is probed on the next pass, never activated unprobed', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const up = (host: string, port: number) => ({ internal: true, host, port, protocol: 'tcp' as const, where: 'location /' });
  // Written while the edge is down: pending, upstream never measured.
  fake.running = false;
  const down = await run(dirs, fake, [unit('ph-1', { upstreams: [up('app-dead', 80)] })]);
  assert.equal(status(down, 'ph-1'), 'pending');
  assert.equal(down.units[0].upstreams[0].reachable, null);
  // The edge comes back: same targets, prior status pending → probed, the dead target blocks it.
  fake.running = true;
  const p = await run(dirs, fake, [unit('ph-1', { upstreams: [up('app-dead', 80)] })], { prior: priorOf(down) });
  assert.ok(fake.calls.some((c) => c[0] === 'oblimint-edge-probe' && c[2] === 'app-dead'), 'probed');
  assert.equal(status(p, 'ph-1'), 'upstreamUnreachable');
  // A unit reported active whose TCP target was never measured (probes were off) is probed once enabled.
  fake.reachable.add('app-ok:80');
  const off = await run(dirs, fake, [unit('ph-2', { upstreams: [up('app-ok', 80)] })], { settings: { ...SETTINGS, probeUpstreams: false } });
  assert.equal(status(off, 'ph-2'), 'active');
  const n = fake.calls.filter((c) => c[0] === 'oblimint-edge-probe').length;
  await run(dirs, fake, [unit('ph-2', { upstreams: [up('app-ok', 80)], body: '        add_header X-T 2;' })], { prior: priorOf(off) });
  assert.equal(fake.calls.filter((c) => c[0] === 'oblimint-edge-probe').length, n + 1, 'never-measured target probed');
});

test('upstream probes run in parallel (bounded), not one 3 s timeout after the other', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const inner = fake.exec;
  let inFlight = 0;
  let maxInFlight = 0;
  fake.exec = async (cmd) => {
    if (cmd[0] === 'oblimint-edge-probe' && cmd[1] === 'tcp') {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    }
    return inner(cmd);
  };
  const units = Array.from({ length: 20 }, (_, i) => unit(`ph-${i + 1}`, { upstreams: [{ internal: true, host: `app-${i}`, port: 80, protocol: 'tcp' as const, where: 'location /' }] }));
  const out = await run(dirs, fake, units);
  assert.equal(out.units.filter((u) => u.status === 'upstreamUnreachable').length, 20);
  assert.ok(maxInFlight > 1 && maxInFlight <= PROBE_CONCURRENCY, `concurrency ${maxInFlight}`);
});

test('edge not running: files written untested, nothing executed, changed units pending', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  fake.running = false;
  const out = await run(dirs, fake, [unit('ph-1'), unit('ph-2', { config: 'server { proxy_pass http://literal:80; }' })]);
  assert.equal(out.result, 'skipped');
  assert.equal(out.error, 'edge not running');
  assert.equal(fake.calls.length, 0);
  assert.equal(status(out, 'ph-1'), 'pending');
  assert.ok(live(dirs, 'ph-1'));
  assert.equal(status(out, 'ph-2'), 'stub', 'an invalid unit is never written, even untested');
  assert.doesNotMatch(live(dirs, 'ph-2')!, /literal/);
  assert.equal(fs.existsSync(path.join(dirs.good, GOOD_MARKER)), false, 'nothing recorded as good');
  // A second pass while the edge is still down: the untested live file is not a "last good" version.
  const again = await run(dirs, fake, [unit('ph-1')], { prior: priorOf(out) });
  assert.equal(status(again, 'ph-1'), 'pending', 'never reported active before it was tested');
  // The edge comes up: the unit is tested, then active.
  fake.running = true;
  const up = await run(dirs, fake, [unit('ph-1')], { prior: priorOf(again) });
  assert.equal(status(up, 'ph-1'), 'active');
  assert.ok(fake.calls.some((c) => c.includes('-t')), 'nginx -t ran');
});

test('unit re-checks (H5, ED2, ED5): invalid units refused before any test', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const stream = (id: string, port: number): PipelineUnit => ({
    id, scope: 'stream', level: 'server', owner: { kind: 'stream', id: 1, accountId: null, tenantId: null, label: id },
    serverNames: [], listen: [{ port, protocol: 'tcp' }], tls: null,
    config: `server {\n    listen ${port};\n    set $up_s db-1:5432;\n    proxy_pass $up_s;\n}\n`, files: {}, upstreams: [], rawSnippets: [],
  });
  const out = await run(dirs, fake, [
    unit('ph-1', { config: 'server {\n    listen 80;\n    server_name ph-1.example.com;\n    location / { proxy_pass http://10.0.0.1:80; }\n}\n' }),
    unit('ph-2', { config: 'server {\n    listen 80;\n    server_name ph-2.example.com;\n    include /etc/passwd;\n}\n' }),
    unit('ph-3', { files: { '../escape': 'x' } }),
    unit('ph-4', { rawSnippets: ['root /;'] }),
    unit('ph-5', { name: 'ph-1.example.com' }), // name already served by ph-1 (refused unit still claims it)
    unit('ph-6', { config: 'server {\n    listen 8080;\n    server_name ph-6.example.com;\n}\n' }),
    unit('ph-7', { config: 'map $a $b { default 1; }\n' }),
    unit('ph-8', { config: 'server {\n    listen 80;\n    server_name ph-8.example.com;\n    auth_basic_user_file /etc/nginx/oblimint/aux/ph-1/htpasswd;\n}\n' }),
    stream('st-1', 5432),
    stream('st-2', 22),
    unit('ph-9'),
  ]);
  const err = (id: string) => out.units.find((u) => u.unitId === id)!.error ?? '';
  assert.match(err('ph-1'), /proxy_pass must target a variable/);
  assert.match(err('ph-2'), /include is not allowed/);
  assert.match(err('ph-3'), /invalid aux file name/);
  assert.match(err('ph-4'), /advancedConfig line 1: root is not allowed/);
  assert.match(err('ph-5'), /already served by unit ph-1/);
  assert.match(err('ph-6'), /listen on 80 \/ 443 only/);
  assert.match(err('ph-7'), /server\{\} blocks only/);
  assert.match(err('ph-8'), /aux files of another unit/);
  assert.equal(status(out, 'st-1'), 'active');
  assert.match(err('st-2'), /22\/tcp is not approved/);
  assert.equal(live(dirs, 'st-2', 'streamD'), null, 'a refused stream without good version serves nothing');
  assert.ok(live(dirs, 'st-1', 'streamD'));
  assert.equal(status(out, 'ph-9'), 'active');
  assert.equal(fake.sandboxTests, 1, 'the valid candidates together (HTTP-only stubs need no test)');
  for (const id of ['ph-1', 'ph-2', 'ph-4']) assert.doesNotMatch(live(dirs, id) ?? '', /10\.0\.0\.1|passwd|root \/;/);
});

test('disabled owner: 503 stub keeping the names (status disabled), back to the unit when re-enabled', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1')]);
  const p2 = await run(dirs, fake, [unit('ph-1', { disabled: true })], { prior: priorOf(p1) });
  assert.equal(status(p2, 'ph-1'), 'disabled');
  const conf = live(dirs, 'ph-1')!;
  assert.equal(parseUnitHeader(Buffer.from(conf))?.kind, 'disabled');
  assert.match(conf, /server_name ph-1\.example\.com;[\s\S]*return 503;/);
  assert.doesNotMatch(conf, /proxy_pass/);
  const p3 = await run(dirs, fake, [unit('ph-1')], { prior: priorOf(p2) });
  assert.equal(status(p3, 'ph-1'), 'active');
  assert.match(live(dirs, 'ph-1')!, /proxy_pass \$up_0;/);
});

test('a provider failed (keepUnknown): its live units are kept, otherwise unknown units are removed', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1'), unit('d-1')]);
  await run(dirs, fake, [unit('d-1')], { prior: priorOf(p1), keepUnknown: true });
  assert.ok(live(dirs, 'ph-1'), 'kept while its provider failed');
  await run(dirs, fake, [unit('d-1')], { prior: priorOf(p1) });
  assert.equal(live(dirs, 'ph-1'), null);
});

test('global nginx -t naming a changed unit (interaction missed by the sandbox): that unit back to its baseline, the rest reloaded', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1'), unit('ph-2')]);
  const good1 = live(dirs, 'ph-1');
  // The sandbox (one unit + globals) accepts it; the global test does not (fake: a file naming BROKEN only when ph-2 is present too).
  const original = fake.exec;
  fake.exec = async (cmd) => {
    if (cmd[0] === 'nginx' && cmd[1] === '-t' && cmd.length === 2) {
      fake.globalTests++;
      fake.calls.push(cmd);
      const a = live(dirs, 'ph-1') ?? '';
      return a.includes('X-Clash') ? { exitCode: 1, stdout: '', stderr: 'nginx: [emerg] duplicate zone "z" in /etc/nginx/oblimint/conf.d/ph-1.conf:7' } : { exitCode: 0, stdout: '', stderr: '' };
    }
    return original(cmd);
  };
  const out = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-Clash 1;' }), unit('ph-2', { body: '        add_header X-Ok 1;' })], { prior: priorOf(p1) });
  assert.equal(status(out, 'ph-1'), 'quarantined');
  assert.match(out.units[0].error!, /duplicate zone/);
  assert.equal(live(dirs, 'ph-1'), good1);
  assert.equal(status(out, 'ph-2'), 'active');
  assert.match(live(dirs, 'ph-2')!, /X-Ok/);
  assert.equal(out.reloaded, true);
});

test('admin rollback: the previous good configuration becomes live and good again', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const deps = { dirs, exec: fake.exec, isRunning: async () => true, log: quiet };
  assert.equal((await rollbackToPrevious(deps)).error, 'noPreviousConfiguration');
  const p1 = await run(dirs, fake, [unit('ph-1'), unit('ph-2')]);
  const v1 = live(dirs, 'ph-1');
  await run(dirs, fake, [unit('ph-1', { body: '        add_header X-V2 1;' }), unit('ph-2'), unit('ph-3')], { prior: priorOf(p1) });
  const out = await rollbackToPrevious(deps);
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(live(dirs, 'ph-1'), v1);
  assert.equal(live(dirs, 'ph-3'), null);
  assert.deepEqual(out.changedUnits.map((u) => u.id).sort(), ['ph-1', 'ph-3']);
  assert.equal(out.changedUnits.find((u) => u.id === 'ph-1')?.restoredKind, 'unit');
  assert.equal(out.changedUnits.find((u) => u.id === 'ph-3')?.restoredKind, null);
  assert.equal(readSnapshot(dirs.good, { goodPaths: true })?.conf['conf.d'].get('ph-1')?.toString(), v1);
});

test('admin rollback after a rolled-back pass: the rollback point is the good copy that pass started from (healthy hosts kept)', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const deps = { dirs, exec: fake.exec, isRunning: async () => true, log: quiet };
  const settings = { ...SETTINGS, canary: true, canarySampleSize: 5 };
  const p1 = await run(dirs, fake, [unit('ph-1')], { settings });
  const p2 = await run(dirs, fake, [unit('ph-1'), unit('ph-7')], { settings, prior: priorOf(p1) });
  assert.equal(status(p2, 'ph-7'), 'active');
  const v7 = live(dirs, 'ph-7');
  // ph-7 is edited, the canary fails: the pass is rolled back (good/ unchanged).
  fake.httpStatus = (host, reloads) => (host === 'ph-7.example.com' && reloads >= 3 ? null : 200);
  const p3 = await run(dirs, fake, [unit('ph-1'), unit('ph-7', { body: '        return 444;' })], { settings, prior: priorOf(p2) });
  assert.equal(p3.result, 'rolledBack');
  fake.httpStatus = () => 200;
  const out = await rollbackToPrevious(deps);
  assert.equal(out.ok, true, out.error ?? '');
  assert.equal(live(dirs, 'ph-7'), v7, 'the healthy host created before the failing pass is still served');
  assert.deepEqual(out.changedUnits, [], 'nothing held back: the live tree already was the rollback point');
});

test('symbolic links in the aux tree are removed, never followed', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-edge-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(dirs.aux, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dirs.aux, 'ph-1'), 'junction');
  } catch {
    t.skip('symbolic links not available here');
    return;
  }
  await run(dirs, fake, [unit('ph-1', { files: { htpasswd: 'u:h\n' } })]);
  assert.equal(fs.readdirSync(outside).length, 0, 'nothing written through the link');
  assert.equal(fs.lstatSync(path.join(dirs.aux, 'ph-1')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(dirs.aux, 'ph-1', 'htpasswd'), 'utf8'), 'u:h\n');
});

test('canary: a host whose upstream is slower than the probe (edge accepted, no response in time) is an answer, not a rollback', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const settings = { ...SETTINGS, canary: true, canarySampleSize: 5 };
  const p1 = await run(dirs, fake, [unit('ph-1')], { settings });
  // Before the reload the new host falls to the default server (404); after it, its cold upstream takes > 5 s.
  fake.httpStatus = (host, reloads) => (host === 'ph-2.example.com' ? (reloads >= 2 ? 'slow' : 404) : 200);
  const out = await run(dirs, fake, [unit('ph-1'), unit('ph-2')], { settings, prior: priorOf(p1) });
  assert.equal(out.result, 'ok', out.error ?? '');
  assert.equal(out.canary?.ok, true);
  assert.equal(status(out, 'ph-2'), 'active');
  // A host that stops answering at all (refused / reset) still rolls back.
  fake.httpStatus = (host, reloads) => (host === 'ph-3.example.com' && reloads >= 3 ? null : 200);
  const bad = await run(dirs, fake, [unit('ph-1'), unit('ph-2'), unit('ph-3')], { settings, prior: priorOf(out) });
  assert.equal(bad.result, 'rolledBack');
});

test('canary hold: retried automatically once CANARY_HOLD_RETRY_MS is over; a held unit without good version keeps a stub', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const settings = { ...SETTINGS, canary: true, canarySampleSize: 5 };
  const p1 = await run(dirs, fake, [unit('ph-1')], { settings });
  fake.httpStatus = (host, reloads) => (host === 'ph-1.example.com' && reloads === 2 ? null : 200);
  const held = await run(dirs, fake, [unit('ph-1'), unit('ph-2')], { settings, prior: priorOf(p1) });
  assert.equal(held.result, 'rolledBack');
  assert.equal(status(held, 'ph-2'), 'quarantined');
  assert.equal(live(dirs, 'ph-2'), null, 'the rolled-back tree is the previous good one');
  // Next pass: still held, but its names keep a 503 stub instead of falling to the default server.
  const next = await run(dirs, fake, [unit('ph-1'), unit('ph-2')], { settings, prior: priorOf(held) });
  assert.equal(status(next, 'ph-2'), 'stub');
  assert.equal(parseUnitHeader(Buffer.from(live(dirs, 'ph-2')!))?.kind, 'stub');
  assert.match(live(dirs, 'ph-2')!, /server_name ph-2\.example\.com;/);
  // Later: retried (the canary passes now) without any retry / forced sync.
  const old = new Map([...priorOf(next, priorOf(held))].map(([k, v]) => [k, { ...v, checkedAt: new Date(Date.now() - CANARY_HOLD_RETRY_MS - 1000) }]));
  const retried = await run(dirs, fake, [unit('ph-1'), unit('ph-2')], { settings, prior: old });
  assert.equal(status(retried, 'ph-2'), 'active');
  assert.match(live(dirs, 'ph-2')!, /proxy_pass \$up_0;/);
});

test('infrastructure failures never refuse a unit: exec exception / missing sandbox mount => pending + infraError, accepted once healed', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1')]);
  const good = live(dirs, 'ph-1');
  fake.failExec.sandbox = true;
  const before = fake.sandboxTests;
  const out = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-New 1;' }), unit('ph-2')], { prior: priorOf(p1) });
  assert.ok(out.infraError && /timed out/.test(out.infraError), String(out.infraError));
  assert.equal(status(out, 'ph-1'), 'pending');
  assert.equal(status(out, 'ph-2'), 'pending');
  assert.equal(live(dirs, 'ph-1'), good, 'last good kept');
  assert.equal(live(dirs, 'ph-2'), null, 'untested new unit not served');
  assert.equal(fake.sandboxTests - before, 1, 'gave up after the first failure');
  fake.failExec.sandbox = false;
  // Sandbox mount missing: a configuration error naming no candidate, reproduced by an empty sandbox => infrastructure.
  fake.sandboxMissing = true;
  const tests = fake.sandboxTests;
  const out2 = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-New 1;' }), unit('ph-2')], { prior: priorOf(out) });
  assert.ok(out2.infraError);
  assert.equal(fake.sandboxTests - tests, 2, 'candidates together, then the empty sandbox');
  assert.equal(status(out2, 'ph-1'), 'pending');
  assert.equal(status(out2, 'ph-2'), 'pending');
  assert.ok(!out2.units.some((u) => u.status === 'stub' || u.status === 'quarantined'));
  fake.sandboxMissing = false;
  const healed = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-New 1;' }), unit('ph-2')], { prior: priorOf(out2) });
  assert.equal(healed.infraError, null);
  assert.equal(status(healed, 'ph-1'), 'active');
  assert.equal(status(healed, 'ph-2'), 'active');
});

test('global nginx -t exec failure: the pass fails (infraError), units pending, never refused', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1')]);
  const good = live(dirs, 'ph-1');
  fake.failExec.global = true;
  const before = fake.globalTests;
  const out = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-New 1;' })], { prior: priorOf(p1) });
  assert.equal(out.result, 'failed');
  assert.ok(out.infraError);
  assert.equal(status(out, 'ph-1'), 'pending');
  assert.equal(fake.globalTests - before, 1, 'no unit-by-unit isolation on an exec failure');
  assert.equal(live(dirs, 'ph-1'), good);
  fake.failExec.global = false;
  const next = await run(dirs, fake, [unit('ph-1', { body: '        add_header X-New 1;' })], { prior: priorOf(out) });
  assert.equal(status(next, 'ph-1'), 'active');
});

test('a refused version is re-tested once REFUSED_RETEST_MS is over (stale refusals heal)', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const p1 = await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })]);
  assert.equal(status(p1, 'ph-1'), 'stub');
  const tests = fake.sandboxTests;
  await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })], { prior: priorOf(p1) });
  assert.equal(fake.sandboxTests, tests, 'not re-tested while recent');
  const old = new Map([...priorOf(p1)].map(([k, v]) => [k, { ...v, checkedAt: new Date(Date.now() - REFUSED_RETEST_MS - 1000) }]));
  await run(dirs, fake, [unit('ph-1', { body: '        BROKEN;' })], { prior: old });
  assert.ok(fake.sandboxTests > tests);
});

test('name collision: the colliding unit never serves its good version; its stub keeps only its free names', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const two = (id: string, names: string[]) => unit(id, {
    serverNames: names,
    config: `server {\n    listen 80;\n    server_name ${names.join(' ')};\n    location / {\n        set $up_0 http://app-1-web:80;\n        proxy_pass $up_0;\n    }\n}\n`,
  });
  const p1 = await run(dirs, fake, [two('ph-9', ['a.example.com', 'b.example.com'])]);
  assert.equal(status(p1, 'ph-9'), 'active');
  // d-1 (earlier in the order) now claims a.example.com: ph-9 must not keep serving it from its good version.
  const out = await run(dirs, fake, [two('d-1', ['a.example.com']), two('ph-9', ['a.example.com', 'b.example.com'])], { prior: priorOf(p1) });
  assert.equal(status(out, 'd-1'), 'active');
  assert.match(out.units.find((u) => u.unitId === 'ph-9')!.error!, /already served by unit d-1/);
  assert.equal(status(out, 'ph-9'), 'stub');
  const stub = live(dirs, 'ph-9')!;
  assert.match(stub, /server_name b\.example\.com;/);
  assert.doesNotMatch(stub, /a\.example\.com/);
  // Every name taken: nothing served at all.
  const out2 = await run(dirs, fake, [two('d-1', ['a.example.com', 'b.example.com']), two('ph-9', ['a.example.com', 'b.example.com'])], { prior: priorOf(out) });
  assert.equal(status(out2, 'ph-9'), 'quarantined');
  assert.equal(live(dirs, 'ph-9'), null);
});

test('TLS stubs: one bad certificate only downgrades its own stub to HTTP-only', async (t) => {
  const dirs = tempDirs(t);
  const fake = fakeEdge(dirs);
  const a = edgeCertPaths('ph-1.example.com');
  const b = edgeCertPaths('ph-2.example.com');
  const c = edgeCertPaths('ph-3.example.com');
  fake.badCerts.add(b.certPath);
  const out = await run(dirs, fake, [
    unit('ph-1', { body: '        BROKEN;', tls: a }),
    unit('ph-2', { body: '        BROKEN;', tls: b }),
    unit('ph-3', { body: '        BROKEN;', tls: c }),
  ]);
  for (const id of ['ph-1', 'ph-2', 'ph-3']) assert.equal(status(out, id), 'stub');
  assert.match(live(dirs, 'ph-1')!, /listen 443 ssl;/);
  assert.match(live(dirs, 'ph-3')!, /listen 443 ssl;/);
  assert.doesNotMatch(live(dirs, 'ph-2')!, /listen 443/);
});
