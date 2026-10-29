import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DomainOwnershipCheckResult } from '@oblimint/shared';
import { PublicDnsError, type PublicDnsLookup } from '../../utils/publicDns';
import {
  CHECK_FINAL_INTERVAL_MS, checkResultSignature, evaluateOwnership, FAST_CHECK_INTERVAL_MS, FAST_CHECK_WINDOW_MS, nextCheckDelayMs,
  ownershipTxt, parseCheckResult,
} from './ownership.service';
import type { RegistryDelegation, RegistryLookup } from './registryDelegation';

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

/** Legacy triple of a proof (ok, method, error). */
async function brief(...args: Parameters<typeof evaluateOwnership>) {
  const { ok, method, error } = await evaluateOwnership(...args);
  return { ok, method, error };
}

const fail = () => new PublicDnsError('TXT x: ETIMEOUT', 'ETIMEOUT');
const opts = { allowNs: true, nameservers: NS };

test('ownershipTxt: record name and value', () => {
  assert.deepEqual(ownershipTxt('example.com', 'abc123'), { txtName: '_oblimint-challenge.example.com', txtValue: 'oblimint-verify=abc123' });
});

test('TXT proof: ok, missing, mismatch', async () => {
  const ok = fakeDns({ '_oblimint-challenge.example.com': ['v=spf1 -all', 'oblimint-verify=tok'] });
  assert.deepEqual(await brief(ok, 'example.com', 'tok', opts), { ok: true, method: 'txt', error: null });
  assert.deepEqual(ok.asked, ['TXT _oblimint-challenge.example.com'], 'TXT first, NS not needed');

  assert.deepEqual(await brief(fakeDns({}), 'example.com', 'tok', opts), { ok: false, method: null, error: 'txtMissing' });
  assert.deepEqual(await brief(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=other'] }), 'example.com', 'tok', opts),
    { ok: false, method: null, error: 'txtMismatch' });
  // Surrounding spaces of a TXT chunk are tolerated, the case of the token is not.
  assert.equal((await brief(fakeDns({ '_oblimint-challenge.example.com': [' oblimint-verify=tok '] }), 'example.com', 'tok', opts)).ok, true);
  assert.equal((await brief(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=TOK'] }), 'example.com', 'tok', opts)).ok, false);
});

test('NS proof: every public NS must be ours, only when allowed', async () => {
  const delegated = fakeDns({}, { 'example.com': ['NS1.oblimint.example.', 'ns2.oblimint.example'] });
  assert.deepEqual(await brief(delegated, 'example.com', 'tok', opts), { ok: true, method: 'ns', error: null });
  // Proof disabled (settings dns.allowNsProof=false) or no name server configured.
  assert.deepEqual(await brief(delegated, 'example.com', 'tok', { allowNs: false, nameservers: NS }), { ok: false, method: null, error: 'txtMissing' });
  assert.deepEqual(await brief(delegated, 'example.com', 'tok', { allowNs: true, nameservers: [] }), { ok: false, method: null, error: 'txtMissing' });
  // Claims: TXT only, never NS (the squatter may hold the delegation).
  assert.deepEqual(await brief(delegated, 'example.com', 'tok', { ...opts, txtOnly: true }), { ok: false, method: null, error: 'txtMissing' });
  // A partial delegation is not a proof.
  const partial = fakeDns({}, { 'example.com': ['ns1.oblimint.example', 'ns.other-provider.net'] });
  assert.deepEqual(await brief(partial, 'example.com', 'tok', opts), { ok: false, method: null, error: 'nsMismatch' });
  const foreign = fakeDns({}, { 'example.com': ['ns.other-provider.net'] });
  assert.deepEqual(await brief(foreign, 'example.com', 'tok', opts), { ok: false, method: null, error: 'txtMissing' });
  // A sub-name without its own delegation has no NS (NODATA): no proof.
  assert.equal((await brief(fakeDns({}, {}), 'shop.example.com', 'tok', opts)).ok, false);
});

test('resolver failure → resolverFailed, unless another proof succeeds', async () => {
  assert.deepEqual(await brief(fakeDns({ '_oblimint-challenge.example.com': fail() }), 'example.com', 'tok', { allowNs: false, nameservers: NS }),
    { ok: false, method: null, error: 'resolverFailed' });
  assert.deepEqual(await brief(fakeDns({}, { 'example.com': fail() }), 'example.com', 'tok', opts),
    { ok: false, method: null, error: 'resolverFailed' });
  // TXT lookup failed but the delegation proves it.
  assert.deepEqual(await brief(fakeDns({ '_oblimint-challenge.example.com': fail() }, { 'example.com': NS }), 'example.com', 'tok', opts),
    { ok: true, method: 'ns', error: null });
  // A mismatching TXT is reported before a resolver failure of the NS lookup.
  assert.deepEqual(await brief(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=x'] }, { 'example.com': fail() }), 'example.com', 'tok', opts),
    { ok: false, method: null, error: 'txtMismatch' });
});

/** Fake registry (parent zone servers): one answer per name, calls recorded. */
function fakeRegistry(table: Record<string, Partial<RegistryDelegation> | Error>): RegistryLookup & { asked: string[] } {
  const asked: string[] = [];
  const fn = (async (name: string) => {
    asked.push(name);
    const v = table[name];
    if (v instanceof Error) throw v;
    return { zone: 'com', found: [], failed: false, ...(v ?? {}) };
  }) as RegistryLookup & { asked: string[] };
  fn.asked = asked;
  return fn;
}

const OLD = ['dns103.example.net', 'ns103.example.net'];

test('combined outcome: both methods reported (TXT missing AND the delegation still elsewhere)', async () => {
  // The owner's case: NS switched at the registrar, not effective yet — the resolvers and the registry still show the old provider.
  const dns = fakeDns({}, { 'example.com': ['NS103.example.net.', 'dns103.example.net'] });
  const reg = fakeRegistry({ 'example.com': { found: OLD } });
  const p = await evaluateOwnership(dns, 'example.com', 'tok', { ...opts, registry: reg });
  assert.equal(p.ok, false);
  assert.equal(p.error, 'txtMissing', 'legacy code unchanged');
  assert.deepEqual(p.result, {
    summary: 'notProven',
    provenBy: null,
    txt: { outcome: 'missing', found: [] },
    ns: {
      expected: NS,
      public: { found: OLD, status: 'elsewhere', failed: false },
      registry: { zone: 'com', found: OLD, status: 'elsewhere', failed: false },
      matches: false,
    },
  });
  assert.deepEqual(reg.asked, ['example.com']);
});

test('combined outcome: the registry already delegates to us while the resolvers still cache the old NS → proven (ns)', async () => {
  const dns = fakeDns({}, { 'example.com': OLD });
  const p = await evaluateOwnership(dns, 'example.com', 'tok', { ...opts, registry: fakeRegistry({ 'example.com': { found: ['ns2.oblimint.example', 'NS1.oblimint.example.'] } }) });
  assert.deepEqual([p.ok, p.method, p.error], [true, 'ns', null]);
  assert.equal(p.result.summary, 'proven');
  assert.equal(p.result.provenBy, 'ns');
  assert.equal(p.result.ns?.public.status, 'elsewhere');
  assert.deepEqual(p.result.ns?.registry, { zone: 'com', found: NS, status: 'ours', failed: false });
  assert.equal(p.result.ns?.matches, true);
  // Registry mixed (half switched): not a proof, legacy nsMismatch.
  const mixed = await evaluateOwnership(dns, 'example.com', 'tok', { ...opts, registry: fakeRegistry({ 'example.com': { found: ['ns1.oblimint.example', 'ns103.example.net'] } }) });
  assert.deepEqual([mixed.ok, mixed.error, mixed.result.summary, mixed.result.ns?.registry?.status], [false, 'nsMismatch', 'notProven', 'mixed']);
});

test('combined outcome: the registry is not asked when not needed / not allowed', async () => {
  const reg = fakeRegistry({});
  // Public view already ours.
  const viaPublic = await evaluateOwnership(fakeDns({}, { 'example.com': NS }), 'example.com', 'tok', { ...opts, registry: reg });
  assert.deepEqual([viaPublic.ok, viaPublic.method, viaPublic.result.ns?.registry], [true, 'ns', null]);
  // TXT proves it first: NS not tried at all.
  const viaTxt = await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=tok'] }), 'example.com', 'tok', { ...opts, registry: reg });
  assert.deepEqual(viaTxt.result, { summary: 'proven', provenBy: 'txt', txt: { outcome: 'found', found: [] }, ns: null });
  // NS method off / claims (TXT only): ns null, the TXT outcome alone.
  for (const o of [{ allowNs: false, nameservers: NS }, { ...opts, txtOnly: true }]) {
    const r = await evaluateOwnership(fakeDns({}, { 'example.com': NS }), 'example.com', 'tok', { ...o, registry: reg });
    assert.deepEqual(r.result, { summary: 'notProven', provenBy: null, txt: { outcome: 'missing', found: [] }, ns: null });
  }
  assert.deepEqual(reg.asked, [], 'never asked');
});

test('combined outcome: TXT mismatch values, not delegated, failures', async () => {
  const mismatch = await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': ['oblimint-verify=old', 'x'.repeat(400)] }), 'example.com', 'tok', opts);
  assert.equal(mismatch.result.txt.outcome, 'mismatch');
  assert.deepEqual(mismatch.result.txt.found, ['oblimint-verify=old', 'x'.repeat(255)], 'values capped');
  assert.deepEqual(mismatch.result.ns?.public, { found: [], status: 'none', failed: false }, 'NS still tried and reported');
  assert.equal(mismatch.result.ns?.registry, null, 'no registry lookup given');

  // Registry: not delegated (authoritative NXDOMAIN / NODATA) vs not reachable.
  const none = await evaluateOwnership(fakeDns({}), 'example.com', 'tok', { ...opts, registry: fakeRegistry({ 'example.com': { found: [] } }) });
  assert.deepEqual(none.result.ns?.registry, { zone: 'com', found: [], status: 'none', failed: false });
  const unreachable = await evaluateOwnership(fakeDns({}), 'example.com', 'tok', { ...opts, registry: fakeRegistry({ 'example.com': { failed: true } }) });
  assert.deepEqual(unreachable.result.ns?.registry, { zone: 'com', found: [], status: 'none', failed: true });
  assert.equal(unreachable.result.summary, 'notProven', 'the public views answered');
  // A registry lookup that throws is ignored (bonus view).
  const thrown = await evaluateOwnership(fakeDns({}, { 'example.com': OLD }), 'example.com', 'tok', { ...opts, registry: fakeRegistry({ 'example.com': new Error('boom') }) });
  assert.deepEqual([thrown.result.summary, thrown.result.ns?.registry, thrown.result.ns?.public.status], ['notProven', null, 'elsewhere']);

  // Everything tried failed → resolverFailed; one view answering → notProven (with details).
  const allDown = await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': fail() }, { 'example.com': fail() }), 'example.com', 'tok',
    { ...opts, registry: fakeRegistry({ 'example.com': { failed: true } }) });
  assert.deepEqual([allDown.error, allDown.result.summary, allDown.result.txt.outcome, allDown.result.ns?.public.failed], ['resolverFailed', 'resolverFailed', 'resolverFailed', true]);
  const txtDown = await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': fail() }, { 'example.com': OLD }), 'example.com', 'tok', opts);
  assert.deepEqual([txtDown.error, txtDown.result.summary, txtDown.result.ns?.public.status], ['resolverFailed', 'notProven', 'elsewhere']);
  const txtOnlyDown = await evaluateOwnership(fakeDns({ '_oblimint-challenge.example.com': fail() }), 'example.com', 'tok', { allowNs: false, nameservers: NS });
  assert.equal(txtOnlyDown.result.summary, 'resolverFailed');
});

test('stored result: parsed defensively, signature ignores the time', async () => {
  const { result } = await evaluateOwnership(fakeDns({}, { 'example.com': OLD }), 'example.com', 'tok', { ...opts, registry: fakeRegistry({ 'example.com': { found: OLD } }) });
  const stored: DomainOwnershipCheckResult = { at: '2026-01-01T00:00:00.000Z', trigger: 'auto', ...result };
  assert.deepEqual(parseCheckResult(JSON.stringify(stored)), stored);
  assert.deepEqual(parseCheckResult(stored), stored, 'jsonb comes back as an object');
  assert.equal(parseCheckResult(null), null);
  assert.equal(parseCheckResult('not json'), null);
  assert.equal(parseCheckResult(42), null);
  // Unknown values fall back to safe ones.
  assert.deepEqual(parseCheckResult({ summary: '?', txt: { outcome: '?', found: [1, 'a'] }, ns: { public: { status: '?' } }, trigger: 'x' }), {
    at: new Date(0).toISOString(), trigger: 'auto', summary: 'notProven', provenBy: null,
    txt: { outcome: 'missing', found: ['a'] },
    ns: { expected: [], public: { found: [], status: 'none', failed: false }, registry: null, matches: false },
  });
  const later: DomainOwnershipCheckResult = { ...stored, at: '2026-02-02T00:00:00.000Z', trigger: 'manual' };
  assert.equal(checkResultSignature(stored), checkResultSignature(later));
  const moved = { ...stored, ns: { ...stored.ns!, registry: { zone: 'com', found: NS, status: 'ours' as const, failed: false } } };
  assert.notEqual(checkResultSignature(stored), checkResultSignature(moved));
  assert.equal(checkResultSignature(null), '');
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
