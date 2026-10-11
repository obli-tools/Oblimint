import { generateKeyPairSync } from 'node:crypto';
import type { FakeHandlers, FakeReply, FakeSessionOptions } from '../../contracts/testing';
import { SQL } from '../collect/accounts';
import { DB_SQL } from '../collect/databases';
import { MAIL_SQL } from '../collect/mail';
import { caPem, eccExampleOrgPem, exampleTldPem, oldExamplePem, selfSignedPem } from './certs';
import { REFS_DEPTH, refsRegex } from '../../source/templates';
import { SRC_IP, apacheSite, nginxFpm, nginxProxy, nginxRedirect, nginxSite } from './vhosts';

// ─────────────────────────────────────────────────────────────────────────────
// Fake CWP 1.18 server for the discovery tests (anonymised: acct1…acct6,
// example.tld / *.example / *.test, 203.0.113.x / 192.0.2.x / 10.0.0.x).
// Covers every case of docs/cwp/CWP-MAP.md: parked domain with its own nginx
// vhost and no Apache vhost, sub-domain with a dotted label, aberrant
// docroot, nested docroot, Laravel public/ layout, proxies (vhost +
// websocket + LAN, JSON only, to the source itself, through Varnish),
// Varnish site, disabled vhost, redirect, suPHP default 8.3, root .htaccess
// php56, sub-dir php74, Apache FPM 5.6, nginx FPM 8.1, dynamic zone with
// journal (checkzone), AXFR fallback, file fallback, orphan zone, DB with
// triggers / views (DEFINER @localhost and @%), MEMORY + MyISAM, latin1,
// escaped `acct1\_%` grant, remote-host and orphan users, bare <user> user,
// {SHA512-CRYPT} + bare $1$ mailbox schemes, external alias, catch-all,
// sieve, DKIM 2048 + 1024, FTP bcrypt users, crontabs (PHP 8.3 / 7.3,
// @reboot, disabled, root), certificates (valid, expired, self-signed, ECC),
// systemd Node / Python services run by non-CWP users, suspended account,
// extra Linux users. A small virtual filesystem drives fs.find / fs.stat /
// fs.du / fs.lineCount / fs.grepHtaccess like the real commands would.
// ─────────────────────────────────────────────────────────────────────────────

export const FIXTURE_NOW = new Date('2026-10-10T12:00:00Z');

interface VNode {
  type: 'f' | 'd' | 'l';
  size: number;
  uid: number;
  lines?: number;
}

export interface Scenario {
  options: FakeSessionOptions;
  vfs: Map<string, VNode>;
  files: Record<string, string>;
  /** Every SQL string sent to mysql.query (filled while the scenario runs). */
  sqlSeen: string[];
}

function tsv(header: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => (v === null ? 'NULL' : String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n'));
  return [header.join('\t'), ...rows.map((r) => r.map(cell).join('\t'))].join('\n') + '\n';
}

function dkimTxt(selector: string, bits: number): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const b64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
  return `${selector}._domainkey\tIN\tTXT\t( "v=DKIM1; k=rsa; "\n\t  "p=${b64.slice(0, 200)}"\n\t  "${b64.slice(200)}" )  ; ----- DKIM key ${selector} for test\n`;
}

