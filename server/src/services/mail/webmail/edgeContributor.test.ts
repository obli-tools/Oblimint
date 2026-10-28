import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVhost } from '../../edge/nginxConfig';
import type { PlanCertificate } from '../../edge/vhostPlan';
import { isUnderPanel, planWebmailVhosts, webmailHostRefusal, type WebmailPlanInput } from './edgeContributor';

function input(over: Partial<WebmailPlanInput> = {}): WebmailPlanInput {
  return {
    kind: 'roundcube',
    platformHost: 'webmail.platform.test',
    panelHost: 'panel.platform.test',
    perDomain: true,
    domains: [
      { id: 7, accountId: 3, tenantId: 2, name: 'exemple.fr', accountStatus: 'active' },
      { id: 4, accountId: 5, tenantId: 2, name: 'autre.fr', accountStatus: 'suspended' },
    ],
    maxMessageSizeMb: 50,
    certificates: [],
    certFilesExist: () => true,
    claimed: new Set<string>(),
    ...over,
  };
}

const cert = (primary: string, names: string[], status: PlanCertificate['status'] = 'valid', domainId: number | null = null): PlanCertificate =>
  ({ domain_id: domainId, site_id: null, primary_name: primary, status, names });

const ALL_CERTS = [
  cert('webmail.platform.test', ['webmail.platform.test']),
  cert('mail.exemple.fr', ['mail.exemple.fr', 'webmail.exemple.fr']),
  cert('mail.autre.fr', ['mail.autre.fr', 'webmail.autre.fr']),
];

