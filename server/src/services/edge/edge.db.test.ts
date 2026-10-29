import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import selfsigned from 'selfsigned';
import { createPrivateKey } from 'crypto';
import type * as acme from 'acme-client';

// Integration test of the DB side of the edge module (queries of buildVhosts,
// certificate rows, renewal pass) against the PGlite harness. Opt-in:
//   PG_PORT=55435 node <scratchpad>/pg/pgserver.mjs
//   EDGE_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55435/postgres \
//     npx tsx --test src/services/edge/edge.db.test.ts
// No Docker (fake engine: edge "not running"), no network (fake ACME client).

const url = process.env.EDGE_TEST_DATABASE_URL;

test('edge DB integration (buildVhosts, certificate issuance + renewal pass)', { skip: !url && 'EDGE_TEST_DATABASE_URL not set' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-edge-db-'));
  process.env.DATABASE_URL = url;
  process.env.OBLIMINT_DATA_DIR = root;
  const { db } = await import('../../db');
  t.after(async () => {
    await db.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await db.migrate.latest();

  const engine = await import('../docker/engine');
  const notFound = Object.assign(new Error('no such container'), { statusCode: 404 });
  engine.setEngineFactoryForTests(() => ({ getContainer: () => ({ inspect: async () => { throw notFound; } }) }) as never, 1);
  t.after(() => engine.setEngineFactoryForTests(null));

  const { edgeService } = await import('./edge.service');
  const { certificateService } = await import('./certificate.service');
  const { localPaths } = await import('../hosting/paths');

  // ── seed ──
  await db('app_config').insert([
    { key: 'panel_hostname', value: 'panel.host.example' },
    { key: 'acme_email', value: 'ops@host.example' },
    // P2: previews on the dedicated preview domain (platform settings seed, non-public TLD: never sent to the CA).
    { key: 'preview_domain', value: 'previews.host.example' },
  ]).onConflict('key').merge();
  (await import('../platformSettings')).platformSettings.invalidate();
  const [plan] = await db('plans').insert({ tenant_id: 1, name: 'Edge plan', limits: JSON.stringify({}) }).returning('id');
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: 1, node_id: 1, plan_id: plan.id, username: 'edgeacct', uid: 41000, gid: 41000, status: 'active',
  }).returning('id');
  const [gone] = await db('hosting_accounts').insert({
    tenant_id: 1, node_id: 1, plan_id: plan.id, username: 'edgegone', uid: 41001, gid: 41001, status: 'deleting',
  }).returning('id');
  const [site] = await db('sites').insert({
    tenant_id: 1, account_id: acct.id, name: 'Main', slug: 'main', base: 'php-8.3', preview_base: 'php-8.4',
    php_settings: JSON.stringify({ postMaxSizeMb: 2048 }),
  }).returning('id');
  const [goneSite] = await db('sites').insert({ tenant_id: 1, account_id: gone.id, name: 'Gone', slug: 'gone', base: 'php-8.3' }).returning('id');
  // P2: ownership verified (an unverified domain is a placeholder without certificate, D1).
  const verified = { verification_status: 'verified', verification_method: 'admin' };
  const [dom] = await db('domains').insert({
    tenant_id: 1, account_id: acct.id, name: 'example.com', include_www: true, tls_mode: 'letsencrypt', force_https: true, ...verified,
  }).returning('id');
  const [goneDom] = await db('domains').insert({ tenant_id: 1, account_id: gone.id, name: 'gone.example', ...verified }).returning('id');
  await db('site_routes').insert([
    { account_id: acct.id, domain_id: dom.id, path_prefix: '/', site_id: site.id },
    { account_id: gone.id, domain_id: goneDom.id, path_prefix: '/', site_id: goneSite.id },
  ]);

  // ── buildVhosts ──
  const vhosts = await edgeService.buildVhosts();
  const ids = vhosts.map((v) => v.id);
  assert.deepEqual(ids, ['panel', `p-${site.id}`, `d-${dom.id}`]);
  const d = vhosts.find((v) => v.id === `d-${dom.id}`)!;
  assert.deepEqual(d.serverNames, ['example.com', 'www.example.com']);
  assert.equal(d.tls, null);
  assert.deepEqual(vhosts.find((v) => v.id === `p-${site.id}`)?.serverNames, [`main-${site.id}.previews.host.example`]);
  assert.equal(d.clientMaxBodyMb, 2048);

  // ── sync without an edge container: files written, error kept ──
  const sync = await edgeService.syncNow();
  assert.equal(sync.ok, false);
  assert.equal(sync.error, 'edge not running');
  assert.deepEqual(fs.readdirSync(localPaths.edgeConfD()).sort(), [`d-${dom.id}.conf`, `p-${site.id}.conf`, 'panel.conf']);
  const status = await edgeService.status();
  assert.equal(status.running, false);
  assert.equal(status.lastSyncError, 'edge not running');
  assert.equal(status.vhostCount, 3);

  // ── settings ──
  await edgeService.setAcmeDirectory('staging');
  assert.equal(await edgeService.acmeDirectory(), 'staging');

  // ── issuance with a fake ACME client ──
  const names = ['example.com', 'www.example.com'];
  const pems = selfsigned.generate([{ name: 'commonName', value: names[0] }], {
    days: 90, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }],
  });
  const key = createPrivateKey(pems.private).export({ type: 'pkcs8', format: 'pem' }).toString();
  let fail = false;
  certificateService._setDeps({
    selfTest: undefined,
    // The certificate key must match the fake certificate.
    createCertificateKey: async () => key,
    createClient: () => ({
      async createAccount() { return {}; },
      async createOrder() { return { url: 'o' } as unknown as acme.Order; },
      async getAuthorizations() { return [] as acme.Authorization[]; },
      async getChallengeKeyAuthorization() { return 'ka'; },
      async completeChallenge() { return {}; },
      async waitForValidStatus(item) { return item; },
      async finalizeOrder(o) { if (fail) throw new Error('rate limited'); return o; },
      async getCertificate() { return pems.cert; },
    }),
  });

  const detail = await certificateService.request(dom.id);
  assert.equal(detail.status, 'valid', detail.lastError ?? '');
  assert.equal(detail.issuer, 'letsencrypt-staging');
  assert.deepEqual(detail.names, names);
  assert.ok(detail.notAfter && new Date(detail.notAfter).getTime() > Date.now() + 80 * 24 * 3600_000);
  assert.ok(detail.log.some((l) => l.message.includes('Certificate installed')));
  assert.ok(fs.existsSync(path.join(localPaths.edgeCerts(), 'example.com', 'privkey.pem')));

  const withTls = (await edgeService.buildVhosts()).find((v) => v.id === `d-${dom.id}`)!;
  assert.ok(withTls.tls, 'valid cert + files → tls');

  // No panel / preview issuance from here on (the fake certificate only covers example.com).
  await db('app_config').where({ key: 'panel_hostname' }).del();

  // ── renewal failure keeps the still-valid certificate served + alerts ──
  await db('certificates').where({ domain_id: dom.id }).update({ not_after: new Date(Date.now() + 5 * 24 * 3600_000) });
  fail = true;
  await certificateService.checkRenewals();
  const afterFail = await certificateService.getForDomain(dom.id);
  assert.equal(afterFail?.status, 'valid');
  assert.match(afterFail?.lastError ?? '', /rate limited/);
  assert.ok(afterFail?.log.some((l) => l.message.includes('rate limited')), 'the staff log keeps the raw detail');
  // A6: a client user gets the categorised sentence, never the raw text (log included).
  const clientView = await certificateService.getForDomain(dom.id, 'client');
  assert.match(clientView?.lastError ?? '', /Let's Encrypt rate limit reached/);
  assert.ok(clientView?.log.some((l) => l.message.startsWith('FAILED: ')), 'the client log still says it failed');
  assert.ok(!clientView?.log.some((l) => l.message.includes('rate limited')), 'no raw text in the client log');
  const row = await db('certificates').where({ domain_id: dom.id }).first();
  assert.equal(row.failure_count, 1);
  const alert = await db('audit_logs').where({ action: 'certificate.renewal_failed', tenant_id: 1 }).first();
  assert.ok(alert, 'renewal_failed audited in the tenant of the domain');
  assert.equal(alert.resource_path, String(dom.id));

  // Backoff: the next pass does not retry.
  const attemptsBefore = row.last_attempt_at;
  await certificateService.checkRenewals();
  const row2 = await db('certificates').where({ domain_id: dom.id }).first();
  assert.equal(new Date(row2.last_attempt_at).getTime(), new Date(attemptsBefore).getTime());

  // ── the tenant-visible log never carries the platform-wide nginx output ──
  assert.ok(!afterFail?.log.some((l) => l.message.includes('edge not running')), 'raw sync error not in the certificate log');

  // ── adding www fails: the still-valid row keeps the names its cert covers ──
  const far = new Date(Date.now() + 60 * 24 * 3600_000);
  await db('certificates').where({ domain_id: dom.id }).update({
    names: JSON.stringify(['example.com']), status: 'valid', not_after: far, failure_count: 0, last_attempt_at: null,
  });
  const wwwFail = await certificateService.request(dom.id);
  assert.equal(wwwFail.status, 'valid');
  assert.deepEqual(wwwFail.names, ['example.com'], 'old names kept until the new cert is installed');
  const rowW = await db('certificates').where({ domain_id: dom.id }).first();
  assert.equal(rowW.failure_count, 1);
  // The renewal pass retries it once the backoff is over (not before).
  const lastW = new Date(rowW.last_attempt_at).getTime();
  await certificateService.checkRenewals();
  assert.equal(new Date((await db('certificates').where({ domain_id: dom.id }).first()).last_attempt_at).getTime(), lastW);
  await db('certificates').where({ domain_id: dom.id }).update({ last_attempt_at: new Date(Date.now() - 7 * 3600_000) });
  fail = false;
  await certificateService.checkRenewals();
  const fixed = await certificateService.getForDomain(dom.id);
  assert.deepEqual(fixed?.names, names, 'renewal pass added www');
  assert.equal(fixed?.status, 'valid');

  // ── a failing certificate contributor never gets its platform rows swept ──
  {
    const contributors = await import('./contributors');
    let mode: 'wish' | 'throw' | 'none' = 'throw';
    contributors.registerEdgeContributor({
      id: 'mail-test',
      certificates: async () => {
        if (mode === 'throw') throw new Error('pool acquire timeout');
        return mode === 'wish' ? [{ names: ['mail.shop-contrib.com'], preferDns01: false, tenantId: 1, accountId: null }] : [];
      },
    });
    t.after(() => contributors.clearEdgeContributorsForTests());
    await db('certificates').insert({
      primary_name: 'mail.shop-contrib.com', names: JSON.stringify(['mail.shop-contrib.com']), status: 'valid', issuer: 'letsencrypt-staging',
      not_before: new Date(), not_after: new Date(Date.now() + 60 * 24 * 3600_000),
    });
    const exists = async () => !!(await db('certificates').where({ primary_name: 'mail.shop-contrib.com' }).first());
    await certificateService.checkRenewals();
    assert.ok(await exists(), 'contributor failed ⇒ its rows kept this pass');
    mode = 'wish';
    await certificateService.checkRenewals();
    assert.ok(await exists(), 'still wished ⇒ kept');
    mode = 'none';
    await certificateService.checkRenewals();
    assert.ok(!(await exists()), 'no longer wished (contributor answered) ⇒ swept');
    contributors.clearEdgeContributorsForTests();
  }

  // ── manual renew rate limits ──
  const { AppError } = await import('../../middleware/errorHandler');
  const codeOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? `${e.statusCode}:${e.code}` : String(e); } };
  // Cooldown right after an attempt (everyone).
  assert.equal(await codeOf(certificateService.startRequest(dom.id, { force: true, staff: true })), '429:certificateRateLimited');
  await db('certificates').where({ domain_id: dom.id }).update({ last_attempt_at: new Date(Date.now() - 3600_000) });
  // Valid, covers the names, far from expiry: client force refused, plain request is a no-op.
  assert.equal(await codeOf(certificateService.startRequest(dom.id, { force: true })), '409:certificateNotDue');
  assert.equal(await codeOf(certificateService.startRequest(dom.id)), null);
  assert.equal(new Date((await db('certificates').where({ domain_id: dom.id }).first()).last_attempt_at).getTime() < Date.now() - 3000_000, true, 'nothing queued');
  // Failure backoff: clients wait, staff may retry.
  await db('certificates').where({ domain_id: dom.id }).update({ status: 'failed', failure_count: 2 });
  assert.equal(await codeOf(certificateService.startRequest(dom.id)), '429:certificateRateLimited');
  assert.equal(await codeOf(certificateService.startRequest(dom.id, { staff: true })), null);
  await certificateService.request(dom.id); // waits for the queued attempt
  assert.equal((await certificateService.getForDomain(dom.id))?.status, 'valid');

  // ── a hung ACME call: the overall deadline records a failure and frees the serial queue ──
  certificateService._setDeps({
    deadlineMs: 300,
    createClient: () => ({
      async createAccount() { return {}; },
      async createOrder() { return { url: 'o' } as unknown as acme.Order; },
      async getAuthorizations() { return [] as acme.Authorization[]; },
      async getChallengeKeyAuthorization() { return 'ka'; },
      async completeChallenge() { return {}; },
      async waitForValidStatus(item) { return item; },
      finalizeOrder: () => new Promise<acme.Order>(() => { /* never settles (dropped TCP connection) */ }),
      async getCertificate() { return pems.cert; },
    }),
  });
  await db('certificates').where({ domain_id: dom.id }).update({ status: 'failed', failure_count: 0, last_attempt_at: null });
  const hung = await certificateService.request(dom.id, { force: true });
  assert.equal(hung.status, 'failed');
  assert.match(hung.lastError ?? '', /timed out/);
  certificateService._setDeps({
    deadlineMs: 10 * 60_000,
    createClient: () => ({
      async createAccount() { return {}; },
      async createOrder() { return { url: 'o' } as unknown as acme.Order; },
      async getAuthorizations() { return [] as acme.Authorization[]; },
      async getChallengeKeyAuthorization() { return 'ka'; },
      async completeChallenge() { return {}; },
      async waitForValidStatus(item) { return item; },
      async finalizeOrder(o) { return o; },
      async getCertificate() { return pems.cert; },
    }),
  });
  assert.equal((await certificateService.request(dom.id, { force: true })).status, 'valid', 'the queue moved on');

  // ── HTTP-01 impossible (port 80 unreachable) + zone on our PowerDNS: ONE new order solved by DNS-01 ──
  const { dns01Provider } = await import('../dns/acmeChallenge');
  const seenChallenges: string[] = [];
  let orderCount = 0;
  let solvable = true;
  const dnsCalls: string[] = [];
  certificateService._setDeps({
    dns01: {
      canSolve: async () => solvable,
      setChallenge: async (n: string) => { dnsCalls.push(`set:${n}`); },
      removeChallenge: async (n: string) => { dnsCalls.push(`remove:${n}`); },
    },
    createClient: () => ({
      async createAccount() { return {}; },
      async createOrder() { orderCount++; return { url: 'o' } as unknown as acme.Order; },
      async getAuthorizations() {
        return names.map((value, i) => ({
          url: `a${i}`, status: 'pending', identifier: { type: 'dns', value },
          challenges: [
            { type: 'http-01', url: `h${i}`, token: `httpTOKEN_${i}_000000`, status: 'pending' },
            { type: 'dns-01', url: `d${i}`, token: `dnsTOKEN_${i}_0000000`, status: 'pending' },
          ],
        })) as unknown as acme.Authorization[];
      },
      async getChallengeKeyAuthorization() { return 'ka'; },
      async completeChallenge(c) {
        seenChallenges.push((c as { type: string }).type);
        if ((c as { type: string }).type === 'http-01') throw new Error('Timeout during connect (likely firewall problem)');
        return {};
      },
      async waitForValidStatus(item) { return item; },
      async finalizeOrder(o) { return o; },
      async getCertificate() { return pems.cert; },
    }),
  });
  await db('certificates').where({ domain_id: dom.id }).update({ status: 'failed', failure_count: 0, last_attempt_at: null });
  const viaDns = await certificateService.request(dom.id, { force: true });
  assert.equal(viaDns.status, 'valid', viaDns.lastError ?? '');
  assert.equal(orderCount, 2, 'a second order after the HTTP-01 failure');
  assert.deepEqual(seenChallenges, ['http-01', 'dns-01', 'dns-01']);
  assert.deepEqual(dnsCalls, ['set:example.com', 'remove:example.com', 'set:www.example.com', 'remove:www.example.com']);
  assert.ok(viaDns.log.some((l) => l.message.includes('retrying with DNS-01')));
  // Zone not on our DNS: no retry, the HTTP-01 failure is recorded.
  solvable = false;
  orderCount = 0;
  seenChallenges.length = 0;
  await db('certificates').where({ domain_id: dom.id }).update({ status: 'failed', failure_count: 0, last_attempt_at: null });
  const noDns = await certificateService.request(dom.id, { force: true });
  assert.equal(noDns.status, 'failed');
  assert.equal(orderCount, 1);
  assert.deepEqual(seenChallenges, ['http-01']);
  certificateService._setDeps({
    dns01: dns01Provider,
    createClient: () => ({
      async createAccount() { return {}; },
      async createOrder() { return { url: 'o' } as unknown as acme.Order; },
      async getAuthorizations() { return [] as acme.Authorization[]; },
      async getChallengeKeyAuthorization() { return 'ka'; },
      async completeChallenge() { return {}; },
      async waitForValidStatus(item) { return item; },
      async finalizeOrder(o) { return o; },
      async getCertificate() { return pems.cert; },
    }),
  });
  assert.equal((await certificateService.request(dom.id, { force: true })).status, 'valid');

  // ── explicit requests: one error code per reason (never a false "suspended") ──
  const [offDom] = await db('domains').insert({ tenant_id: 1, account_id: acct.id, name: 'notls.example', tls_mode: 'none', ...verified }).returning('id');
  assert.equal(await codeOf(certificateService.startRequest(offDom.id)), '409:tlsDisabled');
  const [goneLe] = await db('domains').insert({ tenant_id: 1, account_id: gone.id, name: 'gone-le.example', tls_mode: 'letsencrypt', ...verified }).returning('id');
  assert.equal(await codeOf(certificateService.startRequest(goneLe.id)), '409:accountDeleting');
  await db('app_config').insert({ key: 'panel_hostname', value: 'panel.host.example' }).onConflict('key').merge();
  const [reserved] = await db('domains').insert({ tenant_id: 1, account_id: acct.id, name: 'x.preview.panel.host.example', tls_mode: 'letsencrypt', ...verified }).returning('id');
  assert.equal(await codeOf(certificateService.startRequest(reserved.id)), '409:domainReserved');
  const [onPreview] = await db('domains').insert({ tenant_id: 1, account_id: acct.id, name: 'shop-1.previews.host.example', tls_mode: 'letsencrypt', ...verified }).returning('id');
  assert.equal(await codeOf(certificateService.startRequest(onPreview.id)), '409:domainReserved');
  // D1: an unverified domain never gets a certificate.
  const [pendingDom] = await db('domains').insert({ tenant_id: 1, account_id: acct.id, name: 'pending.example.org', tls_mode: 'letsencrypt' }).returning('id');
  assert.equal(await codeOf(certificateService.startRequest(pendingDom.id)), '409:domainNotVerified');
  assert.equal(await db('certificates').where({ domain_id: pendingDom.id }).first('id'), undefined);
  // A non-public panel name: no ACME order for it nor its preview hosts (no row created).
  certificateService.ensureAuxiliary();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await db('certificates').whereNull('domain_id').first('id'), undefined, 'no panel / preview row for panel.host.example');
  await db('app_config').where({ key: 'panel_hostname' }).del();
  // Reserved / private TLD of a tenant domain: refused before the CA is contacted.
  const [lab] = await db('domains').insert({ tenant_id: 1, account_id: acct.id, name: 'shop.lab.test', tls_mode: 'letsencrypt', ...verified }).returning('id');
  assert.equal(await codeOf(certificateService.startRequest(lab.id)), '409:certificateNameNotPublic');
  assert.equal(await db('certificates').where({ domain_id: lab.id }).first('id'), undefined);
  await db('domains').whereIn('id', [offDom.id, goneLe.id, reserved.id, onPreview.id, pendingDom.id, lab.id]).del();
  assert.equal(await codeOf(certificateService.startRequest(999_999)), '404:notFound');

  // ── platform host names (Settings → platform certificates): state, « retry now », short first retries ──
  {
    const settled: string[] = [];
    certificateService._setDeps({ settleDns: async () => { settled.push('dns'); } });
    await db('app_config').insert({ key: 'client_panel_hostname', value: 'space.example.com' }).onConflict('key').merge();
    const itemOf = async () => (await certificateService.listPlatform()).items.find((i) => i.host === 'space.example.com');
    const fresh = await itemOf();
    assert.ok(fresh, 'client space host listed');
    assert.deepEqual(fresh.roles, ['clientPanel']);
    assert.equal(fresh.certificateId, null);
    assert.equal(fresh.usable, false);
    assert.equal(fresh.blocked, null);
    assert.equal((await certificateService.listPlatform()).items.some((i) => i.host === 'previews.host.example'), false, 'no wildcard setting: preview domain not listed');

    // The fake certificate does not cover the name: failure recorded, retried 10 min later (not 6 h).
    const queued = await certificateService.retryPlatform('Space.Example.com.');
    assert.equal(queued.host, 'space.example.com');
    await certificateService._whenIdle();
    const failed = (await itemOf())!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCount, 1);
    assert.equal(failed.usable, false);
    assert.match(failed.lastError ?? '', /does not cover/);
    assert.deepEqual(settled, ['dns'], 'a platform issuance waits for the pending DNS push');
    assert.equal(new Date(failed.nextAttemptAt!).getTime() - new Date(failed.lastAttemptAt!).getTime(), 10 * 60_000);
    assert.ok(failed.retryAvailableAt, 'cooldown shown');
    assert.equal(await codeOf(certificateService.retryPlatform('space.example.com')), '429:certificateRateLimited');

    // « Retry now » resets the backoff: 3 failures before → 1 after one more failed attempt.
    await db('certificates').where({ primary_name: 'space.example.com' }).update({ last_attempt_at: new Date(Date.now() - 5 * 60_000), failure_count: 3 });
    await certificateService.retryPlatform('space.example.com');
    await certificateService._whenIdle();
    assert.equal(Number((await db('certificates').where({ primary_name: 'space.example.com' }).first()).failure_count), 1);

    // DNS fixed (the certificate covers the name now): issued, served, audited.
    const spacePems = selfsigned.generate([{ name: 'commonName', value: 'space.example.com' }], {
      days: 90, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'space.example.com' }] }],
    });
    const spaceKey = createPrivateKey(spacePems.private).export({ type: 'pkcs8', format: 'pem' }).toString();
    certificateService._setDeps({
      createCertificateKey: async () => spaceKey,
      createClient: () => ({
        async createAccount() { return {}; },
        async createOrder() { return { url: 'o' } as unknown as acme.Order; },
        async getAuthorizations() { return [] as acme.Authorization[]; },
        async getChallengeKeyAuthorization() { return 'ka'; },
        async completeChallenge() { return {}; },
        async waitForValidStatus(item) { return item; },
        async finalizeOrder(o) { return o; },
        async getCertificate() { return spacePems.cert; },
      }),
    });
    await db('certificates').where({ primary_name: 'space.example.com' }).update({ last_attempt_at: new Date(Date.now() - 5 * 60_000) });
    await certificateService.retryPlatform('space.example.com');
    await certificateService._whenIdle();
    const ok = (await itemOf())!;
    assert.equal(ok.status, 'valid', ok.lastError ?? '');
    assert.equal(ok.usable, true);
    assert.equal(ok.failureCount, 0);
    assert.equal(ok.lastError, null);
    assert.equal(ok.issuer, 'letsencrypt-staging');
    assert.ok(ok.nextAttemptAt && new Date(ok.nextAttemptAt).getTime() > Date.now() + 50 * 24 * 3600_000, 'next attempt = renewal window');
    assert.ok(fs.existsSync(path.join(localPaths.edgeCerts(), 'space.example.com', 'fullchain.pem')));
    const issuedAudit = await db('audit_logs').where({ action: 'certificate.issued' }).whereRaw('details::text like ?', ['%space.example.com%']).first();
    assert.ok(issuedAudit, 'issuance audited');
    // Served and far from expiry: no pointless order. Unknown host: 404.
    await db('certificates').where({ primary_name: 'space.example.com' }).update({ last_attempt_at: new Date(Date.now() - 5 * 60_000) });
    assert.equal(await codeOf(certificateService.retryPlatform('space.example.com')), '409:certificateNotDue');
    assert.equal(await codeOf(certificateService.retryPlatform('unknown.example.com')), '404:notFound');

    // Host name removed from the settings: no longer listed, row swept by the renewal pass.
    await db('app_config').where({ key: 'client_panel_hostname' }).del();
    assert.equal((await itemOf()), undefined);
    await certificateService.checkRenewals();
    assert.equal(await db('certificates').where({ primary_name: 'space.example.com' }).first('id'), undefined);
  }

  // ── removal ──
  await certificateService.removeForDomain(dom.id);
  assert.equal(await certificateService.getForDomain(dom.id), null);
  assert.equal(fs.existsSync(path.join(localPaths.edgeCerts(), 'example.com')), false);
  edgeService.stop();
});
