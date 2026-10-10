import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { joinTxtStrings, parseDkimTxt, parseKeyTable, parseOpendkimConf, parseSigningTable, signingPatternMatches } from './dkim';
import { parseFtpListUsers } from './ftp';
import { detectCronPhp, parseCrontab } from './crontab';
import { certCovers, parseCertificate, pemCertificates } from './x509';
import { parseUnitFile, parseVarnishBackends, redactArgs } from './systemd';
import { redactCommand } from './redact';
import { caPem, eccExampleOrgPem, exampleTldPem, oldExamplePem, selfSignedPem } from '../fixtures/certs';

// OpenDKIM, Pure-FTPd, crontab, X.509, systemd and Varnish parsers.

function spki(bits: number): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
}

test('OpenDKIM: conf, KeyTable, SigningTable, public .txt (2048 / 1024 / pkcs1 / ed25519 / revoked)', () => {
  assert.deepEqual(parseOpendkimConf('KeyTable                refile:/etc/opendkim/KeyTable\nSigningTable refile:/etc/opendkim/SigningTable # x\nSelector default\n'), {
    keyTable: '/etc/opendkim/KeyTable', signingTable: '/etc/opendkim/SigningTable', selector: 'default',
  });
  const kt = parseKeyTable('# c\ndefault._domainkey.Example.TLD example.tld:default:/etc/opendkim/userkeys/example.tld/default.private\nbroken line\n');
  assert.deepEqual(kt, [{ keyName: 'default._domainkey.example.tld', domain: 'example.tld', selector: 'default', keyPath: '/etc/opendkim/userkeys/example.tld/default.private' }]);
  const st = parseSigningTable('*@example.tld default._domainkey.example.tld\n# x\n');
  assert.equal(signingPatternMatches(st[0].pattern, 'x@example.tld'), true);
  assert.equal(signingPatternMatches(st[0].pattern, 'x@example.tldx'), false);

  const k2048 = spki(2048);
  const txt = `default._domainkey\tIN\tTXT\t( "v=DKIM1; k=rsa; "\n\t  "p=${k2048.slice(0, 100)}"\n\t  "${k2048.slice(100)}" )  ; ----- DKIM key default for example.tld\n`;
  const p = parseDkimTxt(txt);
  assert.equal(p.bits, 2048);
  assert.equal(p.algorithm, 'rsa');
  assert.equal(p.publicKey, k2048);
  assert.equal(parseDkimTxt(`"v=DKIM1; p=${spki(1024)}"`).bits, 1024);
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs1 = (publicKey.export({ type: 'pkcs1', format: 'der' }) as Buffer).toString('base64');
  assert.equal(parseDkimTxt(`"v=DKIM1; k=rsa; p=${pkcs1}"`).bits, 2048);
  assert.deepEqual(parseDkimTxt('"v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="'), { publicKey: '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=', algorithm: 'ed25519', bits: null });
  assert.deepEqual(parseDkimTxt('"v=DKIM1; k=rsa; p="'), { publicKey: '', algorithm: 'rsa', bits: null });
  assert.equal(parseDkimTxt('"v=DKIM1; p=not-base64!!"').publicKey, null);
  assert.equal(parseDkimTxt('"v=DKIM1; p=QUJD"').bits, null);
  assert.equal(joinTxtStrings('"a\\"b" "c"'), 'a"bc');
});

test('Pure-FTPd listUsers: chroot marker, schemes, hostile lines', () => {
  const u = parseFtpListUsers('ftpuser@example.tld:1001:1001:/home/acct1/public_html/./:2a\nb:1001:1001:/home/acct1/:6\nw:x:1:/a:b/./:zz\n\nbad\n');
  assert.deepEqual(u[0], { login: 'ftpuser@example.tld', uid: 1001, gid: 1001, directory: '/home/acct1/public_html', chroot: true, hashScheme: 'bcrypt' });
  assert.deepEqual(u[1], { login: 'b', uid: 1001, gid: 1001, directory: '/home/acct1', chroot: false, hashScheme: 'sha512-crypt' });
  assert.equal(u[2].uid, null);
  assert.equal(u[2].directory, '/a:b');
  assert.equal(u[2].hashScheme, 'other');
  assert.equal(u.length, 3);
});

test('crontab: env lines, specials, disabled lines, PHP detection, CRLF', () => {
  const c = parseCrontab([
    'MAILTO=""', 'SHELL=/bin/bash', '# This file is managed by CWP', '',
    '*/5 * * * * /usr/local/bin/php /home/acct1/public_html/wp-cron.php > /home/acct1/public_html/cron.log 2>&1',
    '0 3 * * 1-5 /opt/alt/php73/usr/bin/php -q /home/acct1/app/artisan schedule:run',
    '@reboot /home/acct1/scripts/start.sh', '@Daily  cd /home/x && php artisan foo',
    '#30 2 * * * /usr/local/bin/php /home/acct1/old.php', '# 1 2 3 4', '0 0 1 JAN * echo "a;b" | mail -s x y',
  ].join('\r\n'), '8.3');
  assert.equal(c.length, 6);
  assert.deepEqual(c[0], {
    lineNo: 5, schedule: '*/5 * * * *', command: '/usr/local/bin/php /home/acct1/public_html/wp-cron.php > /home/acct1/public_html/cron.log 2>&1',
    disabled: false, phpBinary: '/usr/local/bin/php', phpVersion: '8.3',
  });
  assert.equal(c[1].phpVersion, '7.3');
  assert.equal(c[1].phpBinary, '/opt/alt/php73/usr/bin/php');
  assert.equal(c[2].schedule, '@reboot');
  assert.equal(c[3].schedule, '@daily');
  assert.equal(c[3].phpBinary, 'php');
  assert.equal(c[4].disabled, true);
  assert.equal(c[4].lineNo, 9);
  assert.equal(c[5].command, 'echo "a;b" | mail -s x y');
  assert.deepEqual(detectCronPhp('/opt/alt/php-fpm81/usr/sbin/php-fpm', '8.3'), { phpBinary: null, phpVersion: null });
  assert.equal(detectCronPhp('/usr/bin/php74 x.php', null).phpVersion, '7.4');
});

