#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — static consistency checks of the TEST dataset (runs anywhere, no
// Docker: Windows dev box included). docs/P5-PLAN.md §15 (fake-cwp).
//
//   node images/fake-cwp/check/check-dataset.mjs                  # check
//   node images/fake-cwp/check/check-dataset.mjs --write-expected # regenerate dataset/expected-inventory.json
//
// Builds the exact plan of the image build (placeholder secrets) and checks:
// vhosts ↔ domains, docroots, maildirs, DKIM, zones ↔ named.conf, FTP / cron /
// systemd paths, DB grants, expected-inventory.json = what the seed declares,
// synthetic values only (domains / IPs in reserved ranges), `set -eu` in every
// shell script (+ `bash -n` when bash is available), test-only image markers.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ds from '../dataset/dataset.mjs';
import { buildPlan } from '../build/generate.mjs';
import { placeholderCrypto } from '../build/lib/crypto.mjs';
import { computeExpected } from '../build/lib/facts.mjs';
import { mailboxMessages } from '../build/lib/mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.resolve(HERE, '..');
const REPO_DIR = path.resolve(IMAGE_DIR, '..', '..');
const EXPECTED_FILE = path.join(IMAGE_DIR, 'dataset', 'expected-inventory.json');

const failures = [];
let checks = 0;
function ok(cond, message) {
  checks += 1;
  if (!cond) failures.push(message);
  return cond;
}

const { plan, vhostFiles } = buildPlan(ds, placeholderCrypto());
const content = (p) => {
  const e = plan.get(p);
  return e && e.type === 'file' ? String(e.content) : null;
};
const exists = (p) => plan.has(p);

// ── 1. vhosts ↔ domains ──────────────────────────────────────────────────────

