import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellInt, parseMysqlBatch, parseMysqlRows } from './mysqlBatch';
import {
  classifyIp, isInteractiveShell, isPrivateAddress, parseDu, parseFind, parseIpAddrs, parseLineCount, parseOsRelease, parsePasswd,
  parseStat, parseToolVersions, toolVersionOf, UNKNOWN_TOOL_VERSION,
} from './system';
import {
  parseAddonsWp, parseCwpPro, parseCwpVersionPhp, parseDomainWebConf, parseMysqlUserPrefixes, parseSuphpHandlers, parseVhostsSslJson,
  parseWebServersConf, phpDigitsToVersion, phpVersionOfHandler,
} from './cwpConf';

// Parsers of the mysql --batch, sys.* / fs.* and CWP configuration outputs (formats of docs/P5-PLAN.md §5.4 bis, docs/cwp).

test('mysql --batch: header, NULL, escapes, CRLF, short rows', () => {
  const out = 'User\tHost\tnote\nacct1\tlocalhost\tNULL\nacct1_app\t10.0.0.%\ta\\tb\\nc\\\\d\\0e\r\nshort\n';
  const rows = parseMysqlBatch(out, { header: true });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { User: 'acct1', Host: 'localhost', note: null });
  assert.equal(rows[1].note, 'a\tb\nc\\d\0e');
  assert.equal(rows[1].Host, '10.0.0.%');
  assert.deepEqual(rows[2], { User: 'short', Host: null, note: null });
  // escaped LIKE pattern as stored in mysql.db
  assert.equal(parseMysqlBatch('Db\nacct1\\\\_%\n', { header: true })[0].Db, 'acct1\\_%');
  assert.deepEqual(parseMysqlRows('1\t2\n'), [['1', '2']]);
  assert.deepEqual(parseMysqlBatch('', { header: true }), []);
  assert.deepEqual(parseMysqlBatch('a\tb\n', { header: false }), [{ 0: 'a', 1: 'b' }]);
  assert.equal(cellInt('42'), 42);
  assert.equal(cellInt(null), null);
  assert.equal(cellInt('x'), null);
  // unicode + huge line
  const big = 'é'.repeat(200_000);
  assert.equal(parseMysqlBatch(`c\n${big}\n`, { header: true })[0].c, big);
});

test('getent passwd + shells', () => {
  const p = parsePasswd('root:x:0:0:root:/root:/bin/bash\nbot:x:1020:1020:Bot, ops:/home/bot:/bin/bash\nbad line\nx:x:a:1::/:/bin/sh\r\n');
  assert.equal(p.length, 2);
  assert.deepEqual(p[1], { name: 'bot', uid: 1020, gid: 1020, gecos: 'Bot, ops', home: '/home/bot', shell: '/bin/bash' });
  assert.equal(isInteractiveShell('/sbin/nologin'), false);
  assert.equal(isInteractiveShell('/bin/false'), false);
  assert.equal(isInteractiveShell('/usr/bin/zsh'), true);
  assert.equal(isInteractiveShell(''), false);
});

test('os-release / ip addr', () => {
  assert.equal(parseOsRelease('NAME="Rocky Linux"\nPRETTY_NAME="Rocky Linux 8.10 (Green Obsidian)"\nRocky Linux release 8.10\n'), 'Rocky Linux 8.10 (Green Obsidian)');
  assert.equal(parseOsRelease('CentOS Linux release 7.9.2009 (Core)\n'), 'CentOS Linux release 7.9.2009 (Core)');
  const ips = parseIpAddrs([
    '1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever',
    '2: eth0    inet 203.0.113.10/27 brd 203.0.113.31 scope global eth0\\       valid_lft forever',
    '2: eth0    inet6 fe80::1/64 scope link \\       valid_lft forever',
    '4: br-x@if5    inet 10.99.0.2/24 scope global br-x',
    'garbage',
  ].join('\n'));
  assert.equal(ips.length, 4);
  assert.deepEqual(ips[1], { iface: 'eth0', family: 'inet', address: '203.0.113.10', prefix: 27, scope: 'global' });
  assert.equal(ips[3].iface, 'br-x');
  assert.equal(classifyIp('203.0.113.10'), 'public');
  assert.equal(classifyIp('10.99.0.2'), 'private');
  assert.equal(classifyIp('100.64.1.1'), 'private');
  assert.equal(classifyIp('fd00::1'), 'private');
  assert.equal(classifyIp('::1'), 'loopback');
  assert.equal(classifyIp('fe80::1'), 'link-local');
  assert.equal(classifyIp('::ffff:192.168.1.5'), 'private');
  assert.equal(classifyIp('example.com'), 'invalid');
  assert.equal(isPrivateAddress('localhost'), true);
  assert.equal(isPrivateAddress('192.168.1.30'), true);
  assert.equal(isPrivateAddress('backend.example'), false);
});

