import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderConfig, isMassRemoval, containerCertPath } from './render';
import { cidrContains, parseCidr, networksExcluding, subtractAddress, RenderError } from './validate';
import { baseState, box, CTX, edKey, HASH_APP, lines } from './testUtil';
import { C_LIVE } from './layout';

// Pure rendering of mail/config/postfix-dovecot (docs/P4-PLAN.md §5.2, MA1–MA4, MA12, MA14).

/** master.cf → service name → its line + its "-o" lines. */
function masterServices(content: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const l of content.split('\n')) {
    if (!l || l.startsWith('#')) continue;
    if (/^\s/.test(l)) { if (current) out.get(current)!.push(l.trim()); continue; }
    const [name, type] = l.split(/\s+/);
    current = `${name}/${type}`;
    out.set(current, [l]);
  }
  return out;
}

function mainParams(content: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines(content)) {
    const i = l.indexOf(' = ');
    const key = i > 0 ? l.slice(0, i) : l.replace(/ =$/, '');
    assert.ok(!m.has(key), `main.cf: ${key} defined twice`);
    m.set(key, i > 0 ? l.slice(i + 3) : '');
  }
  return m;
}

test('render: port 25 has no SASL, mynetworks is loopback only, no open relay (MA1, MA2)', () => {
  const out = renderConfig(baseState(), CTX);
  const main = mainParams(out.files.get('postfix/main.cf')!);
  assert.equal(main.get('mynetworks'), '127.0.0.1/32 [::1]/128');
  assert.equal(main.get('smtpd_sasl_auth_enable'), 'no');
  assert.match(main.get('smtpd_relay_restrictions')!, /^permit_mynetworks, reject_unauth_destination$/);
  assert.match(main.get('smtpd_recipient_restrictions')!, /reject_unauth_destination/);
  assert.equal(main.get('mydestination'), '');
  assert.equal(main.get('relay_domains'), '');
  assert.equal(main.get('smtpd_tls_auth_only'), 'yes');
  const master = masterServices(out.files.get('postfix/master.cf')!);
  const smtp = master.get('25/inet')!;
  assert.ok(smtp.includes('-o smtpd_sasl_auth_enable=no'));
  assert.ok(!smtp.some((o) => /sasl_auth_enable=yes|permit_sasl/.test(o)));
  // every mynetworks anywhere is a loopback host
  for (const svc of master.values()) for (const o of svc) {
    const m = /mynetworks=(.*)$/.exec(o);
    if (m) assert.equal(m[1], '127.0.0.1/32');
  }
  assert.equal(main.get('milter_default_action'), 'tempfail');
  assert.match(main.get('smtpd_milters')!, /^inet:oblimint-mail-rspamd:11332$/);
});

test('render: submission 587 = STARTTLS then AUTH, 465 = implicit TLS, sender login mismatch refused (MA1, MA3)', () => {
  const out = renderConfig(baseState(), CTX);
  const main = mainParams(out.files.get('postfix/main.cf')!);
  const master = masterServices(out.files.get('postfix/master.cf')!);
  const s587 = master.get('587/inet')!;
  const s465 = master.get('465/inet')!;
  for (const svc of [s587, s465]) {
    assert.ok(svc.includes('-o smtpd_sasl_auth_enable=yes'));
    assert.ok(svc.includes('-o smtpd_tls_auth_only=yes'));
    assert.ok(svc.includes('-o smtpd_tls_security_level=encrypt'));
    assert.ok(svc.includes('-o smtpd_sender_restrictions=$oblimint_submission_sender_restrictions'));
    assert.ok(svc.includes('-o smtpd_relay_restrictions=$oblimint_submission_relay_restrictions'));
  }
  assert.ok(s465.includes('-o smtpd_tls_wrappermode=yes'));
  assert.ok(!s587.includes('-o smtpd_tls_wrappermode=yes'));
  assert.match(main.get('oblimint_submission_sender_restrictions')!, /reject_sender_login_mismatch/);
  assert.match(main.get('oblimint_submission_sender_restrictions')!, /check_sasl_access lmdb:\$config_directory\/maps\/sasl_access/);
  assert.match(main.get('oblimint_submission_sender_restrictions')!, /, reject$/);
  assert.equal(main.get('oblimint_submission_relay_restrictions'), 'permit_sasl_authenticated, reject');
  assert.ok(main.get('smtpd_sender_login_maps')!.endsWith('maps/sender_login_maps'));
});

