import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { classifyAddress, closeExternalSessionsOn, internalNetworks, mysqlHostAddress, parseSessions, type InternalNetworks } from './externalSessions';

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const inspect = (over: Record<string, unknown> = {}) => ({
  NetworkSettings: { Networks: { db: { IPAddress: '172.30.0.2', IPPrefixLen: 16, Gateway: '172.30.0.1', GlobalIPv6Address: '', GlobalIPv6PrefixLen: 0, IPv6Gateway: '', ...over } } },
}) as unknown as Docker.ContainerInspectInfo;
const NETS = internalNetworks(inspect()) as InternalNetworks;

test('networks of the container: subnet and gateway, or nothing we can trust', () => {
  assert.deepEqual(NETS.ranges, ['172.30.0.0/16']);
  assert.deepEqual([...NETS.gateways], ['172.30.0.1']);
  assert.equal(internalNetworks(inspect({ Gateway: '' })), null, 'no gateway: the proxied sessions cannot be told apart');
  assert.equal(internalNetworks(inspect({ IPAddress: '' })), null, 'no address at all');
  assert.equal(internalNetworks({ NetworkSettings: { Networks: {} } } as never), null);
  assert.equal(internalNetworks(inspect({ GlobalIPv6Address: 'fd00::2', GlobalIPv6PrefixLen: 64, IPv6Gateway: '' })), null, 'dual stack without its IPv6 gateway');
  const dual = internalNetworks(inspect({ GlobalIPv6Address: 'fd00::2', GlobalIPv6PrefixLen: 64, IPv6Gateway: 'fd00::1' })) as InternalNetworks;
  assert.equal(classifyAddress('fd00::9', dual), 'internal');
  assert.equal(classifyAddress('fd00::1', dual), 'external');
});

test('classification: the site stays internal, the gateway is external', () => {
  for (const internal of ['', '127.0.0.1', '::1', '172.30.0.3', '172.30.255.254', '::ffff:172.30.0.9']) assert.equal(classifyAddress(internal, NETS), 'internal', internal);
  for (const external of ['172.30.0.1', '::ffff:172.30.0.1', '203.0.113.7', '10.1.2.3', '172.31.0.3', '2001:db8::1']) assert.equal(classifyAddress(external, NETS), 'external', external);
  assert.equal(classifyAddress('not an address', NETS), 'unknown');
});

test('PROCESSLIST.HOST', () => {
  assert.equal(mysqlHostAddress('localhost'), '');
  assert.equal(mysqlHostAddress(''), '');
  assert.equal(mysqlHostAddress('172.30.0.3:40112'), '172.30.0.3');
  assert.equal(mysqlHostAddress('172.30.0.3'), '172.30.0.3');
  assert.equal(mysqlHostAddress('[2001:db8::1]:3306'), '2001:db8::1');
  assert.equal(mysqlHostAddress('::ffff:172.30.0.3:40112'), '172.30.0.3');
  assert.equal(mysqlHostAddress('some.host.name:40112'), null, 'a name is never guessed');
  assert.equal(mysqlHostAddress('localhost:40112'), null);
});

test('listing: a line we cannot read marks the whole set, a user cannot forge a column', () => {
  const ok = parseSessions('mariadb', `7\t${hex('app')}\t${hex('203.0.113.7:555')}\n8\t${hex('system user')}\t\n9\t${hex('app')}\t${hex('localhost')}\n`);
  assert.equal(ok.unreadable, false);
  assert.deepEqual(ok.sessions.map((s) => [s.id, s.address]), [['7', '203.0.113.7'], ['8', ''], ['9', '']]);
  assert.equal(parseSessions('postgresql', `7\t${hex('app')}\t${hex('203.0.113.7')}\n8\t\t\n`).sessions[1].address, '');
  assert.equal(parseSessions('mariadb', `7\t${hex('app')}\t${hex('a.name:55')}\n`).unreadable, true);
  assert.equal(parseSessions('mariadb', 'garbage line\n').unreadable, true);
  assert.equal(parseSessions('mariadb', `7\tapp\t${hex('localhost')}\n`).unreadable, true, 'not hex');
  assert.equal(parseSessions('postgresql', `7\t${hex('app')}\t${hex('x')}\textra\n`).unreadable, true);
  // A user named after a tab and an address stays one value.
  const forged = parseSessions('mariadb', `7\t${hex('a\t172.30.0.3')}\t${hex('203.0.113.7:1')}\n`);
  assert.deepEqual(forged.sessions.map((s) => [s.user, s.address]), [['a\t172.30.0.3', '203.0.113.7']]);
});

// A fake engine, at the level of the docker exec: what is listed, what is killed.
function fakeDocker(state: {
  running?: boolean; bindings?: Record<string, unknown>; info?: Docker.ContainerInspectInfo; sessions: string; killed?: string[]; after?: string; listError?: boolean;
}): Docker {
  let killedOnce = false;
  return {
    getContainer: () => ({
      inspect: async () => ({ ...(state.info ?? inspect()), State: { Running: state.running !== false }, HostConfig: { PortBindings: state.bindings ?? { '3306/tcp': [{ HostPort: '33060' }] } } }),
      exec: async (o: { Env: string[] }) => {
        const sql = (o.Env.find((e) => e.startsWith('OBLIMINT_SQL=')) ?? '').slice('OBLIMINT_SQL='.length);
        const isKill = /KILL CONNECTION|pg_terminate_backend/.test(sql);
        if (isKill) { state.killed?.push(sql); killedOnce = true; }
        const out = !isKill ? (killedOnce ? (state.after ?? '') : state.sessions) : '';
        return {
          start: async () => {
            const { PassThrough } = await import('stream');
            const s = new PassThrough();
            setImmediate(() => {
              if (out) { const b = Buffer.from(out); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); s.write(Buffer.concat([h, b])); }
              s.end();
            });
            return s;
          },
          inspect: async () => ({ ExitCode: !isKill && state.listError ? 1 : 0 }),
        };
      },
    }),
  } as unknown as Docker;
}

