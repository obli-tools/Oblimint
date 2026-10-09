import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePorts, parseListeners } from './ports';

// busybox `netstat -ltnu` output, as printed by the setup port probe.
const HEADER = 'Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State\n';
const RESOLVED =
  'tcp        0      0 127.0.0.53:53           0.0.0.0:*               LISTEN\n' +
  'tcp        0      0 127.0.0.54:53           0.0.0.0:*               LISTEN\n' +
  'udp        0      0 127.0.0.53:53           0.0.0.0:*\n' +
  'udp        0      0 127.0.0.54:53           0.0.0.0:*\n';
const SSH = 'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN\ntcp        0      0 :::22                   :::*                    LISTEN\n';

test('stock Ubuntu (systemd-resolved on 53): warn, not fail — DNS only arrives in P2', () => {
  const v = evaluatePorts(HEADER + SSH + RESOLVED);
  assert.equal(v.status, 'warn');
  assert.match(v.detail, /53\/tcp\+udp/);
  assert.match(v.detail, /DNS/);
  assert.match(v.fixCommand ?? '', /DNSStubListener=no/);
});

test('a local MTA on 25: warn only', () => {
  const v = evaluatePorts(`${HEADER}tcp6       0      0 :::25                   :::*                    LISTEN\n`);
  assert.equal(v.status, 'warn');
  assert.match(v.detail, /25\/tcp/);
  assert.match(v.fixCommand ?? '', /postfix/);
});

test('80 or 443 busy: fail (the edge cannot start), later ports reported too', () => {
  const v = evaluatePorts(`${HEADER}tcp        0      0 0.0.0.0:443             0.0.0.0:*               LISTEN\n${RESOLVED}`);
  assert.equal(v.status, 'fail');
  assert.match(v.detail, /443\/tcp/);
  assert.match(v.detail, /53\/tcp\+udp/);
  assert.match(v.fixCommand ?? '', /nginx/);
});

test('nothing busy: ok; established (non LISTEN) tcp lines are ignored', () => {
  const v = evaluatePorts(`${HEADER + SSH}tcp        0      0 10.0.0.5:80             10.0.0.9:51000          ESTABLISHED\n`);
  assert.equal(v.status, 'ok');
  assert.equal(v.fixCommand, undefined);
  assert.deepEqual([...parseListeners(RESOLVED, [53]).get(53)!].sort(), ['tcp', 'udp']);
});
