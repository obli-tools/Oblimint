import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOSTING_SETTINGS, type ScannerSettings } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { getScanner, noopScanner, setScanner } from '../releases/scan';
import { eicarSample } from './samples';
import { scanService, setScanDepsForTests } from './scan.service';
import { createScandClient } from './scandClient';
import { CLEAN, fakeScand, KEY } from './testUtil';

// scanService: status / update / self-test / start with injected settings, container state and a fake scand.

const ON: ScannerSettings = { ...DEFAULT_HOSTING_SETTINGS.scanner, enabled: true };
const RUNNING = async () => ({ deployed: true, running: true, error: null });
const ABSENT = async () => ({ deployed: false, running: false, error: null });

after(() => {
  setScanDepsForTests(null);
  setScanner(noopScanner);
});

const STATUS = {
  version: '0.3.0',
  clamav: { enabled: true, available: true, version: '1.4.3', signatureVersion: '27420', signaturesUpdatedAt: '2026-10-08T08:24:32Z', ruleCount: null },
  yara: { enabled: true, available: true, version: '4.5.2', signatureVersion: 'oblimint-1', ruleCount: 32 },
};

async function detectingScand() {
  const eicar = eicarSample();
  return fakeScand((body, url) => {
    if (url.startsWith('/v1/status')) return { json: STATUS };
    if (url.startsWith('/v1/update')) return { json: { ok: true } };
    if (body.equals(eicar)) return { json: { clamav: { status: 'found', signature: 'Win.Test.EICAR_HDB-1' }, yara: { matches: [] } } };
    if (body.includes('<?php')) return { json: { clamav: { status: 'ok' }, yara: { matches: [{ rule: 'Oblimint_Webshell_Marker', tags: [], meta: { score: 80 } }] } } };
    return { json: CLEAN };
  });
}

test('status: container + scand engines + heuristics', async () => {
  const fake = await detectingScand();
  try {
    setScanDepsForTests({ settings: async () => ON, containerState: RUNNING, client: async () => createScandClient({ baseUrl: fake.url, key: KEY }) });
    const st = await scanService.status();
    assert.equal(st.deployed, true);
    assert.equal(st.running, true);
    assert.equal(st.clamav.available, true);
    assert.equal(st.clamav.signatureVersion, '27420');
    assert.equal(st.yara.ruleCount, 32);
    assert.equal(st.heuristics.enabled, true);
    assert.ok(st.heuristics.ruleCount >= 20);

    setScanDepsForTests({ settings: async () => ({ ...ON, clamav: false }), containerState: RUNNING, client: async () => createScandClient({ baseUrl: fake.url, key: KEY }) });
    const noClam = await scanService.status();
    assert.equal(noClam.clamav.enabled, false);
    assert.equal(noClam.clamav.available, false);
  } finally {
    await fake.close();
  }
  // scand gone: summarized error, never the raw text.
  setScanDepsForTests({ settings: async () => ON, containerState: RUNNING, client: async () => createScandClient({ baseUrl: fake.url, key: KEY }) });
  const down = await scanService.status();
  assert.equal(down.clamav.available, false);
  assert.equal(down.clamav.error, 'scanner unreachable');
  setScanDepsForTests({ settings: async () => ON, containerState: ABSENT });
  const absent = await scanService.status();
  assert.equal(absent.deployed, false);
  assert.equal(absent.clamav.error, null);
});

test('self-test: EICAR through ClamAV, webshell through YARA + heuristics', async () => {
  const fake = await detectingScand();
  try {
    setScanDepsForTests({ settings: async () => ON, containerState: RUNNING, client: async () => createScandClient({ baseUrl: fake.url, key: KEY }) });
    const r = await scanService.test();
    assert.equal(r.ok, true, r.error ?? '');
    assert.equal(r.error, null);
    assert.ok(r.detections.some((d) => d.engine === 'clamav' && d.rule === 'clamav:Win.Test.EICAR_HDB-1'));
    assert.ok(r.detections.some((d) => d.engine === 'yara' && d.rule === 'yara:Oblimint_Webshell_Marker'));
    assert.ok(r.detections.some((d) => d.engine === 'heuristic' && d.rule === 'php.eval-decode'));
    assert.ok(r.detections.some((d) => d.engine === 'heuristic' && d.rule === 'php.request-exec'));
  } finally {
    await fake.close();
  }
});