test('render: the null sender is refused on submission and never DKIM-signed (MA3, MA5)', () => {
  const out = renderConfig(baseState(), CTX);
  const main = mainParams(out.files.get('postfix/main.cf')!);
  const sender = main.get('oblimint_submission_sender_restrictions')!.split(/,\s*(?![^{]*\})/).map((x) => x.trim());
  const nullIdx = sender.findIndex((r) => /^check_sender_access inline:\{ \{ <> = REJECT 5\.7\.1 [^{}]+\} \}$/.test(r));
  assert.ok(nullIdx >= 0, 'null sender REJECT present');
  assert.ok(nullIdx < sender.indexOf('reject_sender_login_mismatch'));
  assert.ok(nullIdx < sender.indexOf('permit_sasl_authenticated'), 'refused before permit_sasl_authenticated');
  const dk = out.files.get('rspamd/dkim_signing.conf')!;
  assert.match(dk, /^allow_envfrom_empty = false;$/m);
  assert.match(dk, /^allow_hdrfrom_mismatch = false;$/m);
  assert.match(dk, /^allow_hdrfrom_multiple = false;$/m);
  assert.match(dk, /^use_domain = "header";$/m);
  assert.match(dk, /^sign_authenticated = true;$/m);
});

test('render: relay intake 10025 trusts the exact relay addresses only (MA2)', () => {
  const state = baseState();
  state.relay.relayAddresses = ['172.20.0.7', 'fd00:1::7', '172.20.0.0/16', 'oblimint-mail-relay'];
  const out = renderConfig(state, CTX);
  assert.deepEqual(lines(out.files.get('postfix/cidr/relay_clients')), ['172.20.0.7/32 OK', 'fd00:1::7/128 OK']);
  assert.ok(out.domainErrors['mail.oblimint.test'], 'the invalid entries are reported');
  const master = masterServices(out.files.get('postfix/master.cf')!);
  const relay = master.get('10025/inet')!;
  assert.ok(relay.includes('-o smtpd_sasl_auth_enable=no'));
  assert.ok(relay.includes('-o smtpd_relay_restrictions=$oblimint_relay_relay_restrictions'));
  const main = mainParams(out.files.get('postfix/main.cf')!);
  for (const k of ['oblimint_relay_client_restrictions', 'oblimint_relay_relay_restrictions', 'oblimint_relay_recipient_restrictions']) {
    // (recipient: recipient_access first, then the same exact-client check)
    assert.match(main.get(k)!, /check_client_access cidr:\$config_directory\/cidr\/relay_clients, reject$/);
  }
  // relay addresses sign DKIM (Rspamd sign_networks), same exact hosts
  assert.match(out.files.get('rspamd/dkim_signing.conf')!, /sign_networks = \["172\.20\.0\.7\/32", "fd00:1::7\/128"\];/);
  // empty relay ⇒ empty table ⇒ everything refused
  const none = renderConfig({ ...baseState(), relay: { relayHost: '', relayAddresses: [] } }, CTX);
  assert.deepEqual(lines(none.files.get('postfix/cidr/relay_clients')), []);
});

test('render: maps — domains, mailboxes, aliases, forwarding with / without copy, sender logins', () => {
  const out = renderConfig(baseState(), CTX);
  assert.deepEqual(lines(out.files.get('postfix/maps/virtual_domains')), ['exemple.fr OK'], 'inactive domain not served (D1, MA10)');
  assert.deepEqual(lines(out.files.get('postfix/maps/virtual_mailboxes')), [
    'compta@exemple.fr exemple.fr/compta/', 'contact@exemple.fr exemple.fr/contact/', 'jean@exemple.fr exemple.fr/jean/', 'vacances@exemple.fr exemple.fr/vacances/',
  ]);
  assert.deepEqual(lines(out.files.get('postfix/maps/virtual_aliases')), [
    'compta@exemple.fr expert@cabinet.fr',
    'jean@exemple.fr jean@exemple.fr,jean@gmail.com',
    'equipe@exemple.fr contact@exemple.fr,jean@exemple.fr',
    'info@exemple.fr contact@exemple.fr',
  ]);
  assert.deepEqual(lines(out.files.get('postfix/maps/sender_login_maps')), [
    'compta@exemple.fr compta@exemple.fr',
    'contact@exemple.fr contact@exemple.fr',
    'equipe@exemple.fr contact@exemple.fr,jean@exemple.fr',
    'info@exemple.fr contact@exemple.fr',
    'jean@exemple.fr jean@exemple.fr',
    'vacances@exemple.fr vacances@exemple.fr',
  ]);
  assert.deepEqual(out.counts, { domains: 1, mailboxes: 5, aliases: 2 });
  assert.deepEqual(out.domainErrors, {});
});

test('render: catch-all comes last of its domain and never swallows an existing mailbox', () => {
  const state = baseState();
  state.domains[0].catchAll = 'contact@exemple.fr';
  const v = lines(renderConfig(state, CTX).files.get('postfix/maps/virtual_aliases'));
  assert.equal(v[v.length - 1], '@exemple.fr contact@exemple.fr');
  for (const m of ['contact', 'vacances']) assert.ok(v.includes(`${m}@exemple.fr ${m}@exemple.fr`), `identity of ${m}`);
  // forwarded mailboxes keep their forwarding line (more specific than the catch-all)
  assert.ok(v.includes('compta@exemple.fr expert@cabinet.fr'));
  const idx = (k: string) => v.findIndex((l) => l.startsWith(`${k} `));
  for (const k of ['contact@exemple.fr', 'info@exemple.fr', 'equipe@exemple.fr']) assert.ok(idx(k) < idx('@exemple.fr'));
});

