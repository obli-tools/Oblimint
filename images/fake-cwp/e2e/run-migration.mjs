#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — end-to-end CWP migration scenario against a REAL panel (the Linux test host),
// docs/P5-PLAN.md §16 items 1–4. Node ≥ 20, no dependency (fetch + cookie jar).
//
//   PANEL_URL=https://panel.linux-test-host.test ADMIN_USER=admin ADMIN_PASSWORD=… \
//   SOURCE_HOST=<address of the fake-cwp port AS SEEN FROM THE PANEL CONTAINER> SOURCE_PORT=2222 \
//   SSH_KEY_FILE=~/.ssh/fake-cwp_ed25519 EXPECTED_FINGERPRINT=SHA256:… \
//   node images/fake-cwp/e2e/run-migration.mjs [--accounts acct1,acct2] [--skip-runs] [--trust-presented-key]
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0   accept a self-signed panel certificate (the Linux test host)
//   TIMEOUT_MIN=60                   global wait budget for the discovery / runs
//
// Steps: login → source (create / reuse) → test → pin the host key (only if it
// equals EXPECTED_FINGERPRINT, printed by scripts/run.sh) → discovery → compare
// the inventory with dataset/expected-inventory.json → plan + staff adjustments
// → compute (no blocking account) → initial runs → poll → assertions over the
// API → manual checks printed. Exit 1 when a HARD check fails; SOFT checks
// (counting conventions, expected warning codes) are printed only.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ds from '../dataset/dataset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'dataset', 'expected-inventory.json'), 'utf8'));
const API = '/api/system/migration';

// ── options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const env = (name, fallback) => {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback === undefined) {
    console.error(`missing environment variable ${name} (see the header of ${path.basename(fileURLToPath(import.meta.url))})`);
    process.exit(2);
  }
  return fallback;
};

