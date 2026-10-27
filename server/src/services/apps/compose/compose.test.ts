import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDotenv, stringifyDotenv } from './dotenv';
import { digestFromRepoDigests, formatImageRef, imageDenied, parseImageRef, registryAllowed } from './image';
import { interpolate, InterpolationError } from './interpolate';
import { parseDurationMs, parseSize, splitCommand } from './units';
import { inspectEnvValue, inspectLabels, secretValues, validateCompose, type ComposeContext, type SourceInspector } from './validate';

// Compose validation / rewrite (docs/P4b-PLAN.md §5.2): every refusal, every rewrite, line numbers,
// hostile paths, interpolation, limit sums across stacks, profiles, replicas.

function ctx(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    env: new Map(),
    baseDir: 'files',
    rootDir: 'files',
    inspector: null,
    policy: { allowedRegistries: ['docker.io', 'ghcr.io'], deniedImages: [], allowBuild: false, capAddAllowed: ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE'] },
    maxServices: 20,
    defaults: { memoryMb: 256, cpus: 0.5 },
    plan: { cpus: 2, memoryMb: 2048, containers: 10, pidsPerContainer: 512 },
    node: { memoryMb: 16384, cpus: 8 },
    others: { cpus: 0, memoryMb: 0, containers: 0 },
    ...over,
  };
}

const run = (yaml: string, over: Partial<ComposeContext> = {}) => validateCompose(yaml, ctx(over));
const codes = (yaml: string, over: Partial<ComposeContext> = {}) => run(yaml, over).result.issues.map((i) => `${i.severity}:${i.code}`);
const errorOf = (yaml: string, code: string, over: Partial<ComposeContext> = {}) => run(yaml, over).result.issues.find((i) => i.code === code && i.severity === 'error');

test('a simple compose validates and is rewritten', () => {
  const out = run(`services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    restart: always
    container_name: foo
volumes: {}
`);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const web = out.resolved!.services[0];
  assert.equal(web.imageRef, 'docker.io/library/nginx:1.27');
  assert.deepEqual(web.exposedPorts, [{ port: 80, protocol: 'tcp' }]);
  assert.equal(web.restart, 'unless-stopped');
  assert.deepEqual(web.networks, ['default']);
  assert.equal(web.fabric.front, true);
  assert.equal(web.limits.memoryMb, 256);
  assert.equal(web.limits.cpus, 0.5);
  assert.equal(web.limits.pids, 512);
  const c = out.result.issues.map((i) => i.code);
  assert.ok(c.includes('hostPortIgnored') && c.includes('restartPolicy') && c.includes('containerNameIgnored'));
  assert.match(out.result.effectiveYaml!, /cap_drop:\n\s+- ALL/);
  assert.doesNotMatch(out.result.effectiveYaml!, /8080/);
});

test('YAML syntax errors carry a line number', () => {
  const out = run('services:\n  web:\n    image: nginx\n   bad: [\n');
  assert.equal(out.result.ok, false);
  assert.equal(out.result.issues[0].code, 'yamlSyntax');
  assert.ok((out.result.issues[0].line ?? 0) >= 3);
});

test('issues point at the right line', () => {
  const yaml = 'services:\n  web:\n    image: nginx\n    privileged: true\n';
  const i = errorOf(yaml, 'privileged')!;
  assert.equal(i.line, 4);
  assert.equal(i.path, 'services.web.privileged');
  assert.equal(i.service, 'web');
});

test('root keys: include / unknown refused, name / version / x- ignored', () => {
  assert.ok(errorOf('include: [a.yml]\nservices:\n  a:\n    image: nginx\n', 'includeNotSupported'));
  assert.ok(errorOf('foo: 1\nservices:\n  a:\n    image: nginx\n', 'unknownKey'));
  assert.equal(run('name: x\nversion: "3.8"\nx-common: &c\n  image: nginx\nservices:\n  a: *c\n').result.ok, true);
  assert.ok(errorOf('services: {}\n', 'noServices'));
  assert.ok(errorOf('- a\n- b\n', 'notAnObject'));
});

