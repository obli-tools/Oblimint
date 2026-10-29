import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_NOTIFICATION_FAMILIES, DEFAULT_USER_NOTIFICATION_PREFS, NOTIFICATION_EVENT_FAMILY, NOTIFICATION_EVENTS, NOTIFICATION_FAMILIES,
} from '@oblimint/shared';
import { audienceOf, normalizePrefs, parseIds, safeLink } from './userNotifications.service';
import { formatFrom } from '../mail/transactional';
import { EVENT_LABELS_FR } from './notifications/plugins';

test('every notification event has a family, a French label and an audience', () => {
  for (const e of NOTIFICATION_EVENTS) {
    assert.ok(NOTIFICATION_FAMILIES.includes(NOTIFICATION_EVENT_FAMILY[e]), e);
    assert.ok(EVENT_LABELS_FR[e], e);
    assert.ok(audienceOf(e), e);
  }
  assert.equal(Object.keys(NOTIFICATION_EVENT_FAMILY).length, NOTIFICATION_EVENTS.length);
  for (const f of NOTIFICATION_FAMILIES) assert.ok(DEFAULT_USER_NOTIFICATION_PREFS[f], f);
});

test('audience: decisions go to approvers, platform / security never to clients', () => {
  assert.equal(audienceOf('release.pendingApproval').client, 'releases.approve');
  assert.equal(audienceOf('release.pendingApproval').staff, 'releases.approve');
  assert.equal(audienceOf('release.rejected').client, 'releases.publish');
  assert.equal(audienceOf('certificate.failed').client, 'read');
  assert.equal(audienceOf('platform.updateFailed').client, null);
  assert.equal(audienceOf('platform.updateFailed').staff, null, 'platform admins only');
  assert.equal(audienceOf('security.banned').client, null);
  assert.ok(!CLIENT_NOTIFICATION_FAMILIES.includes('platform'));
  assert.ok(!CLIENT_NOTIFICATION_FAMILIES.includes('security'));
});

test('preferences: defaults filled, junk ignored', () => {
  assert.deepEqual(normalizePrefs(null), DEFAULT_USER_NOTIFICATION_PREFS);
  const p = normalizePrefs({ quota: { inApp: false, email: true }, releases: { inApp: 'no' }, nope: { inApp: false } });
  assert.deepEqual(p.quota, { inApp: false, email: true });
  assert.deepEqual(p.releases, { inApp: true, email: false });
  assert.equal((p as Record<string, unknown>).nope, undefined);
  assert.deepEqual(normalizePrefs('{"mail":{"email":true}}').mail, { inApp: true, email: true });
  assert.deepEqual(normalizePrefs('not json'), DEFAULT_USER_NOTIFICATION_PREFS);
});

test('links stay inside the panel', () => {
  assert.equal(safeLink('/sites/3?tab=releases'), '/sites/3?tab=releases');
  for (const bad of ['//evil.example.com/x', 'https://evil.example.com', 'javascript:alert(1)', '/\\evil.example.com', '', null, 42]) {
    assert.equal(safeLink(bad), null, String(bad));
  }
});

test('ids of the inbox actions', () => {
  assert.deepEqual(parseIds([3, '4', 3, -1, 'x']), [3, 4]);
  assert.throws(() => parseIds('3'), /array/);
  assert.throws(() => parseIds([]), /1 to 500/);
  assert.throws(() => parseIds(Array.from({ length: 501 }, (_, i) => i + 1)), /1 to 500/);
});

test('sender display form never injects a header', () => {
  assert.equal(formatFrom(null, 'noreply@example.com'), '"Oblimint" <noreply@example.com>');
  assert.equal(formatFrom('Hébergeur "X"\r\nBcc: a@example.com', 'noreply@example.com'), '"Hébergeur XBcc: a@example.com" <noreply@example.com>');
  assert.equal(formatFrom('""', 'n@example.com'), '"Oblimint" <n@example.com>');
});