test('tool versions (sys.toolVersions, P6: no rpm): version of each first line, absent tools left out', () => {
  const out = [
    'rsync|/usr/bin/rsync|rsync  version 3.1.3  protocol version 31',
    'mysqldump|/usr/bin/mysqldump|mysqldump  Ver 10.19 Distrib 10.3.39-MariaDB, for Linux (x86_64)',
    'mysql|/usr/bin/mysql|mysql from 11.4.2-MariaDB, client 15.2 for linux-systemd (x86_64) using  EditLine wrapper',
    'named-checkzone|/usr/sbin/named-checkzone|9.11.36-RedHat-9.11.36-11.el8_9',
    'postconf|/usr/sbin/postconf|mail_version = 3.5.8',
    'doveconf|-|',
    'garbage line',
    'nginx|relative/path|nginx version: nginx/1.14.1',
    '',
  ].join('\r\n');
  assert.deepEqual(parseToolVersions(out), {
    rsync: '3.1.3', mysqldump: '10.3.39-MariaDB', mysql: '11.4.2-MariaDB', 'named-checkzone': '9.11.36-RedHat-9.11.36-11.el8_9', postconf: '3.5.8',
  });
  assert.equal(parseToolVersions('rsync|/usr/bin/rsync|\n').rsync, UNKNOWN_TOOL_VERSION, 'present, version unreadable: still present (no rsyncMissing)');
  assert.deepEqual(parseToolVersions('rsync|-|\n'), {});
  assert.equal(toolVersionOf('mysql  Ver 8.0.36 for Linux on x86_64 (MySQL Community Server - GPL)'), '8.0.36');
  assert.equal(toolVersionOf('2.3.16 (7e2e900c1a)'), '2.3.16');
  assert.equal(toolVersionOf('rsync  version v3.2.7  protocol version 31'), '3.2.7');
  assert.equal(toolVersionOf('no digits here'), null);
  assert.ok((toolVersionOf(`9.${'1'.repeat(200)}`) ?? '').length <= 64);
});

test('find -printf / stat / du / wc outputs', () => {
  const f = parseFind([
    'd|755|acct1|acct1|4096|1700000000.1234567890|/home/acct1/public_html|',
    'l|777|acct1|acct1|11|1700000000.0|/home/acct1/link|/etc/shadow',
    'f|644|acct1|acct1|10|1700000000.0|/home/acct1/we|rd|',
    'f|644|x|x|1|1|relative|',
    'short|line',
  ].join('\n'));
  assert.equal(f.length, 3);
  assert.equal(f[1].link, '/etc/shadow');
  assert.equal(f[2].path, '/home/acct1/we|rd');
  const s = parseStat('/home/a|b|directory|4096|1001|1001|755|1700000000\n/x|regular file|5|0|0|644|1\n');
  assert.equal(s.get('/home/a|b')?.kind, 'directory');
  assert.equal(s.get('/x')?.size, 5);
  const du = parseDu('123\t/home/acct1\n9 /home/with space\nnope\n');
  assert.equal(du.get('/home/acct1'), 123);
  assert.equal(du.get('/home/with space'), 9);
  const wc = parseLineCount('  2 /home/acct1/.ssh/authorized_keys\n  1 /home/b/.ssh/authorized_keys\n  3 total\n');
  assert.equal(wc.get('/home/acct1/.ssh/authorized_keys'), 2);
  assert.equal(wc.size, 2);
});