test('every refused service key', () => {
  const cases: Array<[string, string]> = [
    ['privileged: true', 'privileged'],
    ['network_mode: host', 'hostNetwork'],
    ['network_mode: "container:abc"', 'networkMode'],
    ['network_mode: "service:db"', 'networkMode'],
    ['network_mode: bridge', 'networkMode'],
    ['pid: host', 'hostPid'],
    ['ipc: host', 'hostIpc'],
    ['uts: host', 'hostUts'],
    ['userns_mode: host', 'userns'],
    ['cgroup_parent: /x', 'cgroupParent'],
    ['cgroup: host', 'cgroupParent'],
    ['devices: ["/dev/sda:/dev/sda"]', 'devices'],
    ['device_cgroup_rules: ["c 1:3 mr"]', 'deviceCgroupRules'],
    ['gpus: all', 'gpus'],
    ['sysctls: {net.ipv4.ip_forward: 1}', 'sysctls'],
    ['runtime: nvidia', 'unsupportedKey'],
    ['storage_opt: {size: 1G}', 'unsupportedKey'],
    ['volumes_from: [other]', 'unsupportedKey'],
    ['external_links: [x]', 'unsupportedKey'],
    ['mac_address: 02:42:ac:11:65:43', 'unsupportedKey'],
    ['extends: {service: x}', 'extendsNotSupported'],
    ['cap_add: [NET_RAW]', 'capNotAllowed'],
    ['cap_add: [NET_ADMIN]', 'capNotAllowed'],
    ['cap_add: [SYS_ADMIN]', 'capNotAllowed'],
    ['cap_add: [ALL]', 'capNotAllowed'],
    ['deploy: {replicas: 3}', 'replicas'],
    ['scale: 2', 'replicas'],
    ['deploy: {resources: {reservations: {devices: [{capabilities: [gpu]}]}}}', 'devices'],
    ['extra_hosts: ["db:10.0.0.5"]', 'extraHostsPrivate'],
    ['extra_hosts: ["host.docker.internal:host-gateway"]', 'extraHostsPrivate'],
    ['extra_hosts: ["x:127.0.0.1"]', 'extraHostsPrivate'],
    ['use_api_socket: true', 'dockerSocket'],
    ['frobnicate: 1', 'unknownKey'],
  ];
  for (const [line, code] of cases) {
    const yaml = `services:\n  a:\n    image: nginx\n    ${line}\n`;
    const issue = errorOf(yaml, code);
    assert.ok(issue, `${line} → ${code}; got ${JSON.stringify(codes(yaml))}`);
    assert.equal(issue!.line, 4, `${line}: line`);
  }
  // Even a capability the global list allows is refused when the settings do not list it.
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    cap_add: [SYS_CHROOT]\n', 'capNotAllowed'));
  assert.equal(run('services:\n  a:\n    image: nginx\n    cap_add: [SYS_CHROOT]\n', { policy: { ...ctx().policy, capAddAllowed: ['SYS_CHROOT'] } }).result.ok, true);
  // Settings listing NET_RAW are still refused (never in APP_CAP_ADD_ALLOWED).
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    cap_add: [NET_RAW]\n', 'capNotAllowed', { policy: { ...ctx().policy, capAddAllowed: ['NET_RAW', 'NET_ADMIN'] } }));
  // network_mode none is allowed and joins no network.
  const none = run('services:\n  a:\n    image: nginx\n    network_mode: none\n    ports: ["80"]\n');
  assert.equal(none.result.ok, true);
  assert.deepEqual(none.resolved!.services[0].networks, []);
  assert.equal(none.resolved!.services[0].fabric.front, false);
  // public extra host accepted
  assert.deepEqual(run('services:\n  a:\n    image: nginx\n    extra_hosts: ["api:93.184.216.34"]\n').resolved!.services[0].extraHosts, ['api:93.184.216.34']);
});

test('ignored keys produce warnings, never reach the effective config', () => {
  const yaml = `services:
  a:
    image: nginx
    hostname: x
    dns: [8.8.8.8]
    links: [b]
    logging: {driver: syslog}
    security_opt: ["seccomp=unconfined", "apparmor=unconfined"]
    cap_drop: [NET_RAW]
    oom_score_adj: -1000
    platform: linux/arm64
    labels: {oblimint.account: "1", com.docker.compose.project: x, my.label: ok}
  b:
    image: nginx
`;
  const out = run(yaml);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const c = out.result.issues.map((i) => i.code);
  for (const code of ['hostnameIgnored', 'dnsIgnored', 'linksIgnored', 'loggingIgnored', 'securityOptIgnored', 'labelReserved', 'unsupportedKey']) assert.ok(c.includes(code as never), code);
  assert.deepEqual(out.resolved!.services.find((s) => s.name === 'a')!.labels, { 'my.label': 'ok' });
});

