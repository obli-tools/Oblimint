import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { applyRender, readManifest, reloadPartOf, type ApplyDeps, type ReloadPart } from './apply';
import { RSPAMD_WATCHED_MAPS } from './confRspamd';
import { renderConfig } from './render';
import { baseState, box, CTX, tempDir } from './testUtil';

// File application: atomic rewrite of what changed, stale files, DKIM keys, manifest, crash recovery.

function deps(root: string, parts: Array<Set<ReloadPart>>): ApplyDeps {
  return {
    configDir: path.join(root, 'config'),
    dkimDir: path.join(root, 'dkim'),
    setOwners: false,
    reload: async (p) => { parts.push(new Set(p)); },
    now: () => new Date('2026-10-09T12:00:00Z'),
  };
}

test('apply: stale Sieve scripts and DKIM keys removed after success, foreign files kept', async (t) => {
  const root = tempDir(t);
  const parts: Array<Set<ReloadPart>> = [];
  const d = deps(root, parts);
  await applyRender(renderConfig(baseState(), CTX), d);
  assert.ok(fs.existsSync(path.join(d.configDir, 'sieve/104.sieve')));
  fs.writeFileSync(path.join(d.dkimDir, 'README'), 'not ours');
  const s = baseState();
  s.mailboxes[3].autoresponder = null;
  s.dkim[0].signing = false;
  s.dkim[1].signing = true;
  await applyRender(renderConfig(s, CTX), d);
  assert.equal(fs.existsSync(path.join(d.configDir, 'sieve/104.sieve')), false);
  assert.equal(fs.existsSync(path.join(d.dkimDir, 'exemple.fr/om202610.key')), false);
  assert.equal(fs.existsSync(path.join(d.dkimDir, 'exemple.fr/om202611.key')), true);
  assert.equal(fs.existsSync(path.join(d.dkimDir, 'README')), true);
  assert.deepEqual([...parts[1]].sort(), ['engine', 'rspamd']);
  assert.equal(fs.readdirSync(d.configDir, { recursive: true } as never).filter((f: unknown) => String(f).endsWith('.tmp')).length, 0);
});

test('apply: files on disk but never confirmed (crash before the manifest) ⇒ everything reloaded', async (t) => {
  const root = tempDir(t);
  const parts: Array<Set<ReloadPart>> = [];
  const d = deps(root, parts);
  const out = renderConfig(baseState(), CTX);
  await applyRender(out, d);
  fs.unlinkSync(path.join(d.configDir, 'manifest.json'));
  const res = await applyRender(out, d);
  assert.equal(res.changed, true);
  assert.deepEqual(res.parts, ['engine', 'rspamd']);
  assert.equal(readManifest(d.configDir)?.fingerprint, out.fingerprint);
  assert.equal(readManifest(path.join(root, 'nope')), null);
  fs.writeFileSync(path.join(d.configDir, 'manifest.json'), '{"version":2}');
  assert.equal(readManifest(d.configDir), null, 'unknown manifest = none');
});

test('apply: password files and keys get restrictive modes', { skip: process.platform === 'win32' ? 'POSIX modes: verified on Linux (the Linux test host)' : false }, async (t) => {
  const root = tempDir(t);
  const d = deps(root, []);
  await applyRender(renderConfig(baseState(), CTX), d);
  const mode = (p: string) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(path.join(d.configDir, 'dovecot/passwd')), 0o600);
  assert.equal(mode(path.join(d.configDir, 'dovecot/apppasswords.0')), 0o600);
  assert.equal(mode(path.join(d.configDir, 'postfix/main.cf')), 0o644);
  assert.equal(mode(path.join(d.dkimDir, 'exemple.fr/om202610.key')), 0o640);
  assert.equal(mode(path.join(d.configDir, 'manifest.json')), 0o600);
});

test('apply: parts that could not be checked stay unconfirmed and are checked by the next apply, even unchanged', async (t) => {
  const root = tempDir(t);
  const parts: Array<Set<ReloadPart>> = [];
  let down: ReloadPart[] = ['engine'];
  const d: ApplyDeps = { ...deps(root, parts), reload: async (p) => { parts.push(new Set(p)); return down.filter((x) => p.has(x)); } };
  const out = renderConfig(baseState(), CTX);
  const first = await applyRender(out, d);
  assert.deepEqual(first.unconfirmed, ['engine']);
  assert.deepEqual(readManifest(d.configDir)?.unconfirmed, ['engine']);
  down = [];
  const second = await applyRender(out, d);
  assert.equal(second.changed, true, 'same fingerprint, but never checked ⇒ applied again');
  assert.deepEqual([...parts[1]].sort(), ['engine', 'rspamd']);
  assert.deepEqual(second.unconfirmed, []);
  assert.equal(readManifest(d.configDir)?.unconfirmed, undefined);
  assert.equal((await applyRender(out, d)).changed, false, 'confirmed ⇒ unchanged');
});