test('render: reception off ⇒ REJECT and never an alias / forward target (MA12)', () => {
  const state = baseState();
  state.mailboxes[0].receiveEnabled = false; // contact
  const out = renderConfig(state, CTX);
  assert.deepEqual(lines(out.files.get('postfix/maps/recipient_access')), [
    'contact@exemple.fr REJECT 5.2.1 Mailbox unavailable',
    'info@exemple.fr REJECT 5.1.1 Recipient address rejected',
  ]);
  const v = lines(out.files.get('postfix/maps/virtual_aliases'));
  assert.ok(v.includes('equipe@exemple.fr jean@exemple.fr'));
  assert.ok(!v.some((l) => l.startsWith('info@')));
  // every smtpd (25, 587, 465, 10025, Sieve 10026) checks recipient_access before anything that could permit
  const main = mainParams(out.files.get('postfix/main.cf')!);
  const master = masterServices(out.files.get('postfix/master.cf')!);
  const smtpds = [...master.entries()].filter(([, svc]) => /\ssmtpd$/.test(svc[0]));
  assert.deepEqual(smtpds.map(([k]) => k).sort(), ['10025/inet', '127.0.0.1:10026/inet', '25/inet', '465/inet', '587/inet']);
  for (const [name, svc] of smtpds) {
    const o = svc.find((l) => l.startsWith('-o smtpd_recipient_restrictions='));
    const value = o ? o.slice('-o smtpd_recipient_restrictions='.length) : main.get('smtpd_recipient_restrictions')!;
    const resolved = value.startsWith('$') ? main.get(value.slice(1))! : value;
    const items = resolved.split(/,\s*/);
    const access = items.indexOf('check_recipient_access lmdb:$config_directory/maps/recipient_access');
    assert.ok(access >= 0, `${name}: recipient_access checked`);
    const firstPermit = items.findIndex((i) => /^permit|^check_client_access/.test(i));
    assert.ok(firstPermit < 0 || access < firstPermit, `${name}: recipient_access before any permit`);
  }
  // still in the userdb (data kept), still able to log in (only reception is off)
  assert.ok(lines(out.files.get('dovecot/users')).some((l) => l.startsWith('contact@exemple.fr:')));
  assert.ok(lines(out.files.get('dovecot/passwd')).some((l) => l.startsWith('contact@exemple.fr:')));
});

test('render: login disabled ⇒ out of the passdb, kept in the userdb; sending disabled ⇒ sender / SASL access', () => {
  const state = baseState();
  state.mailboxes[1].loginEnabled = false; // jean (account suspended)
  state.mailboxes[0].sendEnabled = false; // contact
  const out = renderConfig(state, CTX);
  const passwd = lines(out.files.get('dovecot/passwd'));
  assert.ok(!passwd.some((l) => l.startsWith('jean@')));
  assert.ok(!passwd.some((l) => l.startsWith('info@pending.fr')), 'inactive domain: no login');
  assert.ok(lines(out.files.get('dovecot/users')).some((l) => l.startsWith('jean@exemple.fr::5000:5000::/var/vmail/exemple.fr/jean::')));
  assert.ok(lines(out.files.get('dovecot/users')).some((l) => l.startsWith('info@pending.fr:')));
  assert.deepEqual(lines(out.files.get('postfix/maps/sasl_access')), ['contact@exemple.fr REJECT 5.7.1 Sending is disabled for this mailbox']);
  const sa = lines(out.files.get('postfix/maps/sender_access'));
  assert.ok(sa.includes('contact@exemple.fr REJECT 5.7.1 Sending is disabled for this mailbox'));
  assert.ok(sa.includes('info@exemple.fr REJECT 5.7.1 Sending is disabled for this address'), 'alias owned only by a non-sending mailbox');
  assert.ok(sa.includes('equipe@exemple.fr REJECT 5.7.1 Sending is disabled for this address'), 'jean cannot log in, contact cannot send: no owner of equipe may send');
  const slm = lines(out.files.get('postfix/maps/sender_login_maps'));
  assert.ok(!slm.some((l) => l.includes('jean@exemple.fr')), 'a mailbox that cannot log in owns no sender address');
});