test('volumes: docker socket, absolute, outside, symlink, relative RO, named, anonymous, external, driver', () => {
  const svc = (v: string) => `services:\n  a:\n    image: nginx\n    volumes:\n      - ${v}\nvolumes:\n  data: {}\n`;
  assert.ok(errorOf(svc('/var/run/docker.sock:/var/run/docker.sock'), 'dockerSocket'));
  assert.ok(errorOf(svc('/run/podman/podman.sock:/x'), 'dockerSocket'));
  assert.ok(errorOf(svc('{type: bind, source: /var/run/docker.sock, target: /s}'), 'dockerSocket'));
  assert.ok(errorOf(svc('/etc:/host-etc'), 'absoluteBind'));
  assert.ok(errorOf(svc('~/x:/x'), 'absoluteBind'));
  assert.ok(errorOf(svc('{type: bind, source: /srv/oblimint/run, target: /x}'), 'absoluteBind'));
  assert.ok(errorOf(svc('../../../etc:/x'), 'bindOutsideStack'));
  assert.ok(errorOf(svc('./a/../../src/x:/x'), 'bindOutsideStack'));
  assert.ok(errorOf(svc('ghost:/data'), 'externalVolume'));
  assert.ok(errorOf(svc('data:relative'), 'invalidName'));
  assert.ok(errorOf(svc('{type: npipe, source: x, target: /x}'), 'unsupportedKey'));
  // line of the volume entry
  assert.equal(errorOf(svc('/etc:/host-etc'), 'absoluteBind')!.line, 5);

  const ok = run(svc('./conf:/etc/app'));
  assert.equal(ok.result.ok, true);
  assert.deepEqual(ok.resolved!.services[0].volumes, [{ kind: 'bind', source: 'files/conf', target: '/etc/app', readOnly: true }]);
  // writable binds of the stack source are refused (symlink swap → host mount)
  assert.ok(errorOf(svc('./conf:/etc/app:rw'), 'unsupportedKey'));
  assert.ok(errorOf(svc('./:/w:rw'), 'unsupportedKey'));
  assert.ok(errorOf(svc('{type: bind, source: ./data, target: /d, read_only: false}'), 'unsupportedKey'));
  assert.equal(run(svc('{type: bind, source: ./data, target: /d}')).resolved!.services[0].volumes[0].readOnly, true);
  assert.deepEqual(run(svc('data:/data')).resolved!.services[0].volumes, [{ kind: 'volume', source: 'data', target: '/data', readOnly: false }]);
  const anon = run(svc('/var/lib/x'));
  assert.equal(anon.result.ok, true);
  assert.equal(anon.resolved!.services[0].volumes[0].source, 'anon-a-0');
  assert.ok(anon.result.effective!.volumes.includes('anon-a-0'));
  const tmp = run(svc('{type: tmpfs, target: /cache, tmpfs: {size: 1g}}'));
  assert.equal(tmp.resolved!.services[0].tmpfs[0].sizeBytes, 256 * 1024 * 1024);

  // symlink (R1): inspector reports a link in the path
  const inspector: SourceInspector = { kind: (rel) => (rel.startsWith('files/link') ? 'symlink' : 'dir'), readText: () => null };
  assert.ok(errorOf(svc('./link/x:/x'), 'symlinkInPath', { inspector }));

  const top = (body: string) => `services:\n  a:\n    image: nginx\nvolumes:\n  ${body}\n`;
  assert.ok(errorOf(top('data: {external: true}'), 'externalVolume'));
  assert.ok(errorOf(top('data: {driver: nfs}'), 'volumeDriver'));
  assert.ok(errorOf(top('data: {driver_opts: {type: none, o: bind, device: /etc}}'), 'volumeDriver'));
  assert.ok(errorOf(top('Data: {}'), 'invalidName'));
});

test('git sources: relative paths resolve against the compose directory, contained in src/', () => {
  const over = { baseDir: 'src/deploy', rootDir: 'src' as const };
  const ok = run('services:\n  a:\n    image: nginx\n    volumes: ["../conf:/c", "./x:/x"]\n', over);
  assert.deepEqual(ok.resolved!.services[0].volumes.map((v) => v.source), ['src/conf', 'src/deploy/x']);
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    volumes: ["../../volumes/other:/c"]\n', 'bindOutsideStack', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    volumes: ["../../../2/src:/c"]\n', 'bindOutsideStack', over));
});

