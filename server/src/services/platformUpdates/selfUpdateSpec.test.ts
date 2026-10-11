import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import {
  clonePanelContainer, demuxDockerLogs, dockerSocketBind, healthVerdict, helperCreateOptions, OLD_PANEL_RE, oldPanelName, parseHelperPlan, parseHelperResult,
  HELPER_RESULT_PREFIX, UPDATER_ROLE,
} from './selfUpdateSpec';

const ID = 'abcdef0123456789'.repeat(4);

const imageInspect = {
  Config: {
    Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_ENV=production', 'PORT=8443', 'PANEL_TLS=selfsigned'],
    Cmd: ['node', 'dist/src/index.js'],
    WorkingDir: '/app/server',
    Labels: { 'org.opencontainers.image.version': '1.0.0' },
    ExposedPorts: { '8443/tcp': {} },
    Healthcheck: { Test: ['CMD', 'node', '-e', 'probe'] },
  },
};

function panelInspect(): Docker.ContainerInspectInfo {
  return {
    Id: ID,
    Name: '/oblimint',
    Image: 'sha256:oldimage',
    Config: {
      Hostname: ID.slice(0, 12),
      Image: 'meejay/oblimint:latest',
      Env: [...imageInspect.Config.Env, 'OBLIMINT_DATA_DIR=/srv/oblimint', 'OBLIMINT_IMAGE_TAG=latest', 'DATABASE_URL=postgres://x'],
      Cmd: ['node', 'dist/src/index.js'],
      WorkingDir: '/app/server',
      Labels: { 'org.opencontainers.image.version': '1.0.0', 'com.example.owner': 'ops' },
      ExposedPorts: { '8443/tcp': {}, '9000/tcp': {} },
      Healthcheck: imageInspect.Config.Healthcheck,
    },
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/srv/oblimint:/srv/oblimint'],
      PortBindings: { '8443/tcp': [{ HostIp: '', HostPort: '8443' }] },
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: 'bridge',
      CapDrop: ['NET_RAW'],
    },
    Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Mode: '', RW: true, Propagation: 'rprivate' }],
    NetworkSettings: {
      Networks: {
        bridge: { Aliases: null, IPAMConfig: null } as never,
        'oblimint-panel': { Aliases: ['oblimint-panel', ID.slice(0, 12)], IPAMConfig: null } as never,
        'oblimint-mail': { Aliases: ['oblimint-panel'], IPAMConfig: { IPv4Address: '192.0.2.5' } } as never,
      },
    },
    State: { Running: true },
  } as unknown as Docker.ContainerInspectInfo;
}

test('self-update clone: same name, env, mounts, ports, restart policy, networks / aliases; image defaults dropped', () => {
  const clone = clonePanelContainer(panelInspect(), imageInspect, 'meejay/oblimint:latest');
  const cfg = clone.create;
  assert.equal(clone.name, 'oblimint');
  assert.equal(cfg.name, 'oblimint');
  assert.equal(cfg.Image, 'meejay/oblimint:latest');
  // Operator env kept; image defaults (PATH, NODE_ENV, PORT…) left to the NEW image.
  assert.deepEqual(cfg.Env, ['OBLIMINT_DATA_DIR=/srv/oblimint', 'OBLIMINT_IMAGE_TAG=latest', 'DATABASE_URL=postgres://x']);
  // Image label (version) dropped, operator label kept; Cmd / WorkingDir / Healthcheck from the image.
  assert.deepEqual(cfg.Labels, { 'com.example.owner': 'ops' });
  assert.equal(cfg.Cmd, undefined);
  assert.equal(cfg.WorkingDir, undefined);
  assert.equal((cfg as { Healthcheck?: unknown }).Healthcheck, undefined);
  assert.deepEqual(cfg.ExposedPorts, { '9000/tcp': {} });
  // Hostname derived from the old id dropped (the new process finds itself through HOSTNAME).
  assert.equal(cfg.Hostname, undefined);
  assert.deepEqual(cfg.HostConfig?.Binds, ['/var/run/docker.sock:/var/run/docker.sock', '/srv/oblimint:/srv/oblimint']);
  assert.deepEqual(cfg.HostConfig?.PortBindings, { '8443/tcp': [{ HostIp: '', HostPort: '8443' }] });
  assert.deepEqual(cfg.HostConfig?.RestartPolicy, { Name: 'unless-stopped', MaximumRetryCount: 0 });
  assert.deepEqual(cfg.HostConfig?.CapDrop, ['NET_RAW']);
  // First network = NetworkMode, the others connected afterwards with their aliases (container id alias dropped).
  assert.deepEqual(cfg.NetworkingConfig, { EndpointsConfig: { bridge: {} } });
  assert.deepEqual(clone.extraNetworks, [
    { name: 'oblimint-panel', aliases: ['oblimint-panel'], ipv4: null, ipv6: null },
    { name: 'oblimint-mail', aliases: ['oblimint-panel'], ipv4: '192.0.2.5', ipv6: null },
  ]);
});

