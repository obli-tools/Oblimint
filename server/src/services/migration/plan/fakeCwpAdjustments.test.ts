import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { CwpDomain, MigrationAccountChoice, MigrationPlanChoices } from '@oblimint/shared';
import { computePlan } from './compute';
import { defaultChoices } from './defaults';
import { account, domain, ftpUser, inventory, target } from './fixtures';
import { accountChoiceSchema } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the staff choices the fake-cwp e2e applies (images/fake-cwp/dataset/expected-inventory.json,
// planAdjustments, generated from the dataset) must (1) pass the PUT /plans/:id/accounts/:username schema and
// (2) lift the blocking proxy warnings of acct2 (proxyPrivateTarget, proxyTargetRefused, proxyDomainUnverified)
// with the planner as it is — else the the Linux test host e2e stops before the runs. Also: acct6's adjustment raises
// ftpHashUnsupported (expectedWarnings).
// ─────────────────────────────────────────────────────────────────────────────

interface ExpectedDomain {
  fqdn: string; kind: CwpDomain['kind']; account: string; parent: string | null; subLabel: string | null; docroot: string | null;
  serving: CwpDomain['serving'];
  proxy: { scheme: 'http' | 'https'; host: string; port: number; websocket: boolean; via: 'nginx-vhost' | 'webservers-json'; isPrivate: boolean } | null;
}
interface Expected {
  domains: ExpectedDomain[];
  planAdjustments: { account: string; choice: unknown; reason: string }[];
  expectedWarnings: Record<string, string[]>;
}

const EXPECTED_FILE = path.resolve(__dirname, '../../../../../images/fake-cwp/dataset/expected-inventory.json');
const expected = JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8')) as Expected;

function adjustment(user: string): MigrationAccountChoice {
  const all = expected.planAdjustments.filter((a) => a.account === user);
  assert.equal(all.length, 1, `${user}: exactly one adjustment (the PUT replaces the account choice)`);
  return accountChoiceSchema.parse(all[0].choice) as MigrationAccountChoice;
}

test('fake-cwp planAdjustments: one per account, all valid account choices', () => {
  const users = expected.planAdjustments.map((a) => a.account);
  assert.equal(new Set(users).size, users.length);
  for (const u of users) adjustment(u);
});

test('fake-cwp acct2: proxy blockers lifted by the staff adjustments', () => {
  const user = 'acct2';
  const domains = expected.domains.filter((d) => d.account === user && d.serving === 'proxy').map((d) => domain(d.fqdn, user, {
    kind: d.kind, parent: d.parent, subLabel: d.subLabel, docroot: d.docroot, serving: 'proxy', php: null, ssl: false,
    proxy: d.proxy,
  }));
  assert.ok(domains.length >= 5, 'acct2 proxy domains in the expected inventory');
  const inv = inventory({
    accounts: [account(user, { mainDomain: 'gamma.test' })],
    domains: [domain('gamma.test', user), ...domains],
  });
  const tgt = target(); // tenant 1 allows external proxy targets (the e2e sets it, PX2)
  const ch: MigrationPlanChoices = defaultChoices(inv, tgt);

  const blockingCodes = (c: MigrationPlanChoices) => {
    const a = computePlan(inv, c, tgt, 7).accounts.find((x) => x.cwpUsername === user)!;
    return { a, blocking: a.warnings.filter((w) => w.severity === 'blocking').map((w) => `${w.code}(${w.scope.key})`) };
  };
  const before = blockingCodes(ch);
  for (const code of ['proxyPrivateTarget', 'proxyTargetRefused', 'proxyDomainUnverified']) {
    assert.ok(before.blocking.some((b) => b.startsWith(`${code}(`)), `${code} blocking without the adjustments: ${before.blocking.join(', ')}`);
  }

  ch.accounts[user] = adjustment(user);
  const after = blockingCodes(ch);
  assert.deepEqual(after.blocking, [], `still blocking: ${after.blocking.join(', ')}`);
  assert.equal(after.a.blocked, false);
  // Private targets kept, allowed by the staff; the documentation-range target skipped.
  for (const d of domains.filter((x) => x.proxy?.isPrivate)) {
    const ph = after.a.proxies.find((p) => p.fqdns.includes(d.fqdn));
    assert.ok(ph, `${d.fqdn}: proxy host planned`);
    assert.equal(ph.target.allowPrivate, true, `${d.fqdn}: allowPrivate`);
  }
  assert.ok(!after.a.proxies.some((p) => p.fqdns.includes('cloud.gamma.test')), 'cloud.gamma.test skipped');
  const codes = new Set(after.a.warnings.map((w) => w.code));
  for (const code of ['proxyPrivateTarget', 'proxyWebsocket']) assert.ok(codes.has(code), `${code} still raised (non-blocking)`);
});

test('fake-cwp acct6: the adoption asked for the MD5-crypt FTP user raises ftpHashUnsupported', () => {
  const user = 'acct6';
  const inv = inventory({
    accounts: [account(user, { mainDomain: 'iota.example' })],
    domains: [domain('iota.example', user)],
    ftpUsers: [ftpUser('legacy@iota.example', user, '/home/acct6', 'md5-crypt')],
  });
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  const plain = computePlan(inv, ch, tgt, 7).accounts[0];
  assert.equal(plain.warnings.some((w) => w.code === 'ftpHashUnsupported'), false, 'default: nobody adopted, no warning');
  ch.accounts[user] = adjustment(user);
  const a = computePlan(inv, ch, tgt, 7).accounts[0];
  assert.ok(expected.expectedWarnings[user].includes('ftpHashUnsupported'));
  assert.ok(a.warnings.some((w) => w.code === 'ftpHashUnsupported' && w.severity === 'warning'));
  assert.equal(a.ftp, null);
  assert.equal(a.blocked, false);
});