test('networks: external refused, undeclared refused, internal kept, aliases', () => {
  assert.ok(errorOf('services:\n  a:\n    image: nginx\nnetworks:\n  n: {external: true}\n', 'externalNetwork'));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    networks: [ghost]\n', 'externalNetwork'));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\nnetworks:\n  n: {driver: host}\n', 'networkMode'));
  const out = run('services:\n  a:\n    image: nginx\n    networks:\n      back: {aliases: [api]}\nnetworks:\n  back: {internal: true}\n');
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.effective!.networks, [{ name: 'back', internal: true }]);
  assert.deepEqual(out.resolved!.services[0].networkAliases, { back: ['api'] });
});

test('images: registry allow-list, deny patterns, invalid refs, build rights', () => {
  assert.ok(errorOf('services:\n  a:\n    image: quay.io/x/y:1\n', 'registryNotAllowed'));
  assert.ok(errorOf('services:\n  a:\n    image: "nginx:latest"\n', 'imageNotAllowed', { policy: { ...ctx().policy, deniedImages: ['*:latest'] } }));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n', 'imageNotAllowed', { policy: { ...ctx().policy, deniedImages: ['docker.io/library/ngin*'] } }));
  assert.ok(errorOf('services:\n  a:\n    image: "NOT VALID"\n', 'imageNotAllowed'));
  assert.ok(errorOf('services:\n  a:\n    command: ls\n', 'imageMissing'));
  assert.ok(errorOf('services:\n  a:\n    build: .\n', 'buildNotAllowed'));
  const withBuild = { policy: { ...ctx().policy, allowBuild: true }, baseDir: 'src', rootDir: 'src' as const };
  const b = run('services:\n  a:\n    build: {context: ./app, dockerfile: Dockerfile.prod, args: {V: "1"}}\n', withBuild);
  assert.equal(b.result.ok, true, JSON.stringify(b.result.issues));
  assert.deepEqual(b.resolved!.services[0].buildSpec, { context: 'src/app', dockerfile: 'Dockerfile.prod', args: { V: '1' }, target: null });
  assert.equal(b.resolved!.services[0].image, null);
  assert.ok(errorOf('services:\n  a:\n    build: ../..\n', 'buildContextOutsideStack', withBuild));
  assert.ok(errorOf('services:\n  a:\n    build: https://github.com/x/y.git\n', 'buildContextOutsideStack', withBuild));
  assert.ok(errorOf('services:\n  a:\n    build: {context: ., dockerfile: ../../etc/passwd}\n', 'buildContextOutsideStack', withBuild));
});

test('interpolation from the stack .env only', () => {
  process.env.OBLIMINT_SHOULD_NOT_LEAK = 'leak';
  const env = new Map([['TAG', '1.27'], ['EMPTY', ''], ['PW', 'hunter2-secret']]);
  const out = run(`services:
  a:
    image: nginx:\${TAG}
    environment:
      A: \${EMPTY:-def}
      B: \${EMPTY-def}
      C: \${UNSET:-x\${TAG}}
      D: $$literal
      E: \${OBLIMINT_SHOULD_NOT_LEAK}
      DB_PASSWORD: \${PW}
`, { env });
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const e = Object.fromEntries(out.resolved!.services[0].environment);
  assert.deepEqual(e, { A: 'def', B: '', C: 'x1.27', D: '$literal', E: '', DB_PASSWORD: 'hunter2-secret' });
  assert.equal(out.resolved!.services[0].imageRef, 'docker.io/library/nginx:1.27');
  const missing = out.result.issues.find((i) => i.code === 'missingVariable')!;
  assert.equal(missing.severity, 'warning');
  assert.equal(missing.line, 9);
  assert.doesNotMatch(out.result.effectiveYaml!, /hunter2/);
  delete process.env.OBLIMINT_SHOULD_NOT_LEAK;

  const req = errorOf('services:\n  a:\n    image: nginx\n    environment:\n      X: ${NEEDED:?set NEEDED}\n', 'missingVariable')!;
  assert.equal(req.message, 'set NEEDED');
  assert.equal(req.line, 5);
  assert.ok(errorOf('services:\n  a:\n    image: "nginx:${TAG"\n', 'interpolation'));
});

