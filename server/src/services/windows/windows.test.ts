import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_SITE_MAINTENANCE_SETTINGS, type WindowSchedule } from '@oblimint/shared';
import type { HostingActor } from '../hosting/access';
import { applySettingsUpdate, isValidTimezone, mergeSettings, nextScheduleAt, nextWindowAt, normalizeCron, validateSchedule } from './settings';
import { generateToken, hashToken, parseToken, tokenMatches } from './siteTokens';
import { validationVerdict } from './policy';
import { manifestChanges, maskDetail, readManifest, windowForActor, withDetail, toWindow, type WindowRow } from './rows';
import { rowBlocks } from './engine';

// ─────────────────────────────────────────────────────────────────────────────
// Pure parts of the windows module (docs/P3-PLAN.md §15): settings (cron +
// IANA time zone + next occurrence + limits), site tokens (format, hash,
// constant-time verify), the override permission matrix, the export manifest
// reader, A6 masking, the publication guard predicate.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-09T10:00:00.000Z'); // a Friday

const sched = (over: Partial<WindowSchedule> = {}): WindowSchedule => ({
  enabled: true, cron: '0 3 * * 0', timezone: 'Europe/Paris', durationMinutes: 60, kickPath: '/wp-cron.php', ...over,
});

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { return (e as { code?: string }).code; }
  return undefined;
};

test('settings: defaults merged, unknown values normalized', () => {
  assert.deepEqual(mergeSettings(null), DEFAULT_SITE_MAINTENANCE_SETTINGS);
  assert.deepEqual(mergeSettings('garbage'), DEFAULT_SITE_MAINTENANCE_SETTINGS);
  const m = mergeSettings({ pendingPolicy: 'revert', autoValidate: 'nope', snapshot: { mode: 'selected', databaseIds: [3, 'x', -1] }, supervised: true });
  assert.equal(m.pendingPolicy, 'revert');
  assert.equal(m.autoValidate, 'scheduled');
  assert.deepEqual(m.snapshot, { mode: 'selected', databaseIds: [3] });
  assert.equal(m.supervised, true);
});

