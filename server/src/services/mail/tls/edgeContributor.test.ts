import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVhost, validateVhost } from '../../edge/nginxConfig';
import type { PlanCertificate, PlatformHosts } from '../../edge/vhostPlan';
import { MAIL_PUBLIC_PATHS, mailCertificateNames, planMailCertificateWishes, planMailVhosts, type MailEdgeDomain, type MailEdgeInput } from './edgeContributor';

const platform: PlatformHosts = { panel: 'panel.host.net', previewDomain: 'preview.host.net', dbAdmin: null, probeV4: null, probeV6: null, extra: ['mail.host.net'] };

const dom = (over: Partial<MailEdgeDomain> = {}): MailEdgeDomain => ({
  id: 7, tenantId: 2, accountId: 11, name: 'exemple.fr', autoconfig: true, mtaSts: true, webmail: true, ...over,
});

const input = (over: Partial<MailEdgeInput> = {}): MailEdgeInput => ({ host: 'mail.host.net', domains: [dom()], taken: new Set(), platform, ...over });

const ctx = (certificates: PlanCertificate[] = [], files: string[] = [], claimed: string[] = []) => ({
  panelUpstream: 'https://oblimint-panel:8443',
  certificates,
  certFilesExist: (p: string) => files.includes(p),
  claimed: new Set(claimed),
});

test('vhosts: mail-host (ACME only) + m-<id> with exact locations to the panel, the rest 404', () => {
  const vhosts = planMailVhosts(input(), ctx());
  assert.deepEqual(vhosts.map((v) => v.id), ['mail-host', 'm-7']);
  const host = vhosts[0];
  assert.deepEqual(host.serverNames, ['mail.host.net']);
  assert.deepEqual(host.locations, []);
  assert.equal(host.kind, 'mail');
  const m = vhosts[1];
  assert.deepEqual(m.serverNames, ['mail.exemple.fr', 'autoconfig.exemple.fr', 'autodiscover.exemple.fr', 'mta-sts.exemple.fr']);
  assert.deepEqual(m.locations.map((l) => l.pathPrefix), [...MAIL_PUBLIC_PATHS]);
  assert.ok(m.locations.every((l) => l.exact && l.kind === 'mail' && l.upstream === 'https://oblimint-panel:8443' && l.siteId === null));
  assert.equal(m.accountId, 11);
  assert.equal(m.tenantId, 2);
  for (const v of vhosts) {
    validateVhost(v);
    const conf = renderVhost(v);
    assert.match(conf, /location \^~ \/\.well-known\/acme-challenge\//);
    assert.match(conf, /return 404;/);
    assert.equal(v.tls, null, 'no certificate yet: HTTP only');
  }
  const conf = renderVhost(m);
  assert.match(conf, /location = \/autodiscover\/autodiscover\.xml \{/);
  assert.match(conf, /location = \/Autodiscover\/Autodiscover\.xml \{/);
  assert.match(conf, /location = \/\.well-known\/mta-sts\.txt \{/);
  assert.ok(!/location \^~ \/ \{/.test(conf), 'never a catch-all route to the panel');
});

test('vhost names follow the options; taken, reserved and claimed names are dropped', () => {
  const v1 = planMailVhosts(input({ domains: [dom({ autoconfig: false, mtaSts: false })] }), ctx());
  assert.deepEqual(v1[1].serverNames, ['mail.exemple.fr']);
  const v2 = planMailVhosts(input({ taken: new Set(['mail.exemple.fr']) }), ctx([], [], ['autoconfig.exemple.fr', 'mail.host.net']));
  assert.deepEqual(v2.map((v) => v.id), ['m-7']);
  assert.deepEqual(v2[0].serverNames, ['autodiscover.exemple.fr', 'mta-sts.exemple.fr']);
  // A mail domain under the preview domain (platform name) gets nothing.
  const v3 = planMailVhosts(input({ host: null, domains: [dom({ name: 'x.preview.host.net' })] }), ctx());
  assert.deepEqual(v3, []);
});

test('TLS only with a VALID certificate whose files exist and that covers every name', () => {
  const names = ['mail.exemple.fr', 'autoconfig.exemple.fr', 'autodiscover.exemple.fr', 'mta-sts.exemple.fr', 'webmail.exemple.fr'];
  const cert = (primary: string, covered: string[], status: PlanCertificate['status'] = 'valid'): PlanCertificate =>
    ({ domain_id: null, site_id: null, primary_name: primary, status, names: JSON.stringify(covered) });
  const ok = planMailVhosts(input(), ctx([cert('mail.exemple.fr', names), cert('mail.host.net', ['mail.host.net'])], ['mail.exemple.fr', 'mail.host.net']));
  assert.equal(ok[1].tls?.certPath, '/etc/nginx/oblimint/certs/mail.exemple.fr/fullchain.pem');
  assert.equal(ok[0].tls?.keyPath, '/etc/nginx/oblimint/certs/mail.host.net/privkey.pem');
  ok.forEach(validateVhost);
  assert.match(renderVhost(ok[1]), /listen 443 ssl;/);
  assert.equal(planMailVhosts(input(), ctx([cert('mail.exemple.fr', names)], []))[1].tls, null, 'files missing');
  assert.equal(planMailVhosts(input(), ctx([cert('mail.exemple.fr', names, 'failed')], ['mail.exemple.fr']))[1].tls, null, 'not valid');
  assert.equal(planMailVhosts(input(), ctx([cert('mail.exemple.fr', ['mail.exemple.fr'])], ['mail.exemple.fr']))[1].tls, null, 'does not cover mta-sts');
  // A wildcard of the tenant covers them too.
  const wild = planMailVhosts(input(), ctx([cert('exemple.fr', ['exemple.fr', '*.exemple.fr'])], ['exemple.fr']));
  assert.equal(wild[1].tls?.certPath, '/etc/nginx/oblimint/certs/exemple.fr/fullchain.pem');
});

test('certificate wishes: one per active mail domain, webmail.<d> when served, DNS-01 when solvable, never a taken / non-public name', () => {
  const wishes = planMailCertificateWishes(input({ domains: [dom(), dom({ id: 8, name: 'autre.org', webmail: false, mtaSts: false, tenantId: 3, accountId: 12 })] }),
    (p) => p === 'mail.exemple.fr');
  assert.deepEqual(wishes, [
    { names: ['mail.exemple.fr', 'autoconfig.exemple.fr', 'autodiscover.exemple.fr', 'mta-sts.exemple.fr', 'webmail.exemple.fr'], preferDns01: true, tenantId: 2, accountId: 11 },
    { names: ['mail.autre.org', 'autoconfig.autre.org', 'autodiscover.autre.org'], preferDns01: false, tenantId: 3, accountId: 12 },
  ]);
  const taken = mailCertificateNames(dom(), { taken: new Set(['mail.exemple.fr', 'webmail.exemple.fr']), platform });
  assert.deepEqual(taken, ['autoconfig.exemple.fr', 'autodiscover.exemple.fr', 'mta-sts.exemple.fr']);
  assert.deepEqual(planMailCertificateWishes(input({ domains: [dom({ name: 'lab.test' })] }), () => true), [], '.test is not public');
  assert.deepEqual(planMailCertificateWishes(input({ domains: [] }), () => true), [], 'H comes from PlatformHosts.extra, not from a wish');
});