test('profiles, replicas, depends_on (unknown, cycle, order, healthy)', () => {
  const p = run('services:\n  a:\n    image: nginx\n  dbg:\n    image: busybox\n    profiles: [debug]\n');
  assert.deepEqual(p.result.effective!.services.map((s) => s.name), ['a']);
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    depends_on: [ghost]\n', 'dependsUnknown'));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    depends_on: [b]\n  b:\n    image: nginx\n    depends_on: [a]\n', 'dependsCycle'));
  const order = run(`services:
  web:
    image: nginx
    depends_on:
      db: {condition: service_healthy}
      cache: {condition: service_started}
  db:
    image: mariadb:11
    healthcheck: {test: ["CMD", "healthcheck.sh", "--connect"], interval: 10s, retries: 5}
  cache:
    image: redis:7
`);
  assert.equal(order.result.ok, true, JSON.stringify(order.result.issues));
  const names = order.resolved!.services.map((s) => s.name);
  assert.ok(names.indexOf('db') < names.indexOf('web') && names.indexOf('cache') < names.indexOf('web'));
  assert.deepEqual(order.resolved!.services.find((s) => s.name === 'web')!.dependsOn, [{ service: 'db', condition: 'healthy' }, { service: 'cache', condition: 'started' }]);
  assert.equal(order.resolved!.services.find((s) => s.name === 'db')!.health!.intervalMs, 10_000);
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n  b:\n    image: nginx\n', 'tooManyServices', { maxServices: 1 }));
  assert.ok(errorOf('services:\n  Bad_Name:\n    image: nginx\n', 'invalidServiceName'));
});

test('caps: stop grace, shm, tmpfs, ulimits, pids', () => {
  const out = run(`services:
  a:
    image: nginx
    stop_grace_period: 10m
    shm_size: 2g
    tmpfs: ["/run:size=1g,mode=1777", "/tmp"]
    ulimits: {nofile: {soft: 200000, hard: 300000}, memlock: -1}
    pids_limit: 100000
`);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const a = out.resolved!.services[0];
  assert.equal(a.stopGraceSec, 120);
  assert.equal(a.shmSizeBytes, 256 * 1024 * 1024);
  assert.deepEqual(a.tmpfs.map((t) => t.sizeBytes / 1048576), [256, 64]);
  assert.equal(a.tmpfs[0].mode, '1777');
  assert.deepEqual(a.ulimits, [{ name: 'nofile', soft: 65536, hard: 65536 }]);
  assert.equal(a.limits.pids, 512);
  const c = out.result.issues.map((i) => i.code);
  for (const code of ['stopGraceCapped', 'shmSize', 'tmpfsSize', 'ulimitCapped', 'pidsCapped']) assert.ok(c.includes(code as never), code);
  assert.equal(run('services:\n  a:\n    image: nginx\n    pids_limit: 64\n').resolved!.services[0].limits.pids, 64);
});

test('limits: declared, defaults, capped, sums across the stacks of the account', () => {
  const out = run(`services:
  a:
    image: nginx
    deploy: {resources: {limits: {cpus: "1.5", memory: 1g}}}
  b:
    image: nginx
    mem_limit: 64m
    cpus: 0.25
  c:
    image: nginx
`);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const lim = Object.fromEntries(out.resolved!.services.map((s) => [s.name, s.limits]));
  assert.deepEqual(lim.a, { cpus: 1.5, memoryMb: 1024, pids: 512 });
  assert.deepEqual(lim.b, { cpus: 0.25, memoryMb: 64, pids: 512 });
  assert.deepEqual(lim.c, { cpus: 0.25, memoryMb: 256, pids: 512 }, 'default CPU reduced to what is left of the plan');
  assert.deepEqual(out.result.effective!.totals, { cpus: 2, memoryMb: 1344, containers: 3 });

  // node / plan cap of one declared service
  const capped = run('services:\n  a:\n    image: nginx\n    mem_limit: 64g\n    cpus: 32\n', { plan: { cpus: 4, memoryMb: 100_000, containers: 10, pidsPerContainer: 512 } });
  assert.deepEqual(capped.resolved!.services[0].limits, { cpus: 4, memoryMb: 16384, pids: 512 });
  assert.ok(capped.result.issues.some((i) => i.code === 'resourceCapped'));

  // sums across stacks: the other stacks already use most of the plan
  const others = { cpus: 1.8, memoryMb: 1900, containers: 9 };
  const sum = run('services:\n  a:\n    image: nginx\n    mem_limit: 512m\n    cpus: 1\n  b:\n    image: nginx\n', { others });
  const c = sum.result.issues.filter((i) => i.severity === 'error').map((i) => i.code).sort();
  assert.deepEqual(c, ['planContainersExceeded', 'planCpuExceeded', 'planMemoryExceeded']);
  assert.equal(sum.result.ok, false);
  const mem = sum.result.issues.find((i) => i.code === 'planMemoryExceeded')!;
  assert.equal(mem.params!.limit, 2048);
  // unlimited plan totals: no sum check, the node ceiling still applies
  const unl = run('services:\n  a:\n    image: nginx\n    mem_limit: 99g\n', { plan: { cpus: null, memoryMb: null, containers: null, pidsPerContainer: 256 }, others: { cpus: 100, memoryMb: 100000, containers: 100 } });
  assert.equal(unl.result.ok, true);
  assert.equal(unl.resolved!.services[0].limits.memoryMb, 16384);
  // plan with zero memory: refused
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n', 'planMemoryExceeded', { plan: { cpus: 1, memoryMb: 0, containers: 5, pidsPerContainer: 64 } }));
});

