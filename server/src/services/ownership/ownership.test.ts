import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicDnsError, type PublicDnsLookup } from '../../utils/publicDns';
import {
  CHECK_FINAL_INTERVAL_MS, evaluateOwnership, FAST_CHECK_INTERVAL_MS, FAST_CHECK_WINDOW_MS, nextCheckDelayMs, ownershipTxt,
} from './ownership.service';

// Pure ownership logic (no database): proofs read through a fake public DNS
// (the real one goes through utils/publicDns.ts, settings dns.resolvers),
// worker backoff. The DB flows are in ownership.db.test.ts.

const MIN = 60_000;
const NS = ['ns1.oblimint.example', 'ns2.oblimint.example'];

/** Fake public DNS: records per name; a name mapped to an Error throws it. */
function fakeDns(txt: Record<string, string[] | Error>, ns: Record<string, string[] | Error> = {}): PublicDnsLookup & { asked: string[] } {
  const asked: string[] = [];
  const answer = (table: Record<string, string[] | Error>, name: string, kind: string) => {
    asked.push(`${kind} ${name}`);
    const v = table[name];
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v ?? []);
  };
  return { asked, txt: (n) => answer(txt, n, 'TXT'), ns: (n) => answer(ns, n, 'NS') };
}

const fail = () => new PublicDnsError('TXT x: ETIMEOUT', 'ETIMEOUT');
const opts = { allowNs: true, nameservers: NS };

test('ownershipTxt: record name and value', () => {
  assert.deepEqual(ownershipTxt('example.com', 'abc123'), { txtName: '_oblimint-challenge.example.com', txtValue: 'oblimint-verify=abc123' });
});