const row = (id: number, engine: 'mariadb' | 'mysql' | 'postgresql' = 'mariadb', external = true) =>
  ({ id, name: `i${id}`, engine, root_secret: '', external_enabled: external, node_id: 1 });
const run = (rows: ReturnType<typeof row>[], dockers: Record<number, Docker>) =>
  closeExternalSessionsOn(rows, { dockerOf: async (r) => dockers[r.id], passwordOf: () => 'pw', settleMs: 1 });

const EXTERNAL = `7\t${hex('app')}\t${hex('203.0.113.7:555')}\n`;
const GATEWAY = `8\t${hex('app')}\t${hex('172.30.0.1:556')}\n`;
const SITE = `9\t${hex('app')}\t${hex('172.30.0.3:557')}\n10\t${hex('app')}\t${hex('localhost')}\n`;

test('kills what comes through the port, leaves the rest', async () => {
  const killed: string[] = [];
  const [r] = await run([row(1)], { 1: fakeDocker({ sessions: EXTERNAL + GATEWAY + SITE, killed, after: SITE }) });
  assert.equal(r.state, 'closed');
  assert.deepEqual([r.killed, r.kept, r.remaining], [2, 2, 0]);
  assert.deepEqual(killed, ['KILL CONNECTION 7;', 'KILL CONNECTION 8;']);
  assert.deepEqual(r.sessions, [{ user: 'app', ip: '203.0.113.7' }, { user: 'app', ip: '172.30.0.1' }]);
});

test('PostgreSQL: pid and address are compared again when killing', async () => {
  const killed: string[] = [];
  const [r] = await run([row(1, 'postgresql')], { 1: fakeDocker({ sessions: `7\t${hex('app')}\t${hex('203.0.113.7')}\n9\t${hex('app')}\t${hex('172.30.0.3')}\n11\t\t\n`, killed, after: `9\t${hex('app')}\t${hex('172.30.0.3')}\n` }) });
  assert.deepEqual([r.state, r.killed, r.kept], ['closed', 1, 2]);
  assert.equal(killed.length, 1);
  assert.match(killed[0], /\(pid, host\(client_addr\)\) IN \(\(7, '203\.0\.113\.7'\)\)/);
});

test('an instance without an external port is not even listed', async () => {
  const killed: string[] = [];
  const [r] = await run([row(1, 'mariadb', false)], { 1: fakeDocker({ bindings: {}, sessions: EXTERNAL, killed }) });
  assert.deepEqual([r.state, r.killed], ['notExposed', 0]);
  assert.deepEqual(killed, []);
});

test('a stopped server: nothing to do', async () => {
  assert.equal((await run([row(1)], { 1: fakeDocker({ running: false, sessions: '' }) }))[0].state, 'stopped');
});

test('distinction not reliable: nothing killed on that engine, the other engine goes on', async () => {
  const killedA: string[] = [];
  const killedB: string[] = [];
  const killedC: string[] = [];
  const out = await run([row(1), row(2), row(3, 'postgresql')], {
    1: fakeDocker({ info: inspect({ Gateway: '' }), sessions: EXTERNAL, killed: killedA }),
    2: fakeDocker({ sessions: EXTERNAL + SITE, killed: killedB }),
    3: fakeDocker({ sessions: `7\t${hex('app')}\t${hex('203.0.113.7')}\n`, killed: killedC }),
  });
  assert.deepEqual(out.map((r) => [r.state, r.reason]), [['unreliable', 'unknownNetwork'], ['unreliable', 'sameEngine'], ['closed', null]]);
  assert.deepEqual([killedA, killedB], [[], []]);
  assert.equal(killedC.length, 1);
});

test('one unreadable session holds back the whole engine', async () => {
  const killed: string[] = [];
  const [r] = await run([row(1)], { 1: fakeDocker({ sessions: `${EXTERNAL}7\t${hex('app')}\t${hex('a.name:1')}\n`, killed }) });
  assert.deepEqual([r.state, r.reason, r.killed], ['unreliable', 'unreadableSession', 0]);
  assert.deepEqual(killed, []);
});

test('a session that refuses to end, or a listing that fails: failed, the other instance goes on', async () => {
  const killedB: string[] = [];
  const out = await run([row(1), row(2)], {
    1: fakeDocker({ sessions: EXTERNAL, listError: true }),
    2: fakeDocker({ sessions: EXTERNAL, killed: killedB, after: EXTERNAL }),
  });
  assert.equal(out[0].state, 'failed');
  assert.match(out[0].error ?? '', /SQL client exited/);
  assert.deepEqual([out[1].state, out[1].killed, out[1].remaining], ['failed', 0, 1]);
  assert.equal(killedB.length, 1);
});