const globRe = (g: string) => new RegExp(`^${g.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);

export function buildScenario(): Scenario {
  const vfs = new Map<string, VNode>();
  const files: Record<string, string> = {};
  const sqlSeen: string[] = [];
  const unitFiles: Record<string, string> = {};

  const dir = (p: string, uid = 0) => {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      if (!vfs.has(cur)) vfs.set(cur, { type: 'd', size: 4096, uid });
    }
  };
  const node = (p: string, size = 100, uid = 0, extra: Partial<VNode> = {}) => {
    dir(p.slice(0, p.lastIndexOf('/')), uid);
    vfs.set(p, { type: 'f', size, uid, ...extra });
  };
  const file = (p: string, content: string, uid = 0) => {
    node(p, Buffer.byteLength(content), uid);
    files[p] = content;
  };

  // ── server ────────────────────────────────────────────────────────────────
  file('/usr/local/cwpsrv/htdocs/resources/admin/include/version.php', '<?php\n$webpanel_version = "1.18";\n$webpanel_build = "24";\n');
  file('/usr/local/cwp/.conf/web_servers.conf', '{"webserver_setup":"nginx-varnish-apache","apache_port":"8181"}');
  file('/usr/local/cwp/.conf/.cwp_pro.conf', '1\n');
  file('/usr/local/cwp/.conf/mysql_user_prefix.conf', 'acct1x\n');
  file('/usr/local/etc/suphp.conf', [
    '[global]', 'logfile=/var/log/suphp.log', '[handlers]', ';Handler for php-scripts',
    'application/x-httpd-php="php:/usr/local/bin/php-cgi"',
    'x-httpd-php56="php:/opt/alt/php56/usr/bin/php-cgi"',
    'x-httpd-php73="php:/opt/alt/php73/usr/bin/php-cgi"',
    'x-httpd-php74="php:/opt/alt/php74/usr/bin/php-cgi"',
    'x-httpd-php81="php:/opt/alt/php81/usr/bin/php-cgi"', '',
  ].join('\n'));
  file('/usr/local/cwp/.conf/vhosts-ssl.json', JSON.stringify({
    'example.tld': { user: 'acct1', install_date: '2026-07-22 15:19:30', expiry_date: '2099-01-01 00:00:00', san: [], autossl: 'on' },
    'ecc.example.org': { user: 'acct2', install_date: '2026-07-22 15:19:30', expiry_date: '2099-01-01 00:00:00', san: [], autossl: 'on' },
    'old.example': { user: 'acct5', install_date: '2020-01-01 00:00:00', expiry_date: '2021-01-01 00:00:00', san: [], autossl: 'off' },
  }));
  for (const v of ['56', '73', '74', '81', '83']) {
    dir(`/opt/alt/php${v}/usr/bin`);
    dir(`/opt/alt/php-fpm${v}/usr/etc/php-fpm.d/users`);
  }
  for (const v of ['56', '81', '83']) node(`/opt/alt/php-fpm${v}/usr/etc/php-fpm.d/users/acct1.conf`);
  node('/opt/alt/php-fpm83/usr/etc/php-fpm.d/users/nobody.conf');
  for (const t of ['default', 'php-fpm', 'proxy', 'backbone', 'proxy_websocket']) node(`/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/nginx/${t}.tpl`);
  for (const t of ['default', 'all_methods', 'php-fpm']) node(`/usr/local/cwpsrv/htdocs/resources/conf/web_servers/vhosts/apache/${t}.tpl`);
  dir('/usr/local/cwp/users/suspended/acct3');
  dir('/usr/local/apache/domlogs');
  node('/usr/local/apache/domlogs/example.tld.log', 5_000_000);

  // ── homes ─────────────────────────────────────────────────────────────────
  const homes: Array<[string, number]> = [['acct1', 1001], ['acct2', 1002], ['acct3', 1003], ['acct4', 1004], ['acct5', 1005], ['acct6', 1006]];
  for (const [u, uid] of homes) {
    for (const d of ['public_html', '.conf/webservers', 'tmp', 'backupcwp', 'cwp_stats', '.trash']) dir(`/home/${u}/${d}`, uid);
  }
  // acct1: WordPress main site with php56 root override and a php74 sub-dir.
  node('/home/acct1/public_html/wp-config.php', 3000, 1001);
  node('/home/acct1/public_html/wp-includes/version.php', 1000, 1001);
  node('/home/acct1/public_html/index.php', 400, 1001);
  file('/home/acct1/public_html/.htaccess', '# BEGIN WordPress\nRewriteEngine On\nAddHandler application/x-httpd-php56 .php .php5\n# END WordPress\n', 1001);
  file('/home/acct1/public_html/legacy/.htaccess', 'Options -Indexes\nAddHandler application/x-httpd-php74 .php\n', 1001);
  file('/home/acct1/public_html/blog/.htaccess', '# nothing about php here\n', 1001);
  node('/home/acct1/public_html/blog/index.html', 200, 1001);
  node('/home/acct1/public_html/uploads/big.bin', 1_000_000, 1001);
  node('/home/acct1/a.b.example.tld/index.php', 300, 1001);
  node('/home/acct1/app/artisan', 1700, 1001);
  node('/home/acct1/app/bootstrap/app.php', 500, 1001);
  node('/home/acct1/app/composer.json', 500, 1001);
  node('/home/acct1/app/public/index.php', 500, 1001);
  node('/home/acct1/home/acct2/site/index.php', 100, 1001);
  node('/home/acct1/scripts/start.sh', 100, 1001);
  node('/home/acct1/node/App/main.js', 2000, 1019);
  file('/home/acct1/node/App/package.json', '{"name":"app"}', 1019);
  node('/home/acct1/node/bot/main.py', 2000, 1020);
  dir('/home/acct1/tools/.git', 1001);
  file('/home/acct1/php.ini', 'memory_limit=256M\n', 1001);
  file('/home/acct1/public_html/.user.ini', 'upload_max_filesize=64M\n', 1001);
  node('/home/acct1/.ssh/authorized_keys', 800, 1001, { lines: 2 });
  file('/home/acct1/.conf/webservers/example.tld.conf', JSON.stringify({
    'nginx_template-type': 'default', 'nginx_template-name': 'default', 'varnish_template-name': 'default', 'apache_template-type': 'php-fpm',
    'apache_template-name': 'all_methods', 'php-fpm_ver': '81', nginx: true, varnish: false, 'php-fpm': false, 'apache-additional': true,
  }), 1001);
  file('/home/acct1/.conf/webservers/ws.example.tld.conf', JSON.stringify({
    'nginx_template-type': 'default', 'nginx_template-name': 'default', 'custom-ip': '10.0.0.50', 'custom-port': '8123', nginx: true,
  }), 1001);
  file('/home/acct1/.conf/.addons_wp', JSON.stringify([{
    domain: 'example.tld', path: '/home/acct1/public_html/', url: 'http://example.tld/', wpbd: 'acct1_wp', wpuserdb: 'acct1_wp',
    db_result: { result: 'success' }, version: null, lang: 'fr', installed_at: '2023-02-06 20:58:24', footprint: '0123456789abcdef0123456789abcdef',
  }]), 1001);
  file('/home/acct1/cron', '*/5 * * * * /usr/local/bin/php /home/acct1/public_html/wp-cron.php > /home/acct1/public_html/cron.log 2>&1\n15 4 * * 0 /usr/local/bin/php /home/acct1/public_html/weekly.php\n', 1001);

  // acct2: example.org (suPHP default), Varnish site, Varnish custom backend, ECC cert + custom template, redirect, disabled.
  node('/home/acct2/public_html/index.php', 300, 1002);
  // Outside the docroot: secrets cited by the code (attached), an archive nobody cites (left over), an absolute path.
  file('/home/acct2/public_html/config.php', "<?php\n$s = require __DIR__ . '/../private_html/secrets.php';\n", 1002);
  file('/home/acct2/public_html/abs.php', "<?php\ninclude '/home/acct2/lib/x.php';\n", 1002);
  file('/home/acct2/private_html/secrets.php', '<?php\nreturn [];\n', 1002);
  node('/home/acct2/lib/x.php', 50, 1002);
  node('/home/acct2/Save/old.zip', 5000, 1002);
  node('/home/acct2/other.example.org/index.html', 300, 1002);
  node('/home/acct2/ecc.example.org/index.php', 300, 1002);
  file('/home/acct2/.conf/webservers/ecc.example.org.conf', JSON.stringify({
    'nginx_template-type': 'default', 'nginx_template-name': 'backbone', 'apache_template-name': 'default', nginx: true, 'apache-additional': true,
  }), 1002);
  // acct3 (suspended) + acct4 (Node app behind a local proxy) + acct5 (certificates) + acct6 (JSON-only proxy).
  node('/home/acct3/public_html/index.html', 100, 1003);
  file('/home/acct4/node/app/package.json', '{"name":"nodeapp"}', 1004);
  node('/home/acct4/node/app/server.js', 900, 1004);
  node('/home/acct5/public_html/index.php', 100, 1005);
  node('/home/acct5/selfsigned.test/index.php', 100, 1005);
  file('/home/acct6/.conf/webservers/lan.test.conf', JSON.stringify({
    'nginx_template-type': 'default', 'nginx_template-name': 'default', 'custom-port': '443', 'custom-ip': '192.168.1.30', nginx: true,
  }), 1006);

  // ── vhosts ────────────────────────────────────────────────────────────────
  const ng = '/etc/nginx/conf.d/vhosts';
  const ap = '/usr/local/apache/conf.d/vhosts';
  file(`${ng}/example.tld.conf`, nginxSite('example.tld', 'acct1', '/home/acct1/public_html', { ssl: true }));
  file(`${ap}/example.tld.conf`, apacheSite('example.tld', 'acct1', '/home/acct1/public_html', { ssl: true }));
  // parked: own nginx vhost, NO Apache vhost.
  file(`${ng}/alias.example.tld.conf`, nginxSite('alias.example.tld', 'acct1', '/home/acct1/public_html'));
  file(`${ng}/a.b.example.tld.conf`, nginxSite('a.b.example.tld', 'acct1', '/home/acct1/a.b.example.tld'));
  file(`${ap}/a.b.example.tld.conf`, apacheSite('a.b.example.tld', 'acct1', '/home/acct1/a.b.example.tld', { fpm: '56' }));
  file(`${ng}/blog.example.tld.conf`, nginxSite('blog.example.tld', 'acct1', '/home/acct1/public_html/blog'));
  file(`${ap}/blog.example.tld.conf`, apacheSite('blog.example.tld', 'acct1', '/home/acct1/public_html/blog'));
  file(`${ng}/app.example.tld.conf`, nginxFpm('app.example.tld', 'acct1', '/home/acct1/app/public', '81'));
  file(`${ng}/ws.example.tld.conf`, nginxProxy('ws.example.tld', 'acct1', 'http://10.0.0.50:8123', true));
  file(`${ng}/old.example.tld.conf`, nginxSite('old.example.tld', 'acct1', '/home/acct1/home/acct2/site'));
  file(`${ap}/old.example.tld.conf`, apacheSite('old.example.tld', 'acct1', '/home/acct1/home/acct2/site'));
  file(`${ng}/example.org.conf`, nginxSite('example.org', 'acct2', '/home/acct2/public_html'));
  file(`${ap}/example.org.conf`, apacheSite('example.org', 'acct2', '/home/acct2/public_html'));
  file(`${ng}/other.example.org.conf`, nginxSite('other.example.org', 'acct2', '/home/acct2/other.example.org', { backendPort: 82 }));
  file(`${ap}/other.example.org.conf`, apacheSite('other.example.org', 'acct2', '/home/acct2/other.example.org'));
  file('/etc/varnish/conf.d/vhosts/other.example.org.conf', `backend other_example_org {\n  .host = "${SRC_IP}";\n  .port = "8181";\n}\n`);
  file(`${ng}/vcache.example.org.conf`, nginxSite('vcache.example.org', 'acct2', '/home/acct2/vcache.example.org', { backendPort: 82 }));
  file('/etc/varnish/conf.d/vhosts/vcache.example.org.conf', '# custom backend\nbackend vcache {\n  .host = "192.168.1.20";\n  .port = "8080";\n}\n');
  file(`${ng}/ecc.example.org.conf`, nginxSite('ecc.example.org', 'acct2', '/home/acct2/ecc.example.org', { ssl: true }));
  file(`${ap}/ecc.example.org.conf`, apacheSite('ecc.example.org', 'acct2', '/home/acct2/ecc.example.org'));
  file(`${ng}/go.example.org.conf`, nginxRedirect('go.example.org', 'acct2', 'https://www.example.net$request_uri'));
  file(`${ng}/dead.example.org.conf.disabled`, nginxSite('dead.example.org', 'acct2', '/home/acct2/dead.example.org'));
  file(`${ng}/sub.srvdomain.test.conf`, nginxSite('sub.srvdomain.test', 'acct3', '/home/acct3/public_html'));
  file(`${ap}/sub.srvdomain.test.conf`, apacheSite('sub.srvdomain.test', 'acct3', '/home/acct3/public_html'));
  file(`${ng}/nodeapp.test.conf`, nginxProxy('nodeapp.test', 'acct4', 'http://127.0.0.1:3001', true));
  file(`${ng}/old.example.conf`, nginxSite('old.example', 'acct5', '/home/acct5/public_html'));
  file(`${ap}/old.example.conf`, apacheSite('old.example', 'acct5', '/home/acct5/public_html'));
  file(`${ng}/selfsigned.test.conf`, nginxSite('selfsigned.test', 'acct5', '/home/acct5/selfsigned.test'));
  file(`${ap}/selfsigned.test.conf`, apacheSite('selfsigned.test', 'acct5', '/home/acct5/selfsigned.test'));

  // ── DNS ───────────────────────────────────────────────────────────────────
  file('/var/named/example.tld.db', '; stale file, journal-free zone read through checkzone\n$TTL 14400\n');
  file('/var/named/example.org.db', '$TTL 14400\n');
  file('/var/named/srvdomain.test.db', '$TTL 14400\n');
  node('/var/named/srvdomain.test.db.jnl', 2048);
  file('/var/named/nodeapp.test.db', [
    '; Generated by CWP', '$TTL 300', '$ORIGIN nodeapp.test.',
    '@    86400        IN      SOA     ns3.srvdomain.test. postmaster.nodeapp.test. (',
    '\t\t\t\t2025090843 ; serial', '\t\t\t\t3600            ; refresh', '\t\t\t\t7200 ; retry', '\t\t\t\t1209600 ; expire', '\t\t\t\t86400 )   ; minimum',
    '@\t86400\tIN\tNS\t\tns3.srvdomain.test.', '\t\tIN\tNS\tns4.srvdomain.test.', '@ IN A 203.0.113.10', 'www IN CNAME @',
    'txt IN TXT "v=spf1 +a ~all" "second \\"quoted\\"; part"', 'api 60 A 192.0.2.44', '',
  ].join('\r\n'));
  file('/var/named/forge.test.db', '$TTL 3600\n@ IN SOA ns3.srvdomain.test. hostmaster.forge.test. 1 3600 600 86400 300\n@ IN NS ns3.srvdomain.test.\n@ IN A 192.0.2.10\n');
  node('/var/named/example.tld.db.restore', 300);

  const namedConf = [
    'options {', '\tdirectory "/var/named";', '\trecursion no;', '};', '',
    'key "cwp-updater" { algorithm hmac-sha256; secret "<redacted>"; };',
    '// Zones', '/* the server zone is dynamic */',
    'zone "example.tld" {type master; file "/var/named/example.tld.db";};',
    'zone "example.org" { type master; file "example.org.db"; }; # relative file',
    'zone "srvdomain.test" IN {', '\ttype master;', '\tfile "/var/named/srvdomain.test.db";', '\tallow-update { key "cwp-updater"; };', '};',
    'zone "nodeapp.test" {type master; file "/var/named/nodeapp.test.db"; allow-update { none; };};',
    'zone "." IN { type hint; file "named.ca"; };', '',
  ].join('\n');

  const zoneDumps: Record<string, FakeReply> = {
    'example.tld': [
      'zone example.tld/IN: loaded serial 2025090843',
      'example.tld.\t86400\tIN SOA\tns3.srvdomain.test. postmaster.example.tld. 2025090843 3600 7200 1209600 86400',
      'example.tld.\t86400\tIN NS\tns3.srvdomain.test.', 'example.tld.\t86400\tIN NS\tns4.srvdomain.test.',
      'example.tld.\t14400\tIN A\t203.0.113.10', 'example.tld.\t14400\tIN MX\t0 example.tld.',
      'example.tld.\t14400\tIN TXT\t"v=spf1 +a +mx +ip4:203.0.113.10 ~all"', '_dmarc.example.tld.\t14400\tIN TXT\t"v=DMARC1; p=none"',
      'default._domainkey.example.tld.\t14400\tIN TXT\t"v=DKIM1; k=rsa; " "p=MIIBIjANBgkqh"', 'lan.example.tld.\t300\tIN A\t192.0.2.44',
      'www.example.tld.\t14400\tIN CNAME\texample.tld.', 'OK', '',
    ].join('\n'),
    'example.org': { stdout: '', stderr: 'zone example.org/IN: loading from master file example.org.db failed', exitCode: 1 },
    'srvdomain.test': [
      'zone srvdomain.test/IN: loaded serial 2026100901',
      'srvdomain.test.\t3600\tIN SOA\tns3.srvdomain.test. hostmaster.srvdomain.test. 2026100901 3600 600 86400 300',
      'srvdomain.test.\t3600\tIN NS\tns3.srvdomain.test.', 'srvdomain.test.\t3600\tIN NS\tns4.srvdomain.test.',
      'srvdomain.test.\t3600\tIN A\t203.0.113.10', 'ns3.srvdomain.test.\t3600\tIN A\t203.0.113.10', 'ns4.srvdomain.test.\t3600\tIN A\t203.0.113.11',
      'sub.srvdomain.test.\t3600\tIN A\t203.0.113.10', '_acme-challenge.srvdomain.test.\t60\tIN TXT\t"journal-added"', 'OK', '',
    ].join('\n'),
    'nodeapp.test': { stdout: '', stderr: 'journal out of sync', exitCode: 1 },
  };
  const axfr: Record<string, FakeReply> = {
    'example.org': [
      '; <<>> DiG 9.11.36-RedHat <<>> +noall +answer AXFR example.org @127.0.0.1',
      'example.org.\t\t14400\tIN\tSOA\tns3.srvdomain.test. postmaster.example.org. 2025090801 3600 7200 1209600 86400',
      'example.org.\t\t14400\tIN\tNS\tns3.srvdomain.test.', 'example.org.\t\t14400\tIN\tA\t203.0.113.10',
      'example.org.\t\t14400\tIN\tMX\t10 mail.example.org.', '_sip._tcp.example.org.\t3600\tIN\tSRV\t10 60 5060 sip.example.org.',
      'example.org.\t\t14400\tIN\tCAA\t0 issue "letsencrypt.org"',
      'example.org.\t\t14400\tIN\tSOA\tns3.srvdomain.test. postmaster.example.org. 2025090801 3600 7200 1209600 86400', '',
    ].join('\n'),
    'nodeapp.test': '; <<>> DiG 9.11.36-RedHat <<>> +noall +answer AXFR nodeapp.test @127.0.0.1\n; Transfer failed.\n',
  };

  // ── DKIM ──────────────────────────────────────────────────────────────────
  file('/etc/opendkim/KeyTable', [
    '# OPENDKIM KEY TABLE',
    'default._domainkey.example.tld example.tld:default:/etc/opendkim/userkeys/example.tld/default.private',
    'default._domainkey.example.org example.org:default:/etc/opendkim/userkeys/example.org/default.private', '',
  ].join('\n'));
  file('/etc/opendkim/SigningTable', '# OPENDKIM SIGNING TABLE\n*@example.tld default._domainkey.example.tld\n*@example.org default._domainkey.example.org\n');
  for (const [d, bits] of [['example.tld', 2048], ['example.org', 1024], ['forge.test', 2048]] as const) {
    node(`/etc/opendkim/userkeys/${d}/default.private`, 1700);
    file(`/etc/opendkim/userkeys/${d}/default.txt`, dkimTxt('default', bits));
  }

  // ── crons ─────────────────────────────────────────────────────────────────
  file('/var/spool/cron/acct1', [
    'MAILTO=""', 'SHELL="/bin/bash"',
    '*/5 * * * * /usr/local/bin/php /home/acct1/public_html/wp-cron.php > /home/acct1/public_html/cron.log 2>&1',
    '0 3 * * * /opt/alt/php73/usr/bin/php /home/acct1/app/artisan schedule:run >> /dev/null 2>&1',
    '@reboot /home/acct1/scripts/start.sh',
    '#30 2 * * * /usr/local/bin/php /home/acct1/old.php', '',
  ].join('\n'));
  file('/var/spool/cron/root', '0 */1 * * * /usr/local/cwp/php71/bin/php -d max_execution_time=1000 -q /usr/local/cwpsrv/htdocs/resources/admin/include/cron.php\n17 * * * * rndc sync -clean\n');
  file('/var/spool/cron/botuser', '*/10 * * * * /usr/bin/python3.9 /home/acct1/node/bot/health.py\n');

  // ── certificates ──────────────────────────────────────────────────────────
  file('/etc/pki/tls/certs/example.tld.cert', exampleTldPem);
  file('/etc/pki/tls/certs/example.tld.bundle', caPem);
  file('/etc/pki/tls/certs/old.example.cert', oldExamplePem);
  file('/etc/pki/tls/certs/ecc.example.org.cert', eccExampleOrgPem);
  file('/etc/pki/tls/certs/ecc.example.org.bundle', `${eccExampleOrgPem}${caPem}`);
  file('/etc/pki/tls/certs/selfsigned.test.cert', selfSignedPem);
  node('/etc/pki/tls/certs/hostname.bundle', 2000);

  // ── systemd ───────────────────────────────────────────────────────────────
  unitFiles['/etc/systemd/system/nodesvc.service'] = '[Unit]\nDescription=App main\nAfter=network.target\n\n[Service]\nUser=svcnode\nWorkingDirectory=/home/acct1/node/App\nEnvironment=<redacted>\nExecStart=/usr/bin/node /home/acct1/node/App/main.js --token=abc123 --port 3005\nRestart=always\n\n[Install]\nWantedBy=multi-user.target\n';
  unitFiles['/etc/systemd/system/nodeapp.service'] = '[Unit]\nDescription=Node app of acct4\n\n[Service]\nUser=acct4\nWorkingDirectory=/home/acct4/node/app\nExecStart=/usr/bin/node server.js --port 3001\n';
  unitFiles['/etc/systemd/system/pybot.service'] = '[Unit]\nDescription=Bot\n\n[Service]\nUser=botuser\nWorkingDirectory=/home/acct1/node/bot\nExecStart=/usr/bin/python3.9 /home/acct1/node/bot/main.py\nEnvironmentFile=/home/acct1/node/bot/.env\n';
  unitFiles['/etc/systemd/system/obliview-agent.service'] = '[Unit]\nDescription=Obliview agent\n\n[Service]\nExecStart=/usr/local/bin/obliview-agent\n';
  for (const p of Object.keys(unitFiles)) node(p, unitFiles[p].length);
  vfs.set('/etc/systemd/system/dbus-org.freedesktop.nm-dispatcher.service', { type: 'l', size: 0, uid: 0 });

  // ── command handlers ──────────────────────────────────────────────────────
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash', 'bin:x:1:1:bin:/bin:/sbin/nologin', 'nobody:x:65534:65534:Kernel Overflow User:/:/sbin/nologin',
    'acct1:x:1001:1001::/home/acct1:/bin/bash', 'acct2:x:1002:1002::/home/acct2:/sbin/nologin', 'acct3:x:1003:1003::/home/acct3:/sbin/nologin',
    'acct4:x:1004:1004::/home/acct4:/sbin/nologin', 'acct5:x:1005:1005::/home/acct5:/sbin/nologin', 'acct6:x:1006:1006::/home/acct6:/sbin/nologin',
    'odd:x:1018:1018::/:/sbin/nologin', 'svcnode:x:1019:1019::/home/svcnode:/sbin/nologin', 'botuser:x:1020:1020:Bot, ops:/home/botuser:/bin/bash', '',
  ].join('\n');
  node('/home/botuser/.ssh/authorized_keys', 400, 1020, { lines: 1 });

  const queries = new Map<string, string>([
    [SQL.version, tsv(['version'], [['10.3.39-MariaDB']])],
    [SQL.users, tsv(['id', 'username', 'domain', 'ip_address', 'email', 'setup_date', 'package', 'reseller'], [
      [1, 'acct1', 'example.tld', SRC_IP, 'owner@example.net', '2025-09-05 19:11:44', '2', ''],
      [2, 'acct2', 'example.org', SRC_IP, 'owner2@example.net', '2025-09-05 23:28:15', '1', ''],
      [3, 'acct3', 'sub.srvdomain.test', SRC_IP, 'owner3@example.net', '2025-09-05 23:28:15', '1', ''],
      [4, 'acct4', 'nodeapp.test', SRC_IP, '', '2025-09-06 10:00:00', '2', ''],
      [5, 'acct5', 'old.example', SRC_IP, 'owner5@example.net', '2025-09-06 10:00:00', '2', ''],
      [6, 'acct6', 'lan.test', SRC_IP, 'owner6@example.net', '2025-09-06 10:00:00', '2', ''],
    ])],
    [SQL.packages, tsv(['id', 'package_name', 'disk_quota', 'bandwidth', 'ftp_accounts', 'email_accounts', 'email_lists', 'databases', 'sub_domains', 'parked_domains', 'addons_domains', 'hourly_emails', 'reseller', 'accounts', 'nproc', 'inode'], [
      [1, 'default', '20000', '100000', '10', '10', '10', '10', '10', '10', '10', '200', '', '', '40', '0'],
      [2, 'UNLIMITED', '999999', '-1', '-1', '-1', '-1', '-1', '-1', '-1', '-1', '999999', '', '', '40', '0'],
    ])],
    [SQL.domains, tsv(['id', 'domain', 'user', 'path'], [
      [1, 'alias.example.tld', 'acct1', '/home/acct1/public_html'],
      [2, 'other.example.org', 'acct2', '/home/acct2/other.example.org'],
      [3, 'vcache.example.org', 'acct2', '/home/acct2/vcache.example.org'],
      [4, 'ecc.example.org', 'acct2', '/home/acct2/ecc.example.org'],
      [5, 'go.example.org', 'acct2', '/home/acct2/go.example.org'],
      [6, 'dead.example.org', 'acct2', '/home/acct2/dead.example.org'],
      [7, 'selfsigned.test', 'acct5', '/home/acct5/selfsigned.test'],
    ])],
    [SQL.subdomains, tsv(['id', 'subdomain', 'domain', 'user', 'path'], [
      [1, 'a.b', 'example.tld', 'acct1', '/home/acct1/a.b.example.tld'],
      [2, 'blog', 'example.tld', 'acct1', '/home/acct1/public_html/blog'],
      [3, 'app', 'example.tld', 'acct1', '/home/acct1/app/public'],
      [4, 'ws', 'example.tld', 'acct1', '/home/acct1/ws.example.tld'],
      [5, 'old', 'example.tld', 'acct1', '/home/acct1/old'],
      [6, 'sub', 'srvdomain.test', 'acct3', '/home/acct3/sub.srvdomain.test'],
    ])],
    [SQL.nameservers, tsv(['ns1_name', 'ns1_ip', 'ns2_name', 'ns2_ip'], [['ns3.srvdomain.test', SRC_IP, 'ns4.srvdomain.test', '203.0.113.11']])],
    [DB_SQL.schemata, tsv(['SCHEMA_NAME', 'DEFAULT_CHARACTER_SET_NAME', 'DEFAULT_COLLATION_NAME'], [
      ['acct1_wp', 'utf8mb4', 'utf8mb4_unicode_ci'], ['acct1_legacy', 'latin1', 'latin1_swedish_ci'], ['acct1x_tools', 'utf8', 'utf8_general_ci'],
      ['acct2_shop', 'utf8mb4', 'utf8mb4_general_ci'], ['ghost_data', 'latin1', 'latin1_swedish_ci'],
    ])],
    [DB_SQL.tables, tsv(['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'TABLE_COLLATION', 'SIZE_BYTES'], [
      ['acct1_wp', 'wp_posts', 'BASE TABLE', 'InnoDB', 'utf8mb4_unicode_ci', 3_000_000], ['acct1_wp', 'wp_options', 'BASE TABLE', 'InnoDB', 'utf8mb4_unicode_ci', 1_000_000],
      ['acct1_wp', 'v_posts', 'VIEW', null, null, null],
      ['acct1_legacy', 'sessions', 'BASE TABLE', 'MEMORY', 'latin1_swedish_ci', 0], ['acct1_legacy', 'logs', 'BASE TABLE', 'MyISAM', 'latin1_swedish_ci', 500_000],
      ['acct1_legacy', 'users', 'BASE TABLE', 'InnoDB', 'latin1_bin', 16384], ['acct1x_tools', 'kv', 'BASE TABLE', 'InnoDB', 'utf8_general_ci', 16384],
      ['acct2_shop', 'orders', 'BASE TABLE', 'InnoDB', 'utf8mb4_general_ci', 65536], ['acct2_shop', 'v_orders', 'VIEW', null, null, null],
      ['ghost_data', 't', 'BASE TABLE', 'MyISAM', 'latin1_swedish_ci', 1024],
    ])],
    [DB_SQL.triggers, tsv(['TRIGGER_SCHEMA', 'TRIGGER_NAME', 'DEFINER'], [
      ['acct1_wp', 'trg_posts_bi', 'acct1_wp@localhost'], ['acct1_wp', 'trg_options_bu', 'acct1_app@%'],
    ])],
    [DB_SQL.views, tsv(['TABLE_SCHEMA', 'TABLE_NAME', 'DEFINER', 'SECURITY_TYPE'], [
      ['acct1_wp', 'v_posts', 'acct1_wp@localhost', 'DEFINER'], ['acct2_shop', 'v_orders', 'acct2_shop@%', 'DEFINER'],
    ])],
    [DB_SQL.routines, tsv(['ROUTINE_SCHEMA', 'ROUTINE_NAME', 'DEFINER', 'SECURITY_TYPE'], [])],
    [DB_SQL.events, tsv(['EVENT_SCHEMA', 'EVENT_NAME', 'DEFINER'], [])],
    [DB_SQL.grants, tsv(['Host', 'Db', 'User', 'Select_priv', 'Insert_priv', 'Update_priv', 'Delete_priv', 'Create_priv', 'Drop_priv', 'Grant_priv', 'References_priv', 'Index_priv', 'Alter_priv', 'Create_tmp_table_priv', 'Lock_tables_priv', 'Create_view_priv', 'Show_view_priv', 'Create_routine_priv', 'Alter_routine_priv', 'Execute_priv', 'Event_priv', 'Trigger_priv'], [
      ['localhost', 'acct1\\_%', 'acct1', ...'YYYYYYNYYYYYYYYYYYY'.split('').slice(0, 19)],
      ['localhost', 'acct1\\_wp', 'acct1_wp', ...'YYYYYYNYYYYYYYYYYYY'.split('').slice(0, 19)],
      ['10.0.0.%', 'acct1\\_wp', 'acct1_app', 'Y', 'Y', 'Y', 'Y', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N'],
      ['localhost', 'acct2\\_shop', 'acct2_shop', ...'YYYYYYNYYYYYYYYYYYY'.split('').slice(0, 19)],
    ])],
    [MAIL_SQL.domains, tsv(['domain', 'backupmx', 'active'], [['example.tld', 0, 1], ['example.org', 0, 1]])],
    [MAIL_SQL.aliases, tsv(['address', 'goto', 'domain', 'active'], [
      ['fwd@example.tld', 'someone@external.example', 'example.tld', 1], ['@example.tld', 'contact@example.tld', 'example.tld', 1],
      ['contact@example.tld', 'contact@example.tld', 'example.tld', 1], ['team@example.org', 'info@example.org, contact@example.tld', 'example.org', 3],
    ])],
    [MAIL_SQL.quota, tsv(['username', 'bytes', 'messages'], [['contact@example.tld', 12_345_678, 4353]])],
  ]);

  const userMeta = tsv(['User', 'Host', 'plugin', 'hash_kind', 'max_user_connections'], [
    ['root', 'localhost', '', 'native', 0], ['acct1', 'localhost', '', 'native', 0], ['acct1_wp', 'localhost', 'mysql_native_password', 'native', 0],
    ['acct1_app', 'localhost', '', 'native', 0], ['acct1_app', '10.0.0.%', '', 'native', 0], ['acct2_shop', 'localhost', '', 'native', 10],
    ['ghost_app', 'localhost', '', 'native', 0], ['roundcube', 'localhost', '', 'native', 0], ['postfix', 'localhost', '', 'native', 0],
  ]);
  const mailboxMeta = tsv(['username', 'local_part', 'domain', 'maildir', 'quota', 'uid', 'gid', 'active', 'name', 'scheme'], [
    ['contact@example.tld', 'contact', 'example.tld', 'example.tld/contact/', 0, 1001, 12, 1, 'Contact', 'SHA512-CRYPT'],
    ['legacy@example.tld', 'legacy', 'example.tld', 'example.tld/legacy/', 1073741824, 1001, 12, 0, null, 'MD5-CRYPT*'],
    ['info@example.org', 'info', 'example.org', 'example.org/info/', 0, 1002, 12, 1, 'Info\tdesk', 'SHA512-CRYPT'],
  ]);
  node('/var/vmail/example.tld/contact/cur/1675717694.M949111P19770.cwp,S=18136,W=18375:2,S', 18136);
  node('/var/vmail/example.tld/contact/dovecot-uidlist', 300);
  node('/var/vmail/example.org/info/new/1.msg', 5000);
  dir('/var/vmail/example.org/info/sieve');
  node('/var/vmail/example.org/info/dovecot.sieve', 100);
  dir('/var/vmail/example.tld/legacy');

  const ftp = [
    'ftpuser@example.tld:1001:1001:/home/acct1/public_html/./:2a',
    'backup@example.tld:1001:1001:/home/acct1/./:2y',
    'shop@example.org:1002:1002:/home/acct2/public_html/./:6',
    'weird@example.org:x:1002:/home/acct2/ftp:dir/./:other', '',
  ].join('\n');

  const depth = (p: string) => p.split('/').filter(Boolean).length;
  const handlers: FakeHandlers = {
    'sys.whoami': () => 'root\n',
    'sys.hostname': () => 'cwp.srvdomain.test\n',
    'sys.osRelease': () => 'NAME="Rocky Linux"\nVERSION="8.10 (Green Obsidian)"\nVERSION_ID="8.10"\nPRETTY_NAME="Rocky Linux 8.10 (Green Obsidian)"\nRocky Linux release 8.10 (Green Obsidian)\n',
    'sys.ipAddrs': () => [
      '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever',
      '1: lo    inet6 ::1/128 scope host \\       valid_lft forever preferred_lft forever',
      `2: eth0    inet ${SRC_IP}/27 brd 203.0.113.31 scope global eth0\\       valid_lft forever preferred_lft forever`,
      '2: eth0    inet6 fe80::1/64 scope link \\       valid_lft forever preferred_lft forever',
      '3: eth1    inet 10.99.0.2/24 brd 10.99.0.255 scope global eth1\\       valid_lft forever preferred_lft forever', '',
    ].join('\n'),
    'sys.passwd': () => passwd,
    // P6: tool versions (command -v + version flag), never rpm — what the fake CWP image answers.
    'sys.toolVersions': () => [
      'rsync|/usr/bin/rsync|rsync  version 3.1.3  protocol version 31',
      'mysqldump|/usr/bin/mysqldump|mysqldump  Ver 10.19 Distrib 10.3.39-MariaDB, for Linux (x86_64)',
      'mysql|/usr/bin/mysql|mysql  Ver 15.1 Distrib 10.3.39-MariaDB, for Linux (x86_64) using readline 5.1',
      'named-checkzone|/usr/sbin/named-checkzone|9.11.36-RedHat-9.11.36-11.el8_9',
      'postconf|/usr/sbin/postconf|mail_version = 3.5.8',
      'doveconf|/usr/bin/doveconf|2.3.16 (7e2e900c1a)',
      '',
    ].join('\n'),
    'sys.unitFile': ({ path }) => (path in unitFiles ? unitFiles[path] : { stdout: '', exitCode: 1 }),
    'mysql.query': ({ sql }) => {
      sqlSeen.push(sql);
      const out = queries.get(sql);
      if (out === undefined) return { stdout: '', stderr: 'unexpected query', exitCode: 1 };
      return out;
    },
    'mysql.userMeta': () => userMeta,
    'mail.mailboxMeta': () => mailboxMeta,
    'dns.namedConf': () => namedConf,
    'dns.zoneDump': ({ zone }) => zoneDumps[zone] ?? { stdout: '', exitCode: 1 },
    'dns.axfr': ({ zone }) => axfr[zone] ?? '; Transfer failed.\n',
    'ftp.listUsers': () => ftp,
    'fs.find': ({ path, maxDepth, type, name }) => {
      const base = depth(path);
      if (!vfs.has(path)) return { stdout: '', stderr: `find: '${path}': No such file or directory`, exitCode: 1 };
      const re = name ? globRe(name) : null;
      const out: string[] = [];
      for (const [p, n] of vfs) {
        if (p !== path && !p.startsWith(`${path}/`)) continue;
        if (depth(p) - base > maxDepth) continue;
        if (type && n.type !== type) continue;
        if (re && !re.test(p.slice(p.lastIndexOf('/') + 1))) continue;
        out.push(`${n.type}|${n.type === 'd' ? 755 : 644}|u${n.uid}|g${n.uid}|${n.size}|1700000000.0|${p}|`);
      }
      return out.join('\n') + (out.length ? '\n' : '');
    },
    'fs.stat': ({ paths }) => paths.filter((p) => vfs.has(p)).map((p) => {
      const n = vfs.get(p) as VNode;
      return `${p}|${n.type === 'd' ? 'directory' : n.type === 'l' ? 'symbolic link' : 'regular file'}|${n.size}|${n.uid}|${n.uid}|644|1700000000`;
    }).join('\n') + '\n',
    'fs.du': ({ paths }) => paths.filter((p) => vfs.has(p)).map((p) => {
      let total = 0;
      for (const [q, n] of vfs) if (q === p || q.startsWith(`${p}/`)) total += n.size;
      return `${total}\t${p}`;
    }).join('\n') + '\n',
    'fs.lineCount': ({ paths }) => {
      const rows = paths.filter((p) => vfs.get(p)?.lines !== undefined).map((p) => `  ${vfs.get(p)?.lines} ${p}`);
      return { stdout: rows.join('\n') + '\n', exitCode: rows.length === paths.length ? 0 : 1 };
    },
    'fs.grepRefs': ({ root, names, home }) => {
      const re = new RegExp(refsRegex(names, home), 'gm');
      const out: string[] = [];
      for (const [p, content] of Object.entries(files)) {
        if (!p.startsWith(`${root}/`) || depth(p) - depth(root) > REFS_DEPTH || p.endsWith('/wp-config.php')) continue;
        if (!/\.(php|inc|phtml|ini|py|pl|cgi|sh)$|\/\.htaccess$/.test(p)) continue;
        for (const m of content.matchAll(re)) out.push(`${p}:${m[0]}`);
      }
      return { stdout: out.join('\n') + (out.length ? '\n' : ''), exitCode: out.length ? 0 : 1 };
    },
    'fs.grepHtaccess': ({ root, maxDepth }) => {
      const base = depth(root);
      const out: string[] = [];
      for (const [p, content] of Object.entries(files)) {
        if (!p.startsWith(`${root}/`) || !p.endsWith('/.htaccess') || depth(p) - base > maxDepth) continue;
        content.split('\n').forEach((l, i) => {
          if (/^[\s]*(AddHandler|SetHandler|AddType)[\s].*php/i.test(l)) out.push(`${p}:${i + 1}:${l}`);
        });
      }
      return { stdout: out.join('\n') + (out.length ? '\n' : ''), exitCode: out.length ? 0 : 1 };
    },
  };

  // Files whose content discovery may read (wp-config.php, keys… stay in the vfs only).
  return { options: { phase: 'discovery', handlers, files }, vfs, files, sqlSeen };
}
