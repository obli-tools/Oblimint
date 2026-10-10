import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';
import type { Request } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of module source-executor on a PGlite server
// (docs/P5-PLAN.md §15: source-executor = port 55481):
//   PG_PORT=55481 node <scratchpad>/pg/pgserver.mjs
// MIGRATION_SOURCE_TEST_DATABASE_URL overrides the URL. Skipped cleanly when
// nothing listens. Replays migrations 001–008. SSH is a fake connector (no
// network). Covers: CRUD with the sealed secret never returned, name 409,
// secret rules on update, host change → pin dropped, test (unpinned capture →
// pending key, pin / mismatch, match → whoami / version / os), the executor's
// pin rule (MG3), command log rows in the table (refusals included) and their
// pagination / filters, remove 409 sourceInUse, the HTTP routes.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.MIGRATION_SOURCE_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55481/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('migration sources on PostgreSQL (PGlite)', async (t) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55481)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  const express = (await import('express')).default;
  const { db } = await import('../../../db');
  const { errorHandler } = await import('../../../middleware/errorHandler');
  const routes = (await import('../../../routes/migrationSources.routes')).default;
  const { migrationSourcesService } = await import('./sources.service');
  const { sourceExecutor, setSshConnectorForTests } = await import('./executor');
  const { HostKeyRejectedError } = await import('./ssh');
  const { openJson } = await import('../../../utils/secretBox');
  const { generateEd25519 } = await import('../../monitoring/automation/sshKeys');
  const { SourceCommandRefusedError, SourceConnectionError } = await import('../contracts/source');

  await db.migrate.latest();
  t.after(async () => { setSshConnectorForTests(null); await db.destroy(); });

  const tenant1 = await db('tenants').where({ id: 1 }).first();
  if (!tenant1) await db('tenants').insert({ id: 1, name: 'Default', slug: 'default' });
  const adminId = Number((await db('users').insert({ username: 'mig-admin', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  const req = { session: { userId: adminId, currentTenantId: 1 }, tenantId: 1, headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1', query: {}, params: {}, body: {} } as unknown as Request;

  // ── fake SSH ──
  const FP = 'SHA256:' + 'A'.repeat(43);
  const FP2 = 'SHA256:' + 'B'.repeat(43);
  let presented = { algorithm: 'ssh-ed25519', fingerprint: FP };
  const commands: string[] = [];
  let connects = 0;
  const replies: Record<string, { stdout: string; code?: number }> = {
    'LC_ALL=C id -un': { stdout: 'root\n' },
    'LC_ALL=C cat /etc/os-release /etc/redhat-release': { stdout: 'NAME="Rocky Linux"\nPRETTY_NAME="Rocky Linux 8.10 (Green Obsidian)"\nRocky Linux release 8.10\n' },
  };
  setSshConnectorForTests(async (p) => {
    connects++;
    if (!p.pinnedFingerprint) throw new HostKeyRejectedError('hostKeyUnpinned', presented);
    if (p.pinnedFingerprint !== presented.fingerprint) throw new HostKeyRejectedError('hostKeyMismatch', presented);
    return {
      hostKey: presented,
      conn: {
        closed: false,
        close() { /* */ },
        async exec(command: string) {
          commands.push(command);
          const r = replies[command] ?? (command.includes('version.php')
            ? { stdout: '<?php\n$webpanel_version = "1.18";\n' }
            : { stdout: '', code: 1 });
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          setImmediate(() => { stdout.end(r.stdout); stderr.end(); });
          return { stdout, stderr, stdin: new PassThrough(), done: new Promise((res) => setTimeout(() => res({ code: r.code ?? 0, signal: null }), 5)), kill() { /* */ } };
        },
      },
    } as never;
  });

  await t.test('create: sealed secret, never returned; 409 nameTaken; secret rules', async () => {
    const s = await migrationSourcesService.create(req, { name: 'rin', host: '10.99.0.2', username: 'root', authMethod: 'password', password: 'S3cret-pw!' });
    assert.equal(s.hasSecret, true);
    assert.equal(s.port, 22);
    assert.equal(s.status, 'new');
    assert.equal(s.hostKey, null);
    const json = JSON.stringify(s);
    assert.ok(!json.includes('S3cret'));
    assert.ok(!('password' in s) && !('secret_sealed' in s));
    const row = await db('migration_sources').where({ id: s.id }).first();
    assert.match(row.secret_sealed, /^v1:/);
    assert.ok(!row.secret_sealed.includes('S3cret'));
    assert.deepEqual(openJson('migration-source', row.secret_sealed), { password: 'S3cret-pw!' });
    const audit = await db('audit_logs').where({ action: 'migration.source.create' }).first();
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit.details).includes('S3cret'));

    await assert.rejects(migrationSourcesService.create(req, { name: 'rin', host: 'x.example.tld', username: 'root', authMethod: 'password', password: 'p' }),
      (e: { statusCode?: number; code?: string }) => e.statusCode === 409 && e.code === 'nameTaken');
    await assert.rejects(migrationSourcesService.create(req, { name: 'k', host: 'x.example.tld', username: 'root', authMethod: 'key' }),
      (e: { code?: string }) => e.code === 'secretRequired');
    await assert.rejects(migrationSourcesService.create(req, { name: 'k', host: 'x.example.tld', username: 'root', authMethod: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\ngarbage\n-----END OPENSSH PRIVATE KEY-----\n' }),
      (e: { code?: string }) => e.code === 'invalidPrivateKey');
    const key = generateEd25519('test');
    const k = await migrationSourcesService.create(req, { name: 'keyed', host: 'cwp.example.tld', port: 2222, username: 'admin', authMethod: 'key', privateKey: key.privateKey, useSudo: true });
    assert.equal(k.authMethod, 'key');
    assert.equal(k.useSudo, true);
    assert.ok(!JSON.stringify(await migrationSourcesService.list()).includes('PRIVATE KEY'));
  });

  const rin = async () => (await migrationSourcesService.list()).find((s) => s.name === 'rin')!;

  await t.test('test: unpinned → key captured as pending, nothing runs; pin; match → whoami / os / version', async () => {
    const s = await rin();
    const before = commands.length;
    const r1 = await migrationSourcesService.test(req, s.id);
    assert.equal(r1.ok, false);
    assert.equal(r1.errorCode, 'hostKeyUnpinned');
    assert.equal(r1.hostKeyState, 'unpinned');
    assert.deepEqual(r1.hostKey, { algorithm: 'ssh-ed25519', fingerprint: FP });
    assert.equal(commands.length, before, 'no command before the key is pinned');
    const after1 = await migrationSourcesService.get(s.id);
    assert.deepEqual(after1.pendingHostKey, { algorithm: 'ssh-ed25519', fingerprint: FP });
    assert.equal(after1.status, 'new');

    // MG3: the executor refuses without even connecting.
    const n = connects;
    await assert.rejects(sourceExecutor.session(s.id, { phase: 'discovery' }), (e: unknown) => e instanceof SourceConnectionError && e.code === 'hostKeyUnpinned');
    assert.equal(connects, n);

    await assert.rejects(migrationSourcesService.pinHostKey(req, s.id, { fingerprint: FP2 }), (e: { code?: string }) => e.code === 'hostKeyMismatch');
    const pinned = await migrationSourcesService.pinHostKey(req, s.id, { fingerprint: FP });
    assert.deepEqual(pinned.hostKey, { algorithm: 'ssh-ed25519', fingerprint: FP });
    assert.equal(pinned.pendingHostKey, null);
    assert.ok(pinned.hostKeyPinnedAt);
    await assert.rejects(migrationSourcesService.pinHostKey(req, s.id, { fingerprint: FP }), (e: { code?: string }) => e.code === 'noPendingHostKey');
    assert.ok(await db('audit_logs').where({ action: 'migration.source.hostkey_pin' }).first());

    const r2 = await migrationSourcesService.test(req, s.id);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.hostKeyState, 'match');
    assert.equal(r2.remoteUser, 'root');
    assert.equal(r2.cwpVersion, '1.18');
    assert.equal(r2.osRelease, 'Rocky Linux 8.10 (Green Obsidian)');
    const ok = await migrationSourcesService.get(s.id);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.cwpVersion, '1.18');
    const rows = await db('migration_command_log').where({ source_id: s.id }).orderBy('id');
    assert.deepEqual(rows.map((r: { template: string; status: string }) => `${r.template}:${r.status}`), ['sys.whoami:ok', 'sys.osRelease:ok', 'fs.cat:ok']);

    // Key changed on the server → mismatch, stored pending, status error.
    presented = { algorithm: 'ssh-ed25519', fingerprint: FP2 };
    const r3 = await migrationSourcesService.test(req, s.id);
    assert.equal(r3.errorCode, 'hostKeyMismatch');
    assert.equal(r3.hostKeyState, 'mismatch');
    const mm = await migrationSourcesService.get(s.id);
    assert.equal(mm.status, 'error');
    assert.equal(mm.hostKey?.fingerprint, FP);
    assert.equal(mm.pendingHostKey?.fingerprint, FP2);
    await assert.rejects(sourceExecutor.session(s.id, { phase: 'discovery' }), (e: unknown) => e instanceof SourceConnectionError && e.code === 'hostKeyMismatch');
    presented = { algorithm: 'ssh-ed25519', fingerprint: FP };
  });

  await t.test('executor session: refusals land in migration_command_log', async () => {
    const s = await rin();
    const disc = Number((await db('migration_discoveries').insert({ source_id: s.id, status: 'done' }).returning('id'))[0].id);
    const session = await sourceExecutor.session(s.id, { phase: 'discovery', discoveryId: disc });
    await assert.rejects(session.run('secret.mailboxHashes', { domain: 'example.tld' }), SourceCommandRefusedError);
    await assert.rejects(session.run('fs.cat', { path: '/etc/shadow' }), SourceCommandRefusedError);
    await session.run('sys.whoami', {} as Record<string, never>);
    await session.close();
    const rows = await db('migration_command_log').where({ discovery_id: disc }).orderBy('id');
    assert.deepEqual(rows.map((r: { status: string }) => r.status), ['refused', 'refused', 'ok']);
    assert.equal(rows[0].sensitive, true);
    assert.equal(rows[0].command, '<invalid>');
    assert.equal(rows[2].command, 'LC_ALL=C id -un');
    await db('migration_discoveries').where({ id: disc }).delete();
  });

  await t.test('commands: pagination, newest first, filters', async () => {
    const s = await rin();
    const disc = Number((await db('migration_discoveries').insert({ source_id: s.id, status: 'done' }).returning('id'))[0].id);
    await db('migration_command_log').insert(Array.from({ length: 30 }, (_, i) => ({
      source_id: s.id, discovery_id: i % 2 ? disc : null, template: 'sys.hostname', command: `cmd ${i}`, phase: 'discovery',
      sensitive: false, status: i % 3 === 0 ? 'refused' : 'ok', bytes_out: i,
    })));
    const all = await migrationSourcesService.commands(s.id, { limit: 10, offset: 0 });
    assert.ok(all.total >= 30);
    assert.equal(all.items.length, 10);
    assert.equal(all.items[0].command, 'cmd 29');
    assert.ok(all.items[0].id > all.items[1].id);
    const page2 = await migrationSourcesService.commands(s.id, { limit: 10, offset: 10 });
    assert.equal(page2.items[0].command, 'cmd 19');
    const refusedOnly = await migrationSourcesService.commands(s.id, { limit: 500, offset: 0, status: 'refused' });
    assert.ok(refusedOnly.items.every((i) => i.status === 'refused'));
    const byDisc = await migrationSourcesService.commands(s.id, { limit: 500, offset: 0, discoveryId: disc });
    assert.equal(byDisc.total, 15);
    assert.equal(typeof byDisc.items[0].bytesOut, 'number');
  });

  await t.test('update: secret kept when omitted, method change needs its secret, host change drops the pin', async () => {
    const s = await rin();
    const u1 = await migrationSourcesService.update(req, s.id, { name: 'rin-prod', useSudo: false });
    assert.equal(u1.name, 'rin-prod');
    let row = await db('migration_sources').where({ id: s.id }).first();
    assert.deepEqual(openJson('migration-source', row.secret_sealed), { password: 'S3cret-pw!' });
    assert.equal(u1.hostKey?.fingerprint, FP, 'name change keeps the pin');
    await assert.rejects(migrationSourcesService.update(req, s.id, { authMethod: 'key' }), (e: { code?: string }) => e.code === 'secretRequired');
    await migrationSourcesService.update(req, s.id, { password: 'new-pw' });
    row = await db('migration_sources').where({ id: s.id }).first();
    assert.deepEqual(openJson('migration-source', row.secret_sealed), { password: 'new-pw' });
    const u2 = await migrationSourcesService.update(req, s.id, { port: 2022 });
    assert.equal(u2.hostKey, null);
    assert.equal(u2.pendingHostKey, null);
    assert.equal(u2.status, 'new');
    const audit = await db('audit_logs').where({ action: 'migration.source.update' }).orderBy('id', 'desc').first();
    assert.ok(!JSON.stringify(audit.details).includes('new-pw'));
    await assert.rejects(migrationSourcesService.update(req, s.id, { name: 'keyed' }), (e: { code?: string }) => e.code === 'nameTaken');
  });

  await t.test('remove: 409 sourceInUse while in use, then deleted (cascade)', async () => {
    const s = (await migrationSourcesService.list()).find((x) => x.name === 'rin-prod')!;
    const disc = Number((await db('migration_discoveries').insert({ source_id: s.id, status: 'running' }).returning('id'))[0].id);
    await assert.rejects(migrationSourcesService.remove(req, s.id), (e: { statusCode?: number; code?: string }) => e.statusCode === 409 && e.code === 'sourceInUse');
    await db('migration_discoveries').where({ id: disc }).update({ status: 'done' });
    const planId = Number((await db('migration_plans').insert({ source_id: s.id, discovery_id: disc, name: 'p', choices: JSON.stringify({}), choices_hash: 'h' }).returning('id'))[0].id);
    await assert.rejects(migrationSourcesService.remove(req, s.id), (e: { code?: string }) => e.code === 'sourceInUse');
    const runId = Number((await db('migration_runs').insert({
      plan_id: planId, source_id: s.id, cwp_username: 'acct1', kind: 'initial', status: 'running', target_tenant_id: 1,
    }).returning('id'))[0].id);
    await db('migration_plans').where({ id: planId }).update({ status: 'archived' });
    await assert.rejects(migrationSourcesService.remove(req, s.id), (e: { code?: string }) => e.code === 'sourceInUse');
    await db('migration_runs').where({ id: runId }).update({ status: 'done' });
    await db('migration_run_steps').insert({ run_id: runId, key: 'k', provider: 'web-db', phase: 1, position: 1, label: JSON.stringify({ key: 'x' }) });
    // An archived plan WITH a finished run (RESTRICT on runs.plan_id): removed in order.
    await migrationSourcesService.remove(req, s.id);
    assert.equal(await db('migration_runs').where({ id: runId }).first(), undefined);
    assert.equal(await db('migration_sources').where({ id: s.id }).first(), undefined);
    assert.equal(Number((await db('migration_command_log').where({ source_id: s.id }).count('* as c'))[0].c), 0);
    await assert.rejects(migrationSourcesService.get(s.id), (e: { statusCode?: number }) => e.statusCode === 404);
  });

  await t.test('HTTP routes: validation, envelopes, no secret, allow-list', async (tt) => {
    const app = express();
    app.use(express.json());
    app.use((r, _res, next) => { Object.assign(r, { session: { userId: adminId, currentTenantId: 1 }, tenantId: 1 }); next(); });
    app.use('/api/system/migration', routes);
    app.use(errorHandler);
    const server = app.listen(0);
    tt.after(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system/migration`;
    const call = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string } };
    };
    const created = await call('POST', '/sources', { name: 'http', host: '2001:db8::10', username: 'root', authMethod: 'password', password: 'pw-http' });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.hasSecret, true);
    assert.ok(!JSON.stringify(created.body).includes('pw-http'));
    for (const bad of [
      { name: 'x', host: 'http://x', username: 'root', authMethod: 'password', password: 'p' },
      { name: 'x', host: 'a b', username: 'root', authMethod: 'password', password: 'p' },
      { name: 'x', host: 'h', username: 'Root', authMethod: 'password', password: 'p' },
      { name: 'x', host: 'h', username: 'root', authMethod: 'token', password: 'p' },
      { name: 'x', host: 'h', username: 'root', authMethod: 'password', password: 'p', port: 70000 },
      { name: 'x', host: 'h', username: 'root', authMethod: 'key', privateKey: 'not a key' },
      { name: 'x', host: 'h', username: 'root', authMethod: 'password', password: 'p', extra: 1 },
      { name: '', host: 'h', username: 'root', authMethod: 'password', password: 'p' },
    ]) {
      const r = await call('POST', '/sources', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.code, 'validation');
    }
    const id = created.body.data.id;
    assert.equal((await call('GET', `/sources/${id}`)).body.data.name, 'http');
    assert.equal((await call('GET', '/sources/999999')).status, 404);
    assert.equal((await call('PUT', `/sources/${id}`, { bogus: true })).status, 400);
    assert.equal((await call('POST', `/sources/${id}/host-key`, { fingerprint: 'md5:xx' })).status, 400);
    assert.equal((await call('POST', `/sources/${id}/host-key`, { fingerprint: FP })).body.code, 'noPendingHostKey');
    const test1 = await call('POST', `/sources/${id}/test`);
    assert.equal(test1.status, 200);
    assert.equal(test1.body.data.errorCode, 'hostKeyUnpinned');
    assert.equal((await call('GET', `/sources/${id}/commands?status=bogus`)).status, 400);
    assert.equal((await call('GET', `/sources/${id}/commands?limit=0`)).status, 400);
    const cmds = await call('GET', `/sources/${id}/commands?limit=5`);
    assert.deepEqual(cmds.body.data, { items: [], total: 0 });
    const allow = await call('GET', '/allowlist');
    assert.equal(allow.body.data.length, 31);
    assert.ok(!allow.body.data.some((x: { id: string }) => x.id === 'rsync.sender'));
    assert.deepEqual((await call('DELETE', `/sources/${id}`)).body, { success: true, data: { deleted: true } });
  });
});
