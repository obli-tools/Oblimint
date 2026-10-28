import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';

// Feature B — database clone of a preview: pure tests (env references,
// credentials, auth copy SQL, clone / preview container specs, planner,
// env overrides, socket dirs). The Docker side is covered on a real host.

process.env.SESSION_SECRET ||= 'preview-db-clone-unit-secret-0123456789';
// localPaths is bound to the data dir at import: a temp root for the socket layout test.
const SOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-clone-sock-'));
process.env.OBLIMINT_DATA_DIR = SOCK_ROOT;
process.on('exit', () => fs.rmSync(SOCK_ROOT, { recursive: true, force: true }));

const {
  cloneDataMb, dbNameVarPrefix, envReferences, instanceOfHost, prepareCloneSockets, withUrlPassword,
} = require('./previewDbClone') as typeof import('./previewDbClone');
const { mergeEnv, openCloneEnv, sealCloneEnv, cloneReady } = require('./previewDbEnv') as typeof import('./previewDbEnv');
const { cloneAuthQuerySql, cloneUserSql, parseCloneAuthOutput, pgCloneRestoreRoleSql } = require('../databases/sql') as typeof import('../databases/sql');
const { previewDbContainerSpec, previewDbServerArgs } = require('../databases/spec') as typeof import('../databases/spec');
const { releasePreviewContainerSpec } = require('../docker/specs') as typeof import('../docker/specs');
const { desiredContainers, planAccount } = require('../docker/planner') as typeof import('../docker/planner');
const { hostingLayout } = require('../hosting/paths') as typeof import('../hosting/paths');
const { accountDbNetwork, EXTERNALLY_MANAGED_ROLES, LABELS, P2_LABELS, previewDbNetwork } = require('../hosting/naming') as typeof import('../hosting/naming');

const INSTANCES = [
  { id: 11, engine: 'mariadb' as const, isDefault: true },
  { id: 12, engine: 'mariadb' as const, isDefault: false },
  { id: 13, engine: 'postgresql' as const, isDefault: true },
];
const DATABASES = [
  { id: 101, name: 'wp', instanceId: 11 },
  { id: 102, name: 'shop', instanceId: 12 },
  { id: 103, name: 'wp', instanceId: 12 },
  { id: 104, name: 'app', instanceId: 13 },
];
const USERS = [
  { instanceId: 11, username: 'wpuser' },
  { instanceId: 12, username: 'shopuser' },
  { instanceId: 13, username: 'appuser' },
];

test('clone: host values designate the live instance (names, sockets, localhost), anything else none', () => {
  assert.equal(instanceOfHost('db-12', INSTANCES), 12);
  assert.equal(instanceOfHost('oblimint-db-12:3306', INSTANCES), 12);
  assert.equal(instanceOfHost('/run/oblimint-db/i-13/.s.PGSQL.5432', INSTANCES), 13);
  assert.equal(instanceOfHost('localhost', INSTANCES), 11, 'default MySQL-family instance');
  assert.equal(instanceOfHost('/run/mysqld/mysqld.sock', INSTANCES), 11);
  assert.equal(instanceOfHost('/run/postgresql', INSTANCES), 13);
  assert.equal(instanceOfHost('db-99', INSTANCES), null, 'not an instance of the account');
  assert.equal(instanceOfHost('db.example.com', INSTANCES), null);
  assert.equal(dbNameVarPrefix('DB_NAME'), 'DB_');
  assert.equal(dbNameVarPrefix('PGDATABASE'), 'PG');
  assert.equal(dbNameVarPrefix('POSTGRES_DB'), 'POSTGRES_');
  assert.equal(dbNameVarPrefix('WORDPRESS_DB_NAME'), 'WORDPRESS_DB_');
  assert.equal(dbNameVarPrefix('APP_NAME'), null, 'no database hint');
  assert.equal(dbNameVarPrefix('REDIS_DB'), null);
});

