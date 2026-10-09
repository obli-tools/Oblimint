import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  announceCertificateInstalled, clearEdgeContributorsForTests, collectCertificateWishes, contributedCertificateWishes, registerEdgeContributor,
  withContributedVhosts,
} from './contributors';
import type { EdgeVhost } from './nginxConfig';
import type { PlatformHosts } from './vhostPlan';

const platform: PlatformHosts = { panel: 'panel.example.net', previewDomain: null, dbAdmin: null, probeV4: null, probeV6: null, extra: [] };
const ctx = { platform, panelUpstream: 'https://oblimint-panel:8443', certificates: [], certFilesExist: () => false };

function vhost(id: string, names: string[], kind: EdgeVhost['kind'] = 'site'): EdgeVhost {
  return {
    id, kind, serverNames: names, tls: null, forceHttps: false, suspended: false, locations: [], extraHeaders: {}, clientMaxBodyMb: 10,
    accountId: null, tenantId: null,
  };
}

test('contributed vhosts come after the base ones and never take a claimed name', async () => {
  clearEdgeContributorsForTests();
  registerEdgeContributor({
    id: 'a',
    vhosts: async (c) => {
      assert.ok(c.claimed.has('shop.example.com'));
      return [vhost('m-1', ['shop.example.com', 'autoconfig.shop.example.com'], 'mail'), vhost('m-2', ['shop.example.com'], 'mail')];
    },
  });
  registerEdgeContributor({ id: 'b', vhosts: async () => [vhost('w-1', ['autoconfig.shop.example.com', 'webmail.shop.example.com'], 'webmail')] });
  registerEdgeContributor({ id: 'boom', vhosts: async () => { throw new Error('boom'); } });
  const out = await withContributedVhosts([vhost('d-1', ['shop.example.com'])], ctx);
  assert.deepEqual(out.map((v) => [v.id, v.serverNames]), [
    ['d-1', ['shop.example.com']],
    ['m-1', ['autoconfig.shop.example.com']],
    ['w-1', ['webmail.shop.example.com']],
  ]);
  clearEdgeContributorsForTests();
});

test('certificate wishes and installation announcements survive a failing contributor', async () => {
  clearEdgeContributorsForTests();
  const seen: string[] = [];
  registerEdgeContributor({ id: 'boom', certificates: async () => { throw new Error('x'); }, onCertificateInstalled: () => { throw new Error('y'); } });
  registerEdgeContributor({
    id: 'mail',
    certificates: async () => [{ names: ['mail.shop.example.com', 'autoconfig.shop.example.com'], preferDns01: true, tenantId: 2, accountId: 7 }, { names: [], preferDns01: false, tenantId: 1, accountId: null }],
    onCertificateInstalled: (p) => { seen.push(p); },
  });
  const wishes = await contributedCertificateWishes(platform);
  assert.equal(wishes.length, 1);
  assert.equal(wishes[0].names[0], 'mail.shop.example.com');
  announceCertificateInstalled('mail.shop.example.com', ['mail.shop.example.com']);
  assert.deepEqual(seen, ['mail.shop.example.com']);
  clearEdgeContributorsForTests();
});

test('certificate wishes report the contributors that failed (the renewal pass then keeps platform rows)', async () => {
  clearEdgeContributorsForTests();
  registerEdgeContributor({ id: 'ok', certificates: async () => [{ names: ['webmail.example.net'], preferDns01: false, tenantId: 1, accountId: null }] });
  assert.deepEqual((await collectCertificateWishes(platform)).failed, []);
  registerEdgeContributor({ id: 'mail', certificates: async () => { throw new Error('pool acquire timeout'); } });
  const r = await collectCertificateWishes(platform);
  assert.deepEqual(r.failed, ['mail']);
  assert.deepEqual(r.wishes.map((w) => w.names[0]), ['webmail.example.net']);
  clearEdgeContributorsForTests();
});