test('TXT proof: ok, missing, mismatch', async () => {
  const ok = fakeDns({ '_oblimint-challenge.example.com': ['v=spf1 -all', 'oblimint-verify=tok'] });
  assert.deepEqual(await evaluateOwnership(ok, 'example.com', 'tok', opts), { ok: true, method: 'txt', error: null });
  assert.deepEqual(ok.asked, ['TXT _oblimint-challenge.example.com'], 'TXT first, NS not needed');

  assert.deepEqual(await evaluateOwnership(fakeDns({}), 'example.com', 'tok', opts), { ok: false, method: null, error: 'txtMissing' });
  assert.deepEqual(await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=other'] }), 'example.com', 'tok', opts),
    { ok: false, method: null, error: 'txtMismatch' });
  // Surrounding spaces of a TXT chunk are tolerated, the case of the token is not.
  assert.equal((await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': [' oblimint-verify=tok '] }), 'example.com', 'tok', opts)).ok, true);
  assert.equal((await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=TOK'] }), 'example.com', 'tok', opts)).ok, false);
});

test('NS proof: every public NS must be ours, only when allowed', async () => {
  const delegated = fakeDns({}, { 'example.com': ['NS1.oblimint.example.', 'ns2.oblimint.example'] });
  assert.deepEqual(await evaluateOwnership(delegated, 'example.com', 'tok', opts), { ok: true, method: 'ns', error: null });
  // Proof disabled (settings dns.allowNsProof=false) or no name server configured.
  assert.deepEqual(await evaluateOwnership(delegated, 'example.com', 'tok', { allowNs: false, nameservers: NS }), { ok: false, method: null, error: 'txtMissing' });
  assert.deepEqual(await evaluateOwnership(delegated, 'example.com', 'tok', { allowNs: true, nameservers: [] }), { ok: false, method: null, error: 'txtMissing' });
  // Claims: TXT only, never NS (the squatter may hold the delegation).
  assert.deepEqual(await evaluateOwnership(delegated, 'example.com', 'tok', { ...opts, txtOnly: true }), { ok: false, method: null, error: 'txtMissing' });
  // A partial delegation is not a proof.
  const partial = fakeDns({}, { 'example.com': ['ns1.oblimint.example', 'ns.other-provider.net'] });
  assert.deepEqual(await evaluateOwnership(partial, 'example.com', 'tok', opts), { ok: false, method: null, error: 'nsMismatch' });
  const foreign = fakeDns({}, { 'example.com': ['ns.other-provider.net'] });
  assert.deepEqual(await evaluateOwnership(foreign, 'example.com', 'tok', opts), { ok: false, method: null, error: 'txtMissing' });
  // A sub-name without its own delegation has no NS (NODATA): no proof.
  assert.equal((await evaluateOwnership(fakeDns({}, {}), 'shop.example.com', 'tok', opts)).ok, false);
});

test('resolver failure → resolverFailed, unless another proof succeeds', async () => {
  assert.deepEqual(await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': fail() }), 'example.com', 'tok', { allowNs: false, nameservers: NS }),
    { ok: false, method: null, error: 'resolverFailed' });
  assert.deepEqual(await evaluateOwnership(fakeDns({}, { 'example.com': fail() }), 'example.com', 'tok', opts),
    { ok: false, method: null, error: 'resolverFailed' });
  // TXT lookup failed but the delegation proves it.
  assert.deepEqual(await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': fail() }, { 'example.com': NS }), 'example.com', 'tok', opts),
    { ok: true, method: 'ns', error: null });
  // A mismatching TXT is reported before a resolver failure of the NS lookup.
  assert.deepEqual(await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=x'] }, { 'example.com': fail() }), 'example.com', 'tok', opts),
    { ok: false, method: null, error: 'txtMismatch' });
});

test('worker cadence: +1 min, then every 5 min for 48 h after creation, then the backoff (6 h)', () => {
  const H = 60 * MIN;
  assert.equal(FAST_CHECK_WINDOW_MS, 48 * H);
  assert.equal(FAST_CHECK_INTERVAL_MS, 5 * MIN);
  assert.equal(nextCheckDelayMs(0), 1 * MIN);
  assert.equal(nextCheckDelayMs(1 * MIN + 2_000), 5 * MIN);
  assert.equal(nextCheckDelayMs(6 * MIN + 4_000), 5 * MIN, 'fast window: the 15 min step is capped');
  assert.equal(nextCheckDelayMs(21 * MIN + 6_000), 5 * MIN);
  assert.equal(nextCheckDelayMs(47 * H), 5 * MIN);
  assert.equal(nextCheckDelayMs(48 * H), CHECK_FINAL_INTERVAL_MS, 'window over: back to the normal cadence');
  assert.equal(nextCheckDelayMs(30 * 24 * H), 6 * H);
  // A manual check re-opens the fast window for 48 h (from the click).
  assert.equal(nextCheckDelayMs(30 * 24 * H, 0), 5 * MIN);
  assert.equal(nextCheckDelayMs(30 * 24 * H, 47 * H), 5 * MIN);
  assert.equal(nextCheckDelayMs(30 * 24 * H, 48 * H), 6 * H);
  assert.equal(nextCheckDelayMs(30 * 24 * H, -1), 6 * H, 'a click in the future (clock skew) is ignored');
  assert.equal(nextCheckDelayMs(0, 0), 1 * MIN, 'never slower than the backoff');
  // Simulated worker (30 s tick latency): the sequence of delays over 3 days.
  let t = 0;
  const delays: number[] = [];
  let next = nextCheckDelayMs(0);
  while (t < 72 * H) {
    t += next + 30_000;
    delays.push(next / MIN);
    next = nextCheckDelayMs(t);
  }
  assert.deepEqual(delays.slice(0, 4), [1, 5, 5, 5]);
  assert.ok(delays.length < 600, `bounded: ${delays.length} checks in 72 h`);
  assert.deepEqual(delays.slice(-3), [360, 360, 360]);
  assert.ok(delays.filter((d) => d === 5).length > 500, 'every 5 min during the first 48 h');
});