test('platform host + webmail.<d> per active mail domain, location / → webmail container, headers, body limit', () => {
  const { vhosts, platformRefusal } = planWebmailVhosts(input({ certificates: ALL_CERTS }));
  assert.equal(platformRefusal, null);
  assert.deepEqual(vhosts.map((v) => [v.id, v.serverNames[0]]), [
    ['webmail', 'webmail.platform.test'],
    ['w-4', 'webmail.autre.fr'],
    ['w-7', 'webmail.exemple.fr'],
  ]);
  for (const v of vhosts) {
    validateVhost(v); // H5: what the edge would render
    assert.equal(v.kind, 'webmail');
    assert.deepEqual(v.locations, [{ pathPrefix: '/', upstream: 'http://oblimint-webmail:8080', kind: 'webmail', siteId: null }]);
    assert.deepEqual(v.extraHeaders, { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    assert.equal(v.clientMaxBodyMb, 60);
  }
  const platform = vhosts.find((v) => v.id === 'webmail')!;
  assert.equal(platform.accountId, null);
  const w7 = vhosts.find((v) => v.id === 'w-7')!;
  assert.deepEqual([w7.accountId, w7.tenantId, w7.suspended], [3, 2, false]);
  assert.equal(vhosts.find((v) => v.id === 'w-4')!.suspended, true, 'suspended account: suspension page');
});

test("P1': a webmail host equal to the panel host or under it is never served, and the refusal is reported", () => {
  for (const h of ['panel.platform.test', 'webmail.panel.platform.test', 'WEBMAIL.Panel.Platform.Test']) {
    const { vhosts, platformRefusal } = planWebmailVhosts(input({ platformHost: h }));
    assert.ok(platformRefusal && /P1'/.test(platformRefusal), h);
    assert.ok(!vhosts.some((v) => v.id === 'webmail'), h);
  }
  assert.equal(webmailHostRefusal('webmail.platform.test', 'panel.platform.test'), null);
  assert.ok(webmailHostRefusal('not a host', 'panel.platform.test'));
  // A per-domain name under the panel host (tenant domain below it) is skipped too.
  const under = planWebmailVhosts(input({ domains: [{ id: 9, accountId: 1, tenantId: 1, name: 'x.panel.platform.test', accountStatus: 'active' }] }));
  assert.ok(!under.vhosts.some((v) => v.id === 'w-9'));
  assert.equal(isUnderPanel('apanel.platform.test', 'panel.platform.test'), false, 'suffix without a dot is another name');
});

test('nothing for webmail none; no per-domain vhosts when webmailPerDomain is off; no platform vhost when unset', () => {
  assert.equal(planWebmailVhosts(input({ kind: 'none' })).vhosts.length, 0);
  assert.deepEqual(planWebmailVhosts(input({ perDomain: false })).vhosts.map((v) => v.id), ['webmail']);
  assert.deepEqual(planWebmailVhosts(input({ platformHost: null })).vhosts.map((v) => v.id), ['w-4', 'w-7']);
});

test('D1 / served accounts: a deleting account gets no webmail vhost', () => {
  const plan = planWebmailVhosts(input({ domains: [{ id: 1, accountId: 1, tenantId: 1, name: 'gone.fr', accountStatus: 'deleting' }] }));
  assert.deepEqual(plan.vhosts.map((v) => v.id), ['webmail']);
});

test('names already claimed (tenant domain webmail.<d>, platform names) are not taken', () => {
  const plan = planWebmailVhosts(input({ claimed: new Set(['webmail.exemple.fr', 'webmail.platform.test']) }));
  assert.deepEqual(plan.vhosts.map((v) => v.id), ['w-4']);
});

test('TLS only with a VALID platform certificate covering the name whose files exist; HTTPS forced then', () => {
  const certificates = [
    cert('webmail.platform.test', ['webmail.platform.test']),
    cert('mail.exemple.fr', ['mail.exemple.fr', 'autoconfig.exemple.fr', 'webmail.exemple.fr']),
    cert('mail.autre.fr', ['mail.autre.fr', 'autoconfig.autre.fr']), // does not cover webmail.autre.fr
  ];
  const { vhosts } = planWebmailVhosts(input({ certificates }));
  const by = (id: string) => vhosts.find((v) => v.id === id)!;
  assert.equal(by('webmail').tls?.certPath.endsWith('/webmail.platform.test/fullchain.pem'), true);
  assert.equal(by('webmail').forceHttps, true);
  assert.equal(by('w-7').tls?.keyPath.endsWith('/mail.exemple.fr/privkey.pem'), true);
  assert.equal(by('w-7').forceHttps, true);
  assert.equal(by('w-4').tls, null);
  assert.equal(by('w-4').forceHttps, false);
  // No certificate: ACME only — the login form never travels over plain HTTP.
  assert.deepEqual(by('w-4').locations, [], 'no proxy to the webmail without TLS');
  validateVhost(by('w-4'));
  assert.equal(by('w-7').locations.length, 1);

  // pending / failed rows, missing files and TENANT rows never give TLS.
  for (const c of [
    cert('mail.exemple.fr', ['webmail.exemple.fr'], 'pending'),
    cert('mail.exemple.fr', ['webmail.exemple.fr'], 'failed'),
    cert('exemple.fr', ['exemple.fr', '*.exemple.fr'], 'valid', 12),
  ]) {
    const w = planWebmailVhosts(input({ certificates: [c] })).vhosts.find((v) => v.id === 'w-7')!;
    assert.equal(w.tls, null, `${c.primary_name} ${c.status}`);
  }
  const noFiles = planWebmailVhosts(input({ certificates, certFilesExist: () => false })).vhosts;
  assert.ok(noFiles.every((v) => v.tls === null && !v.forceHttps && v.locations.length === 0));
  // names stored as a JSON string, wildcard platform certificate.
  const wild = planWebmailVhosts(input({ certificates: [{ ...cert('platform.test', []), names: JSON.stringify(['platform.test', '*.platform.test']) }] }));
  assert.ok(wild.vhosts.find((v) => v.id === 'webmail')!.tls);
});

test('body limit follows the platform message size (+10 MiB)', () => {
  const { vhosts } = planWebmailVhosts(input({ maxMessageSizeMb: 100 }));
  assert.ok(vhosts.every((v) => v.clientMaxBodyMb === 110));
});

test("kind 'oblimint': same hosts, location / → the panel's webmail listener; no listener = no location", async () => {
  const { oblimintWebmailUpstream } = await import('./edgeContributor');
  assert.equal(oblimintWebmailUpstream(8082), 'http://oblimint-panel:8082');
  assert.equal(oblimintWebmailUpstream(0), null);
  const { vhosts } = planWebmailVhosts(input({ kind: 'oblimint', oblimintUpstream: 'http://oblimint-panel:8082', certificates: ALL_CERTS }));
  assert.equal(vhosts.length, 3);
  for (const v of vhosts) {
    validateVhost(v);
    assert.deepEqual(v.locations, [{ pathPrefix: '/', upstream: 'http://oblimint-panel:8082', kind: 'webmail', siteId: null }]);
    assert.equal(v.forceHttps, true);
  }
  const off = planWebmailVhosts(input({ kind: 'oblimint', oblimintUpstream: null, certificates: ALL_CERTS }));
  for (const v of off.vhosts) assert.deepEqual(v.locations, []);
  // Never under the panel host, whatever the kind.
  const under = planWebmailVhosts(input({ kind: 'oblimint', oblimintUpstream: 'http://oblimint-panel:8082', platformHost: 'webmail.panel.platform.test', perDomain: false }));
  assert.equal(under.vhosts.length, 0);
  assert.ok(under.platformRefusal);
});