test('env_file / secrets / configs: inside the source only, read without following links', () => {
  const files: Record<string, string> = { 'src/app.env': 'A=1\n# c\nexport B="two"\n', 'src/secret.txt': 's3cr3t' };
  const inspector: SourceInspector = {
    kind: (rel) => (rel === 'src/link.env' ? 'symlink' : files[rel] !== undefined ? 'file' : 'missing'),
    readText: (rel) => files[rel] ?? null,
  };
  const over = { inspector, baseDir: 'src', rootDir: 'src' as const };
  const out = run(`services:
  a:
    image: nginx
    env_file: [./app.env]
    environment: [C=3]
    secrets: [db_pw]
    configs: [{source: conf, target: /etc/x.conf}]
secrets:
  db_pw: {file: ./secret.txt}
configs:
  conf: {file: ./app.env}
`, over);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const a = out.resolved!.services[0];
  assert.deepEqual(Object.fromEntries(a.environment), { A: '1', B: 'two', C: '3' });
  assert.deepEqual(a.volumes, [
    { kind: 'bind', source: 'src/secret.txt', target: '/run/secrets/db_pw', readOnly: true },
    { kind: 'bind', source: 'src/app.env', target: '/etc/x.conf', readOnly: true },
  ]);
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    env_file: /etc/passwd\n', 'envFileOutsideStack', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    env_file: ../../../x.env\n', 'envFileOutsideStack', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    env_file: ./link.env\n', 'symlinkInPath', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    env_file: ./missing.env\n', 'envFileOutsideStack', over));
  assert.equal(run('services:\n  a:\n    image: nginx\n    env_file: [{path: ./missing.env, required: false}]\n', over).result.ok, true);
  assert.ok(errorOf('services:\n  a:\n    image: nginx\nsecrets:\n  s: {file: /etc/shadow}\n', 'secretsFileOutsideStack', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\nsecrets:\n  s: {external: true}\n', 'unsupportedKey', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\nconfigs:\n  s: {file: ../../x}\n', 'configsFileOutsideStack', over));
  assert.ok(errorOf('services:\n  a:\n    image: nginx\n    secrets: [nope]\n', 'secretsFileOutsideStack', over));
});

test('YAML bombs and huge inputs are refused', () => {
  const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
services:
  a:
    image: nginx
`;
  assert.equal(run(bomb).result.ok, false);
  assert.equal(run(`services:\n  a:\n    image: nginx\n#${'x'.repeat(300 * 1024)}\n`).result.ok, false);
});

test('dotenv parsing', () => {
  const r = parseDotenv('# c\nA=1\nexport B = two # comment\nC="x\\ny"\nD=\'lit $X\'\nE="multi\nline"\nbad line\n1X=2\n');
  assert.deepEqual([...r.values], [['A', '1'], ['B', 'two'], ['C', 'x\ny'], ['D', 'lit $X'], ['E', 'multi\nline']]);
  assert.deepEqual(r.errors.map((e) => e.line), [8, 9]);
  const text = stringifyDotenv([['A', 'plain'], ['B', 'with space "q" $x']]);
  assert.deepEqual([...parseDotenv(text).values], [['A', 'plain'], ['B', 'with space "q" $x']]);
});

