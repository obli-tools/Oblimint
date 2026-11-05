import { execSync } from 'child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import mysql from 'mysql2';
import pg from 'pg';
import type { DbEngine } from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END test of the containment step sqlSessions on REAL engines and a REAL
// published port, run from ANOTHER machine than the Docker host (never by default):
//   EXTSQL_E2E_DOCKER=<host>:<port>           Docker API of the Linux host
//   EXTSQL_E2E_HOST=<host>                    its address as this machine reaches it
//   EXTSQL_E2E_ENGINES=mariadb:11.4,postgresql:postgres:16-alpine,mysql:8.4
//   EXTSQL_E2E_FREEZE / EXTSQL_E2E_UNFREEZE   optional commands, {port} replaced: drop then
//                                             allow the traffic of the port, as the firewall does
// Sessions: a driver from this machine (the real external client, frozen when the
// commands are given), a client on the Docker host through the published port on
// loopback (Docker's proxy: the engine sees the gateway), a client on the instance
// network, a client on the socket. Everything created is named oblimint-test-extsql-*
// (the instances oblimint-db-99xxxx) and removed; an image pulled here too.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_LABEL = { 'oblimint-test': 'extsql' };
const ROOT = 'root-extsql-0123456789';
const APP = 'appextsql';
const APP_PW = 'app-extsql-0123456789';

function sleepSql(family: 'mysql' | 'postgresql'): string {
  return family === 'postgresql' ? 'SELECT pg_sleep(240)' : 'SELECT SLEEP(240)';
}

async function pull(docker: Docker, image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return false;
  } catch { /* not there */ }
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())));
  return true;
}

interface External {
  query(sql: string): Promise<unknown>;
  dead(): boolean;
  close(): void;
}

function connectExternal(engine: DbEngine, host: string, port: number): Promise<External> {
  if (dbFamilyOf(engine) === 'postgresql') {
    const c = new pg.Client({ host, port, user: APP, password: APP_PW, database: 'postgres', connectionTimeoutMillis: 15_000 });
    let dead = false;
    c.on('error', () => { dead = true; });
    c.on('end', () => { dead = true; });
    return c.connect().then(() => ({ query: (s: string) => c.query(s), dead: () => dead, close: () => { void c.end().catch(() => {}); } }));
  }
  return new Promise((resolve, reject) => {
    const c = mysql.createConnection({ host, port, user: APP, password: APP_PW, connectTimeout: 15_000 });
    let dead = false;
    c.on('error', () => { dead = true; });
    c.on('end', () => { dead = true; });
    c.connect((err) => {
      if (err) { reject(err); return; }
      resolve({
        query: (s: string) => new Promise((res, rej) => c.query(s, (e, rows) => (e ? rej(e) : res(rows)))),
        dead: () => dead,
        close: () => { c.destroy(); },
      });
    });
  });
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([
  p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms)),
]);

const specs = (process.env.EXTSQL_E2E_ENGINES ?? '').split(',').filter(Boolean);