test('apply: a mailbox / alias change touching only the Rspamd limits maps never restarts Rspamd (watched file maps)', async (t) => {
  const root = tempDir(t);
  const parts: Array<Set<ReloadPart>> = [];
  const d = deps(root, parts);
  await applyRender(renderConfig(baseState(), CTX), d);
  assert.equal(parts.length, 1);

  // New mailbox with an hourly limit: Postfix / Dovecot maps + oblimint_sendlimits.map.
  const s = baseState();
  s.mailboxes.push(box(105, 'nouveau', 'exemple.fr', { sendPerHour: 50 }));
  const res = await applyRender(renderConfig(s, CTX), d);
  assert.equal(res.changed, true);
  assert.deepEqual(res.parts, ['engine'], 'the engine reloads its maps, Rspamd is NOT restarted');
  assert.deepEqual([...parts[1]], ['engine']);
  assert.match(fs.readFileSync(path.join(d.configDir, 'rspamd/oblimint_sendlimits.map'), 'utf8'), /^nouveau@exemple\.fr 50$/m);

  // Only a limit changes (the Rspamd map alone): nothing to reload at all, still applied.
  const s2 = baseState();
  s2.mailboxes.push(box(105, 'nouveau', 'exemple.fr', { sendPerHour: 80 }));
  const out2 = renderConfig(s2, CTX);
  const res2 = await applyRender(out2, d);
  assert.equal(res2.changed, true);
  assert.deepEqual(res2.parts, []);
  assert.equal(parts.length, 2, 'reload not even called');
  assert.equal(readManifest(d.configDir)?.fingerprint, out2.fingerprint);
  assert.match(fs.readFileSync(path.join(d.configDir, 'rspamd/oblimint_sendlimits.map'), 'utf8'), /^nouveau@exemple\.fr 80$/m);

  // A real Rspamd setting (actions.conf) still restarts it.
  const s3 = baseState();
  s3.mailboxes.push(box(105, 'nouveau', 'exemple.fr', { sendPerHour: 80 }));
  s3.settings.spamRejectScore = 20;
  const res3 = await applyRender(renderConfig(s3, CTX), d);
  assert.deepEqual(res3.parts, ['rspamd']);
});

test('apply: reload parts per file, watched maps = the maps rspamd.local.lua declares', () => {
  assert.equal(reloadPartOf('postfix/maps/virtual_mailboxes'), 'engine');
  assert.equal(reloadPartOf('dovecot/passwd'), 'engine');
  assert.equal(reloadPartOf('sieve/104.sieve'), 'engine');
  assert.equal(reloadPartOf('rspamd/actions.conf'), 'rspamd');
  assert.equal(reloadPartOf('rspamd/dkim_signing.conf'), 'rspamd');
  assert.equal(reloadPartOf('rspamd/redis.conf'), 'rspamd');
  for (const m of RSPAMD_WATCHED_MAPS) assert.equal(reloadPartOf(`rspamd/${m}`), null, m);
  assert.equal(reloadPartOf('rspamd/other.map'), 'rspamd', 'only the declared maps are watched');
  // Every watched map is a FILE map of the image's Lua (otherwise Rspamd would never re-read it).
  const lua = fs.readFileSync(path.resolve(__dirname, '../../../../../../images/mail-rspamd/rspamd.local.lua'), 'utf8');
  const declared = [...lua.matchAll(/add_map\(\{\s*type = 'map',\s*url = MAPDIR \.\. '([a-z_]+\.map)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, [...RSPAMD_WATCHED_MAPS].sort());
  assert.match(lua, /local MAPDIR = '\/etc\/rspamd\/local\.d\/'/);
  // And they are all rendered.
  const files = [...renderConfig(baseState(), CTX).files.keys()];
  for (const m of RSPAMD_WATCHED_MAPS) assert.ok(files.includes(`rspamd/${m}`), m);
});
