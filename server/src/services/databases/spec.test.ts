import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DbEngine, DbTuningProfile } from '@oblimint/shared';
import { DB_ENGINE_VERSIONS, DB_PROFILE_MEMORY_MB } from '@oblimint/shared';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, specHash, TENANT_OOM_SCORE_ADJ } from '../docker/specs';
import { EXTERNALLY_MANAGED_ROLES, LABELS, P2_LABELS, PANEL_NETWORK } from '../hosting/naming';
import {
  clientArgv, dbTuning, dumpArgv, pingArgv, renderFirstRunEnv, renderServerArgs, restoreArgv, siteSocketPath,
} from './engines';
import { dbAdminContainerSpec, dbInstanceContainerSpec, dbInstanceImage, type DbInstanceContainerInput } from './spec';

// Pure container specs of the databases module (docs/P2-PLAN.md §4, §9.3, B1).

const base: DbInstanceContainerInput = {
  instanceId: 7,
  accountId: 3,
  uid: 20003,
  gid: 20003,
  engine: 'mariadb',
  version: '11.4',
  profile: 'S',
  rootPassword: 'r00t-Secret-xyz',
  externalPort: null,
  dataDir: '/srv/oblimint/accounts/3/databases/7',
  socketDir: '/srv/oblimint/accounts/3/dbsock/i-7',
};

const ENGINES: Array<[DbEngine, string]> = DB_ENGINE_VERSIONS.map((v) => [v.engine, v.version]);

test('instance spec: hardening invariants for every engine version and profile', () => {
  for (const [engine, version] of ENGINES) {
    for (const profile of ['S', 'M', 'L'] as DbTuningProfile[]) {
      const spec = dbInstanceContainerSpec({ ...base, engine, version, profile });
      const hc = spec.HostConfig!;
      const what = `${engine} ${version} ${profile}`;
      assert.equal(spec.User, '20003:20003', what);
      assert.deepEqual(hc.CapDrop, ['ALL'], what);
      assert.equal(hc.CapAdd, undefined, `${what}: no capability added`);
      assert.ok(hc.SecurityOpt?.includes(NO_NEW_PRIVILEGES), what);
      assert.ok(hc.SecurityOpt?.includes(TENANT_SECCOMP_OPT), what);
      assert.equal(hc.ReadonlyRootfs, true, what);
      assert.equal(hc.Privileged, undefined, what);
      assert.match(hc.Tmpfs!['/tmp'], /noexec/, what);
      assert.match(hc.Tmpfs!['/tmp'], /nosuid/, what);
      assert.match(hc.Tmpfs!['/tmp'], /nodev/, what);
      assert.match(hc.Tmpfs!['/run'], /noexec,nosuid,nodev/, what);
      const mem = DB_PROFILE_MEMORY_MB[profile] * 1048576;
      assert.equal(hc.Memory, mem, `${what}: memory = profile`);
      assert.equal(hc.MemorySwap, mem, `${what}: no swap`);
      assert.ok((hc.PidsLimit ?? 0) > 0, what);
      assert.equal(hc.OomScoreAdj, TENANT_OOM_SCORE_ADJ, what);
      assert.deepEqual(hc.LogConfig, LOG_CONFIG, what);
      assert.deepEqual(hc.RestartPolicy, { Name: 'unless-stopped' }, what);
      assert.equal(hc.NetworkMode, 'oblimint-acct-3-db', `${what}: account DATABASE network, never the one the edge joins`);
      assert.equal(hc.PortBindings, undefined, `${what}: nothing published without external access`);
      assert.equal(spec.ExposedPorts, undefined, what);
      // never the docker socket nor a panel path
      for (const m of hc.Mounts ?? []) {
        assert.doesNotMatch(String(m.Source), /docker\.sock|\/run\/hostd|\/config|staging/, what);
        assert.equal(m.Type, 'bind');
      }
      assert.equal(hc.Binds, undefined, what);
    }
  }
});