test('X.509: SAN + CN, validity, issuer, self-signed, key types, coverage', () => {
  const valid = parseCertificate(exampleTldPem);
  assert.ok(valid);
  assert.deepEqual(valid.names.sort(), ['example.tld', 'mail.example.tld', 'www.example.tld']);
  assert.equal(valid.notAfter, '2099-01-01T00:00:00.000Z');
  assert.equal(valid.issuer, 'O=Example Test CA, CN=Test CA R1');
  assert.equal(valid.selfSigned, false);
  assert.equal(valid.keyType, 'rsa');
  assert.equal(parseCertificate(oldExamplePem)?.notAfter, '2021-01-01T00:00:00.000Z');
  assert.equal(parseCertificate(selfSignedPem)?.selfSigned, true);
  assert.equal(parseCertificate(caPem)?.selfSigned, true);
  assert.equal(parseCertificate(eccExampleOrgPem)?.keyType, 'ec');
  assert.equal(parseCertificate('garbage'), null);
  assert.equal(parseCertificate('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'), null);
  assert.equal(pemCertificates(`${eccExampleOrgPem}\n${caPem}`).length, 2);
  assert.equal(certCovers(['*.example.tld'], 'a.example.tld'), true);
  assert.equal(certCovers(['*.example.tld'], 'a.b.example.tld'), false);
  assert.equal(certCovers(['*.example.tld'], 'example.tld'), false);
});

test('systemd units (Environment redacted at the source) + credential arguments + Varnish backends', () => {
  const u = parseUnitFile([
    '[Unit]', 'Description=App main', '', '[Service]', 'User=svcnode', 'WorkingDirectory=-/home/acct1/node/App',
    'Environment=<redacted>', 'EnvironmentFile=-/home/acct1/node/App/.env',
    'ExecStart=/usr/bin/node /home/acct1/node/App/main.js \\', '  --api-key s3cr3t --password=hunter2 --port 3005', 'ExecStart=/second', '',
    '[Install]', 'WantedBy=multi-user.target',
  ].join('\n'));
  assert.equal(u.user, 'svcnode');
  assert.equal(u.workingDirectory, '/home/acct1/node/App');
  assert.equal(u.runtime, 'node');
  assert.deepEqual(u.ports, [3005]);
  assert.deepEqual(u.environmentFiles, ['/home/acct1/node/App/.env']);
  assert.ok(u.execStart && !u.execStart.includes('s3cr3t') && !u.execStart.includes('hunter2'));
  assert.equal(parseUnitFile('[Service]\nExecStart=/usr/bin/python3.9 bot.py\n').runtime, 'python');
  assert.equal(parseUnitFile('[Service]\nExecStart=/usr/bin/env node index.js\n').runtime, 'node');
  assert.equal(parseUnitFile('[Service]\nExecStart=/usr/local/bin/agent\n').runtime, 'other');
  assert.equal(redactArgs('run TOKEN=abc --keyfile /k'), 'run TOKEN=<redacted> --keyfile <redacted>');
  assert.deepEqual(parseVarnishBackends('/* c */ backend default { .host = "203.0.113.10"; .port = "8181"; }\n# x\nbackend b2 {\n .host = "192.168.1.20";\n .port = 8080;\n}'), [
    { name: 'default', host: '203.0.113.10', port: 8181 }, { name: 'b2', host: '192.168.1.20', port: 8080 },
  ]);
});

test('redactCommand: credential values of cron / ExecStart command lines', () => {
  const cases: Array<[string, string]> = [
    ['mysqldump -uacct1_wp -pS3cret acct1_wp > /home/a/b.sql', 'mysqldump -uacct1_wp -p<redacted> acct1_wp > /home/a/b.sql'],
    ['mysql -u root -p -e "x"', 'mysql -u root -p -e "x"'],
    ['mysql --password=pw db; mysql --password pw2 db', 'mysql --password=<redacted> db; mysql --password <redacted> db'],
    ['wget -q "https://x.tld/cron.php?run=1&key=abcd&cron_token=t"', 'wget -q "https://x.tld/cron.php?run=1&key=<redacted>&cron_token=<redacted>"'],
    ['curl -u user:pass https://x.tld', 'curl -u user:<redacted> https://x.tld'],
    ['curl --user=user:pass https://x.tld', 'curl --user=user:<redacted> https://x.tld'],
    ['node app.js --db postgres://u:pw@h/db', 'node app.js --db postgres://u:<redacted>@h/db'],
    ['MYSQL_PWD=x mysqldump db', 'MYSQL_PWD=<redacted> mysqldump db'],
    ['sshpass -p secret rsync a b', 'sshpass -p <redacted> rsync a b'],
    ['/usr/local/bin/php /home/a/public_html/wp-cron.php > /dev/null 2>&1', '/usr/local/bin/php /home/a/public_html/wp-cron.php > /dev/null 2>&1'],
    ['/opt/alt/php73/usr/bin/php /home/a/app/artisan schedule:run -p 3000', '/opt/alt/php73/usr/bin/php /home/a/app/artisan schedule:run -p 3000'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactCommand(input), expected, input);
    assert.equal(redactCommand(expected), expected, `idempotent: ${expected}`);
  }
  assert.equal(redactArgs('node a.js --db mysql://u:pw@h/db -pX'), 'node a.js --db mysql://u:<redacted>@h/db -p<redacted>');
});