test('clone: env references — names narrowed by their host, URLs, credentials (secret flag kept)', () => {
  const r = envReferences([
    { name: 'APP_NAME', value: 'shop', secret: false },
    { name: 'DB_NAME', value: 'wp', secret: false },
    { name: 'DB_HOST', value: 'db-12', secret: false },
    { name: 'DB_USER', value: 'shopuser', secret: false },
    { name: 'DB_PASSWORD', value: 'real-secret', secret: true },
    { name: 'DATABASE_URL', value: 'postgresql://appuser:pw%40x@db-13:5432/app?sslmode=disable', secret: true },
  ], INSTANCES, DATABASES, USERS);
  assert.deepEqual(r.databaseIds, [103, 104], 'wp of instance 12 only (DB_HOST), app from the URL; APP_NAME ignored');
  const plain = r.credentials.find((c) => c.passwordVar === 'DB_PASSWORD')!;
  assert.deepEqual([plain.kind, plain.username, plain.secret, plain.instanceIds], ['plain', 'shopuser', true, [12]]);
  assert.ok(plain.siblings.includes('DB_USER') && plain.siblings.includes('DB_HOST') && plain.siblings.includes('DB_NAME'));
  const url = r.credentials.find((c) => c.passwordVar === 'DATABASE_URL')!;
  assert.deepEqual([url.kind, url.username, url.instanceIds], ['url', 'appuser', [13]]);
  // Without a host, a name present on two instances references both.
  assert.deepEqual(envReferences([{ name: 'DB_NAME', value: 'wp', secret: false }], INSTANCES, DATABASES, USERS).databaseIds, [101, 103]);
  // An unknown user is no credential.
  assert.equal(envReferences([{ name: 'DB_USER', value: 'nobody', secret: false }, { name: 'DB_PASSWORD', value: 'x', secret: true }], INSTANCES, DATABASES, USERS).credentials.length, 0);
});

test('clone: URL password replaced, data tmpfs sized and bounded', () => {
  const u = withUrlPassword('mysql://wpuser:old@db-11:3306/wp?charset=utf8mb4', 'n3w/p@ss');
  assert.ok(u.startsWith('mysql://wpuser:'));
  assert.ok(u.includes('@db-11:3306/wp?charset=utf8mb4'));
  assert.ok(!u.includes('old'));
  assert.equal(decodeURIComponent(new URL(u).password), 'n3w/p@ss');
  assert.equal(cloneDataMb(10 * 1048576, 2048), 276);
  assert.equal(cloneDataMb(0, 2048), 256);
  assert.equal(cloneDataMb(null, 100), 456, 'unknown size: the cap');
  assert.equal(cloneDataMb(50_000 * 1048576, 2048), 2 * 2048 + 256, 'bounded');
});