test('render: Dovecot passwd-file lines, quota, sieve_before, trusted networks without the gateway (MA1, MA6)', () => {
  const out = renderConfig(baseState(), CTX);
  const users = lines(out.files.get('dovecot/users'));
  assert.ok(users.includes('contact@exemple.fr::5000:5000::/var/vmail/exemple.fr/contact::userdb_quota_rule=*:storage=1024M'));
  assert.ok(users.includes(`vacances@exemple.fr::5000:5000::/var/vmail/exemple.fr/vacances::userdb_sieve_before=${C_LIVE}/sieve/104.sieve`));
  const passwd = lines(out.files.get('dovecot/passwd'));
  assert.ok(passwd.some((l) => /^jean@exemple\.fr:\{MD5-CRYPT\}\$1\$cwpsalt1\$[^:]+::::::$/.test(l)), 'imported CWP hash kept as is');
  const conf = out.files.get('dovecot/dovecot.conf')!;
  const trusted = /^login_trusted_networks = (.*)$/m.exec(conf)![1].split(' ');
  assert.equal(trusted.length, 16);
  for (const n of trusted) {
    const c = parseCidr(n);
    assert.ok(!cidrContains(c, '172.20.0.1'), `${n} contains the gateway`);
    assert.ok(cidrContains(parseCidr('172.20.0.0/16'), n.split('/')[0]));
  }
  assert.ok(trusted.some((n) => cidrContains(parseCidr(n), '172.20.0.9')));
  assert.match(conf, /^disable_plaintext_auth = yes$/m);
  assert.match(conf, /^listen = \*$/m, 'IPv4-only mail network');
  assert.match(renderConfig(baseState(), { ...CTX, mailSubnets: ['172.20.0.0/16', 'fd00:1::/64'] }).files.get('dovecot/dovecot.conf')!, /^listen = \*, ::$/m);
  assert.match(conf, /^ssl = required$/m);
  assert.match(conf, /^ssl_min_protocol = TLSv1\.2$/m);
  assert.match(conf, /^auth_failure_delay = 2 secs$/m);
  assert.match(conf, /quota_status_overquota = "552 5\.2\.2 Mailbox is full"/);
  assert.match(conf, /^mail_location = maildir:\/var\/vmail\/%d\/%n\/Maildir$/m);
  // no Dovecot listener on the relay intake / no plaintext without TLS outside trusted
  assert.ok(!/10025/.test(conf));
});

test('render: webmail app passwords — mail network only (never the gateway), expired ones dropped, one slot per credential', () => {
  const state = baseState();
  state.appPasswords.push(
    { id: 2, mailboxId: 101, address: 'contact@exemple.fr', passwordHash: HASH_APP, expiresAt: '2026-10-09T22:00:00Z', purpose: 'webmail', allowNets: ['172.20.0.0/16'] },
    { id: 3, mailboxId: 101, address: 'contact@exemple.fr', passwordHash: HASH_APP, expiresAt: '2026-10-09T11:00:00Z', purpose: 'webmail', allowNets: ['172.20.0.0/16'] },
    { id: 4, mailboxId: 102, address: 'jean@exemple.fr', passwordHash: HASH_APP, expiresAt: '2026-10-09T22:00:00Z', purpose: 'webmail', allowNets: [] },
    { id: 5, mailboxId: 999, address: 'jean@exemple.fr', passwordHash: HASH_APP, expiresAt: '2026-10-09T22:00:00Z', purpose: 'webmail', allowNets: ['172.20.0.0/16'] },
  );
  const out = renderConfig(state, CTX);
  assert.ok(out.files.has('dovecot/apppasswords.0'));
  assert.ok(out.files.has('dovecot/apppasswords.1'));
  assert.ok(!out.files.has('dovecot/apppasswords.2'), 'the expired credential is not rendered');
  const slot0 = lines(out.files.get('dovecot/apppasswords.0'));
  assert.equal(slot0.length, 1, 'no unrestricted credential (empty allowNets)');
  assert.match(slot0[0], /^contact@exemple\.fr:\{SHA512-CRYPT\}[^:\s]+::::::allow_real_nets=[0-9./,]+$/);
  const nets = slot0[0].split('allow_real_nets=')[1].split(',');
  for (const n of nets) assert.ok(!cidrContains(parseCidr(n), '172.20.0.1'));
  assert.ok(out.domainErrors['exemple.fr']?.includes('app password'), 'wrong mailbox id reported');
  const conf = out.files.get('dovecot/dovecot.conf')!;
  assert.match(conf, /apppasswords\.0\n/);
  assert.match(conf, /apppasswords\.1\n/);
  assert.ok(!/apppasswords\.2/.test(conf));
  // a mailbox that cannot log in has no session credential either
  const s2 = baseState();
  s2.mailboxes[0].loginEnabled = false;
  assert.ok(!renderConfig(s2, CTX).files.has('dovecot/apppasswords.0'));
});

