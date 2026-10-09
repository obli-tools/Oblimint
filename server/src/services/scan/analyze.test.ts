import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_HOSTING_SETTINGS, type ScannerSettings } from '@oblimint/shared';
import { localContentTree, type AnalyzeInput, type ChangedPath } from '../maintenance/contracts';
import { analyzeChanges } from './analyze';
import { createScandClient } from './scandClient';
import { CLEAN, fakeScand, KEY } from './testUtil';

// analyze() end to end: a temp directory tree read through localContentTree + a fake scand.

const SETTINGS: ScannerSettings = { ...DEFAULT_HOSTING_SETTINGS.scanner, enabled: true, maxFileSizeMb: 1 };

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function makeTree(files: Record<string, string | Buffer>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-scan-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// Never real samples on disk (an antivirus on the dev box would remove them): the fake scand
// recognises markers; the PHP file only carries what the heuristics need.
const EICAR = Buffer.from('OBLIMINT-FAKE-VIRUS-MARKER');
const EV = ['ev', 'al'].join('');
const SHELL = Buffer.from(['<?php', '// OBLIMINT-FAKE-YARA-MARKER', `$x = ${EV}(gzinflate($blob));`, ''].join('\n'));
const tree = makeTree({
  'wp-content/plugins/hello/hello.php': '<?php\n/* Plugin Name: Hello */\nadd_action("init", "hello_init");\n',
  'wp-content/plugins/hello/readme.txt': '=== Hello ===\n',
  'shell.php': SHELL,
  'notes/eicar.txt': EICAR,
  'big.bin': Buffer.alloc(2 * 1024 * 1024, 0x41),
  'wp-content/uploads/a.php': '<?php echo 1;',
});

const files: ChangedPath[] = [
  { path: 'wp-content/plugins/hello/hello.php', change: 'added', type: 'file', size: null, mode: null },
  { path: 'wp-content/plugins/hello/readme.txt', change: 'modified', type: 'file', size: null, mode: null },
  { path: 'shell.php', change: 'added', type: 'file', size: null, mode: null },
  { path: 'notes/eicar.txt', change: 'added', type: 'file', size: null, mode: null },
  { path: 'big.bin', change: 'added', type: 'file', size: null, mode: null },
  { path: 'old.php', change: 'deleted', type: 'file', size: null },
  { path: 'wp-content/plugins/old', change: 'deleted', type: 'dir', size: null },
  { path: 'wp-content/uploads/a.php', change: 'added', type: 'file', size: null, mode: null, ignored: 'dataPath' },
  { path: 'vendor/.git/HEAD', change: 'added', type: 'file', size: null, ignored: 'nestedRepo' },
];

const input = (o: Partial<AnalyzeInput> = {}): AnalyzeInput => ({
  origin: 'window', siteId: 1, accountId: 2, appProfile: 'wordpress', tree: localContentTree(tree), files,
  dataPaths: [{ path: 'wp-content/uploads', policy: 'typed', allowedExtensions: ['jpg', 'png'] }], ...o,
});

function scandAnswer(body: Buffer) {
  if (body.equals(EICAR)) return { json: { clamav: { status: 'found', signature: 'Win.Test.EICAR_HDB-1' }, yara: { matches: [] } } };
  if (body.includes('OBLIMINT-FAKE-YARA-MARKER')) return { json: { clamav: { status: 'ok' }, yara: { matches: [{ rule: 'Oblimint_Webshell_Marker', tags: ['webshell'], meta: { score: 80, description: 'Known webshell marker' } }] } } };
  return { json: CLEAN };
}

test('analyze: heuristics + YARA + ClamAV, skipped big file, counts, blocked', async () => {
  const fake = await fakeScand(scandAnswer);
  try {
    const a = await analyzeChanges(input(), { settings: SETTINGS, engine: createScandClient({ baseUrl: fake.url, key: KEY }) });
    assert.deepEqual(a.summary.engines, ['heuristic', 'yara', 'clamav']);
    assert.equal(a.scan.scanner, 'heuristic+yara+clamav');
    assert.equal(a.summary.scannerUnavailable, false);
    assert.equal(a.summary.skipped, 1);
    assert.equal(a.summary.verdict, 'infected');
    assert.equal(a.summary.blocked, true);
    assert.equal(a.summary.risk.score, 100);
    assert.equal(a.summary.risk.level, 'critical');
    assert.deepEqual(a.summary.counts, { added: 4, modified: 1, deleted: 1, total: 6, executable: 2, ignored: 2, bytes: a.summary.counts.bytes });
    assert.ok(a.summary.counts.bytes > 2 * 1024 * 1024);

    const by = new Map(a.files.map((f) => [f.path, f]));
    assert.equal(a.files.length, files.length, 'one FileAnalysis per input path, in order');
    assert.deepEqual(a.files.map((f) => f.path), files.map((f) => f.path));
    assert.equal(by.get('wp-content/plugins/hello/hello.php')!.risk, 0);
    const shell = by.get('shell.php')!;
    assert.ok(shell.executable);
    assert.ok(shell.findings.some((f) => f.engine === 'yara' && f.rule === 'yara:Oblimint_Webshell_Marker'));
    assert.ok(shell.findings.some((f) => f.engine === 'heuristic' && f.rule === 'php.eval-decode' && f.line === 3));
    assert.ok(shell.findings.some((f) => f.rule === 'exec.new-outside-expected'));
    assert.equal(shell.level, 'critical');
    const eicar = by.get('notes/eicar.txt')!;
    assert.equal(eicar.risk, 100);
    assert.equal(eicar.findings[0].rule, 'clamav:Win.Test.EICAR_HDB-1');
    const big = by.get('big.bin')!;
    assert.ok(big.findings.some((f) => f.rule === 'scan.skipped'));
    assert.equal(big.binary, false);
    assert.equal(by.get('old.php')!.risk, 0);
    const dataFile = by.get('wp-content/uploads/a.php')!;
    assert.equal(dataFile.ignored, 'dataPath');
    assert.deepEqual(dataFile.findings.map((f) => f.rule), ['datapath.code'], 'only the typed data path check runs on an ignored entry');
    assert.equal(by.get('vendor/.git/HEAD')!.findings.length, 0);

    // Data-path / skipped files were never sent; the 3 regular small files were.
    const sent = fake.requests.map((r) => decodeURIComponent(r.url.replace('/v1/scan?name=', ''))).sort();
    assert.deepEqual(sent, ['notes/eicar.txt', 'shell.php', 'wp-content/plugins/hello/hello.php', 'wp-content/plugins/hello/readme.txt']);

    // Release-shaped summary: flattened, most severe first, with engine / path / line.
    assert.equal(a.scan.findings[0].severity, 'critical');
    assert.ok(a.scan.findings.some((f) => f.engine === 'clamav' && f.path === 'notes/eicar.txt'));
    assert.equal(a.scan.blocked, true);
    assert.deepEqual(a.scan.risk, { score: 100, level: 'critical' });
  } finally {
    await fake.close();
  }
});

test('analyze: unreachable scanner ⇒ heuristics only, scannerUnavailable, never throws, stops sending', async () => {
  const fake = await fakeScand(scandAnswer);
  await fake.close();
  const a = await analyzeChanges(input(), { settings: SETTINGS, engine: createScandClient({ baseUrl: fake.url, key: KEY }) });
  assert.deepEqual(a.summary.engines, ['heuristic']);
  assert.equal(a.summary.scannerUnavailable, true);
  assert.equal(a.scan.scannerUnavailable, true);
  assert.equal(a.scan.scanner, 'heuristic');
  assert.ok(a.summary.risk.score >= 70, 'the webshell is still caught by the heuristics');
  assert.equal(a.summary.blocked, true);
  assert.ok(a.summary.skipped >= 4);
});

test('analyze: wrong key ⇒ scannerUnavailable (circuit opens after the first refusal)', async () => {
  const fake = await fakeScand(scandAnswer);
  try {
    const a = await analyzeChanges(input({ files: files.slice(0, 4) }), { settings: SETTINGS, engine: createScandClient({ baseUrl: fake.url, key: 'nope' }) });
    assert.equal(a.summary.scannerUnavailable, true);
    assert.ok(fake.requests.length <= 4);
  } finally {
    await fake.close();
  }
});

test('analyze: engine error on a file ⇒ scannerUnavailable, the other engine still counts', async () => {
  const fake = await fakeScand(() => ({ json: { clamav: { status: 'ok' }, yara: { matches: [], error: 'yara: exit 2' } } }));
  try {
    const a = await analyzeChanges(input({ files: files.slice(0, 2) }), { settings: SETTINGS, engine: createScandClient({ baseUrl: fake.url, key: KEY }) });
    assert.equal(a.summary.scannerUnavailable, true);
    assert.deepEqual(a.summary.engines, ['heuristic', 'clamav']);
  } finally {
    await fake.close();
  }
});

test('analyze: scanner disabled ⇒ heuristics only, not "unavailable", nothing skipped', async () => {
  const a = await analyzeChanges(input(), { settings: { ...SETTINGS, enabled: false }, engine: null });
  assert.deepEqual(a.summary.engines, ['heuristic']);
  assert.equal(a.summary.scannerUnavailable, false);
  assert.equal(a.summary.skipped, 0);
  assert.equal(a.summary.blocked, true, 'heuristics alone block the webshell (eval + decode, request exec)');
});

test('analyze: enabled but never deployed (no key) ⇒ scannerUnavailable', async () => {
  const a = await analyzeChanges(input({ files: files.slice(0, 2) }), { settings: SETTINGS, engine: null, engineUnavailable: true });
  assert.equal(a.summary.scannerUnavailable, true);
  assert.equal(a.summary.verdict, 'clean');
  assert.equal(a.summary.blocked, false);
});

test('analyze: generic application — base code dirs decide exec.new-outside-expected', async () => {
  const t = makeTree({ 'app/Ctl/New.php': '<?php echo 1;', 'x/y.php': '<?php echo 2;' });
  const f: ChangedPath[] = [
    { path: 'app/Ctl/New.php', change: 'added', type: 'file', size: null, mode: null },
    { path: 'x/y.php', change: 'added', type: 'file', size: null, mode: null },
  ];
  const asked: string[] = [];
  const a = await analyzeChanges({ ...input(), appProfile: 'laravel', tree: localContentTree(t), files: f, dataPaths: [] }, {
    settings: { ...SETTINGS, enabled: false }, engine: null,
    baseCodeDir: async (d) => { asked.push(d); return d === 'app'; },
  });
  assert.equal(a.files[0].findings.length, 0);
  assert.deepEqual(a.files[1].findings.map((x) => x.rule), ['exec.new-outside-expected']);
  assert.equal(a.summary.verdict, 'clean');
  assert.equal(a.summary.risk.level, 'low');
  assert.ok(asked.includes('app/Ctl') && asked.includes('app') && asked.includes('x'));
  const first = await analyzeChanges({ ...input(), appProfile: 'laravel', tree: localContentTree(t), files: f, dataPaths: [] }, {
    settings: { ...SETTINGS, enabled: false }, engine: null, baseCodeDir: null,
  });
  assert.equal(first.summary.risk.score, 0, 'first publication: nothing to compare with');
});

test('analyze: ignored files of a persistent data path never score (not published)', async () => {
  const t = makeTree({ 'wp-content/cache/a.php': '<?php echo 1;', 'wp-content/cache/b.php': '<?php echo 2;', 'wp-content/cache/c.php': '<?php echo 3;' });
  const f: ChangedPath[] = ['a', 'b', 'c'].map((n) => ({ path: `wp-content/cache/${n}.php`, change: 'added', type: 'file', size: null, mode: null, ignored: 'dataPath' }));
  const a = await analyzeChanges({ ...input(), tree: localContentTree(t), files: f, dataPaths: [{ path: 'wp-content/cache', policy: 'persistent', allowedExtensions: null }] }, {
    settings: { ...SETTINGS, enabled: false }, engine: null,
  });
  assert.ok(a.files.every((x) => x.findings.length === 0 && x.risk === 0));
  assert.equal(a.summary.risk.score, 0);
  assert.equal(a.summary.blocked, false);
});

test('analyze: an aborted signal rejects', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(analyzeChanges(input({ signal: ac.signal }), { settings: SETTINGS, engine: null }), (e: Error) => e.name === 'AbortError');
});