test('interpolation edge cases', () => {
  const env = new Map([['A', 'x'], ['E', '']]);
  assert.equal(interpolate('${A:+set}${E:+no}${E+yes}', env), 'setyes');
  assert.equal(interpolate('cost 5$ and $A', env), 'cost 5$ and x');
  assert.throws(() => interpolate('${E:?}', env), InterpolationError);
  assert.equal(interpolate('${E?}', env), '');
  assert.throws(() => interpolate('${1A}', env), InterpolationError);
});

test('image references', () => {
  assert.equal(formatImageRef(parseImageRef('nginx')!), 'docker.io/library/nginx:latest');
  assert.equal(formatImageRef(parseImageRef('vaultwarden/server:1.32.0')!), 'docker.io/vaultwarden/server:1.32.0');
  assert.equal(formatImageRef(parseImageRef('index.docker.io/library/redis:7')!), 'docker.io/library/redis:7');
  assert.equal(parseImageRef('ghcr.io/owner/app@sha256:' + 'a'.repeat(64))!.tag, null);
  assert.equal(parseImageRef('localhost:5000/x')!.registry, 'localhost:5000');
  assert.equal(parseImageRef('registry.example.com:5000/a/b:1')!.repository, 'a/b');
  assert.equal(parseImageRef('UPPER/case'), null);
  assert.equal(parseImageRef('a b'), null);
  assert.ok(registryAllowed('registry-1.docker.io', ['docker.io']));
  assert.ok(!registryAllowed('evil.io', ['docker.io']));
  assert.equal(imageDenied(parseImageRef('nginx:1')!, ['nginx']), 'nginx', 'a pattern without tag denies the whole repository');
  assert.equal(imageDenied(parseImageRef('nginx:1')!, ['nginx:2']), null);
  assert.equal(imageDenied(parseImageRef('nginx:1')!, ['nginx*']), 'nginx*');
  const ref = parseImageRef('nginx:1')!;
  assert.equal(digestFromRepoDigests(ref, ['other@sha256:' + 'b'.repeat(64), 'nginx@sha256:' + 'c'.repeat(64)]), 'sha256:' + 'c'.repeat(64));
});

test('unit parsers', () => {
  assert.equal(parseSize('512m'), 512 * 1048576);
  assert.equal(parseSize('1.5GB'), 1.5 * 1024 ** 3);
  assert.equal(parseSize('12x'), null);
  assert.equal(parseDurationMs('1m30s'), 90_000);
  assert.equal(parseDurationMs('500ms'), 500);
  assert.equal(parseDurationMs('1x'), null);
  assert.deepEqual(splitCommand(`sh -c 'echo "a b"' x\\ y`), ['sh', '-c', 'echo "a b"', 'x y']);
});

test('builds: the images a Dockerfile pulls obey the registry allow-list / deny list (AP5)', () => {
  const files: Record<string, string> = {};
  const inspector: SourceInspector = {
    kind: (rel) => (rel in files ? 'file' : rel === 'src/app' ? 'dir' : 'missing'),
    readText: (rel) => files[rel] ?? null,
  };
  const over = { policy: { ...ctx().policy, allowBuild: true, deniedImages: ['*:latest'] }, baseDir: 'src', rootDir: 'src' as const, inspector };
  const yaml = 'services:\n  a:\n    build: {context: ./app, args: {BASE: "ghcr.io/acme/base:2"}}\n';
  const check = (df: string) => { files['src/app/Dockerfile'] = df; return run(yaml, over); };

  assert.equal(check('FROM node:24-alpine AS build\nRUN npm ci\nFROM build\nCOPY --from=build /a /b\nFROM scratch\nCOPY --from=0 /x /y\n').result.ok, true);
  assert.equal(check('ARG BASE=docker.io/library/alpine:3\nFROM ${BASE}\n').result.ok, true, 'global ARG overridden by the build arg (ghcr.io allowed)');
  assert.ok(check('FROM quay.io/evil/img:1\n').result.issues.some((i) => i.code === 'registryNotAllowed'));
  assert.ok(check('FROM nginx\n').result.issues.some((i) => i.code === 'imageNotAllowed'), 'implicit :latest refused by the deny list');
  assert.ok(check('FROM alpine:3 AS a\nCOPY --from=quay.io/x/y:1 /a /b\n').result.issues.some((i) => i.code === 'registryNotAllowed'), 'COPY --from an image');
  assert.ok(check('FROM alpine:3\nRUN --mount=type=bind,from=quay.io/x/y:1,target=/m true\n').result.issues.some((i) => i.code === 'registryNotAllowed'), 'RUN --mount from an image');
  assert.ok(check('# syntax=quay.io/x/frontend:1\nFROM alpine:3\n').result.issues.some((i) => i.code === 'registryNotAllowed'), 'BuildKit frontend');
  assert.ok(check('FROM ${UNKNOWN}\n').result.issues.some((i) => i.code === 'imageNotAllowed' && /cannot be resolved/.test(i.message)), 'unresolvable FROM refused');
  assert.ok(check('FROM \\\n  quay.io/x/y:1\n').result.issues.some((i) => i.code === 'registryNotAllowed'), 'line continuation');
  delete files['src/app/Dockerfile'];
  assert.ok(errorOf(yaml, 'buildContextOutsideStack', over), 'missing Dockerfile (or a link) refused at deploy time');
});