test('instance spec: mounts, socket dir and data dir per family', () => {
  const maria = dbInstanceContainerSpec(base);
  assert.deepEqual(maria.HostConfig!.Mounts, [
    { Type: 'bind', Source: '/srv/oblimint/accounts/3/databases/7', Target: '/var/lib/mysql', ReadOnly: false },
    { Type: 'bind', Source: '/srv/oblimint/accounts/3/dbsock/i-7', Target: '/run/mysqld', ReadOnly: false },
  ]);
  const pg = dbInstanceContainerSpec({ ...base, engine: 'postgresql', version: '17' });
  assert.deepEqual(pg.HostConfig!.Mounts, [
    { Type: 'bind', Source: '/srv/oblimint/accounts/3/databases/7', Target: '/var/lib/postgresql/data', ReadOnly: false },
    { Type: 'bind', Source: '/srv/oblimint/accounts/3/dbsock/i-7', Target: '/run/postgresql', ReadOnly: false },
  ]);
  // Windows-style host paths are normalised (bind sources are POSIX on the Docker host).
  const win = dbInstanceContainerSpec({ ...base, dataDir: 'C:\\srv\\db', socketDir: 'C:\\srv\\sock' });
  assert.equal(win.HostConfig!.Mounts![0].Source, 'C:/srv/db');
});

test('instance spec: labels, names, alias, image', () => {
  const spec = dbInstanceContainerSpec(base);
  assert.equal(spec.name, 'oblimint-db-7');
  assert.equal(spec.Image, 'mariadb:11.4');
  assert.equal(spec.Labels![LABELS.internal], 'true');
  assert.equal(spec.Labels![LABELS.account], '3');
  assert.equal(spec.Labels![P2_LABELS.dbInstance], '7');
  assert.equal(spec.Labels![LABELS.role], 'db');
  assert.ok(EXTERNALLY_MANAGED_ROLES.includes('db'), 'the planner never removes it');
  assert.match(spec.Labels![LABELS.specHash], /^[0-9a-f]{64}$/);
  assert.deepEqual(spec.NetworkingConfig!.EndpointsConfig!['oblimint-acct-3-db'].Aliases, ['oblimint-db-7', 'db-7']);
  assert.deepEqual(Object.keys(spec.NetworkingConfig!.EndpointsConfig!), ['oblimint-acct-3-db']);
  assert.equal(dbInstanceImage('postgresql', '16', 'registry.local/'), 'registry.local/postgres:16');
  assert.throws(() => dbInstanceImage('mysql', '5.7'));
});

test('instance spec: port published only with external access', () => {
  const my = dbInstanceContainerSpec({ ...base, engine: 'mysql', version: '8.4', externalPort: 33012 });
  assert.deepEqual(my.ExposedPorts, { '3306/tcp': {} });
  assert.deepEqual(my.HostConfig!.PortBindings, { '3306/tcp': [{ HostPort: '33012' }] });
  const pg = dbInstanceContainerSpec({ ...base, engine: 'postgresql', version: '15', externalPort: 33013 });
  assert.deepEqual(pg.HostConfig!.PortBindings, { '5432/tcp': [{ HostPort: '33013' }] });
  for (const bad of [0, -1, null]) {
    assert.equal(dbInstanceContainerSpec({ ...base, externalPort: bad as number | null }).HostConfig!.PortBindings, undefined);
  }
});

test('instance spec: hash is stable and tracks every relevant change', () => {
  const a = dbInstanceContainerSpec(base);
  const b = dbInstanceContainerSpec({ ...base });
  assert.equal(a.Labels![LABELS.specHash], b.Labels![LABELS.specHash]);
  assert.equal(a.Labels![LABELS.specHash], specHash(a));
  const variants: Array<Partial<DbInstanceContainerInput>> = [
    { profile: 'M' }, { externalPort: 33000 }, { version: '10.11' }, { uid: 20004 }, { rootPassword: 'other-password-123' },
  ];
  const hashes = new Set([a.Labels![LABELS.specHash]]);
  for (const v of variants) hashes.add(dbInstanceContainerSpec({ ...base, ...v }).Labels![LABELS.specHash]);
  assert.equal(hashes.size, variants.length + 1);
});