test('analyze: a symlink is never followed', { skip: process.platform === 'win32' ? 'symbolic links need privileges on Windows' : false }, async () => {
  const t = makeTree({ 'real.txt': 'hello' });
  fs.symlinkSync('/etc/passwd', path.join(t, 'link.php'));
  const fake = await fakeScand(scandAnswer);
  try {
    const a = await analyzeChanges({ ...input(), tree: localContentTree(t), files: [{ path: 'link.php', change: 'added', type: 'file', size: null }], dataPaths: [] }, {
      settings: SETTINGS, engine: createScandClient({ baseUrl: fake.url, key: KEY }),
    });
    assert.equal(fake.requests.length, 0);
    assert.ok(a.files[0].findings.some((f) => f.rule === 'scan.skipped'));
  } finally {
    await fake.close();
  }
});

test('analyze: an executable larger than what was inspected always needs a human (padding + webshell at the end)', async () => {
  const pad = Buffer.alloc(5 * 1024 * 1024, 0x20);
  const tail = Buffer.from(`\n<?php ${EV}($_POST['x']);\n`);
  const t = makeTree({ 'lib/cache.php': Buffer.concat([Buffer.from('<?php /* '), pad, Buffer.from(' */ ?>'), tail]), 'big.bin': Buffer.alloc(5 * 1024 * 1024, 0x41) });
  const f: ChangedPath[] = [
    { path: 'lib/cache.php', change: 'modified', type: 'file', size: null, mode: null },
    { path: 'big.bin', change: 'added', type: 'file', size: null, mode: null },
  ];
  const base = { ...input(), appProfile: 'generic-php' as const, tree: localContentTree(t), files: f, dataPaths: [] };
  // Scanner disabled (heuristics read 4 MiB) and scanner enabled but the file above maxFileSizeMb: same outcome.
  const fake = await fakeScand(scandAnswer);
  try {
    for (const deps of [
      { settings: { ...SETTINGS, enabled: false }, engine: null },
      { settings: SETTINGS, engine: createScandClient({ baseUrl: fake.url, key: KEY }) },
    ]) {
      const a = await analyzeChanges(base, deps);
      const php = a.files[0];
      assert.ok(php.findings.some((x) => x.rule === 'scan.exec-uninspected' && x.severity === 'warn'), JSON.stringify(php.findings));
      assert.ok(php.risk >= SETTINGS.reviewScore);
      assert.notEqual(a.summary.verdict, 'clean', 'never auto-validated, awaiting approval in the pipeline');
      assert.ok(a.summary.findings > 0 && a.summary.risk.score > 5);
      assert.ok(!a.files[1].findings.some((x) => x.rule === 'scan.exec-uninspected'), 'only executables');
    }
  } finally {
    await fake.close();
  }
  // Fully covered by the engines (under maxFileSizeMb): no such finding.
  const fake2 = await fakeScand(scandAnswer);
  try {
    const a = await analyzeChanges(base, { settings: { ...SETTINGS, maxFileSizeMb: 16 }, engine: createScandClient({ baseUrl: fake2.url, key: KEY }) });
    assert.ok(!a.files[0].findings.some((x) => x.rule === 'scan.exec-uninspected'), JSON.stringify(a.files[0].findings));
  } finally {
    await fake2.close();
  }
});