test('published host ports (any form) are accepted, rewritten to exposed ports and never published (§5.2, AP1)', () => {
  const out = run(`services:
  web:
    image: nginx:1.27
    ports:
      - "8088:80"
      - "127.0.0.1:8089:81"
      - "[::1]:8090:82/udp"
      - target: 83
        published: 8091
        host_ip: 0.0.0.0
      - "84"
`);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  const web = out.resolved!.services[0];
  assert.deepEqual(web.exposedPorts, [
    { port: 80, protocol: 'tcp' }, { port: 81, protocol: 'tcp' }, { port: 82, protocol: 'udp' },
    { port: 83, protocol: 'tcp' }, { port: 84, protocol: 'tcp' },
  ]);
  const ignored = out.result.issues.filter((i) => i.code === 'hostPortIgnored');
  assert.equal(ignored.length, 4, 'one warning per entry that named a host port');
  assert.ok(ignored.every((i) => i.severity === 'warning'));
  assert.ok(out.result.issues.some((i) => i.code === 'portsNotPublished' && i.severity === 'warning'));
  const y = out.result.effectiveYaml!;
  for (const hostPort of ['8088', '8089', '8090', '8091', '127.0.0.1', '0.0.0.0', '::1']) assert.ok(!y.includes(hostPort), `${hostPort} absent from the effective model`);
  assert.doesNotMatch(y, /^\s+ports:/m, 'no ports: key in the effective model');
});

test('inspect env values: secret names, .env secret values (equal or contained) and URL credentials are masked (M9)', () => {
  const secrets = secretValues(new Map([['DB_PASSWORD', 'hunter22'], ['APP_NAME', 'shop'], ['API_KEY', 'abc']]));
  assert.deepEqual(secrets, ['hunter22'], 'only secret-looking keys, 4 characters at least');
  assert.equal(inspectEnvValue('DB_PASSWORD', 'hunter22', secrets), null);
  assert.equal(inspectEnvValue('MYSQL_ROOT', 'hunter22', secrets), null, 'same value under a harmless name');
  assert.equal(inspectEnvValue('CONN', 'mysql://app:hunter22@db:3306/shop', secrets), null, 'secret embedded');
  assert.equal(inspectEnvValue('UPSTREAM', 'https://bob:pa55@api.example.com/v1', secrets), 'https://********@api.example.com/v1');
  assert.equal(inspectEnvValue('REPO', 'https://ghp_tokenonly@github.com/acme/x.git', secrets), 'https://********@github.com/acme/x.git');
  assert.equal(inspectEnvValue('HOME_URL', 'https://example.com/a@b', secrets), 'https://example.com/a@b', 'an @ in the path is not a credential');
  assert.equal(inspectEnvValue('APP_NAME', 'shop', secrets), 'shop');
  assert.equal(inspectEnvValue('EMPTY', '', secrets), '');
  // Labels are interpolated from the .env too (M9): same masking, all hidden when the .env is unreadable.
  const labels = { 'x.conn': 'pg://app:hunter22@db/x', 'x.plain': 'hunter22', 'traefik.http.middlewares.a.basicauth.users': 'bob:hash', 'oblimint.app': '7', 'x.upstream': 'https://bob:pa55@api.example.com' };
  assert.deepEqual(inspectLabels(labels, secrets), {
    'x.conn': null, 'x.plain': null, 'traefik.http.middlewares.a.basicauth.users': null, 'oblimint.app': '7', 'x.upstream': 'https://********@api.example.com',
  });
  assert.deepEqual(inspectLabels({ 'oblimint.app': '7' }, null), { 'oblimint.app': null });
});