test('self-test: engines that miss are reported; absent container ⇒ 409 scannerNotDeployed; disabled ⇒ heuristics only', async () => {
  const blind = await fakeScand(() => ({ json: CLEAN }));
  try {
    setScanDepsForTests({ settings: async () => ON, containerState: RUNNING, client: async () => createScandClient({ baseUrl: blind.url, key: KEY }) });
    const r = await scanService.test();
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /ClamAV did not detect/);
    assert.match(r.error ?? '', /YARA did not match/);
  } finally {
    await blind.close();
  }
  setScanDepsForTests({ settings: async () => ON, containerState: ABSENT });
  await assert.rejects(scanService.test(), (e: unknown) => e instanceof AppError && e.statusCode === 409 && e.code === 'scannerNotDeployed');
  setScanDepsForTests({ settings: async () => ({ ...ON, enabled: false }), containerState: ABSENT });
  const h = await scanService.test();
  assert.equal(h.ok, true);
  assert.ok(h.detections.every((d) => d.engine === 'heuristic'));
});

test('updateSignatures: freshclam through scand; 409 when not running; 502 summarized on failure', async () => {
  const fake = await detectingScand();
  try {
    setScanDepsForTests({ settings: async () => ON, containerState: RUNNING, client: async () => createScandClient({ baseUrl: fake.url, key: KEY }) });
    const st = await scanService.updateSignatures();
    assert.equal(st.clamav.available, true);
    assert.ok(fake.requests.some((r) => r.url === '/v1/update' && r.method === 'POST'));
  } finally {
    await fake.close();
  }
  setScanDepsForTests({ settings: async () => ON, containerState: RUNNING, client: async () => createScandClient({ baseUrl: fake.url, key: KEY }) });
  await assert.rejects(scanService.updateSignatures(), (e: unknown) => e instanceof AppError && e.statusCode === 502 && e.code === 'backendUnavailable' && e.message === 'Signature update failed: scanner unreachable');
  setScanDepsForTests({ settings: async () => ON, containerState: ABSENT });
  await assert.rejects(scanService.updateSignatures(), (e: unknown) => e instanceof AppError && e.code === 'scannerNotDeployed');
});

test('analyze through the service: enabled without a key ⇒ scannerUnavailable; start registers the pre-publish scanner', async () => {
  const probed: Array<[number, number]> = [];
  setScanDepsForTests({
    settings: async () => ON, containerState: ABSENT, client: async () => null,
    baseCodeDir: async (siteId, accountId) => { probed.push([siteId, accountId]); return async (d) => d === 'lib'; },
  });
  // Generic application: a new file in a directory that held code in the live release is expected (§9.2).
  const gen = await scanService.analyze({
    origin: 'window', siteId: 4, accountId: 9, appProfile: 'drupal', dataPaths: [],
    files: [{ path: 'lib/New.php', change: 'added', type: 'file', size: 5 }, { path: 'odd/x.php', change: 'added', type: 'file', size: 5 }],
    tree: { root: '/x', stat: async () => ({ type: 'file', size: 5, mode: 0o644 }), read: async () => ({ data: Buffer.from('<?php'), truncated: false, size: 5 }), readlink: async () => null },
  });
  assert.deepEqual(probed, [[4, 9]]);
  assert.deepEqual(gen.files.map((f) => f.findings.filter((x) => x.rule === 'exec.new-outside-expected').length), [0, 1]);
  const a = await scanService.analyze({
    origin: 'adapter', siteId: 1, accountId: 1, appProfile: null, files: [], dataPaths: [],
    tree: { root: '/x', stat: async () => null, read: async () => null, readlink: async () => null },
  });
  assert.equal(a.summary.scannerUnavailable, true);
  assert.equal(a.summary.verdict, 'clean');
  assert.ok((await scanService.status()).lastScanAt);
  scanService.start();
  try {
    assert.equal(getScanner().name, 'oblimint');
  } finally {
    scanService.stop();
  }
});