test('clone SQL: stored authentication read hex-encoded and replayed, never trusted blindly', () => {
  assert.equal(cloneAuthQuerySql('mariadb', []), null);
  assert.match(cloneAuthQuerySql('mariadb', ['wpuser'])!.sql, /mysql\.global_priv WHERE Host = '%' AND User IN \('wpuser'\)/);
  assert.match(cloneAuthQuerySql('mysql', ['wpuser'])!.sql, /HEX\(authentication_string\) FROM mysql\.user/);
  assert.match(cloneAuthQuerySql('postgresql', ['appuser'])!.sql, /pg_catalog\.pg_authid WHERE rolname IN \('appuser'\)/);
  assert.throws(() => cloneAuthQuerySql('mariadb', ["x' OR 1=1 --"]));

  const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
  const maria = parseCloneAuthOutput('mariadb', `${hex('wpuser')}\t${hex('mysql_native_password')}\t${hex('*C9B2DB1CA193280B971CA3602D5174A5D637D2BF')}\n${hex('bad user')}\t${hex('x')}\t\nzz\tzz\n`);
  assert.deepEqual([...maria.keys()], ['wpuser']);
  assert.deepEqual(maria.get('wpuser'), { kind: 'mariadb', plugin: 'mysql_native_password', authString: '*C9B2DB1CA193280B971CA3602D5174A5D637D2BF' });
  const mysql = parseCloneAuthOutput('mysql', `${hex('u1')}\t${hex('caching_sha2_password')}\t24410035\n`);
  assert.deepEqual(mysql.get('u1'), { kind: 'mysql', plugin: 'caching_sha2_password', authHex: '24410035' });
  const pg = parseCloneAuthOutput('postgresql', `${hex('appuser').toLowerCase()}\t${hex('SCRAM-SHA-256$4096:abc=$k1:k2').toLowerCase()}\n${hex('nopw')}\t\n`);
  assert.deepEqual(pg.get('appuser'), { kind: 'postgresql', verifier: 'SCRAM-SHA-256$4096:abc=$k1:k2' });
  assert.deepEqual(pg.get('nopw'), { kind: 'postgresql', verifier: null });

  const grants = [{ databaseId: 101, databaseName: 'wp_db', level: 'all' as const }];
  const m = cloneUserSql('mysql', 'wpuser', maria.get('wpuser')!, grants).sql;
  assert.match(m, /CREATE USER 'wpuser'@'%' IDENTIFIED VIA mysql_native_password USING '\*C9B2/);
  assert.match(m, /GRANT ALL PRIVILEGES ON `wp\\_db`\.\* TO 'wpuser'@'%';/);
  assert.match(cloneUserSql('mysql', 'u1', mysql.get('u1')!, []).sql, /IDENTIFIED WITH caching_sha2_password AS 0x24410035;/);
  assert.match(cloneUserSql('mysql', 'u1', { kind: 'password', password: "p'w" }, []).sql, /IDENTIFIED BY 'p\\'w';/);
  const p = cloneUserSql('postgresql', 'appuser', pg.get('appuser')!, [{ databaseId: 104, databaseName: 'app', level: 'readonly' }]).sql;
  assert.match(p, /CREATE ROLE "appuser" LOGIN PASSWORD 'SCRAM-SHA-256\$4096:abc=\$k1:k2';/);
  assert.match(p, /\\connect "app"\nGRANT USAGE ON SCHEMA public TO "appuser";/);
  // Injection attempts through what the live server returned are refused.
  assert.throws(() => cloneUserSql('mysql', 'wpuser', { kind: 'mariadb', plugin: "x; DROP USER root --", authString: '' }, []));
  assert.throws(() => cloneUserSql('mysql', 'wpuser', { kind: 'mysql', plugin: 'caching_sha2_password', authHex: "0x00'" }, []));
  assert.throws(() => cloneUserSql('postgresql', 'appuser', { kind: 'postgresql', verifier: "x'; DROP ROLE postgres; --" }, []));
  assert.throws(() => cloneUserSql('postgresql', 'bad-user', { kind: 'password', password: 'x' }, []));
  assert.throws(() => pgCloneRestoreRoleSql(104, 'postgres', 'x'));
  assert.match(pgCloneRestoreRoleSql(104, 'oblimint_r0a1b2c3d', 'pw').sql, /GRANT "oblimint_o104" TO "oblimint_r0a1b2c3d";/);
});

const layout = hostingLayout('/srv/oblimint');

test('clone spec: private network only, live names as aliases, data on a uid-owned tmpfs, no port, never restarted', () => {
  const s = previewDbContainerSpec({
    siteId: 7, previewId: 3, accountId: 2, instanceId: 11, uid: 20002, gid: 20002, engine: 'mariadb', version: '11.4',
    rootPassword: 'clone-root', socketDir: layout.previewDbSocketInstance(2, 7, 3, 11), dataMb: 300, cpus: 1,
  });
  assert.equal(s.name, 'oblimint-site-7-rpv-3-db-11');
  const hc = s.HostConfig!;
  assert.equal(hc.NetworkMode, previewDbNetwork(3));
  assert.deepEqual(Object.keys(s.NetworkingConfig!.EndpointsConfig!), ['oblimint-pv-3'], 'one network: never the account (DB) networks');
  assert.deepEqual(s.NetworkingConfig!.EndpointsConfig!['oblimint-pv-3'].Aliases, ['oblimint-site-7-rpv-3-db-11', 'db-11', 'oblimint-db-11']);
  assert.equal(hc.PortBindings, undefined);
  assert.equal(s.ExposedPorts, undefined);
  assert.deepEqual(hc.RestartPolicy, { Name: 'no' });
  assert.equal(hc.ReadonlyRootfs, true);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.match(hc.Tmpfs!['/var/lib/mysql'], /size=300m,mode=0700,uid=20002,gid=20002$/);
  assert.equal(hc.Memory, (256 + 300) * 1048576);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(s.User, '20002:20002');
  assert.deepEqual(hc.Mounts, [{ Type: 'bind', Source: '/srv/oblimint/accounts/2/sites/7/previews/3/dbsock/i-11', Target: '/run/mysqld', ReadOnly: false }]);
  assert.equal(s.Labels?.[LABELS.role], 'preview-db');
  assert.equal(s.Labels?.[LABELS.preview], '3');
  assert.equal(s.Labels?.[P2_LABELS.dbInstance], undefined, 'never mistaken for the live instance');
  assert.ok((s.Env ?? []).includes('MARIADB_ROOT_PASSWORD=clone-root'));
  assert.ok(previewDbServerArgs('postgresql').includes('fsync=off'));
  const pg = previewDbContainerSpec({
    siteId: 7, previewId: 3, accountId: 2, instanceId: 13, uid: 20002, gid: 20002, engine: 'postgresql', version: '16',
    rootPassword: 'r', socketDir: '/x', dataMb: 10, cpus: 0.5,
  });
  assert.match(pg.HostConfig!.Tmpfs!['/var/lib/postgresql/data'], /size=64m,mode=0700,uid=20002/);
  assert.equal(pg.HostConfig!.Mounts![0].Target, '/run/postgresql');
  assert.ok(EXTERNALLY_MANAGED_ROLES.includes('preview-db'), 'the account planner never removes a clone as an orphan');
});

test('preview container: the CLONE sockets only with a clone, never the account dbsock', () => {
  const base = {
    siteId: 7, previewId: 3, accountId: 2, uid: 20002, gid: 20002, base: 'apache-php8.3' as const, limits: { ...DEFAULT_PLAN_LIMITS },
    previewReleasesDir: layout.previewReleases(2, 7, 3), previewRuntimeDir: layout.previewRuntime(2, 7, 3), dataDir: layout.siteData(2, 'blog'),
    ephemeralPaths: [], env: [], caps: { memoryMb: 512, cpus: 1 },
  };
  assert.equal(releasePreviewContainerSpec(base).HostConfig!.Mounts!.length, 3);
  const m = releasePreviewContainerSpec({
    ...base, cloneDbSockets: { root: layout.previewDbSockets(2, 7, 3), mysql: layout.previewDbSocketDefault(2, 7, 3, 'mysql'), postgresql: layout.previewDbSocketDefault(2, 7, 3, 'postgresql') },
  }).HostConfig!.Mounts!;
  const byTarget = new Map(m.map((x) => [x.Target, x]));
  assert.equal(byTarget.get('/run/oblimint-db')!.Source, '/srv/oblimint/accounts/2/sites/7/previews/3/dbsock');
  assert.equal(byTarget.get('/run/mysqld')!.Source, '/srv/oblimint/accounts/2/sites/7/previews/3/dbsock/mysql');
  assert.equal(byTarget.get('/run/postgresql')!.Source, '/srv/oblimint/accounts/2/sites/7/previews/3/dbsock/postgresql');
  for (const x of m) {
    assert.equal(x.ReadOnly, true);
    assert.ok(!x.Source!.startsWith(layout.dbSockets(2)), 'never the live sockets');
  }
});

test('planner: a ready clone puts the preview on its private network, never on the account database network', () => {
  const inp = (dbClone: boolean) => ({
    account: { id: 2, nodeId: 1, uid: 20002, gid: 20002, status: 'active' as const, limits: { ...DEFAULT_PLAN_LIMITS }, filesrvMode: 'off' as const, filesrvPort: null, filesrvActiveUntil: null },
    sites: [{ id: 7, slug: 'blog', status: 'active' as const, base: 'apache-php8.3' as const, previewBase: null, runtimes: [], dataPaths: [],
      releasePreview: { id: 3, base: 'apache-php8.3' as const, ephemeralPaths: [], env: [], dbClone } }],
    actual: [{ name: 'oblimint-site-7-rpv-3-db-11', state: 'running', labels: { [LABELS.account]: '2', [LABELS.site]: '7', [LABELS.role]: 'preview-db', [LABELS.preview]: '3' } }],
    network: { exists: true, panel: 'aliased' as const, edge: 'attached' as const },
    panelRef: 'abc', edgePresent: true, now: new Date('2026-10-28T12:00:00Z'), layout,
  });
  const pv = (dbClone: boolean) => desiredContainers(inp(dbClone)).find((d) => d.role === 'site-rpreview')!;
  assert.deepEqual(pv(true).extraNetworks, ['oblimint-pv-3']);
  assert.deepEqual(pv(false).extraNetworks, []);
  assert.ok(!pv(true).extraNetworks.includes(accountDbNetwork(2)));
  const site = desiredContainers(inp(true)).find((d) => d.role === 'site')!;
  assert.ok(!site.extraNetworks.includes('oblimint-pv-3'), 'the live site never joins it');
  const plan = planAccount(inp(true));
  assert.ok(!plan.actions.some((a) => a.kind === 'removeContainer' && a.name === 'oblimint-site-7-rpv-3-db-11'), 'clone left to the preview module');
});

test('clone env: sealed overrides replace the real values, sorted; unreadable → none', () => {
  const sealed = sealCloneEnv([['DB_PASSWORD', 'random-1']]);
  assert.ok(sealed && !sealed.includes('random-1'));
  assert.deepEqual(openCloneEnv(sealed), [['DB_PASSWORD', 'random-1']]);
  assert.deepEqual(openCloneEnv('garbage'), []);
  assert.equal(sealCloneEnv([]), null);
  assert.deepEqual(mergeEnv([['DB_USER', 'u'], ['APP', 'x']], [['DB_PASSWORD', 'r'], ['APP', 'y']]), [['APP', 'y'], ['DB_PASSWORD', 'r'], ['DB_USER', 'u']]);
  assert.equal(cloneReady({ state: 'ready' }), true);
  assert.equal(cloneReady(JSON.stringify({ state: 'cloning' })), false);
  assert.equal(cloneReady(null), false);
});

test('clone sockets: layout of previews/<pid>/dbsock with the default links', (t) => {
  const root = SOCK_ROOT;
  const probe = path.join(root, 'probe');
  try { fs.symlinkSync('/x', probe); } catch { t.skip('symlinks unavailable on this host'); return; }
  const { localPaths } = require('../hosting/paths') as typeof import('../hosting/paths');
  const local = localPaths.previewDbSockets(2, 7, 3);
  if (!local.startsWith(root.replace(/\\/g, '/'))) { t.skip('localPaths bound to another data dir'); return; }
  prepareCloneSockets({ accountId: 2, siteId: 7, previewId: 3, uid: 20002, gid: 20002 }, [{ id: 11, engine: 'mariadb', isDefault: true }, { id: 13, engine: 'postgresql', isDefault: false }]);
  assert.equal(fs.readlinkSync(path.join(local, 'mysql', 'mysqld.sock')), '/run/oblimint-db/i-11/mysqld.sock');
  assert.ok(fs.statSync(path.join(local, 'i-11')).isDirectory());
  assert.ok(fs.statSync(path.join(local, 'i-13')).isDirectory());
  assert.equal(fs.readdirSync(path.join(local, 'postgresql')).length, 0, 'no default PostgreSQL instance cloned: no link');
});
