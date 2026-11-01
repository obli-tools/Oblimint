import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkExplicitRange, freeIntervals, intersectRanges, largestBlock, mergeRanges, planAllocation, planGrow, planShrink, portCount,
  PortAllocationError, subtractRanges,
} from './portAllocator';
import { hostPortsOn, reservedInputs, reservedRanges, reservedReason } from './reservedPorts';

// Port blocks of the shared IP (migration 032): free intervals, first fit, the fragmented fallback (« give 10
// ports, it takes the 10 available ones »), growth by extension, a shrink that keeps the used ports, the pool
// edges and the reserved ports.

const R = (from: number, to: number) => ({ from, to });

test('ranges: merge, subtract, intersect', () => {
  assert.deepEqual(mergeRanges([R(5, 9), R(1, 3), R(4, 4), R(20, 22), R(21, 30)]), [R(1, 9), R(20, 30)]);
  assert.deepEqual(subtractRanges([R(1, 100)], [R(10, 19), R(50, 50), R(90, 200)]), [R(1, 9), R(20, 49), R(51, 89)]);
  assert.deepEqual(intersectRanges([R(1, 10), R(20, 30)], [R(5, 25)]), [R(5, 10), R(20, 25)]);
  assert.equal(portCount([R(1, 10), R(20, 20)]), 11);
});

test('the default pool minus SFTP / SQL ranges: about 15 233 usable numbers', () => {
  const free = freeIntervals(R(20000, 40000), [R(30000, 32767), R(33000, 34999)], []);
  assert.deepEqual(free, [R(20000, 29999), R(32768, 32999), R(35000, 40000)]);
  assert.equal(portCount(free), 10000 + 232 + 5001);
  assert.equal(largestBlock(free), 10000);
});

test('first fit contiguous, else the n lowest free ports (prefer) or a refusal (require)', () => {
  const free = [R(20000, 20003), R(20010, 20012), R(20020, 20029)];
  assert.deepEqual(planAllocation(free, 3), [R(20000, 20002)]);
  assert.deepEqual(planAllocation(free, 10), [R(20020, 20029)], 'first interval long enough');
  assert.deepEqual(planAllocation([R(20000, 20003), R(20010, 20012), R(20020, 20022)], 10), [R(20000, 20003), R(20010, 20012), R(20020, 20022)]);
  assert.throws(() => planAllocation([R(20000, 20003), R(20010, 20012), R(20020, 20022)], 10, 'require'),
    (e: unknown) => e instanceof PortAllocationError && e.code === 'portPoolNoContiguousBlock' && (e.details as { largestBlock: number }).largestBlock === 4);
  assert.throws(() => planAllocation([R(20000, 20003)], 5), (e: unknown) => e instanceof PortAllocationError && e.code === 'portPoolExhausted');
  assert.deepEqual(planAllocation([R(20000, 20003)], 0), []);
});

test('grow: extends the highest block upwards, else a new block', () => {
  const blocks = [{ id: 1, from: 20000, to: 20009, origin: 'plan' as const }];
  assert.deepEqual(planGrow(blocks, [R(20010, 20100)], 5), { extend: { id: 1, to: 20014 }, add: [] });
  // The ports above are another account's: a new first-fit block.
  assert.deepEqual(planGrow(blocks, [R(20050, 20100)], 5), { extend: null, add: [R(20050, 20054)] });
  assert.deepEqual(planGrow([], [R(20000, 20100)], 3), { extend: null, add: [R(20000, 20002)] });
});