test('settings: cron expressions and time zones', () => {
  assert.equal(normalizeCron('  0   3 * * sun '), '0 3 * * sun');
  assert.equal(normalizeCron('@Weekly'), '@weekly');
  for (const bad of ['', '* * * *', '0 0 * * * *', '@reboot', '$(id) * * * *', '0 0 * * * ; rm']) {
    assert.equal(code(() => normalizeCron(bad)), 'invalidSchedule', bad);
  }
  assert.equal(isValidTimezone('Europe/Paris'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
});

test('settings: next occurrence in the IANA time zone (Sunday 03:00 Paris = 01:00 / 02:00 UTC)', () => {
  // 2026-10-11 is a Sunday, Paris in CEST (UTC+2) → 01:00Z.
  assert.equal(nextScheduleAt({ cron: '0 3 * * 0', timezone: 'Europe/Paris' }, NOW)?.toISOString(), '2026-10-11T01:00:00.000Z');
  // After the DST switch (2026-10-25), Paris is UTC+1 → 02:00Z on 2026-11-01.
  assert.equal(nextScheduleAt({ cron: '0 3 * * 0', timezone: 'Europe/Paris' }, new Date('2026-10-26T00:00:00Z'))?.toISOString(), '2026-11-01T02:00:00.000Z');
  assert.equal(nextScheduleAt({ cron: '0 3 * * 0', timezone: 'UTC' }, NOW)?.toISOString(), '2026-10-11T03:00:00.000Z');
  assert.equal(nextScheduleAt({ cron: '0 0 30 2 *', timezone: 'UTC' }, NOW), null, 'never fires');
  const s = { ...DEFAULT_SITE_MAINTENANCE_SETTINGS, schedule: sched() };
  assert.equal(nextWindowAt(s, NOW)?.toISOString(), '2026-10-11T01:00:00.000Z');
  assert.equal(nextWindowAt({ ...s, schedule: sched({ enabled: false }) }, NOW), null);
  assert.equal(nextWindowAt(DEFAULT_SITE_MAINTENANCE_SETTINGS, NOW), null);
});

test('settings: schedule validation (duration ≤ max, kickPath, never-firing)', () => {
  assert.deepEqual(validateSchedule(sched({ cron: '0  3 * * 0' }), 1440, NOW), sched());
  assert.equal(code(() => validateSchedule(sched({ timezone: 'Nowhere/City' }), 1440, NOW)), 'invalidSchedule');
  assert.equal(code(() => validateSchedule(sched({ durationMinutes: 2000 }), 1440, NOW)), 'windowMaxDuration');
  assert.equal(code(() => validateSchedule(sched({ durationMinutes: 2 }), 1440, NOW)), 'invalidSchedule');
  for (const bad of ['wp-cron.php', '//evil.example/x', 'http://x/', '/a b', '/x\ny', '/é']) {
    assert.equal(code(() => validateSchedule(sched({ kickPath: bad }), 1440, NOW)), 'invalidSchedule', bad);
  }
  assert.equal(validateSchedule(sched({ kickPath: '/index.php?doing_wp_cron=1' }), 1440, NOW).kickPath, '/index.php?doing_wp_cron=1');
  assert.equal(validateSchedule(sched({ kickPath: '' }), 1440, NOW).kickPath, null);
  assert.equal(code(() => validateSchedule(sched({ cron: '0 0 30 2 *' }), 1440, NOW)), 'invalidSchedule');
});

test('settings: update merge, default duration limit, snapshot ids only when selected', () => {
  const cur = DEFAULT_SITE_MAINTENANCE_SETTINGS;
  const next = applySettingsUpdate(cur, { pendingPolicy: 'revert', schedule: sched(), snapshot: { mode: 'selected', databaseIds: [2, 2, 5] } }, 1440, NOW);
  assert.equal(next.pendingPolicy, 'revert');
  assert.deepEqual(next.snapshot, { mode: 'selected', databaseIds: [2, 5] });
  assert.equal(next.schedule?.timezone, 'Europe/Paris');
  assert.deepEqual(applySettingsUpdate(next, { snapshot: { mode: 'all', databaseIds: [9] } }, 1440, NOW).snapshot, { mode: 'all', databaseIds: [] });
  assert.equal(applySettingsUpdate(next, { schedule: null }, 1440, NOW).schedule, null);
  assert.equal(code(() => applySettingsUpdate(cur, { defaultDurationMinutes: 90 }, 60, NOW)), 'windowMaxDuration');
  assert.equal(cur.pendingPolicy, 'keep', 'input not mutated');
});

test('site tokens: format, sha256 storage, constant-time verification', () => {
  const g = generateToken(42);
  assert.match(g.token, /^obt_42_[A-Za-z0-9_-]{43}$/);
  assert.equal(g.hash, hashToken(g.token));
  assert.match(g.hash, /^[0-9a-f]{64}$/);
  assert.ok(g.prefix.startsWith('obt_42_') && g.prefix.length <= 32);
  assert.ok(!g.prefix.includes(g.token.slice(14)), 'the prefix does not reveal the secret');
  assert.equal(parseToken(g.token), 42);
  for (const bad of ['', 'obt_42_short', 'obt_0_' + 'a'.repeat(43), 'obt_x_' + 'a'.repeat(43), `${g.token}x`, `Bearer ${g.token}`, 'obt_42_' + 'a'.repeat(42) + '!']) {
    assert.equal(parseToken(bad), null, bad);
  }
  assert.equal(tokenMatches(g.token, g.hash), true);
  assert.equal(tokenMatches(g.token, hashToken(generateToken(42).token)), false);
  assert.equal(tokenMatches(g.token, ''), false);
  assert.equal(tokenMatches(g.token, 'not-hex'), false);
  assert.notEqual(generateToken(42).token, g.token, 'random');
});

const staffAdmin: HostingActor = { kind: 'staff', userId: 1, tenantId: 1, globalView: true, caps: '*' };
const staffSites: HostingActor = { kind: 'staff', userId: 2, tenantId: 5, globalView: false, caps: new Set(['sites.manage']) };
const staffRead: HostingActor = { kind: 'staff', userId: 3, tenantId: 5, globalView: false, caps: new Set(['overview.read']) };
const clientFull: HostingActor = { kind: 'client', userId: 4, tenantId: 5, accounts: new Map([[7, new Set(['releases.publish', 'releases.approve'] as const)]]) };
const clientPublish: HostingActor = { kind: 'client', userId: 5, tenantId: 5, accounts: new Map([[7, new Set(['releases.publish'] as const)]]) };

test('validation / override permission matrix (M5)', () => {
  const target = { tenantId: 5, accountId: 7, publishMode: 'manual' as const };
  const blocked = { blocked: true, score: 85, level: 'high' };
  const clean = { blocked: false, score: 5, level: 'low' };
  const v = (a: HostingActor, an: typeof clean, override: boolean, mode: 'manual' | 'approval' = 'manual') => {
    const r = validationVerdict(a, { ...target, publishMode: mode }, an, override);
    return r.ok ? (r.override ? 'ok+override' : 'ok') : `${r.error.statusCode}:${r.error.code ?? ''}`;
  };
  // Clean analysis.
  assert.equal(v(staffSites, clean, false), 'ok');
  assert.equal(v(clientPublish, clean, false), 'ok');
  assert.equal(v(staffRead, clean, false), '403:');
  assert.equal(v(clientPublish, clean, true), '403:overrideForbidden', 'a client never asks for an override');
  assert.equal(v(staffSites, clean, true), 'ok', 'override without a blocked analysis changes nothing');
  // Blocked analysis.
  assert.equal(v(staffSites, blocked, false), '409:riskBlocked');
  assert.equal(v(clientFull, blocked, false), '409:riskBlocked');
  assert.equal(v(clientFull, blocked, true), '403:overrideForbidden', 'even with releases.approve');
  assert.equal(v(staffSites, blocked, true), 'ok+override');
  assert.equal(v(staffAdmin, blocked, true), 'ok+override');
  // Approval mode: releases.approve needed.
  assert.equal(v(clientPublish, clean, false, 'approval'), '403:');
  assert.equal(v(clientFull, clean, false, 'approval'), 'ok');
  // riskBlocked details.
  const r = validationVerdict(staffSites, target, blocked, false);
  assert.ok(!r.ok && JSON.stringify(r.error.details) === JSON.stringify({ score: 85, level: 'high' }));
  // Other tenant (staff not global): invisible → 403 from actorCan.
  assert.equal(v(staffSites, clean, false).startsWith('ok'), true);
  assert.equal(validationVerdict(staffSites, { tenantId: 9, accountId: 7, publishMode: 'manual' }, clean, false).ok, false);
});

test('export manifest: reader + entries → change list', () => {
  const dir = fs.mkdtempSync(path.join(process.env.OBLIMINT_TEST_TMP || os.tmpdir(), 'manifest-'));
  const file = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, windowId: 7, releaseNumber: 3, createdAt: 'x', truncated: false,
    entries: [
      { path: 'a.php', change: 'added', type: 'file', size: 10, mode: 420, sha256: 'ab', linkTarget: null, exported: true, skipped: null },
      { path: 'a.php', change: 'added', type: 'file', size: 10, mode: 420, sha256: 'ab', linkTarget: null, exported: true, skipped: null },
      { path: 'big.zip', change: 'added', type: 'file', size: 9e9, mode: 420, sha256: 'cd', linkTarget: null, exported: false, skipped: 'tooLarge' },
      { path: 'old', change: 'deleted', type: 'dir', size: null, mode: null, sha256: null, linkTarget: null, exported: false, skipped: null },
      { path: '../x', change: 'weird', type: 'socket', size: 1 },
    ],
  }));
  const m = readManifest(file, 7);
  assert.equal(m.entries.length, 5);
  const c = manifestChanges(m);
  assert.deepEqual(c.map((x) => [x.path, x.change, x.type, x.size, x.skipped, x.ignored ?? null]), [
    ['a.php', 'added', 'file', 10, null, null],
    ['big.zip', 'added', 'file', 9e9, 'tooLarge', null],
    ['old', 'deleted', 'dir', null, null, null],
    ['../x', 'modified', 'file', 1, null, 'invalidPath'],
  ]);
  assert.throws(() => readManifest(file, 8), /autre fenêtre/);
  assert.throws(() => readManifest(path.join(dir, 'absent.json'), 7), /absent/);
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readManifest(file, 7), /illisible/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A6: backend causes masked for clients only', () => {
  const msg = withDetail('montage de la fenêtre impossible', new Error('mount: /srv/oblimint/accounts/3/sites/9: EBUSY [x]'));
  assert.equal(msg, 'montage de la fenêtre impossible [détail : mount: /srv/oblimint/accounts/3/sites/9: EBUSY (x)]');
  assert.equal(maskDetail(msg), 'montage de la fenêtre impossible');
  assert.equal(maskDetail('commit candidat abc : +1 ~0 -0'), 'commit candidat abc : +1 ~0 -0');
  const row = {
    id: 1, tenant_id: 5, account_id: 7, site_id: 9, number: 1, trigger: 'manual', status: 'failed', overlay: 'unmounted',
    base_release_id: 1, base_release_number: 1, base_commit: 'x', result_release_id: null, candidate_commit: null, candidate_ref: null,
    opened_by: null, token_id: null, token_name: null, note: null, opened_at: null, expires_at: null, closed_at: null, close_reason: null,
    exec_allowed_until: null, last_kick_at: null, decision: null, decided_by: null, decided_at: null, decision_reason: null,
    scan_override: false, counts: null, risk_score: null, risk_level: null, analysis: null, checksums: null, healthcheck: null,
    auto_validation: null, staging_conflicts: '[]', db_restored: false, error: msg, log: '[]', created_at: NOW, updated_at: NOW,
  } as unknown as WindowRow;
  const w = { ...toWindow(row), log: [{ at: 'x', level: 'error' as const, message: msg }] };
  const forClient = windowForActor(clientFull, w);
  assert.equal(forClient.error, 'montage de la fenêtre impossible');
  assert.equal(forClient.log[0].message, 'montage de la fenêtre impossible');
  assert.equal(windowForActor(staffSites, w).error, msg);
});

test('publication guard: which windows hold the site (§5.3)', () => {
  assert.equal(rowBlocks(undefined), false);
  assert.equal(rowBlocks({ status: 'open', overlay: 'rw' }), true);
  assert.equal(rowBlocks({ status: 'opening', overlay: 'none' }), true);
  assert.equal(rowBlocks({ status: 'pending_review', overlay: 'ro' }), true);
  assert.equal(rowBlocks({ status: 'pending_review', overlay: 'unmounted' }), false, 'revert policy: the site serves the base again');
  assert.equal(rowBlocks({ status: 'validating', overlay: 'unmounted' }), true);
  assert.equal(rowBlocks({ status: 'rejecting', overlay: 'unmounted' }), true);
  assert.equal(rowBlocks({ status: 'validated', overlay: 'ro' }), false, 'final windows never block');
});