test('tuning: memory per profile, buffer pool ≈ 50 % (S: 25 %), shared_buffers ≈ 25 %, connections 50/100/200', () => {
  const expect: Record<DbTuningProfile, [number, number, number, number]> = {
    S: [256, 50, 64, 64], M: [768, 100, 384, 192], L: [2048, 200, 1024, 512],
  };
  for (const p of ['S', 'M', 'L'] as DbTuningProfile[]) {
    const t = dbTuning(p);
    assert.deepEqual([t.memoryMb, t.maxConnections, t.innodbBufferPoolMb, t.sharedBuffersMb], expect[p], p);
    assert.ok(t.pidsLimit > t.maxConnections, p);
    assert.ok(t.tmpfsMb < t.memoryMb, `${p}: the /tmp tmpfs is charged to the same cgroup`);
  }
  const maria = renderServerArgs('mariadb', 'M');
  for (const a of ['--skip-name-resolve', '--innodb-buffer-pool-size=384M', '--max-connections=100', '--log-warnings=2', '--socket=/run/mysqld/mysqld.sock']) {
    assert.ok(maria.includes(a), a);
  }
  assert.ok(maria.every((a) => a.startsWith('--')), 'flags only: the entrypoint prepends the server binary');
  const mysql = renderServerArgs('mysql', 'S');
  assert.ok(mysql.includes('--log-error-verbosity=3'));
  assert.ok(mysql.includes('--performance-schema=OFF'));
  assert.ok(!renderServerArgs('mysql', 'L').includes('--performance-schema=OFF'));
  for (const p of ['S', 'M', 'L'] as const) assert.ok(renderServerArgs('mysql', p).includes('--disable-log-bin'), `MySQL ${p}: no binary logs`);
  assert.ok(!maria.some((a) => a.includes('log-bin')), 'MariaDB: binary log off by default');
  const pg = renderServerArgs('postgresql', 'L');
  assert.equal(pg[0], '-c');
  for (const kv of ['shared_buffers=512MB', 'max_connections=200', 'log_connections=on', 'log_line_prefix=%m [%p] %h ',
    'unix_socket_directories=/run/postgresql', 'log_min_error_statement=panic', 'listen_addresses=*']) {
    assert.ok(pg.includes(kv), kv);
  }
});

test('first-run env: superuser bound to the socket, PostgreSQL never trusts local connections', () => {
  const maria = renderFirstRunEnv('mariadb', 'pw');
  assert.ok(maria.includes('MARIADB_ROOT_PASSWORD=pw'));
  assert.ok(maria.includes('MARIADB_ROOT_HOST=localhost'));
  const mysql = renderFirstRunEnv('mysql', 'pw');
  assert.ok(mysql.includes('MYSQL_ROOT_HOST=localhost'));
  const pg = renderFirstRunEnv('postgresql', 'pw');
  assert.ok(pg.includes('POSTGRES_PASSWORD=pw'));
  assert.ok(pg.some((e) => e.startsWith('POSTGRES_INITDB_ARGS=') && e.includes('--auth-local=scram-sha-256')));
  assert.ok(pg.includes('POSTGRES_HOST_AUTH_METHOD=scram-sha-256'));
});