const PANEL_URL = env('PANEL_URL').replace(/\/+$/, '');
const ADMIN_USER = env('ADMIN_USER');
const ADMIN_PASSWORD = env('ADMIN_PASSWORD');
const SOURCE_HOST = env('SOURCE_HOST');
const SOURCE_PORT = Number(env('SOURCE_PORT', '2222'));
const SSH_KEY_FILE = env('SSH_KEY_FILE', path.join(os.homedir(), '.ssh', 'fake-cwp_ed25519')).replace(/^~(?=\/)/, os.homedir());
const EXPECTED_FINGERPRINT = env('EXPECTED_FINGERPRINT', '');
const TIMEOUT_MS = Number(env('TIMEOUT_MIN', '60')) * 60_000;
const ACCOUNTS = opt('--accounts', ds.ACCOUNTS.map((a) => a.username).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const SOURCE_NAME = `fake-cwp ${SOURCE_HOST}:${SOURCE_PORT}`;

// ── reporting ────────────────────────────────────────────────────────────────

const hardFailures = [];
let softWarnings = 0;
const pass = (msg) => console.log(`  ✓ ${msg}`);
const hard = (cond, msg) => {
  if (cond) pass(msg);
  else {
    hardFailures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
  return cond;
};
const soft = (cond, msg) => {
  if (cond) pass(msg);
  else {
    softWarnings += 1;
    console.log(`  ~ ${msg}`);
  }
  return cond;
};
// Items that could not be proven automatically: printed again (numbered) at the end, with the manual checks.
const manualPending = [];
const manual = (msg) => {
  manualPending.push(msg);
  console.log(`  ? MANUAL: ${msg}`);
};
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP (session cookie jar, JSON envelope {success, data}) ─────────────────

const cookies = new Map();

async function http(method, url, body) {
  const headers = { accept: 'application/json' };
  if (cookies.size > 0) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  // Every state-changing request carries a JSON body (originGuard: no Origin header from Node = not a browser).
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const res = await fetch(`${PANEL_URL}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok || (json && json.success === false)) {
    const err = new Error(`${method} ${url} → ${res.status} ${json?.code ?? ''} ${json?.error ?? text.slice(0, 300)}`.trim());
    err.status = res.status;
    err.code = json?.code;
    throw err;
  }
  return json && 'data' in json ? json.data : json;
}
const get = (url) => http('GET', url);
const post = (url, body) => http('POST', url, body);
const put = (url, body) => http('PUT', url, body);

async function waitFor(label, fn, { interval = 3000, timeout = TIMEOUT_MS } = {}) {
  const start = Date.now();
  let last = '';
  for (;;) {
    const { done, value, status } = await fn();
    if (status && status !== last) {
      console.log(`  … ${label}: ${status}`);
      last = status;
    }
    if (done) return value;
    if (Date.now() - start > timeout) throw new Error(`${label}: timeout after ${Math.round(timeout / 60000)} min`);
    await sleep(interval);
  }
}

// ── secrets that must never leak (MG2) ───────────────────────────────────────

const PASSWORDS = [
  ...ds.ACCOUNTS.map((a) => a.linuxPassword), ...ds.LINUX_USERS.map((u) => u.linuxPassword).filter(Boolean),
  ...ds.MAILBOXES.map((m) => m.password), ...ds.DB_USERS.map((u) => u.password), ...ds.FTP_USERS.map((f) => f.password),
  ds.SERVER.mysql.rootPassword, ds.SERVER.mysql.postfixPassword, ds.SERVER.mysql.roundcubePassword,
];
/**
 * `commands`: the command log holds rendered COMMANDS, whose SQL / awk may legitimately name hash
 * prefixes ('{SHA512-CRYPT}%', "$6$"…): only the values themselves (passwords, canary strings) are searched there.
 */
function leaks(label, value, { commands = false } = {}) {
  const text = JSON.stringify(value);
  const canaries = commands ? EXPECTED.canaries.filter((c) => /must-/.test(c) || c === ds.SERVER.mysql.rootPassword) : EXPECTED.canaries;
  const found = [...canaries, ...PASSWORDS].filter((s) => text.includes(s));
  return hard(found.length === 0, `${label}: no secret / hash / key (MG2)${found.length ? ` — FOUND ${found.map((s) => JSON.stringify(s.slice(0, 12))).join(', ')}` : ''}`);
}

// ── scenario ─────────────────────────────────────────────────────────────────

async function login() {
  section('login');
  const data = await post('/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
  if (data?.requires2fa) throw new Error('the admin account has 2FA enabled: use an admin without TOTP for this scenario');
  pass(`logged in as ${data?.user?.username ?? ADMIN_USER}`);
}

async function ensureSource() {
  section('source');
  const privateKey = fs.readFileSync(SSH_KEY_FILE, 'utf8');
  const sources = await get(`${API}/sources`);
  let source = sources.find((s) => s.host === SOURCE_HOST && s.port === SOURCE_PORT);
  if (source) {
    pass(`reusing source #${source.id} (${source.name})`);
  } else {
    source = await post(`${API}/sources`, { name: SOURCE_NAME, host: SOURCE_HOST, port: SOURCE_PORT, username: 'root', authMethod: 'key', privateKey, useSudo: false });
    pass(`source #${source.id} created`);
  }
  hard(!JSON.stringify(source).includes('PRIVATE KEY'), 'the source never echoes its private key');

  let test = await post(`${API}/sources/${source.id}/test`);
  console.log(`  test: ok=${test.ok} hostKeyState=${test.hostKeyState} key=${test.hostKey?.algorithm} ${test.hostKey?.fingerprint} error=${test.errorCode ?? '-'}`);
  if (test.hostKeyState !== 'match') {
    hard(test.ok === false && ['hostKeyUnpinned', 'hostKeyMismatch'].includes(test.errorCode), 'unpinned host: the test refuses to run commands (MG3)');
    source = await get(`${API}/sources/${source.id}`);
    const pending = source.pendingHostKey?.fingerprint;
    if (!pending) throw new Error('no pending host key after the test');
    if (EXPECTED_FINGERPRINT && pending !== EXPECTED_FINGERPRINT) {
      throw new Error(`presented host key ${pending} ≠ EXPECTED_FINGERPRINT ${EXPECTED_FINGERPRINT}: NOT pinned`);
    }
    if (!EXPECTED_FINGERPRINT && !flag('--trust-presented-key')) {
      throw new Error(`set EXPECTED_FINGERPRINT (printed by scripts/run.sh) or pass --trust-presented-key to pin ${pending}`);
    }
    await post(`${API}/sources/${source.id}/host-key`, { fingerprint: pending });
    pass(`host key ${pending} pinned`);
    test = await post(`${API}/sources/${source.id}/test`);
  }
  hard(test.ok && test.hostKeyState === 'match', `test OK with the pinned key (remote user ${test.remoteUser})`);
  hard(test.cwpVersion === ds.SERVER.cwpVersion, `CWP version read = ${test.cwpVersion} (expected ${ds.SERVER.cwpVersion})`);
  soft(/Rocky/i.test(test.osRelease ?? ''), `OS release = ${test.osRelease}`);
  return source;
}

async function discover(source) {
  section('discovery');
  let discovery;
  try {
    discovery = await post(`${API}/sources/${source.id}/discoveries`);
  } catch (err) {
    if (err.code !== 'discoveryRunning') throw err;
    discovery = (await get(`${API}/sources/${source.id}/discoveries`)).find((d) => d.status === 'running');
  }
  discovery = await waitFor(`discovery #${discovery.id}`, async () => {
    const d = await get(`${API}/discoveries/${discovery.id}`);
    return { done: d.status !== 'running', value: d, status: `${d.status} ${d.phase ?? ''} ${d.progress ? `${d.progress.done}/${d.progress.total}` : ''}` };
  });
  if (!hard(discovery.status === 'done', `discovery done (${discovery.status}${discovery.error ? `: ${discovery.error}` : ''})`)) return null;
  const inv = await get(`${API}/discoveries/${discovery.id}/inventory`);
  fs.writeFileSync(path.join(os.tmpdir(), `fake-cwp-inventory-${discovery.id}.json`), JSON.stringify(inv, null, 2));
  console.log(`  inventory saved to ${path.join(os.tmpdir(), `fake-cwp-inventory-${discovery.id}.json`)}`);
  return { discovery, inv };
}

function compareInventory(inv) {
  section('inventory vs dataset/expected-inventory.json');
  for (const [k, v] of Object.entries(EXPECTED.counts.hard)) hard(inv.counts?.[k] === v, `counts.${k} = ${inv.counts?.[k]} (expected ${v})`);
  for (const [k, { expected, note }] of Object.entries(EXPECTED.counts.soft)) {
    const got = inv.counts?.[k];
    soft(k === 'outside' ? got >= expected : got === expected, `counts.${k} = ${got} (expected ${k === 'outside' ? '≥ ' : ''}${expected}: ${note})`);
  }
  leaks('inventory', inv);

  hard(inv.server?.cwpVersion === EXPECTED.server.cwpVersion && inv.server?.cwpPro === true, `server: CWP ${inv.server?.cwpVersion} Pro=${inv.server?.cwpPro}`);
  soft(inv.server?.phpDefault === EXPECTED.server.phpDefault, `server.phpDefault = ${inv.server?.phpDefault}`);
  soft(inv.server?.webserverSetup === EXPECTED.server.webserverSetup, `server.webserverSetup = ${inv.server?.webserverSetup}`);
  soft(EXPECTED.server.sourceIps.every((ip) => (inv.server?.publicIps ?? []).includes(ip)), `server.publicIps ${JSON.stringify(inv.server?.publicIps)} contains ${EXPECTED.server.sourceIps} (needs --cap-add NET_ADMIN)`);

  for (const a of EXPECTED.accounts) {
    const got = (inv.accounts ?? []).find((x) => x.username === a.username);
    hard(got && got.suspended === a.suspended && got.uid === a.uid && got.mainDomain === a.mainDomain && got.packageId === a.packageId,
      `account ${a.username}: uid ${got?.uid}, main ${got?.mainDomain}, package ${got?.packageId}, suspended ${got?.suspended}`);
    soft(got?.sshAccess === a.sshAccess && got?.authorizedKeys === a.authorizedKeys, `account ${a.username}: ssh ${got?.sshAccess} keys ${got?.authorizedKeys}`);
  }

  for (const e of EXPECTED.domains) {
    if (e.duplicateOf && e.kind === 'subdomain') continue;
    const d = (inv.domains ?? []).find((x) => x.fqdn === e.fqdn);
    if (!hard(Boolean(d), `domain ${e.fqdn} found`)) continue;
    const label = `${e.fqdn} [${e.kind}]`;
    hard(d.kind === e.kind && d.account === e.account, `${label}: kind ${d.kind}, account ${d.account}`);
    hard(d.docroot === e.docroot, `${label}: docroot ${d.docroot}`);
    hard(d.serving === e.serving, `${label}: serving ${d.serving}`);
    if (e.php && e.serving === 'site') {
      hard(d.php?.version === e.php.version && d.php?.handler === e.php.handler && d.php?.source === e.php.source,
        `${label}: PHP ${d.php?.version} ${d.php?.handler} via ${d.php?.source} (expected ${e.php.version} ${e.php.handler} via ${e.php.source})`);
      for (const o of e.php.htaccessOverrides) {
        hard((d.php?.htaccessOverrides ?? []).some((x) => x.version === o.version && String(x.path).replace(/^\/+|\/+$/g, '').endsWith(o.path)),
          `${label}: .htaccess override ${o.path} → ${o.version}`);
      }
    } else if (e.serving === 'proxy') {
      hard(d.php === null || d.php?.version === null, `${label}: no PHP (proxy)`);
    }
    if (e.proxy) {
      hard(d.proxy?.host === e.proxy.host && d.proxy?.port === e.proxy.port && d.proxy?.scheme === e.proxy.scheme && d.proxy?.websocket === e.proxy.websocket,
        `${label}: proxy ${d.proxy?.scheme}://${d.proxy?.host}:${d.proxy?.port} ws=${d.proxy?.websocket}`);
      soft(d.proxy?.via === e.proxy.via && d.proxy?.isPrivate === e.proxy.isPrivate, `${label}: proxy via ${d.proxy?.via}, private ${d.proxy?.isPrivate}`);
    }
    soft(d.wwwAlias === e.wwwAlias, `${label}: www alias ${d.wwwAlias}`);
    soft(d.varnish === e.varnish, `${label}: varnish ${d.varnish}`);
    soft(d.customTemplate === e.customTemplate, `${label}: custom template ${d.customTemplate}`);
    soft((d.duplicateOf ?? null) === (e.duplicateOf ?? null), `${label}: duplicateOf ${d.duplicateOf ?? null}`);
    soft((d.certificate ?? null) === (e.certificate ?? null), `${label}: certificate ${d.certificate ?? null}`);
  }

  for (const z of EXPECTED.zones) {
    const got = (inv.dnsZones ?? []).find((x) => x.name === z.name);
    if (!hard(Boolean(got), `zone ${z.name} found`)) continue;
    hard(got.declared === z.declared && got.dynamic === z.dynamic, `zone ${z.name}: declared ${got.declared}, dynamic ${got.dynamic}`);
    if (z.dynamic) {
      hard(got.journal === true && ['checkzone', 'axfr'].includes(got.readVia), `zone ${z.name}: journal ${got.journal}, read via ${got.readVia} (journal applied)`);
      for (const r of z.journalOnlyRecords) {
        hard((got.records ?? []).some((x) => x.name === r.name && x.type === r.type), `zone ${z.name}: journal-only record ${r.name} ${r.type} present (the .db file is stale)`);
      }
    }
  }
  for (const m of EXPECTED.mailboxes) {
    const got = (inv.mailboxes ?? []).find((x) => x.address === m.address);
    hard(got && got.hashScheme === m.hashScheme && got.hashPrefixed === m.hashPrefixed && got.active === m.active && got.account === m.account,
      `mailbox ${m.address}: ${got?.hashScheme} prefixed=${got?.hashPrefixed} active=${got?.active} account=${got?.account}`);
    soft(got?.hasSieve === m.hasSieve, `mailbox ${m.address}: sieve ${got?.hasSieve}`);
  }
  for (const k of EXPECTED.dkim) {
    const got = (inv.dkimKeys ?? []).find((x) => x.domain === k.domain);
    hard(got && got.bits === k.bits && got.selector === 'default', `DKIM ${k.domain}: ${got?.bits} bits, selector ${got?.selector}`);
  }
  for (const f of EXPECTED.ftpUsers) {
    const got = (inv.ftpUsers ?? []).find((x) => x.login === f.login);
    hard(got && got.hashScheme === f.hashScheme && got.chroot === true && got.directory.replace(/\/+$/, '') === f.directory, `FTP ${f.login}: ${got?.hashScheme} chroot=${got?.chroot} dir=${got?.directory}`);
  }
  for (const c of EXPECTED.certificates) {
    const got = (inv.certificates ?? []).find((x) => x.fqdn === c.fqdn);
    hard(got && got.expired === c.expired && got.selfSigned === c.selfSigned && got.keyType === c.keyType, `certificate ${c.fqdn}: expired=${got?.expired} self=${got?.selfSigned} key=${got?.keyType}`);
  }
  for (const db of EXPECTED.databases) {
    const got = (inv.databases ?? []).find((x) => x.name === db.name);
    hard(got && got.account === db.account, `database ${db.name}: account ${got?.account}`);
    soft(got && db.memoryTables.every((t) => got.memoryTables.includes(t)), `database ${db.name}: MEMORY ${JSON.stringify(got?.memoryTables)}`);
    soft(got && db.definers.every((def) => got.objects.some((o) => o.definer.replace(/`/g, '') === def)), `database ${db.name}: DEFINERs ${db.definers.join(', ') || '-'}`);
  }
  for (const u of EXPECTED.dbUsers) {
    const got = (inv.dbUsers ?? []).find((x) => x.user === u.user && x.host === u.host);
    hard(got && got.hashKind === 'native' && got.remote === u.remote && got.orphan === u.orphan, `MySQL ${u.user}@${u.host}: ${got?.hashKind} remote=${got?.remote} orphan=${got?.orphan}`);
  }
  for (const o of EXPECTED.outsideMin) {
    soft((inv.outside ?? []).some((x) => x.kind === o.kind && String(x.key).includes(o.key)), `outside ${o.kind} ${o.key} (${o.note})`);
  }
  const units = (inv.outside ?? []).filter((x) => x.kind === 'systemd-service');
  hard(!JSON.stringify(units).includes('must-be-redacted'), 'systemd Environment= values redacted on the source');
}

async function checkCommandLog(source) {
  section('command log (read-only executor)');
  const items = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await get(`${API}/sources/${source.id}/commands?limit=500&offset=${offset}`);
    items.push(...(page.items ?? []));
    if (!page.items || page.items.length < 500) break;
  }
  pass(`${items.length} commands logged`);
  const okShadow = items.filter((c) => c.status === 'ok' && /\/etc\/shadow/.test(c.command));
  // Weak sanity check only: rendered commands name the symlink path, not its target. MG10 is really
  // proven by the canary leak checks (inventory, command log) — leaks() below and in checkInventory().
  hard(okShadow.length === 0, 'no successful command names /etc/shadow (sanity check; MG10 proof = canary leak checks)');
  const refused = items.filter((c) => c.status === 'refused');
  if (refused.length > 0) {
    pass(`${refused.length} refused command(s) logged (symlink traps / deny list) — e.g. ${refused.slice(0, 3).map((c) => `${c.template}: ${c.error}`).join(' | ')}`);
  } else {
    // A trap may legitimately come back as an absent file (fs.catMany size -1, §5.4 bis) instead of a
    // 'refused' entry: §16 item 1 is then NOT proven by this run — say so instead of passing silently.
    manual("§16 item 1 not proven: no 'refused' command in the log. Run a template on a denied path (e.g. a deny-list root or the theta.test MG10 symlinks) and check the command log shows it as 'refused'");
  }
  const writes = items.filter((c) => /(^|[\s;|&])(rm|mv|cp|chmod|chown|tee|truncate|kill|systemctl|service|rndc|nsupdate|useradd)\s/.test(c.command));
  hard(writes.length === 0, `no writing command rendered (${writes.slice(0, 3).map((c) => c.command).join(' | ')})`);
  leaks('command log', items, { commands: true });
}

async function plan(discovery) {
  section('target preflight');
  // PX2: an external proxy target needs plan ∧ tenant. The plans created by the migration allow it; the TENANT
  // (Default) must allow it too, else every account with a CWP proxy is blocked (proxyExternalNotAllowed,
  // reason tenantPolicy). This is a staff decision on a real platform; the test platform takes it here.
  const policy = await get('/api/apps/policy/tenants/1');
  if (policy.allowExternalProxyTargets !== true) {
    await put('/api/apps/policy/tenants/1', { allowExternalProxyTargets: true });
    pass('tenant Default: external proxy targets allowed (apps policy, PX2)');
  } else pass('tenant Default already allows external proxy targets');
  const targets = await get(`${API}/targets`);
  // Without a platform IPv4 the zones cannot be rewritten (zoneTargetIpMissing, blocking): set it in the plan below.
  if (!targets.platformIpv4) manual('the platform has no public IPv4: the plan needs global.targetIpv4 (zoneTargetIpMissing otherwise)');

  section('plan (dry-run)');
  let p = await post(`${API}/plans`, { discoveryId: discovery.id, name: `fake-cwp e2e ${new Date().toISOString().slice(0, 16)}` });
  if (!targets.platformIpv4 && process.env.TARGET_IPV4) {
    p = await put(`${API}/plans/${p.id}/choices`, { ...p.choices, global: { ...p.choices.global, targetIpv4: process.env.TARGET_IPV4 } });
    pass(`global.targetIpv4 = ${process.env.TARGET_IPV4} (TARGET_IPV4)`);
  }
  pass(`plan #${p.id} created`);
  // PUT /plans/:id/accounts/:username REPLACES the account choice: one adjustment per account (merged by facts.mjs).
  const adjusted = new Set();
  for (const adj of EXPECTED.planAdjustments) {
    if (!ACCOUNTS.includes(adj.account)) continue;
    if (!hard(!adjusted.has(adj.account), `adjustment ${adj.account}: single entry (a second PUT would replace the first)`)) continue;
    adjusted.add(adj.account);
    p = await put(`${API}/plans/${p.id}/accounts/${adj.account}`, adj.choice);
    pass(`adjustment ${adj.account}: ${JSON.stringify(adj.choice)} (${adj.reason})`);
  }
  p = await post(`${API}/plans/${p.id}/compute`);
  const result = p.result;
  if (!hard(Boolean(result), 'plan computed')) return null;
  leaks('plan result', result);
  const serverCodes = new Set((result.warnings ?? []).map((w) => w.code));
  for (const code of EXPECTED.expectedServerWarnings ?? []) soft(serverCodes.has(code), `server: warning ${code} raised`);
  for (const username of ACCOUNTS) {
    const acc = result.accounts.find((a) => a.cwpUsername === username);
    if (!hard(Boolean(acc), `account ${username} in the plan`)) continue;
    const blocking = acc.warnings.filter((w) => w.severity === 'blocking');
    hard(!acc.blocked, `${username}: not blocked${blocking.length ? ` — ${blocking.map((w) => `${w.code}(${w.scope.key})`).join(', ')}` : ''}`);
    const codes = new Set(acc.warnings.map((w) => w.code));
    console.log(`    warnings: ${[...codes].sort().join(', ') || '-'}`);
    for (const code of EXPECTED.expectedWarnings[username] ?? []) soft(codes.has(code), `${username}: warning ${code} raised`);
    for (const e of EXPECTED.domains.filter((d) => d.account === username && d.expectedBase && d.serving === 'site')) {
      const site = acc.sites.find((s) => s.routes.some((r) => r.fqdn === e.fqdn));
      if (site) soft(site.base === e.expectedBase.base, `${e.fqdn}: base ${site.base} (expected ${e.expectedBase.base})`);
    }
    const domainChoices = EXPECTED.planAdjustments.find((a) => a.account === username)?.choice.domains ?? {};
    for (const e of EXPECTED.domains.filter((d) => d.account === username && d.proxy && d.proxy.host !== '127.0.0.1')) {
      const dc = domainChoices[e.fqdn] ?? {};
      if (dc.as === 'skip') {
        soft(!acc.proxies.some((x) => x.fqdns.includes(e.fqdn)), `${e.fqdn}: skipped by the staff, no proxy host`);
        continue;
      }
      const ph = acc.proxies.find((x) => x.fqdns.includes(e.fqdn) && x.target.host === e.proxy.host && x.target.port === e.proxy.port);
      soft(Boolean(ph), `${e.fqdn}: proxy host → ${e.proxy.host}:${e.proxy.port}`);
      if (ph && e.proxy.isPrivate) soft(ph.target.allowPrivate === (dc.proxyAllowPrivate === true), `${e.fqdn}: private target allowPrivate=${ph.target.allowPrivate}`);
    }
    if (username === 'acct4') hard(acc.suspended === true, 'acct4 planned SUSPENDED (D-SUSPEND)');
  }
  return p;
}

async function runs(p) {
  section('initial runs');
  const started = await post(`${API}/plans/${p.id}/runs`, { accounts: ACCOUNTS, kind: 'initial' });
  pass(`${started.length} run(s) queued: ${started.map((r) => `#${r.id} ${r.cwpUsername}`).join(', ')}`);
  const terminal = new Set(['done', 'failed', 'cancelled']);
  const final = await waitFor('runs', async () => {
    const list = await get(`${API}/runs?planId=${p.id}`);
    const mine = list.filter((r) => started.some((s) => s.id === r.id));
    const status = mine.map((r) => `${r.cwpUsername}:${r.status}${r.currentStep ? `(${r.currentStep})` : ''}`).join(' ');
    return { done: mine.every((r) => terminal.has(r.status) || r.status === 'paused'), value: mine, status };
  }, { interval: 5000 });
  for (const r of final) {
    if (hard(r.status === 'done', `run #${r.id} ${r.cwpUsername}: ${r.status}${r.error ? ` — ${r.error}` : ''}`)) continue;
    const detail = await get(`${API}/runs/${r.id}`);
    for (const s of detail.steps.filter((x) => x.status === 'failed')) console.log(`    failed step ${s.key}: ${s.error}`);
    const events = await get(`${API}/runs/${r.id}/events?limit=500`);
    for (const e of events.filter((x) => x.level === 'error' || x.level === 'warn').slice(-20)) {
      console.log(`    [${e.level}] ${e.stepKey ?? '-'} ${e.code} ${e.message ?? ''} ${e.params ? JSON.stringify(e.params) : ''}`);
    }
  }
  return final;
}

async function afterRuns(p, final) {
  section('assertions after the runs');
  const statuses = await get(`${API}/plans/${p.id}/accounts`);
  for (const username of ACCOUNTS) {
    const st = statuses.find((s) => s.cwpUsername === username);
    hard(st?.initialDone === true, `${username}: initial migration done (target account #${st?.targetAccountId} ${st?.targetUsername ?? ''})`);
  }
  for (const r of final) {
    const detail = await get(`${API}/runs/${r.id}`);
    const events = await get(`${API}/runs/${r.id}/events?limit=500`);
    const report = await get(`${API}/runs/${r.id}/report`);
    leaks(`run #${r.id} (${r.cwpUsername}) steps / events / report`, { detail, events, report });
    const kinds = {};
    for (const m of report.migrated ?? []) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    console.log(`    ${r.cwpUsername}: migrated ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' ') || '-'}`);
  }
  for (const username of EXPECTED.suspended.filter((u) => ACCOUNTS.includes(u))) {
    const st = statuses.find((s) => s.cwpUsername === username);
    if (!st?.targetAccountId) continue;
    const account = await get(`/api/accounts/${st.targetAccountId}`);
    hard(account?.status === 'suspended', `${username} → ${account?.username}: status ${account?.status} (still suspended)`);
  }
  const reportMd = await fetch(`${PANEL_URL}${API}/plans/${p.id}/report.md`, { headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  if (reportMd.ok) {
    const file = path.join(os.tmpdir(), `fake-cwp-plan-${p.id}-report.md`);
    const text = await reportMd.text();
    fs.writeFileSync(file, text);
    leaks('Markdown report', text);
    pass(`report exported to ${file}`);
  }
}

function manualChecks() {
  section('manual checks (the Linux test host, docs/P5-PLAN.md §16 item 4)');
  manualPending.forEach((m, i) => console.log(`  P${i + 1}. ${m}`));
  const mb = ds.MAILBOXES[0];
  const wp = ds.DB_USERS.find((u) => u.user === 'acct1_wp');
  const ftp = ds.FTP_USERS[0];
  console.log(`
  1. WordPress (same wp-config.php): open the PREVIEW URL of site alpha.example (panel → site → preview) — expected body:
       OBLIMINT-FAKE-WP OK db=acct1_wp user=acct1_wp blogname=Alpha (fake-cwp) posts=2 php=8.3.x
     and epsilon.example (latin1 + PHP 5.6 → 7.4): blogname "Café épicé" displayed correctly, /legacy.php reports mysql_* MISSING.
  2. MySQL with the OLD password, DEFINERs kept:
       mysql -h <instance host> -P <port> -u ${wp.user} -p'${wp.password}' acct1_wp -e "SELECT COUNT(*) FROM wp_posts; SHOW TRIGGERS; SHOW CREATE VIEW wp_published\\G"
       → trigger wp_posts_after_insert DEFINER=\`acct1_wp\`@\`%\`; view wp_published DEFINER=\`acct1_wp\`@\`%\`
  3. IMAP with the OLD password, UIDs kept:
       curl -k --url 'imaps://<mail host>:993/' --user '${mb.address}:${mb.password}' -X 'EXAMINE INBOX'
       → * OK [UIDVALIDITY ${mb.uidValidity}] … and 'UID FETCH 1:* (FLAGS)' lists UIDs 1 and 2 (the 'new/' message gets 3)
  4. DKIM with the EXISTING record: the platform zone alpha.example serves default._domainkey with the same p= as
       docker exec oblimint-fake-cwp cat /etc/opendkim/userkeys/alpha.example/default.txt
     send a message from contact@alpha.example and check 'dkim=pass header.s=default' at the receiver; iota.example (1024 bits) got a NEW key.
  5. Proxy via the edge:  curl -k -H 'Host: cloud.gamma.test' https://<edge>/   (target 198.51.100.25:443 must be reachable from the node)
  6. Cron of acct1 rewritten (php → image php, /srv/releases/current/…), '@reboot' refused, writes-to-code redirected to /dev/null.
  7. Suspended account acct4: its site answers the suspension page.
  8. FTP adoption: SFTP to the file server of acct1 with the bcrypt password of ${ftp.login} ('${ftp.password}') if the plan adopted it.
  9. Restart the panel container DURING a file copy of a 'resync' run: it resumes at the interrupted step, nothing duplicated (§16 item 5).
 10. MG1: sh images/fake-cwp/scripts/verify-readonly.sh snapshot after && sh images/fake-cwp/scripts/verify-readonly.sh compare  → EMPTY diff.
 11. Resync: sh images/fake-cwp/scripts/mutate-source.sh, then a 'resync' run of acct1 (§16 item 6).`);
}

async function main() {
  console.log(`fake-cwp e2e — panel ${PANEL_URL}, source ${SOURCE_HOST}:${SOURCE_PORT}, accounts ${ACCOUNTS.join(', ')}`);
  await login();
  const source = await ensureSource();
  const found = await discover(source);
  if (found) {
    compareInventory(found.inv);
    await checkCommandLog(source);
    const p = await plan(found.discovery);
    if (p && !flag('--skip-runs') && hardFailures.length === 0) {
      const final = await runs(p);
      await afterRuns(p, final);
      await checkCommandLog(source);
    } else if (p && !flag('--skip-runs')) {
      console.log('\n(runs NOT started: fix the hard failures above first, or re-run with --skip-runs to only inspect)');
    }
  }
  manualChecks();
  section('result');
  console.log(`  hard failures: ${hardFailures.length}, soft warnings: ${softWarnings}, unproven (manual P-items): ${manualPending.length}`);
  for (const f of hardFailures) console.log(`  ✗ ${f}`);
  process.exit(hardFailures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nfake-cwp e2e aborted: ${err.message}`);
  process.exit(1);
});
