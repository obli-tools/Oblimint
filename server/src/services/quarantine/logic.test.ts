import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostdQuarantineEntry } from '../hostd/client';
import {
  digestDue, digestNotification, digestShouldNotify, itemPathOf, looksLikeText, NO_WATCH, nextDigestAt, normalizeExtensions, planWatchOps,
  quarantineNotification, quarantineNotifyKey, rowFromEntry, type AccountWatchTarget, type DigestFacts,
} from './logic';

// Pure logic of the quarantine module (no DB, no hostd).

const target = (over: Partial<AccountWatchTarget> = {}): AccountWatchTarget => ({
  accountId: 7, nodeId: 1, uid: 20007, gid: 20007, status: 'active',
  sites: [
    { siteId: 11, slug: 'blog', dataPaths: [
      { path: 'wp-content/uploads', policy: 'typed', allowedExtensions: ['JPG', '.png', 'png', 'bad ext', 3] },
      { path: 'wp-content/cache', policy: 'ephemeral', allowedExtensions: null },
    ] },
    { siteId: 12, slug: 'static', dataPaths: [{ path: 'files', policy: 'persistent', allowedExtensions: null }] },
  ],
  ...over,
});

test('normalizeExtensions: lower case, no dot, de-duplicated, sorted, invalid dropped', () => {
  assert.deepEqual(normalizeExtensions(['JPG', '.png', 'png', 'bad ext', 3, 'webp']), ['jpg', 'png', 'webp']);
  assert.deepEqual(normalizeExtensions(null), []);
});

test('planWatchOps: typed site → setWatch, others → removeWatch, cache skips unchanged, force re-pushes', () => {
  const ops = planWatchOps(target(), true, undefined, false);
  assert.equal(ops.length, 2);
  const set = ops.find((o) => o.kind === 'set');
  assert.ok(set && set.kind === 'set');
  assert.deepEqual(set.spec, { accountId: 7, siteId: 11, slug: 'blog', uid: 20007, gid: 20007, typed: [{ path: 'wp-content/uploads', allowedExtensions: ['jpg', 'png'] }] });
  assert.deepEqual(ops.find((o) => o.kind === 'remove'), { kind: 'remove', siteId: 12, signature: NO_WATCH });

  const known = new Map(ops.map((o) => [o.siteId, o.signature]));
  assert.deepEqual(planWatchOps(target(), true, known, false), [], 'unchanged: nothing pushed');
  assert.equal(planWatchOps(target(), true, known, true).length, 2, 'force: everything again');

  // Extension list changed → new signature → pushed.
  const changed = target();
  changed.sites[0].dataPaths[0].allowedExtensions = ['jpg'];
  assert.deepEqual(planWatchOps(changed, true, known, false).map((o) => [o.kind, o.siteId]), [['set', 11]]);
});

test('planWatchOps: typedWatcher off / deleting account → removeWatch; vanished site → removeWatch', () => {
  assert.deepEqual(planWatchOps(target(), false, undefined, false).map((o) => o.kind), ['remove', 'remove']);
  assert.deepEqual(planWatchOps(target({ status: 'deleting' }), true, undefined, false).map((o) => o.kind), ['remove', 'remove']);
  // Suspended accounts keep their watches.
  assert.deepEqual(planWatchOps(target({ status: 'suspended' }), true, undefined, false).map((o) => o.kind).sort(), ['remove', 'set']);
  const known = new Map([[11, 'x'], [99, 'y'], [98, NO_WATCH]]);
  const ops = planWatchOps(target(), true, known, false);
  assert.ok(ops.some((o) => o.kind === 'remove' && o.siteId === 99), 'site gone from the account: unwatched');
  assert.ok(!ops.some((o) => o.siteId === 98), 'already unwatched: nothing');
});

const entry = (over: Partial<HostdQuarantineEntry> = {}): HostdQuarantineEntry => ({
  id: 'q-0001-abcd', accountId: 7, siteId: 11, slug: 'blog', source: 'typed', area: 'data',
  path: 'wp-content/uploads/2026/shell.php', dataPath: 'wp-content/uploads', reason: 'extension', detail: 'extension php',
  size: 42, sha256: 'A'.repeat(64), detectedType: 'text/x-php', quarantinedAt: '2026-10-09T10:00:00Z', restoredAt: null,
  ...over,
});

test('itemPathOf: data path prefix + file, code path as is, unsafe paths refused', () => {
  assert.deepEqual(itemPathOf({ area: 'data', path: 'wp-content/uploads/2026/shell.php', dataPath: 'wp-content/uploads' }),
    { path: 'wp-content/uploads/2026/shell.php', dataPath: 'wp-content/uploads' });
  assert.deepEqual(itemPathOf({ area: 'data', path: '2026/shell.php', dataPath: 'wp-content/uploads' }),
    { path: 'wp-content/uploads/2026/shell.php', dataPath: 'wp-content/uploads' });
  assert.deepEqual(itemPathOf({ area: 'code', path: './wp-content/x.php', dataPath: null }), { path: 'wp-content/x.php', dataPath: null });
  assert.equal(itemPathOf({ area: 'code', path: '../etc/passwd', dataPath: null }).path, '');
});