test('self-update clone: operator overrides of Cmd / user / hostname survive', () => {
  const p = panelInspect();
  p.Config.Cmd = ['node', 'dist/src/index.js', '--flag'];
  p.Config.User = '1000';
  p.Config.Hostname = 'panel-host';
  const cfg = clonePanelContainer(p, imageInspect, 'meejay/oblimint:2').create;
  assert.deepEqual(cfg.Cmd, ['node', 'dist/src/index.js', '--flag']);
  assert.equal(cfg.User, '1000');
  assert.equal(cfg.Hostname, 'panel-host');
});

test('self-update helper: current panel image, docker socket only, plan in the env, no secret', () => {
  const self = panelInspect();
  assert.equal(dockerSocketBind(self), '/var/run/docker.sock:/var/run/docker.sock');
  const plan = { runId: 'r1', target: 'oblimint', newImage: 'meejay/oblimint:latest', healthTimeoutSec: 120 };
  const spec = helperCreateOptions(self, plan, '/var/run/docker.sock:/var/run/docker.sock');
  assert.equal(spec.Image, 'sha256:oldimage');
  assert.equal(spec.name, 'oblimint-updater-r1');
  assert.deepEqual(spec.HostConfig?.Binds, ['/var/run/docker.sock:/var/run/docker.sock']);
  assert.equal(spec.HostConfig?.NetworkMode, 'none');
  assert.equal(spec.Labels?.['oblimint.role'], UPDATER_ROLE);
  assert.equal(spec.Env!.length, 1);
  assert.ok(!spec.Env!.join(' ').includes('postgres://'), 'the panel secrets never go to the helper');
  const encoded = spec.Env![0].slice('OBLIMINT_SELF_UPDATE_PLAN='.length);
  assert.deepEqual(parseHelperPlan(encoded), plan);
  assert.throws(() => parseHelperPlan(undefined));
  assert.throws(() => parseHelperPlan(Buffer.from('{"target":""}').toString('base64')));
});

test('self-update: health verdict, result line, leftover names', () => {
  const opts = { timeoutMs: 60_000, noHealthcheckStableMs: 20_000 };
  assert.equal(healthVerdict({ Running: true, Health: { Status: 'starting' } }, 5_000, opts), 'wait');
  assert.equal(healthVerdict({ Running: true, Health: { Status: 'healthy' } }, 5_000, opts), 'healthy');
  assert.equal(healthVerdict({ Running: true, Health: { Status: 'unhealthy' } }, 5_000, opts), 'failed');
  assert.equal(healthVerdict({ Running: false, Status: 'exited' }, 5_000, opts), 'failed');
  assert.equal(healthVerdict({ Running: true, Health: { Status: 'starting' } }, 61_000, opts), 'failed', 'rollback after N seconds');
  assert.equal(healthVerdict({ Running: true }, 25_000, opts), 'healthy', 'no healthcheck: running long enough');
  assert.equal(healthVerdict(undefined, 0, opts), 'failed');

  const logs = `\u0001\u0000\u0000\u0000\u0000\u0000\u0000 x started\n\u0001\u0000\u0000\u0000\u0000\u0000\u0000P${HELPER_RESULT_PREFIX}{"outcome":"rolledBack","error":"the new container is unhealthy","newImageId":null,"finishedAt":"2026-10-11T00:00:00Z"}\n`;
  assert.deepEqual(parseHelperResult(logs), { outcome: 'rolledBack', error: 'the new container is unhealthy', newImageId: null, finishedAt: '2026-10-11T00:00:00Z' });
  assert.equal(parseHelperResult('nothing'), null);

  const kept = oldPanelName('oblimint', 1760000000000);
  assert.equal(kept, 'oblimint-old-1760000000000');
  assert.ok(OLD_PANEL_RE('oblimint').test(kept));
  assert.ok(!OLD_PANEL_RE('oblimint').test('oblimint-edge'));
  assert.ok(!OLD_PANEL_RE('oblimint').test('oblimint-old-1-x'));
});

test('docker log frames demultiplexed (helper result read from the logs)', () => {
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text, 'utf8');
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const line = `${HELPER_RESULT_PREFIX}{"outcome":"succeeded","error":null,"newImageId":"sha256:x","finishedAt":"t"}\n`;
  const text = demuxDockerLogs(Buffer.concat([frame(1, 'a started\n'), frame(2, 'warn\n'), frame(1, line)]));
  assert.equal(text, `a started\nwarn\n${line}`);
  assert.equal(parseHelperResult(text)?.outcome, 'succeeded');
  assert.equal(demuxDockerLogs(Buffer.from('plain tty output\n')), 'plain tty output\n');
});