const NGINX = '/etc/nginx/conf.d/vhosts';
const APACHE = '/usr/local/apache/conf.d/vhosts';
for (const d of ds.DOMAINS) {
  if (!d.web) {
    ok(d.duplicateRow && ds.DOMAINS.some((x) => x !== d && x.fqdn === d.fqdn && x.web), `${d.fqdn}: a row without vhost must duplicate another row`);
    continue;
  }
  const sfx = d.web.serving === 'disabled' ? '.disabled' : '';
  const nginx = content(`${NGINX}/${d.fqdn}.conf${sfx}`);
  ok(nginx !== null, `${d.fqdn}: nginx vhost ${NGINX}/${d.fqdn}.conf${sfx} missing`);
  if (nginx) {
    ok(new RegExp(`server_name ${d.fqdn.replace(/\./g, '\\.')}(\\s|;)`).test(nginx), `${d.fqdn}: server_name missing in the nginx vhost`);
    ok(d.web.www === nginx.includes(`www.${d.fqdn}`), `${d.fqdn}: www alias mismatch in the nginx vhost`);
    if (d.web.serving === 'proxy') {
      const p = d.web.proxy;
      ok(nginx.includes(`proxy_pass ${p.scheme}://${p.host}:${p.port};`), `${d.fqdn}: proxy_pass to ${p.host}:${p.port} missing`);
      ok(p.websocket === nginx.includes('proxy_set_header Upgrade'), `${d.fqdn}: websocket headers mismatch`);
      if (p.via === 'webservers-json') {
        ok(d.web.json?.['custom-ip'] === p.host && d.web.json?.['custom-port'] === String(p.port), `${d.fqdn}: custom-ip / custom-port JSON mismatch`);
      }
    } else if (d.web.php?.handler === 'nginx-fpm') {
      ok(nginx.includes(`fastcgi_pass unix:/opt/alt/php-fpm${d.web.php.fpm}/usr/var/sockets/${d.account}.sock;`), `${d.fqdn}: fastcgi_pass php-fpm${d.web.php.fpm} missing`);
      ok(nginx.includes(`root ${d.web.docroot};`), `${d.fqdn}: nginx root ≠ docroot`);
    } else {
      ok(nginx.includes(`root ${d.web.docroot};`), `${d.fqdn}: nginx root ≠ docroot`);
      const port = d.web.varnish ? ds.SERVER.varnishPort : ds.SERVER.apachePort;
      ok(nginx.includes(`proxy_pass http://${ds.SERVER.publicIp}:${port};`), `${d.fqdn}: nginx backend :${port} missing`);
    }
    ok(Boolean(d.web.subServers) === nginx.includes(`server_name webmail.${d.fqdn};`), `${d.fqdn}: webmail./mail./cpanel. sub-servers mismatch`);
  }
  const apache = content(`${APACHE}/${d.fqdn}.conf${sfx}`);
  ok(Boolean(d.web.apache) === (apache !== null), `${d.fqdn}: Apache vhost presence ≠ web.apache`);
  if (d.kind === 'parked') ok(apache === null, `${d.fqdn}: parked domains have their own nginx vhost and NO Apache vhost (CWP-MAP §5)`);
  if (d.web.serving === 'proxy' || d.web.php?.handler === 'nginx-fpm') ok(apache === null, `${d.fqdn}: proxy / nginx-fpm domains have no Apache vhost`);
  if (apache) {
    ok(apache.includes(`DocumentRoot ${d.web.docroot}\n`), `${d.fqdn}: Apache DocumentRoot ≠ docroot`);
    const fpm = d.web.php?.handler === 'php-fpm';
    ok(fpm === apache.includes('SetHandler "proxy:unix:'), `${d.fqdn}: SetHandler presence ≠ php-fpm handler`);
    if (fpm) ok(apache.includes(`/opt/alt/php-fpm${d.web.php.fpm}/usr/var/sockets/${d.account}.sock|fcgi://localhost"`), `${d.fqdn}: SetHandler version mismatch`);
  }
  if (d.web.ssl) {
    ok(exists(`${NGINX}/${d.fqdn}.ssl.conf${sfx}`), `${d.fqdn}: nginx .ssl.conf missing`);
    ok(ds.CERTIFICATES.some((c) => c.name === d.web.ssl), `${d.fqdn}: certificate ${d.web.ssl} not in CERTIFICATES`);
    ok(exists(`/etc/pki/tls/certs/${d.web.ssl}.cert`) && exists(`/etc/pki/tls/certs/${d.web.ssl}.bundle`) && exists(`/etc/pki/tls/private/${d.web.ssl}.key`), `${d.fqdn}: certificate files missing`);
  } else {
    ok(!exists(`${NGINX}/${d.fqdn}.ssl.conf${sfx}`), `${d.fqdn}: unexpected .ssl.conf`);
  }
  if (d.web.varnish) ok(exists(`/etc/varnish/conf.d/vhosts/${d.fqdn}.conf`), `${d.fqdn}: Varnish vhost missing`);
  if (d.web.json) ok(exists(`/home/${d.account}/.conf/webservers/${d.fqdn}.conf`), `${d.fqdn}: ~/.conf/webservers JSON missing`);
  if (d.web.template) {
    ok(exists(`/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/${d.web.template}.tpl`), `${d.fqdn}: template ${d.web.template}.tpl missing`);
  }

  // ── 2. docroots ──
  const e = plan.get(d.web.docroot);
  if (d.app?.type === 'symlink-docroot') ok(e?.type === 'symlink', `${d.fqdn}: the trap docroot must be a symlink`);
  else ok(e?.type === 'dir', `${d.fqdn}: docroot ${d.web.docroot} missing`);
  ok(d.web.docroot.startsWith(`/home/${d.account}/`), `${d.fqdn}: docroot outside the account home`);
  if (d.kind === 'main') ok(d.web.docroot === `/home/${d.account}/public_html`, `${d.fqdn}: main domain docroot must be public_html`);
  else if (d.kind === 'parked') ok(d.path === `/home/${d.account}/public_html`, `${d.fqdn}: parked path must be public_html (CWP-MAP §5)`);
  else ok(d.path === d.web.docroot, `${d.fqdn}: root_cwp path ≠ vhost docroot`);
  if (d.kind === 'subdomain') ok(d.fqdn === `${d.sub}.${d.parent}`, `${d.fqdn}: sub-label + parent ≠ fqdn`);
  for (const [rel, handler] of Object.entries(d.web.htaccess?.subdirs ?? {})) {
    ok((content(`${d.web.docroot}/${rel}/.htaccess`) ?? '').includes(`AddHandler application/x-httpd-${handler} .php`), `${d.fqdn}: ${rel}/.htaccess handler missing`);
  }
  if (d.web.htaccess?.root) ok((content(`${d.web.docroot}/.htaccess`) ?? '').startsWith(`AddHandler application/x-httpd-${d.web.htaccess.root} .php`), `${d.fqdn}: root .htaccess handler missing`);
  if (d.web.php?.handler === 'php-fpm' || d.web.php?.handler === 'nginx-fpm') {
    ok(exists(`/opt/alt/php-fpm${d.web.php.fpm}/usr/etc/php-fpm.d/users/${d.account}.conf`), `${d.fqdn}: FPM pool php-fpm${d.web.php.fpm}/${d.account} missing`);
  }
  if (d.app?.type === 'wordpress') {
    const cfg = content(`${d.web.docroot}/wp-config.php`) ?? '';
    const user = ds.DB_USERS.find((u) => u.user === d.app.dbUser && u.host === 'localhost');
    ok(user && cfg.includes(`'DB_PASSWORD', '${user.password}'`) && cfg.includes(`'DB_NAME', '${d.app.db}'`), `${d.fqdn}: wp-config.php ≠ database credentials`);
    ok(exists(`${d.web.docroot}/wp-includes/version.php`) && exists(`${d.web.docroot}/wp-content/uploads/2024/01/photo-1.jpg`), `${d.fqdn}: WordPress markers missing`);
    ok(ds.DATABASES.some((db) => db.name === d.app.db), `${d.fqdn}: WordPress database ${d.app.db} missing`);
  }
}
const uniqueFqdns = new Set(ds.DOMAINS.map((d) => d.fqdn));
ok(uniqueFqdns.size === ds.DOMAINS.length - ds.DOMAINS.filter((d) => d.duplicateRow).length, 'exactly the duplicateRow rows repeat an fqdn');
for (const a of ds.ACCOUNTS) {
  ok(ds.DOMAINS.some((d) => d.kind === 'main' && d.fqdn === a.mainDomain && d.account === a.username), `${a.username}: main domain row missing`);
  ok(ds.PACKAGES.some((p) => String(p.id) === a.package), `${a.username}: unknown package ${a.package}`);
  ok(plan.get(`/home/${a.username}`)?.mode === 0o711, `${a.username}: home must be 0711`);
  if (a.suspended) ok(exists(`/usr/local/cwp/users/suspended/${a.username}`) && exists(`/usr/local/apache/conf.d/suspended_accounts/${a.username}.conf`), `${a.username}: suspension markers missing`);
}
ok(ds.PACKAGES.some((p) => p.disk_quota === '999999' && p.bandwidth === '-1'), 'an UNLIMITED package (-1 / 999999) is required');
ok(ds.ACCOUNTS.every((a) => a.reseller === ''), 'reseller column empty everywhere (CWP-MAP §2)');