test('external SQL sessions on real engines', { timeout: 900_000 }, async (t: TestContext) => {
  if (!process.env.EXTSQL_E2E_DOCKER || !process.env.EXTSQL_E2E_HOST || !specs.length) {
    t.skip('no e2e engines (EXTSQL_E2E_DOCKER / EXTSQL_E2E_HOST / EXTSQL_E2E_ENGINES)');
    return;
  }
  const [dh, dp] = process.env.EXTSQL_E2E_DOCKER.split(':');
  const docker = new Docker({ host: dh, port: Number(dp) });
  const { closeExternalSessionsOn } = await import('./externalSessions');
  const { runSql } = await import('./instances');
  const { DB_CLIENTS, DB_CONTAINER_PATHS, DB_CONTAINER_PORT, renderFirstRunEnv, renderServerArgs } = await import('./engines');
  const { dbInstanceContainer } = await import('../hosting/naming');

  for (const [index, spec] of specs.entries()) {
    const [engine, ...imageParts] = spec.split(':') as [DbEngine, ...string[]];
    const image = imageParts.join(':');
    const family = dbFamilyOf(engine);
    const id = 990_000 + index + (Date.now() % 900) * 10;
    const prefix = `oblimint-test-extsql-${id}`;
    const net = `${prefix}-net`;
    const vol = `${prefix}-sock`;
    const name = dbInstanceContainer(id);
    const created: Docker.Container[] = [];
    const externals: External[] = [];
    let pulled = false;
    let frozenPort: number | null = null;
    const hostPortOf = (info: Docker.ContainerInspectInfo) => Number(info.NetworkSettings.Ports[`${DB_CONTAINER_PORT[family]}/tcp`]?.[0]?.HostPort);
    const unfreeze = () => {
      if (frozenPort !== null && process.env.EXTSQL_E2E_UNFREEZE) execSync(process.env.EXTSQL_E2E_UNFREEZE.replaceAll('{port}', String(frozenPort)), { stdio: 'ignore' });
      frozenPort = null;
    };
    const cleanup = async () => {
      for (const e of externals) e.close();
      try { unfreeze(); } catch { /* reported by the assertions */ }
      for (const c of created) await c.remove({ force: true, v: true }).catch(() => {});
      await docker.getVolume(vol).remove().catch(() => {});
      await docker.getNetwork(net).remove().catch(() => {});
      if (pulled) await docker.getImage(image).remove().catch(() => {});
    };

    await t.test(spec, { timeout: 400_000 }, async () => {
      try {
        pulled = await pull(docker, image);
        await docker.createNetwork({ Name: net, Driver: 'bridge', Labels: RUN_LABEL });
        await docker.createVolume({ Name: vol, Labels: RUN_LABEL });
        const portKey = `${DB_CONTAINER_PORT[family]}/tcp`;
        const socketDir = DB_CONTAINER_PATHS[family].socketDir;
        const instance = await docker.createContainer({
          name, Image: image, Labels: RUN_LABEL, Cmd: renderServerArgs(engine, 'S'), Env: renderFirstRunEnv(engine, ROOT),
          ExposedPorts: { [portKey]: {} },
          HostConfig: { NetworkMode: net, PortBindings: { [portKey]: [{ HostPort: '' }] }, Mounts: [{ Type: 'volume', Source: vol, Target: socketDir }] },
          NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name] } } },
        });
        created.push(instance);
        await instance.start();
        const row = { id, name: 'e2e', engine, root_secret: '', external_enabled: true, node_id: 1 };
        const sql = (s: string, database: string | null = null) => runSql(docker, row, { sql: s, database }, { batch: true, password: ROOT });
        for (let i = 0; ; i++) {
          try {
            // The first-run server listens on the socket only: wait for the final one.
            const ping = await instance.inspect();
            if (!ping.State.Running) throw new Error('instance stopped');
            await sql('SELECT 1;');
            const tcp = await instance.exec({ Cmd: family === 'postgresql' ? ['pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'] : [DB_CLIENTS[engine].admin, '--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', '--connect-timeout=3', 'ping'], AttachStdout: true, AttachStderr: true });
            const st = await tcp.start({}); st.resume();
            await new Promise((r) => st.on('end', r));
            if ((await tcp.inspect()).ExitCode === 0) break;
            throw new Error('not ready');
          } catch (err) {
            if (i >= 120) throw err;
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        await sql(family === 'postgresql'
          ? `CREATE ROLE ${APP} LOGIN PASSWORD '${APP_PW}';`
          : `CREATE USER '${APP}'@'%' IDENTIFIED BY '${APP_PW}';`);

        const port = hostPortOf(await instance.inspect());
        assert.ok(port > 0, 'published port');
        const client = DB_CLIENTS[engine].client;
        const pwEnv = family === 'postgresql' ? `PGPASSWORD=${APP_PW}` : `MYSQL_PWD=${APP_PW}`;
        const cmdOver = (host: string, p: number): string[] => (family === 'postgresql'
          ? [client, '-h', host, '-p', String(p), '-U', APP, '-d', 'postgres', '-c', sleepSql(family)]
          : [client, '--no-defaults', '-h', host, `-P${p}`, `-u${APP}`, '--protocol=TCP', '-e', sleepSql(family)]);
        const cmdSocket = (): string[] => (family === 'postgresql'
          ? [client, '-h', socketDir, '-U', APP, '-d', 'postgres', '-c', sleepSql(family)]
          : [client, '--no-defaults', `--socket=${DB_CONTAINER_PATHS.mysql.socket}`, `-u${APP}`, '-e', sleepSql(family)]);
        const runClient = async (suffix: string, Cmd: string[], HostConfig: Docker.HostConfig) => {
          const c = await docker.createContainer({ name: `${prefix}-${suffix}`, Image: image, Labels: RUN_LABEL, Env: [pwEnv], Entrypoint: [], Cmd, HostConfig });
          created.push(c);
          await c.start();
          return c;
        };
        const siteTcp = await runClient('site-tcp', cmdOver(name, DB_CONTAINER_PORT[family]), { NetworkMode: net });
        const siteSock = await runClient('site-sock', cmdSocket(), { NetworkMode: 'none', Mounts: [{ Type: 'volume', Source: vol, Target: socketDir }] });
        const hostLoop = await runClient('host-loop', cmdOver('127.0.0.1', port), { NetworkMode: 'host' });

        const external = await connectExternal(engine, process.env.EXTSQL_E2E_HOST as string, port);
        externals.push(external);
        await external.query('SELECT 1');

        const appSessions = async () => {
          const out = await sql(family === 'postgresql'
            ? `SELECT COALESCE(host(client_addr), 'socket') FROM pg_stat_activity WHERE usename = '${APP}';`
            : `SELECT HOST FROM information_schema.PROCESSLIST WHERE USER = '${APP}';`);
          return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        };
        for (let i = 0; (await appSessions()).length < 4; i++) {
          if (i > 60) throw new Error(`clients not connected: ${JSON.stringify(await appSessions())}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
        const before = await appSessions();
        t.diagnostic(`${spec} before: ${JSON.stringify(before)}`);

        if (process.env.EXTSQL_E2E_FREEZE) {
          execSync(process.env.EXTSQL_E2E_FREEZE.replaceAll('{port}', String(port)), { stdio: 'ignore' });
          frozenPort = port;
          // The port is really closed: no new connection gets through.
          await assert.rejects(withTimeout(connectExternal(engine, process.env.EXTSQL_E2E_HOST as string, port), 5000, 'frozen'), /timeout|ETIMEDOUT|connect/i);
        }

        const opts = { dockerOf: async () => docker, passwordOf: () => ROOT };
        const [r] = await closeExternalSessionsOn([row], opts);
        t.diagnostic(`${spec} report: ${JSON.stringify(r)}`);
        assert.equal(r.state, 'closed', JSON.stringify(r));
        assert.equal(r.killed, 2, 'the driver and the client through the host loopback');
        assert.equal(r.remaining, 0);

        const after = await appSessions();
        t.diagnostic(`${spec} after: ${JSON.stringify(after)}`);
        assert.equal(after.length, 2, 'the two sessions of the site are still on the server');
        assert.equal((await siteTcp.inspect()).State.Running, true, 'network client alive');
        assert.equal((await siteSock.inspect()).State.Running, true, 'socket client alive');
        for (let i = 0; i < 10 && (await hostLoop.inspect()).State.Running; i++) await new Promise((res) => setTimeout(res, 500));
        assert.equal((await hostLoop.inspect()).State.Running, false, 'the client through the loopback lost its session');

        // Run again: nothing more to kill, the site is untouched.
        const [again] = await closeExternalSessionsOn([row], opts);
        assert.deepEqual([again.state, again.killed], ['closed', 0]);
        assert.equal((await appSessions()).length, 2);

        // What used to happen after the lift: the frozen session answers again. Not any more.
        unfreeze();
        await assert.rejects(withTimeout(external.query('SELECT 1'), 60_000, 'the old session should fail'), (err: Error) => !/^timeout/.test(err.message));

        // A new connection with the same password: still possible once the port is open (no SQL password is touched).
        const fresh = await connectExternal(engine, process.env.EXTSQL_E2E_HOST as string, port);
        externals.push(fresh);
        await fresh.query('SELECT 1');
      } finally {
        await cleanup();
      }
    });
  }
});