test('render: autoresponder Sieve — dates in UTC, aliases, escaping, no variables extension (MA4)', () => {
  const state = baseState();
  state.mailboxes[3].autoresponder = {
    subject: 'Absent "${HOME}" \\ test', body: 'Ligne 1\n.\nLigne "3" ${x}\r\nfin', startsAt: '2026-10-01T08:00:00Z', endsAt: null, intervalDays: 3,
  };
  state.aliases.push({ id: 3, accountId: 10, domainId: 1, address: 'conges@exemple.fr', targets: ['vacances@exemple.fr'] });
  const sieve = renderConfig(state, CTX).files.get('sieve/104.sieve')!;
  assert.match(sieve, /^require \["vacation", "date", "relational"\];$/m);
  assert.ok(!/variables/.test(sieve));
  assert.match(sieve, /currentdate :zone "\+0000" :value "gt" "date" "2026-10-01"/);
  assert.match(sieve, /currentdate :zone "\+0000" :value "ge" "time" "08:00:00"/);
  assert.ok(!/"lt"/.test(sieve), 'no end date ⇒ open-ended');
  assert.match(sieve, /:subject "Absent \\"\$\{HOME\}\\" \\\\ test"/);
  assert.match(sieve, /:addresses \["vacances@exemple\.fr", "conges@exemple\.fr"\]/);
  assert.match(sieve, /:days 3 /);
  assert.ok(sieve.includes('"Ligne 1\n.\nLigne \\"3\\" ${x}\nfin";'));
  assert.match(sieve, /not header :matches "X-Spam-Status" "Yes\*"/);
  // end date exclusive
  const end = renderConfig(baseState(), CTX).files.get('sieve/104.sieve')!;
  assert.match(end, /currentdate :zone "\+0000" :value "lt" "date" "2026-10-20"/);
  assert.match(end, /currentdate :zone "\+0000" :value "lt" "time" "18:30:00"/);
  // subject with a newline: refused, reported, the mailbox itself is still rendered (without the script)
  const bad = baseState();
  bad.mailboxes[3].autoresponder!.subject = 'x\nBcc: victim@example.com';
  const o = renderConfig(bad, CTX);
  assert.ok(!o.files.has('sieve/104.sieve'));
  assert.ok(o.domainErrors['exemple.fr']?.includes('autoresponder'));
  assert.ok(!o.domainErrors['exemple.fr'].includes('victim'), 'the hostile value is not echoed');
  assert.ok(lines(o.files.get('dovecot/users')).some((l) => l.startsWith('vacances@exemple.fr:') && !l.includes('sieve_before')));
});

test('render: hostile values are refused (newline, ":", quotes, spaces, "$") and never echoed', () => {
  const state = baseState();
  state.mailboxes.push(
    box(301, 'evil', 'exemple.fr', { address: 'evil@exemple.fr\nroot@x', localPart: 'evil' }),
    box(302, 'colon', 'exemple.fr', { passwordHash: '{SHA512-CRYPT}$6$abc$def:0:0::/root::', passwordScheme: 'SHA512-CRYPT' }),
    box(303, 'space', 'exemple.fr', { passwordHash: '{SHA512-CRYPT}$6$abcdefgh$x allow_nets=0.0.0.0/0', passwordScheme: 'SHA512-CRYPT' }),
    box(304, 'scheme', 'exemple.fr', { passwordHash: '{PLAIN}secret12345', passwordScheme: 'SHA512-CRYPT' }),
    box(305, 'fwd', 'exemple.fr', { forward: { targets: ['a@b.fr, root@x.fr'], keepCopy: false } }),
  );
  state.aliases.push({ id: 9, accountId: 10, domainId: 1, address: 'quote@exemple.fr', targets: ['"x"@y.fr'] });
  state.domains.push({ id: 3, accountId: 10, name: 'bad$domain.fr', active: true, catchAll: null, maxMessageSizeMb: 10 });
  const out = renderConfig(state, CTX);
  const all = [...out.files.values()].join('\n');
  for (const needle of ['root@x', 'def:0:0', 'allow_nets=0.0.0.0', 'secret12345', '"x"@y.fr', 'bad$domain']) {
    assert.ok(!all.includes(needle), `${needle} leaked into the configuration`);
    assert.ok(!Object.values(out.domainErrors).join(' ').includes(needle), `${needle} echoed in an error message`);
  }
  assert.equal(out.counts.mailboxes, 5, 'only the valid mailboxes are rendered');
  assert.ok(out.domainErrors['exemple.fr']);
  assert.ok(out.domainErrors['bad$domain.fr'.slice(0, 253)]);
  // global values: refused as a whole
  assert.throws(() => renderConfig({ ...baseState(), settings: { ...baseState().settings, hostname: 'mail.x.fr\nmynetworks = 0.0.0.0/0' } }, CTX), RenderError);
  assert.throws(() => renderConfig({ ...baseState(), settings: { ...baseState().settings, hostname: '$myhostname' } }, CTX), RenderError);
  assert.throws(() => renderConfig({ ...baseState(), settings: { ...baseState().settings, spamTagScore: 15, spamRejectScore: 15 } }, CTX), RenderError);
  assert.throws(() => renderConfig({ ...baseState(), settings: { ...baseState().settings, clamdAddress: 'x" ; servers = "evil:1' } }, CTX), RenderError);
});