test('shrink: unused ports first (plan before manual, highest first), refused only when more are used', () => {
  const blocks = [
    { id: 1, from: 20000, to: 20009, origin: 'plan' as const },
    { id: 2, from: 25000, to: 25004, origin: 'manual' as const },
  ];
  // 15 → 12: three ports of the plan block, the highest ones.
  let p = planShrink(blocks, new Set(), 12);
  assert.deepEqual(p.released, [R(20007, 20009)]);
  assert.deepEqual(p.changes.get(1), [R(20000, 20006)]);
  assert.equal(p.changes.has(2), false);
  // A binding on 20009 is kept: the ones below it go.
  p = planShrink(blocks, new Set([20009]), 12);
  assert.deepEqual(p.released, [R(20006, 20008)]);
  assert.deepEqual(p.changes.get(1), [R(20000, 20005), R(20009, 20009)]);
  // Down to 2 with 2 used ports (one in each block): everything else goes, the manual block last.
  p = planShrink(blocks, new Set([20003, 25001]), 2);
  assert.equal(portCount(subtractRanges(blocks, p.released)), 2);
  // 3 used, 2 asked: refused.
  assert.throws(() => planShrink(blocks, new Set([20000, 20001, 25000]), 2), (e: unknown) => e instanceof PortAllocationError && e.code === 'portsInUse');
  // Nothing to do.
  assert.equal(planShrink(blocks, new Set(), 20).changes.size, 0);
});

test('explicit range: inside the pool, not reserved, free', () => {
  const pool = R(20000, 40000);
  assert.doesNotThrow(() => checkExplicitRange(R(21000, 21009), pool, [R(30000, 32767)], [R(20000, 20009)]));
  for (const [r, reason] of [[R(19990, 20005), 'outsidePool'], [R(30005, 30010), 'reserved'], [R(20005, 20015), 'taken']] as const) {
    assert.throws(() => checkExplicitRange(r, pool, [R(30000, 32767)], [R(20000, 20009)]),
      (e: unknown) => e instanceof PortAllocationError && e.code === 'portRangeUnavailable' && (e.details as { reason: string }).reason === reason);
  }
});

test('reserved ports: fixed list, panel ports, SFTP / SQL ranges, streams, extras, host sockets; 80 / 443 of a taken-over dedicated IP', () => {
  const input = {
    panelPort: 8443, pdnsPort: 53, internalPort: 8081, webmailPort: 8082,
    filesrv: R(30000, 32767), db: R(33000, 34999),
    streamPorts: [{ port: 25565, protocol: 'tcp' as const }],
    extra: [21000, R(22000, 22010)],
    hostPorts: [2222],
  };
  const shared = reservedRanges(input, 'shared');
  const reason = (p: number) => reservedReason(shared, p);
  assert.equal(reason(22), 'fixed');
  assert.equal(reason(443), 'fixed');
  assert.equal(reason(8443), 'fixed');
  assert.equal(reason(31000), 'sftp');
  assert.equal(reason(34000), 'sql');
  assert.equal(reason(25565), 'stream');
  assert.equal(reason(21000), 'extra');
  assert.equal(reason(22005), 'extra');
  assert.equal(reason(2222), 'host');
  assert.equal(reason(20000), null);
  const ded = reservedRanges(input, 'dedicated');
  assert.equal(reservedReason(ded, 80), 'fixed', '80 stays the edge\'s without takeover');
  const takeover = reservedRanges(input, 'dedicated', { takeoverWeb: true });
  assert.equal(reservedReason(takeover, 80), null);
  assert.equal(reservedReason(takeover, 443), null);
  assert.equal(reservedReason(takeover, 22), 'fixed');
});

test('host sockets reachable on an address: wildcard or bound to it, never loopback', () => {
  const l = [
    { protocol: 'tcp', address: '0.0.0.0', port: 2222 },
    { protocol: 'tcp', address: '127.0.0.1', port: 5432 },
    { protocol: 'udp', address: '203.0.113.20', port: 9000 },
    { protocol: 'tcp', address: '::', port: 2375 },
  ];
  assert.deepEqual(hostPortsOn(l, '203.0.113.20'), [2222, 2375, 9000]);
  assert.deepEqual(hostPortsOn(l, '203.0.113.30'), [2222, 2375]);
  assert.deepEqual(hostPortsOn(l, null), [2222, 2375, 9000], 'shared scope: any non-loopback address');
});

test('reservedInputs reads the config and the settings', () => {
  const i = reservedInputs({ edge: { streamPorts: [] }, network: { reservedPorts: [1234] } }, [9]);
  assert.ok(i.filesrv.from > 0 && i.db.from > 0);
  assert.deepEqual(i.extra, [1234]);
  assert.deepEqual(i.hostPorts, [9]);
});