test('CWP configuration files', () => {
  assert.equal(parseCwpVersionPhp('<?php\n$webpanel_version = "1.18";\n'), '1.18');
  assert.equal(parseCwpVersionPhp("<?php $webpanel_version='0.9.8.1209';"), '0.9.8.1209');
  assert.equal(parseCwpVersionPhp('<?php echo 1;'), null);
  assert.equal(parseCwpPro('1\n'), true);
  assert.equal(parseCwpPro('0'), false);
  assert.equal(parseCwpPro(null), false);
  assert.equal(parseWebServersConf('{"webserver_setup":"nginx-varnish-apache"}')?.webserverSetup, 'nginx-varnish-apache');
  assert.equal(parseWebServersConf('{broken'), null);
  const ssl = parseVhostsSslJson('{"Example.TLD":{"user":"acct1","install_date":"x","expiry_date":"y","san":["a"],"autossl":"on"},"x":1}');
  assert.equal(ssl?.get('example.tld')?.autossl, true);
  assert.equal(ssl?.size, 1);

  const normal = parseDomainWebConf('{"nginx_template-type":"default","nginx_template-name":"default","varnish_template-name":"default","apache_template-type":"php-fpm","apache_template-name":"all_methods","php-fpm_ver":"56","nginx":true,"varnish":true,"php-fpm":true,"apache-additional":true}');
  assert.equal(normal?.phpFpmVersion, '5.6');
  assert.equal(normal?.apacheTemplate, 'all_methods');
  assert.equal(normal?.customIp, null);
  const proxy = parseDomainWebConf('{"nginx_template-type":"default","nginx_template-name":"default","custom-port":"8123","custom-ip":"192.168.1.5","nginx":true}');
  assert.equal(proxy?.customIp, '192.168.1.5');
  assert.equal(proxy?.customPort, 8123);
  assert.equal(parseDomainWebConf('{"custom-port":"99999","custom-ip":" "}')?.customPort, null);
  assert.equal(parseDomainWebConf('[1,2]'), null);

  const wp = parseAddonsWp('[{"domain":"Example.tld","path":"/home/acct1/public_html/","wpbd":"acct1_sh628","wpuserdb":"acct1_sh826","version":null,"footprint":"x"},{"path":"relative"}]');
  assert.deepEqual(wp, [{ domain: 'example.tld', path: '/home/acct1/public_html', database: 'acct1_sh628', dbUser: 'acct1_sh826', version: null }]);
  assert.equal(parseAddonsWp('nope'), null);

  const suphp = parseSuphpHandlers('[handlers]\n;comment\napplication/x-httpd-php="php:/usr/local/bin/php-cgi"\nx-httpd-php56="php:/opt/alt/php56/usr/bin/php-cgi"\napplication/x-httpd-php74=php:/opt/alt/php74/usr/bin/php-cgi\n');
  assert.equal(suphp.get('x-httpd-php'), '/usr/local/bin/php-cgi');
  assert.equal(suphp.get('x-httpd-php56'), '/opt/alt/php56/usr/bin/php-cgi');
  assert.equal(phpVersionOfHandler('application/x-httpd-php74', suphp, '8.3'), '7.4');
  assert.equal(phpVersionOfHandler('x-httpd-php', suphp, '8.3'), '8.3');
  assert.equal(phpVersionOfHandler('application/x-httpd-ea-php81', suphp, '8.3'), '8.1');
  assert.equal(phpVersionOfHandler('x-httpd-foo', suphp, '8.3'), null);
  assert.equal(phpDigitsToVersion('83'), '8.3');
  assert.equal(phpDigitsToVersion('8'), null);
  assert.deepEqual(parseMysqlUserPrefixes('acct1x\n# comment\nfoo_, bar baz=qux\n'), ['acct1x', 'foo', 'bar', 'baz', 'qux']);
});