test('render: TLS default certificate + SNI for Postfix and Dovecot, paths confined to mail/certs', () => {
  const out = renderConfig(baseState(), CTX);
  const main = mainParams(out.files.get('postfix/main.cf')!);
  assert.equal(main.get('smtpd_tls_chain_files'), '/etc/oblimint/mail-certs/mail.oblimint.test/privkey.pem, /etc/oblimint/mail-certs/mail.oblimint.test/fullchain.pem');
  assert.equal(main.get('tls_server_sni_maps'), 'lmdb:$config_directory/sni/tls_sni');
  assert.deepEqual(lines(out.files.get('postfix/sni/tls_sni')), [
    'autoconfig.exemple.fr /etc/oblimint/mail-certs/mail.exemple.fr/privkey.pem /etc/oblimint/mail-certs/mail.exemple.fr/fullchain.pem',
    'mail.exemple.fr /etc/oblimint/mail-certs/mail.exemple.fr/privkey.pem /etc/oblimint/mail-certs/mail.exemple.fr/fullchain.pem',
    'mail.oblimint.test /etc/oblimint/mail-certs/mail.oblimint.test/privkey.pem /etc/oblimint/mail-certs/mail.oblimint.test/fullchain.pem',
  ]);
  const conf = out.files.get('dovecot/dovecot.conf')!;
  assert.match(conf, /^ssl_cert = <\/etc\/oblimint\/mail-certs\/mail\.oblimint\.test\/fullchain\.pem$/m);
  assert.match(conf, /^local_name mail\.exemple\.fr \{\n {2}ssl_cert = <\/etc\/oblimint\/mail-certs\/mail\.exemple\.fr\/fullchain\.pem$/m);
  // no certificate yet ⇒ the engine's self-signed fallback, no SNI table
  const none = renderConfig({ ...baseState(), tls: [] }, CTX);
  assert.match(none.files.get('postfix/main.cf')!, /smtpd_tls_chain_files = \/run\/oblimint-mail\/selfsigned\/privkey\.pem, \/run\/oblimint-mail\/selfsigned\/fullchain\.pem/);
  assert.ok(!/tls_server_sni_maps/.test(none.files.get('postfix/main.cf')!));
  assert.throws(() => containerCertPath('/srv/oblimint/edge/certs/x/privkey.pem', CTX.hostCertsDir), RenderError);
  assert.throws(() => containerCertPath('/srv/oblimint/mail/certs/../../edge/k.pem', CTX.hostCertsDir), RenderError);
  const escape = baseState();
  escape.tls[1].keyPath = '/srv/oblimint/accounts/1/key.pem';
  const e = renderConfig(escape, CTX);
  assert.ok(e.domainErrors['mail.exemple.fr']);
  assert.ok(!/accounts/.test([...e.files.values()].join('')));
});

test('render: Rspamd — scores, greylisting, ClamAV, DKIM signing keys of active domains only, limits maps (MA14)', () => {
  const state = baseState();
  state.dkim.push({ domain: 'exemple.fr', selector: 'om202610e', algorithm: 'ed25519', privateKeyPem: edKey(), signing: true });
  state.dkim.push({ domain: 'pending.fr', selector: 'om202610', algorithm: 'rsa-2048', privateKeyPem: state.dkim[0].privateKeyPem, signing: true });
  const out = renderConfig(state, CTX);
  const actions = out.files.get('rspamd/actions.conf')!;
  assert.match(actions, /^reject = 15;$/m);
  assert.match(actions, /^add_header = 6;$/m);
  assert.match(actions, /^greylist = null;$/m);
  assert.match(out.files.get('rspamd/greylist.conf')!, /enabled = false;/);
  const av = out.files.get('rspamd/antivirus.conf')!;
  assert.match(av, /servers = "oblimint-scanner:3310";/);
  assert.match(av, /action = "reject";/);
  assert.match(av, /message = '\$\{SCANNER\}: virus found: "\$\{VIRUS\}"';/);
  // never more than clamd accepts (scanner.maxFileSizeMb, default 32), gap stated
  assert.match(av, /^ {2}max_size = 33554432;$/m);
  assert.match(av, /^# Messages above 32 MiB/m);
  const big = renderConfig(baseState(), { ...CTX, clamdMaxFileSizeMb: 100 }).files.get('rspamd/antivirus.conf')!;
  assert.match(big, /^ {2}max_size = 52428800;$/m, 'mail cap below the scanner cap');
  assert.ok(!/^# Messages above/m.test(big));
  assert.match(out.files.get('rspamd/classifier-bayes.conf')!, /^expire = \d+;$/m);
  const dk = out.files.get('rspamd/dkim_signing.conf')!;
  assert.match(dk, /path = "\/etc\/oblimint\/dkim\/exemple\.fr\/om202610\.key"; selector = "om202610";/);
  assert.match(dk, /selector = "om202610e";/);
  assert.ok(!/om202611/.test(dk), 'a "next" key is published, not used');
  assert.ok(!/pending\.fr/.test(dk), 'inactive domain never signs');
  assert.deepEqual([...out.dkimKeys.keys()].sort(), ['exemple.fr/om202610.key', 'exemple.fr/om202610e.key']);
  assert.match(out.dkimKeys.get('exemple.fr/om202610.key')!, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(Buffer.from(out.dkimKeys.get('exemple.fr/om202610e.key')!.trim(), 'base64').length, 32, 'ed25519 seed for Rspamd');
  assert.deepEqual(lines(out.files.get('rspamd/oblimint_sendlimits.map')), ['contact@exemple.fr 200']);
  assert.deepEqual(lines(out.files.get('rspamd/oblimint_sizelimits.map')), ['exemple.fr 26214400']);
  assert.match(out.files.get('postfix/main.cf')!, /^message_size_limit = 52428800$/m);

  const grey = renderConfig({ ...baseState(), settings: { ...baseState().settings, greylisting: true, clamav: false, clamdAddress: null } }, CTX);
  assert.match(grey.files.get('rspamd/actions.conf')!, /^greylist = 4;$/m);
  assert.match(grey.files.get('rspamd/greylist.conf')!, /enabled = true;/);
  assert.ok(!/servers/.test(grey.files.get('rspamd/antivirus.conf')!));
  // UCL: no '$' anywhere but the antivirus placeholders in single quotes
  for (const [name, content] of out.files) {
    if (!name.startsWith('rspamd/')) continue;
    for (const l of content.split('\n')) if (l.includes('$')) assert.match(l, /^ {2}message = '/, `${name}: ${l}`);
  }
});

test('render: deterministic fingerprint, changes with any file or key', () => {
  const a = renderConfig(baseState(), CTX);
  const b = renderConfig(baseState(), CTX);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual([...a.files.keys()], [...b.files.keys()]);
  const s = baseState();
  s.mailboxes[0].quotaMb = 2048;
  assert.notEqual(renderConfig(s, CTX).fingerprint, a.fingerprint);
  const k = baseState();
  k.dkim[0].selector = 'om202612';
  assert.notEqual(renderConfig(k, CTX).fingerprint, a.fingerprint);
  // order of the input does not matter
  const r = baseState();
  r.mailboxes.reverse();
  r.aliases.reverse();
  assert.equal(renderConfig(r, CTX).fingerprint, a.fingerprint);
});

test('mass removal guard: more than half of the known mailboxes, with a floor', () => {
  const prev = ['a@x.fr', 'b@x.fr', 'c@x.fr', 'd@x.fr', 'e@x.fr', 'f@x.fr'];
  assert.equal(isMassRemoval(prev, prev), false);
  assert.equal(isMassRemoval(prev, ['a@x.fr', 'b@x.fr', 'c@x.fr']), false, 'exactly half');
  assert.equal(isMassRemoval(prev, ['a@x.fr', 'b@x.fr']), true);
  assert.equal(isMassRemoval(prev, []), true);
  assert.equal(isMassRemoval(['a@x.fr'], []), false, 'deleting the only mailbox of a small platform');
  assert.equal(isMassRemoval(['a@x.fr', 'b@x.fr'], []), false);
  assert.equal(isMassRemoval(['a@x.fr', 'b@x.fr', 'c@x.fr'], []), true);
});

test('CIDR helpers: subtracting the gateway, IPv6, invalid networks', () => {
  const blocks = subtractAddress(parseCidr('10.0.0.0/30'), '10.0.0.1');
  assert.deepEqual(blocks.map((b) => `${b.prefix}`), ['31', '32']);
  assert.deepEqual(networksExcluding(['10.0.0.0/30'], ['10.0.0.1']), ['10.0.0.2/31', '10.0.0.0/32']);
  assert.deepEqual(networksExcluding(['10.0.0.0/30'], ['192.168.0.1']), ['10.0.0.0/30']);
  const v6 = networksExcluding(['fd00:1::/64'], ['fd00:1::1']);
  assert.equal(v6.length, 64);
  for (const n of v6) assert.ok(!cidrContains(parseCidr(n), 'fd00:1::1'));
  assert.ok(v6.some((n) => cidrContains(parseCidr(n), 'fd00:1::2')));
  for (const bad of ['10.0.0.1/24', '10.0.0.0/33', 'x/8', '10.0.0.0/8/1', '::ffff:1.2.3.4/128', '0.0.0.0 /0']) {
    assert.throws(() => parseCidr(bad), RenderError, bad);
  }
});

test('render: forwarding / alias / catch-all to outside count against the account hourly limit (MA9)', () => {
  const state = baseState();
  state.domains[0].catchAll = 'ext@gmail.com';
  state.aliases.push({ id: 3, accountId: 10, domainId: 1, address: 'out@exemple.fr', targets: ['contact@exemple.fr', 'x@yahoo.fr'] });
  const out = renderConfig(state, CTX);
  assert.deepEqual(lines(out.files.get('rspamd/oblimint_fwdlimits.map')), [
    '@exemple.fr 200',
    'compta@exemple.fr 200',
    'contact@exemple.fr -',
    'equipe@exemple.fr -',
    'info@exemple.fr -',
    'jean@exemple.fr 200',
    'out@exemple.fr 200',
    'vacances@exemple.fr -',
  ]);
  // no limit on the account ⇒ nothing counted; local-only forwarding never counted
  const free = baseState();
  free.mailboxes[0].sendPerHour = null;
  assert.deepEqual(lines(renderConfig(free, CTX).files.get('rspamd/oblimint_fwdlimits.map')), []);
  const local = baseState();
  local.mailboxes = local.mailboxes.map((b) => (b.forward ? { ...b, forward: { targets: ['contact@exemple.fr'], keepCopy: false } } : b));
  assert.deepEqual(lines(renderConfig(local, CTX).files.get('rspamd/oblimint_fwdlimits.map')), []);
});

test('render: a mailbox that may not send gets no Sieve redirect and no personal script (MA9)', () => {
  const state = baseState();
  state.mailboxes[1] = { ...state.mailboxes[1], sendEnabled: false };
  const out = renderConfig(state, CTX);
  const users = lines(out.files.get('dovecot/users'));
  const jean = users.find((l) => l.startsWith('jean@exemple.fr:'))!;
  assert.match(jean, / ?userdb_sieve_max_redirects=0 userdb_sieve=file:\/nonexistent\/oblimint-sieve-disabled$/);
  const contact = users.find((l) => l.startsWith('contact@exemple.fr:'))!;
  assert.ok(!contact.includes('sieve_max_redirects'), 'mailboxes that may send keep the platform setting');
  assert.match(out.files.get('dovecot/dovecot.conf')!, /^ {2}sieve_redirect_envelope_from = recipient$/m);
});

test('render: Sieve vacation / redirect go over SMTP to a loopback-only smtpd, never through sendmail -> postdrop', () => {
  // the Linux test host: under no-new-privileges postdrop loses its setgid bit, vmail cannot
  // write maildrop/, Dovecot killed sendmail after 30 s (vacation reply lost,
  // delivery held). Dovecot's program client also drops supplementary groups,
  // so only an SMTP hand-off works.
  const out = renderConfig(baseState(), CTX);
  const conf = out.files.get('dovecot/dovecot.conf')!;
  assert.match(conf, /^submission_host = 127\.0\.0\.1:10026$/m);
  assert.ok(!/^\s*sendmail_path\s*=/m.test(conf), 'no sendmail path');
  assert.ok(!/mail_access_groups/.test(conf), 'no extra group for the mail processes');
  const main = mainParams(out.files.get('postfix/main.cf')!);
  const master = masterServices(out.files.get('postfix/master.cf')!);
  const sieve = master.get('127.0.0.1:10026/inet')!;
  assert.ok(sieve, 'listener bound to the container loopback only');
  assert.ok(![...master.keys()].some((k) => /^(?:0\.0\.0\.0:|\[::\]:)?10026\//.test(k)), 'never on every address');
  assert.match(sieve[0], /\ssmtpd$/);
  for (const o of ['-o smtpd_sasl_auth_enable=no', '-o mynetworks=127.0.0.1/32', '-o smtpd_client_restrictions=permit_mynetworks,reject',
    '-o smtpd_relay_restrictions=permit_mynetworks,reject', '-o smtpd_recipient_restrictions=$oblimint_sieve_recipient_restrictions']) {
    assert.ok(sieve.includes(o), o);
  }
  assert.equal(main.get('oblimint_sieve_recipient_restrictions'), 'check_recipient_access lmdb:$config_directory/maps/recipient_access, permit_mynetworks, reject');
  // The milter (signing / scanning / hourly limits, MA9) applies: no smtpd_milters override.
  assert.ok(!sieve.some((l) => /smtpd_milters|milter_default_action/.test(l)));
  assert.equal(main.get('milter_default_action'), 'tempfail');
  // master.cf "-o" values never contain spaces (they would be split into arguments).
  for (const [name, svc] of master) for (const l of svc.slice(1)) assert.ok(!/^-o \S+=.*\s/.test(l), `${name}: ${l}`);
});