// MG10 traps.
for (const trap of ['/home/acct5/public_html/.htaccess', '/home/acct5/public_html/.htaccess-link', '/home/acct5/php.ini']) {
  ok(plan.get(trap)?.type === 'symlink' && plan.get(trap).target === '/etc/shadow', `${trap} must be a symlink to /etc/shadow (MG10 trap)`);
}
ok(Object.values(Object.fromEntries(plan.entries)).some((e) => e.path.startsWith('/home/acct2/node/') && e.owner === 'svcnode'), 'files of acct2 owned by another uid (svcnode) are required');

// ── 3. mail ──────────────────────────────────────────────────────────────────

const postfixSql = plan.sqlScripts.find((s) => s.name === '50-postfix-data').sql;
for (const md of ds.MAIL_DOMAINS) {
  const owned = ds.DOMAINS.some((d) => d.fqdn === md.domain && d.account === md.account && ['main', 'addon', 'subdomain'].includes(d.kind));
  ok(owned, `${md.domain}: mail domain not attached to a main / addon / sub domain of ${md.account}`);
  ok(exists(`/var/vmail/${md.domain}`), `${md.domain}: /var/vmail/<domain> missing`);
}
for (const mb of ds.MAILBOXES) {
  const [local, domain] = mb.address.split('@');
  const md = ds.MAIL_DOMAINS.find((m) => m.domain === domain);
  ok(Boolean(md), `${mb.address}: no mail domain`);
  const root = `/var/vmail/${domain}/${local}`;
  for (const sub of ['cur', 'new', 'tmp', '.Sent/cur', '.Spam/cur', '.Trash/cur', '.Drafts/cur']) ok(plan.get(`${root}/${sub}`)?.type === 'dir', `${mb.address}: maildir ${sub} missing`);
  ok(exists(`${root}/.Sent/maildirfolder`), `${mb.address}: maildirfolder missing`);
  ok((content(`${root}/dovecot-uidlist`) ?? '').startsWith(`3 V${mb.uidValidity} `), `${mb.address}: INBOX dovecot-uidlist / UIDVALIDITY missing`);
  const acct = ds.ACCOUNTS.find((a) => a.username === md?.account);
  ok(plan.get(root)?.owner === acct?.username && plan.get(root)?.group === 'mail' && plan.get(root)?.mode === 0o700, `${mb.address}: maildir must be <account>:mail 0700`);
  for (const m of Object.values(mailboxMessages(ds, mb)).flat()) {
    ok(new RegExp(`,S=${Buffer.byteLength(m.content)},W=\\d+`).test(m.base), `${mb.address}: S= size of ${m.base} wrong`);
  }
  ok(postfixSql.includes(`'${mb.address}', '${mb.scheme === 'SHA512-CRYPT' ? '{SHA512-CRYPT}$6$' : '$1$'}`), `${mb.address}: postfix.mailbox row / hash scheme missing`);
  ok(postfixSql.includes(`'${domain}/${local}/'`), `${mb.address}: maildir column missing`);
  if (mb.sieve) ok(plan.get(`${root}/dovecot.sieve`)?.type === 'symlink' && exists(`${root}/sieve/roundcube.sieve`), `${mb.address}: sieve files missing`);
}
// Dovecot 2.3 config syntax: a section takes ONE name, so a space-separated
// local_name list must be quoted (bare 'local_name a b {' → doveconf "Expecting '{'").
const sniConf = content('/etc/dovecot/sni.conf') ?? '';
for (const line of sniConf.split('\n').filter((l) => /^\s*local_name\b/.test(l))) {
  ok(/^local_name (?:"[^"\s]+(?: [^"\s]+)*"|[^"\s{]+) \{$/.test(line), `/etc/dovecot/sni.conf: invalid Dovecot section header: ${line}`);
}
for (const c of ds.CERTIFICATES.filter((x) => ds.MAIL_DOMAINS.some((m) => m.domain === x.name))) {
  ok(sniConf.includes(`local_name "mail.${c.name} webmail.${c.name}" {`), `${c.name}: sni.conf block (mail. + webmail.) missing`);
}
for (const al of ds.ALIASES) ok(ds.MAIL_DOMAINS.some((m) => m.domain === al.domain), `${al.address}: alias on an unknown mail domain`);
ok(ds.ALIASES.some((a) => a.address.startsWith('@')), 'a catch-all alias is required');

const keyTable = content('/etc/opendkim/KeyTable') ?? '';
const signingTable = content('/etc/opendkim/SigningTable') ?? '';
for (const k of ds.DKIM) {
  const dir = `/etc/opendkim/userkeys/${k.domain}`;
  ok(keyTable.includes(`default._domainkey.${k.domain} ${k.domain}:default:${dir}/default.private`), `${k.domain}: KeyTable line missing`);
  ok(signingTable.includes(`*@${k.domain} default._domainkey.${k.domain}`), `${k.domain}: SigningTable line missing`);
  ok(exists(`${dir}/default.private`) && exists(`${dir}/default.txt`), `${k.domain}: key files missing`);
  const zone = ds.ZONES.find((z) => z.name === k.domain);
  if (zone) ok(/default\._domainkey\s.*TXT\s+\( "v=DKIM1; k=rsa; p=/.test(content(`/var/named/${k.domain}.db`) ?? ''), `${k.domain}: DKIM TXT missing in the zone`);
}
ok(ds.DKIM.some((k) => k.bits < 2048), 'a weak (< 2048 bits) DKIM key is required');
ok(ds.DKIM.some((k) => !ds.MAIL_DOMAINS.some((m) => m.domain === k.domain)), 'a DKIM key without mail domain is required');

// ── 4. DNS ───────────────────────────────────────────────────────────────────

const namedConf = content('/etc/named.conf') ?? '';
for (const z of ds.ZONES) {
  ok(namedConf.includes(`zone "${z.name}" {type master; file "/var/named/${z.name}.db";`), `${z.name}: not declared inline in named.conf`);
  ok(exists(`/var/named/${z.name}.db`), `${z.name}: zone file missing`);
  ok(Boolean(z.dynamic) === namedConf.includes(`zone "${z.name}" {type master; file "/var/named/${z.name}.db"; allow-update`), `${z.name}: allow-update mismatch`);
  const zoneText = content(`/var/named/${z.name}.db`) ?? '';
  ok(/SOA\s+ns3\.srvdomain\.test\. postmaster\./.test(zoneText), `${z.name}: SOA missing`);
  for (const [n] of z.dynamicRecords ?? []) ok(!zoneText.includes(n), `${z.name}: journal-only record ${n} must NOT be in the .db file`);
}
for (const x of ds.ZONE_FILES_EXTRA) {
  ok(exists(`/var/named/${x.file}`), `${x.file}: missing`);
  ok(!namedConf.includes(`"/var/named/${x.file}"`), `${x.file}: must not be declared`);
}
ok(ds.ZONES.filter((z) => z.dynamic).length === 1, 'exactly one dynamic zone');
ok(ds.ZONES.some((z) => z.format === 'canonical'), 'a BIND-rewritten (canonical) zone is required');
ok(exists(`/etc/named/keys/${ds.SERVER.dnsUpdateKey}.key`) && namedConf.includes(`include "/etc/named/keys/${ds.SERVER.dnsUpdateKey}.key";`), 'TSIG key file / include missing');
for (const d of ds.DOMAINS.filter((x) => x.kind === 'main' || x.kind === 'addon' || x.kind === 'parked')) {
  ok(ds.ZONES.some((z) => z.name === d.fqdn), `${d.fqdn}: no zone for a main / addon / parked domain`);
}

// ── 5. databases ─────────────────────────────────────────────────────────────

const likeToRegex = (pattern) => new RegExp(`^${pattern.replace(/\\_/g, '\u0000').replace(/[.*+?^${}()|[\]]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.').replace(/\u0000/g, '_')}$`);
for (const u of ds.DB_USERS) {
  ok(u.user.length <= 32, `${u.user}: user name > 32`);
  for (const g of u.grants) ok(ds.DATABASES.some((db) => likeToRegex(g.db).test(db.name)), `${u.user}@${u.host}: grant ${g.db} matches no database`);
  if (u.account) ok(u.user === u.account || u.user.startsWith(`${u.account}_`), `${u.user}: not prefixed by its account`);
}
for (const db of ds.DATABASES) {
  ok(ds.DB_USERS.some((u) => u.grants.some((g) => likeToRegex(g.db).test(db.name))), `${db.name}: no user has a grant on it`);
  ok(db.account === null ? !ds.ACCOUNTS.some((a) => db.name.startsWith(`${a.username}_`)) : db.name.startsWith(`${db.account}_`), `${db.name}: owner / prefix mismatch`);
}
const dbSql = ds.DATABASES.map((d) => d.sql).join('\n');
ok(/ENGINE=MEMORY/.test(dbSql) && /ENGINE=MyISAM/.test(dbSql) && /ENGINE=InnoDB/.test(dbSql), 'InnoDB + MyISAM + MEMORY tables required');
ok(/DEFINER=`[^`]+`@`%`/.test(dbSql) && /DEFINER=`[^`]+`@`localhost`/.test(dbSql), 'DEFINERs @localhost and @% required');
ok(ds.DB_USERS.some((u) => u.auth === 'plugin') && ds.DB_USERS.some((u) => u.auth === 'password'), 'both hash storages (Password / plugin + authentication_string) required');
const byUser = new Map();
for (const u of ds.DB_USERS) byUser.set(u.user, [...(byUser.get(u.user) ?? []), u]);
ok([...byUser.values()].some((list) => list.length > 1 && new Set(list.map((u) => u.password)).size > 1), 'a user whose hosts have different hashes is required');

// ── 6. FTP, cron, systemd ────────────────────────────────────────────────────

const ftp = content('/etc/pure-ftpd/pureftpd.passwd') ?? '';
for (const line of ftp.trim().split('\n')) ok(line.split(':').length === 18, `pureftpd.passwd: 18 fields expected: ${line.split(':')[0]}`);
for (const f of ds.FTP_USERS) {
  ok(plan.get(f.dir)?.type === 'dir', `${f.login}: directory ${f.dir} missing`);
  ok(f.dir.startsWith(`/home/${f.account}`), `${f.login}: directory outside the account home`);
  ok(ftp.includes(`${f.login}:${f.scheme === 'bcrypt' ? '$2a$10$' : '$1$'}`), `${f.login}: hash scheme missing`);
  ok(ftp.includes(`::${f.dir}/./:`), `${f.login}: chroot marker /./ missing`);
}
for (const tab of ds.CRONTABS) {
  ok(exists(`/var/spool/cron/${tab.owner}`), `crontab ${tab.owner} missing`);
  if (tab.owner === 'root') continue;
  for (const line of tab.lines) {
    for (const m of line.matchAll(/\/home\/[A-Za-z0-9._/-]+/g)) ok(exists(m[0]), `crontab ${tab.owner}: ${m[0]} not in the image`);
  }
}
ok(ds.CRONTABS.some((t) => t.lines.some((l) => l.startsWith('@reboot'))) && ds.CRONTABS.some((t) => t.lines.some((l) => l.startsWith('#'))), 'cron: @reboot and commented lines required');
for (const u of ds.SYSTEMD_UNITS) {
  ok(exists(`/etc/systemd/system/${u.name}`), `${u.name} missing`);
  if (u.workingDirectory.startsWith('/home/')) ok(plan.get(u.workingDirectory)?.type === 'dir', `${u.name}: WorkingDirectory ${u.workingDirectory} missing`);
  ok(u.user === 'root' || ds.ACCOUNTS.some((a) => a.username === u.user) || ds.LINUX_USERS.some((l) => l.username === u.user), `${u.name}: unknown user ${u.user}`);
}
ok(ds.SYSTEMD_UNITS.some((u) => u.environment.some((e) => /must-be-redacted/.test(e))), 'a unit with a secret Environment= (redaction proof) is required');

// ── 7. expected inventory ────────────────────────────────────────────────────

const expected = computeExpected(ds, { vhostFiles });
if (process.argv.includes('--write-expected')) {
  fs.writeFileSync(EXPECTED_FILE, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`wrote ${path.relative(REPO_DIR, EXPECTED_FILE)}`);
} else if (ok(fs.existsSync(EXPECTED_FILE), 'dataset/expected-inventory.json missing (run with --write-expected)')) {
  const onDisk = fs.readFileSync(EXPECTED_FILE, 'utf8');
  ok(onDisk === `${JSON.stringify(expected, null, 2)}\n`, 'dataset/expected-inventory.json is stale: the counts / facts differ from what the seed declares (run with --write-expected and review the diff)');
}
// README documents every known test password (Linux ones by their pattern) and the hard counts.
const readmeFile = path.join(IMAGE_DIR, 'README.md');
if (ok(fs.existsSync(readmeFile), 'README.md missing')) {
  const readme = fs.readFileSync(readmeFile, 'utf8');
  const listed = [
    ...Object.values(ds.SERVER.mysql), ...ds.MAILBOXES.map((m) => m.password), ...ds.DB_USERS.map((u) => u.password), ...ds.FTP_USERS.map((f) => f.password),
  ];
  for (const pw of new Set(listed)) {
    if (/^FakeCwp-[a-z0-9]+-linux$/.test(pw)) continue; // bare MySQL users = the Linux password: documented by its pattern
    ok(readme.includes(pw), `README.md: test password ${pw} not documented`);
  }
  for (const u of [...ds.ACCOUNTS, ...ds.LINUX_USERS]) {
    if (u.linuxPassword) ok(u.linuxPassword === `FakeCwp-${u.username}-linux`, `${u.username}: Linux password must follow the documented pattern FakeCwp-<user>-linux`);
  }
  for (const m of ds.MAILBOXES.filter((x) => x.address === 'contact@alpha.example')) ok(readme.includes(`UIDVALIDITY ${m.uidValidity}`), 'README.md: UIDVALIDITY of contact@alpha.example not documented');
}

const hard = expected.counts.hard;
ok(hard.accounts === 6 && hard.suspendedAccounts === 1 && hard.packages === 2, 'accounts / suspended / packages = 6 / 1 / 2');
ok(hard.parkedDomains === 2 && hard.proxyDomains >= 4, '2 parked domains and ≥ 4 proxies required');

// ── 8. synthetic values only ─────────────────────────────────────────────────

const ALLOWED_V4 = [
  [[203, 0, 113], 3], [[192, 0, 2], 3], [[198, 51, 100], 3], [[10], 1], [[192, 168], 2], [[127], 1], [[0, 0, 0, 0], 4],
];
const ipAllowed = (parts) => ALLOWED_V4.some(([prefix]) => prefix.every((v, i) => parts[i] === v))
  || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31); // Docker bridge networks (documentation of the the Linux test host setup)
// Lower-case host names ending with a real TLD (whole host: not followed by another label).
const REAL_TLD = /(?<![a-z0-9.-])((?:[a-z0-9-]+\.)+)(com|net|org|fr|me|io|de|eu|uk|info|biz|co|app|dev|xyz|cloud|tech|online|site|ovh|be|ch|nl|it|es|ru|us|ca|tv|pro|tld)(?![A-Za-z0-9_-]|\.[a-z0-9])/g;
const DOMAIN_ALLOW = [
  /(^|\.)example\.(com|net|org)$/, /^bl\.spamcop\.net$/, /^letsencrypt\.org$/, /^github\.com$/,
  /^[a-z]\.[a-z]+$/, // code tokens (d.app?.type), not host names
];
function scanText(where, text) {
  if (text === null) return;
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
    const parts = m.slice(1, 5).map(Number);
    ok(ipAllowed(parts), `${where}: IPv4 ${m[0]} outside the reserved / LAN ranges`);
  }
  for (const m of text.matchAll(REAL_TLD)) {
    const host = m[0].toLowerCase();
    ok(DOMAIN_ALLOW.some((re) => re.test(host)), `${where}: real-looking domain "${m[0]}" (use *.example / *.test / example.com|net|org)`);
  }
}
for (const t of plan.texts()) scanText(t.where, t.text);
const repoFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else repoFiles.push(p);
  }
};
walk(IMAGE_DIR);
for (const f of repoFiles) {
  if (f === __filenameSelf()) continue;
  scanText(path.relative(IMAGE_DIR, f), fs.readFileSync(f, 'utf8'));
}
function __filenameSelf() {
  return fileURLToPath(import.meta.url);
}

// ── 9. shell scripts, test-only markers ──────────────────────────────────────

const shellScripts = repoFiles.filter((f) => /\.sh$/.test(f) || /^#!\/bin\/(ba)?sh/.test(fs.readFileSync(f, 'utf8').slice(0, 20)));
const bash = ['bash', 'C:/Program Files/Git/bin/bash.exe'].find((b) => spawnSync(b, ['-c', 'true']).status === 0) ?? null;
for (const f of shellScripts) {
  const text = fs.readFileSync(f, 'utf8');
  ok(/^set -[a-z]*e[a-z]*u|^set -[a-z]*u[a-z]*e/m.test(text), `${path.relative(IMAGE_DIR, f)}: \`set -eu\` missing`);
  ok(!text.includes('\r'), `${path.relative(IMAGE_DIR, f)}: CRLF line endings`);
  if (bash) {
    const r = spawnSync(bash, ['-n', f], { encoding: 'utf8' });
    ok(r.status === 0, `${path.relative(IMAGE_DIR, f)}: bash -n failed: ${r.stderr.trim()}`);
  }
}
for (const e of plan.entries.values()) {
  if (e.type !== 'file' || Buffer.isBuffer(e.content) || !/^#!\/bin\/sh/.test(e.content)) continue;
  if (e.path.startsWith('/opt/alt/') || e.path.startsWith('/usr/local/bin/php') || e.path.startsWith('/usr/local/cwp/php71/')) continue; // PHP stubs: exec-only, no state
  ok(/^set -eu/m.test(e.content), `${e.path}: \`set -eu\` missing`);
}
const dockerfile = fs.readFileSync(path.join(IMAGE_DIR, 'Dockerfile'), 'utf8');
ok(/LABEL[\s\S]*oblimint\.test-only="?true"?/.test(dockerfile), 'Dockerfile: LABEL oblimint.test-only=true missing');
const buildSh = path.join(REPO_DIR, 'images', 'build.sh');
if (fs.existsSync(buildSh)) ok(!fs.readFileSync(buildSh, 'utf8').includes('fake-cwp'), 'images/build.sh must never build fake-cwp');

// ── report ───────────────────────────────────────────────────────────────────

const stats = { dirs: 0, files: 0, symlinks: 0 };
for (const e of plan.entries.values()) stats[e.type === 'dir' ? 'dirs' : e.type === 'file' ? 'files' : 'symlinks'] += 1;
console.log(`fake-cwp dataset: ${stats.dirs} directories, ${stats.files} files, ${stats.symlinks} symlinks, ${plan.sqlScripts.length} SQL scripts, ${shellScripts.length} shell scripts${bash ? '' : ' (bash -n skipped: no bash)'}`);
console.log(`counts: ${Object.entries(hard).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} / ${checks} checks FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK — ${checks} checks passed`);