test('client argv: socket, no password, database as an option', () => {
  const m = clientArgv('mariadb', { database: 'shop', batch: true });
  assert.equal(m[0], 'mariadb');
  assert.equal(m[1], '--no-defaults', '--no-defaults must come first');
  assert.ok(m.includes('--socket=/run/mysqld/mysqld.sock'));
  assert.ok(m.includes('--database=shop'));
  assert.ok(!m.some((a) => /pass|-p/.test(a) && a !== '--skip-column-names'), 'never a password on the command line');
  assert.equal(clientArgv('mysql')[0], 'mysql');
  const p = clientArgv('postgresql', { database: 'shop' });
  assert.deepEqual(p.slice(0, 5), ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1']);
  assert.ok(p.includes('--dbname=shop'));
  assert.ok(clientArgv('postgresql').includes('--dbname=postgres'));
  assert.ok(dumpArgv('mysql', 'shop').includes('--single-transaction'));
  assert.ok(dumpArgv('mariadb', 'shop').includes('--routines') && dumpArgv('mariadb', 'shop').includes('--triggers'));
  assert.equal(dumpArgv('mariadb', 'shop')[0], 'mariadb-dump');
  assert.equal(dumpArgv('mariadb', 'shop').at(-1), 'shop');
  assert.ok(dumpArgv('postgresql', 'shop').includes('--no-owner'));
  assert.ok(pingArgv('mariadb').includes('--protocol=TCP'), 'TCP probe: the first-run server listens on the socket only');
  assert.ok(pingArgv('postgresql').includes('127.0.0.1'));
  // regression: the container runs as a uid without /etc/passwd entry; without
  // an explicit user libpq gives up and pg_isready exits 3 forever
  const pg = pingArgv('postgresql');
  assert.equal(pg[pg.indexOf('-U') + 1], 'postgres');
});

test('restore argv: non-superuser, client shell / file commands off', () => {
  const m = restoreArgv('mariadb', 'shop', 'oblimint_o7');
  assert.ok(m.includes('--user=oblimint_o7'));
  assert.ok(m.includes('--sandbox'));
  assert.ok(m.includes('--local-infile=0'));
  assert.ok(m.includes('--database=shop'));
  assert.ok(!m.some((a) => a === '--user=root'));
  const my = restoreArgv('mysql', 'shop', 'oblimint_o7');
  assert.equal(my[0], 'mysql');
  assert.ok(my.includes('--system-command=OFF'));
  assert.ok(!my.includes('--sandbox'), 'MySQL has no --sandbox');
  const p = restoreArgv('postgresql', 'shop', 'oblsso_0a1b2c3d');
  assert.equal(p[0], 'psql');
  assert.equal(p[p.indexOf('-U') + 1], 'oblsso_0a1b2c3d');
  assert.ok(p.includes('--dbname=shop'));
  assert.ok(p.includes('ON_ERROR_STOP=1'));
});

test('site socket paths', () => {
  assert.equal(siteSocketPath('mysql', 4, true), '/run/mysqld/mysqld.sock');
  assert.equal(siteSocketPath('postgresql', 4, true), '/run/postgresql/.s.PGSQL.5432');
  assert.equal(siteSocketPath('mysql', 4, false), '/run/oblimint-db/i-4/mysqld.sock');
  assert.equal(siteSocketPath('postgresql', 9, false), '/run/oblimint-db/i-9/.s.PGSQL.5432');
});

test('admin UI specs: panel network only, nothing published, hardened, key in env', () => {
  for (const kind of ['phpmyadmin', 'adminer'] as const) {
    const spec = dbAdminContainerSpec(kind, { key: 'k'.repeat(64), redeemUrl: 'http://oblimint-panel:8081/internal/dbadmin/redeem', blowfishSecret: 'b'.repeat(64) });
    const hc = spec.HostConfig!;
    assert.equal(spec.name, kind === 'phpmyadmin' ? 'oblimint-phpmyadmin' : 'oblimint-adminer');
    assert.equal(hc.NetworkMode, PANEL_NETWORK);
    assert.equal(hc.PortBindings, undefined);
    assert.equal(spec.ExposedPorts, undefined);
    assert.deepEqual(hc.CapDrop, ['ALL']);
    assert.equal(hc.ReadonlyRootfs, true);
    assert.ok(hc.SecurityOpt?.includes(NO_NEW_PRIVILEGES));
    assert.ok((hc.Memory ?? 0) > 0 && hc.Memory === hc.MemorySwap);
    assert.equal(spec.Labels![LABELS.role], 'dbadmin');
    assert.ok(spec.Env!.includes(`OBLIMINT_DBADMIN_KEY=${'k'.repeat(64)}`));
    assert.ok(spec.Env!.includes('OBLIMINT_REDEEM_URL=http://oblimint-panel:8081/internal/dbadmin/redeem'));
    assert.equal(spec.Env!.some((e) => e.startsWith('OBLIMINT_PMA_SECRET=')), kind === 'phpmyadmin');
    assert.equal(spec.User, undefined, 'the image USER (non-root) applies');
  }
});