test('rowFromEntry: source mapping, tenant from the account, site kept or name from the slug, restored entries', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const row = rowFromEntry(entry(), { id: 7, tenantId: 3 }, { id: 11, name: 'Mon blog' }, now)!;
  assert.equal(row.source, 'typed-path');
  assert.equal(row.tenant_id, 3);
  assert.equal(row.site_id, 11);
  assert.equal(row.site_name, 'Mon blog');
  assert.equal(row.sha256, 'a'.repeat(64));
  assert.equal(row.status, 'quarantined');
  assert.equal(row.detected_at.toISOString(), '2026-10-09T10:00:00.000Z');

  const sup = rowFromEntry(entry({ source: 'supervised', area: 'code', path: 'x.php', dataPath: null, reason: 'executable-write' }), { id: 7, tenantId: 3 }, null, now)!;
  assert.equal(sup.source, 'supervised');
  assert.equal(sup.site_id, null);
  assert.equal(sup.site_name, 'blog', 'site not in the account: name from the slug, no id');
  assert.equal(sup.data_path, null);

  const restored = rowFromEntry(entry({ restoredAt: '2026-10-09T11:00:00Z' }), { id: 7, tenantId: 3 }, null, now)!;
  assert.equal(restored.status, 'restored');
  assert.ok(restored.resolution_note);

  assert.equal(rowFromEntry(entry({ reason: 'weird' as never }), { id: 7, tenantId: 3 }, null, now), null);
  assert.equal(rowFromEntry(entry({ id: '../../etc' }), { id: 7, tenantId: 3 }, null, now), null);
});

test('notification: French text, key per site and hour', () => {
  const at = new Date('2026-10-09T14:59:59Z');
  assert.equal(quarantineNotifyKey(7, 11, at), 'quarantine:site:11:2026-10-09T14');
  assert.equal(quarantineNotifyKey(7, 11, new Date('2026-10-09T14:00:00Z')), quarantineNotifyKey(7, 11, at));
  assert.notEqual(quarantineNotifyKey(7, 11, new Date('2026-10-09T15:00:00Z')), quarantineNotifyKey(7, 11, at));
  assert.equal(quarantineNotifyKey(7, null, at), 'quarantine:account:7:2026-10-09T14');
  const n = quarantineNotification({ path: 'wp-content/uploads/shell.php', reason: 'extension', source: 'typed-path', siteName: 'Mon blog', accountUsername: 'shop' });
  assert.equal(n.title, 'Fichier mis en quarantaine');
  assert.match(n.message, /extension non autorisée/);
  assert.match(n.message, /« Mon blog »/);
});

test('digest scheduling and notification decision', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  assert.equal(digestDue(null, now), 'schedule');
  assert.equal(digestDue('2026-10-09T11:59:00Z', now), 'run');
  assert.equal(digestDue(new Date('2026-10-09T13:00:00Z'), now), 'wait');
  assert.equal(nextDigestAt(now, 24).toISOString(), '2026-10-10T12:00:00.000Z');
  assert.equal(nextDigestAt(now, 0).toISOString(), '2026-10-09T13:00:00.000Z', 'at least one hour');

  const counts = { added: 2, modified: 1, deleted: 0, total: 3, executable: 1, ignored: 0 } as unknown as DigestFacts['counts'];
  const facts: DigestFacts = { siteName: 'Mon blog', accountUsername: 'shop', counts, previousTotal: null, firstDigest: true, risk: { score: 40, level: 'medium' }, newQuarantined: 0 };
  assert.equal(digestShouldNotify(facts), true, 'first digest with changes');
  assert.equal(digestShouldNotify({ ...facts, firstDigest: false, previousTotal: 3 }), false, 'nothing new');
  assert.equal(digestShouldNotify({ ...facts, firstDigest: false, previousTotal: 2 }), true, 'more changes');
  assert.equal(digestShouldNotify({ ...facts, firstDigest: false, previousTotal: 3, newQuarantined: 1 }), true, 'new quarantined files');
  assert.equal(digestShouldNotify({ ...facts, counts: null, newQuarantined: 0 }), false, 'no change at all');
  const n = digestNotification({ ...facts, newQuarantined: 2 });
  assert.equal(n.severity, 'warning');
  assert.match(n.message, /3 changement\(s\)/);
  assert.match(n.message, /risque : moyen/);
  assert.match(n.message, /2 fichier\(s\) exécutable\(s\)/);
  assert.equal(digestNotification({ ...facts, risk: { score: 95, level: 'critical' } }).severity, 'critical');
});

test('looksLikeText: printable text vs binary, truncated UTF-8 tolerated', () => {
  assert.equal(looksLikeText(Buffer.from('<?php echo "héllo"; ?>\n'), false), true);
  assert.equal(looksLikeText(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), false), false);
  const cut = Buffer.from('abc é', 'utf8').subarray(0, 5); // 'é' cut in the middle
  assert.equal(looksLikeText(cut, true), true);
  assert.equal(looksLikeText(cut, false), false);
});
