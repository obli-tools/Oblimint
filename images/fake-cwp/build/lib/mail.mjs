// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — mail of CWP (CWP-MAP §8): postfix database rows, SQL maps of
// Postfix / Dovecot (docs/cwp/postfix-sql-maps.txt, dovecot-sql.txt),
// Maildir++ trees in /var/vmail/<domain>/<local>/ owned <account uid>:mail
// 0700 with dovecot-uidlist (UIDVALIDITY kept by the migration), Sieve
// scripts, OpenDKIM KeyTable / SigningTable / userkeys (selector 'default').
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { q } from './sql.mjs';

const FOLDERS = { INBOX: '', Sent: '.Sent', Spam: '.Spam', Trash: '.Trash', Drafts: '.Drafts' };
const FOLDER_ORDER = ['INBOX', 'Drafts', 'Sent', 'Spam', 'Trash'];

function accountOfDomain(ds, domain) {
  const md = ds.MAIL_DOMAINS.find((m) => m.domain === domain);
  if (!md) throw new Error(`no mail domain ${domain}`);
  return ds.ACCOUNTS.find((a) => a.username === md.account);
}

function qEncode(subject) {
  // RFC 2047 Q-encoding for non-ASCII subjects.
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const bytes = Buffer.from(subject, 'utf8');
  let out = '';
  for (const b of bytes) {
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) out += String.fromCharCode(b);
    else if (b === 0x20) out += '_';
    else out += `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `=?UTF-8?Q?${out}?=`;
}

function rfcDate(epoch) {
  return new Date(epoch * 1000).toUTCString().replace('GMT', '+0000');
}

export function messageText({ from, to, subject, epoch, id, hostname }) {
  return [
    `Return-Path: <${from}>`,
    `Delivered-To: ${to}`,
    `Received: from mx.external.example (mx.external.example [192.0.2.25])`,
    `\tby ${hostname} with ESMTPS id ${id}`,
    `\tfor <${to}>; ${rfcDate(epoch)}`,
    `Message-ID: <${id}@external.example>`,
    `Date: ${rfcDate(epoch)}`,
    `From: Expediteur <${from}>`,
    `To: <${to}>`,
    `Subject: ${qEncode(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    `Message de test du faux CWP (fake-cwp) : ${subject}.`,
    'Ce message doit garder son UID IMAP après la migration.',
    '',
  ].join('\n');
}

/** Maildir files of a mailbox: { folder → [{ base, file (cur/…:2,S | new/…), content, size }] }. */
export function mailboxMessages(ds, mb) {
  const hostname = ds.SERVER.hostname;
  const out = {};
  mb.messages.forEach((m, i) => {
    const epoch = mb.uidValidity + 3600 * (i + 1);
    const id = createHash('sha1').update(`${mb.address}#${i}`).digest('hex').slice(0, 16);
    const content = messageText({ from: 'sender@external.example', to: mb.address, subject: m.subject, epoch, id, hostname });
    const size = Buffer.byteLength(content);
    const wsize = size + (content.match(/\n/g)?.length ?? 0);
    const base = `${epoch}.M${100000 + i * 7919}P${2000 + i}.${hostname},S=${size},W=${wsize}`;
    const file = m.new ? `new/${base}` : `cur/${base}:2,${m.seen ? 'S' : ''}`;
    (out[m.folder] ??= []).push({ base, file, content, size, isNew: Boolean(m.new) });
  });
  return out;
}

export function quota2Of(ds, mb) {
  const msgs = Object.values(mailboxMessages(ds, mb)).flat();
  return { bytes: msgs.reduce((n, m) => n + m.size, 0), messages: msgs.length };
}

export function renderMaildirs(ds, plan) {
  plan.dir('/var/vmail', { owner: 'vmail', group: 'mail', mode: 0o770 });
  for (const md of ds.MAIL_DOMAINS) {
    const acct = ds.ACCOUNTS.find((a) => a.username === md.account);
    const dirOwner = md.dirOwner === 'vmail' ? 'vmail' : acct.username;
    plan.dir(`/var/vmail/${md.domain}`, { owner: dirOwner, group: 'mail', mode: md.dirMode });
  }
  for (const mb of ds.MAILBOXES) {
    const [local, domain] = mb.address.split('@');
    const acct = accountOfDomain(ds, domain);
    const own = { owner: acct.username, group: 'mail' };
    const root = `/var/vmail/${domain}/${local}`;
    const dir = (p) => plan.dir(p, { ...own, mode: 0o700 });
    const file = (p, c) => plan.file(p, c, { ...own, mode: 0o600 });
    const msgs = mailboxMessages(ds, mb);
    dir(root);
    FOLDER_ORDER.forEach((folder, k) => {
      const fdir = FOLDERS[folder] ? `${root}/${FOLDERS[folder]}` : root;
      if (fdir !== root) dir(fdir);
      for (const sub of ['cur', 'new', 'tmp']) dir(`${fdir}/${sub}`);
      if (fdir !== root) file(`${fdir}/maildirfolder`, '');
      const list = msgs[folder] ?? [];
      for (const m of list) file(`${fdir}/${m.file}`, m.content);
      const seen = list.filter((m) => !m.isNew);
      if (seen.length > 0) {
        const uv = mb.uidValidity + 100 * k;
        const guid = createHash('md5').update(`${mb.address}/${folder}`).digest('hex');
        const lines = [`3 V${uv} N${seen.length + 1} G${guid}`, ...seen.map((m, i) => `${i + 1} :${m.base}`)];
        file(`${fdir}/dovecot-uidlist`, `${lines.join('\n')}\n`);
      }
    });
    const uvHex = mb.uidValidity.toString(16);
    file(`${root}/dovecot-uidvalidity`, `${uvHex}\n`);
    file(`${root}/dovecot-uidvalidity.${uvHex}`, '');
    file(`${root}/subscriptions`, 'Drafts\nSent\nSpam\nTrash\n');
    // Dovecot index placeholder: EXCLUDED by the maildir rsync preset (dovecot.index*), rebuilt on the target.
    file(`${root}/dovecot.index.cache`, 'fake-cwp: index placeholder, must not be copied\n');
    if (mb.sieve) {
      dir(`${root}/sieve`);
      file(`${root}/sieve/roundcube.sieve`, `require ["fileinto"];\n# rule:[Spam]\nif header :contains "subject" "[SPAM]"\n{\n\tfileinto "Spam";\n\tstop;\n}\n`);
      plan.symlink(`${root}/dovecot.sieve`, 'sieve/roundcube.sieve', own);
    }
    if (mb.symlinkTrap) plan.symlink(`${root}/${mb.symlinkTrap.name}`, mb.symlinkTrap.target, own);
  }
  plan.dir('/var/sieve');
  plan.file('/var/sieve/globalfilter.sieve', 'require ["fileinto"];\nif header :contains "X-Spam-Flag" "YES" { fileinto "Spam"; }\n');
}

export function mailboxHash(mb, crypto) {
  if (mb.scheme === 'SHA512-CRYPT') return `{SHA512-CRYPT}${crypto.sha512crypt(mb.password, mb.address)}`;
  if (mb.scheme === 'MD5-CRYPT-BARE') return crypto.md5crypt(mb.password, mb.address);
  throw new Error(`unknown scheme ${mb.scheme}`);
}

/** Rows of the postfix database (schema: seed/schemas/postfix.schema.sql). */
export function postfixDataSql(ds, crypto) {
  const created = '2025-09-05 19:31:52';
  const out = ['USE postfix;', "INSERT INTO config (id, name, value) VALUES (1, 'version', '740');"];
  for (const md of ds.MAIL_DOMAINS) {
    out.push(`INSERT INTO domain (domain, description, aliases, mailboxes, maxquota, quota, transport, backupmx, created, modified, active) VALUES (${q(md.domain)}, '', 0, 0, 0, 0, '', 0, ${q(created)}, ${q(created)}, 1);`);
  }
  for (const mb of ds.MAILBOXES) {
    const [local, domain] = mb.address.split('@');
    const acct = accountOfDomain(ds, domain);
    out.push(`INSERT INTO mailbox (username, password, name, maildir, quota, local_part, domain, uid, gid, created, modified, active, phone, email_other, token, token_validity) VALUES (${[
      q(mb.address), q(mailboxHash(mb, crypto)), q(mb.name), q(`${domain}/${local}/`), mb.quota, q(local), q(domain), acct.uid, 12,
      q(created), q(created), mb.active, q(mb.phone), q(mb.emailOther), "''", "'2000-01-01 00:00:00'",
    ].join(', ')});`);
    if (mb.quota2) {
      const { bytes, messages } = quota2Of(ds, mb);
      out.push(`INSERT INTO quota2 (username, bytes, messages) VALUES (${q(mb.address)}, ${bytes}, ${messages});`);
    }
  }
  for (const al of ds.ALIASES) {
    out.push(`INSERT INTO alias (address, goto, domain, created, modified, active) VALUES (${q(al.address)}, ${q(al.goto)}, ${q(al.domain)}, ${q(created)}, ${q(created)}, ${al.active});`);
  }
  return `${out.join('\n')}\n`;
}

const MAPS = {
  'mysql-relay_domains_maps.cf': "query = SELECT domain FROM domain WHERE domain='%s' and backupmx = '1'",
  'mysql-virtual_alias_default_maps.cf': "query = SELECT username FROM mailbox WHERE username='%s' AND active = '1' AND NOT EXISTS (SELECT goto FROM alias WHERE address='%s' AND (active = '1' OR active = '3'))",
  'mysql-virtual_alias_maps.cf': "query = SELECT goto FROM alias WHERE address='%s' AND (active = '1' OR active = '3')",
  'mysql-virtual_alias_pipe_maps.cf': "query = SELECT username FROM alias_pipe WHERE address='%s' AND active = '1'",
  'mysql-virtual_domains_maps.cf': "query = SELECT domain FROM domain WHERE domain='%s' AND backupmx = '0' AND active = '1'",
  'mysql-virtual_mailbox_gid_maps.cf': "query = SELECT gid FROM mailbox WHERE username='%s' AND active = '1'",
  'mysql-virtual_mailbox_limit_maps.cf': "query = SELECT quota FROM mailbox WHERE username='%s' AND active = '1'",
  'mysql-virtual_mailbox_maps.cf': "query = SELECT maildir FROM mailbox WHERE username='%s' AND active = '1'",
  'mysql-virtual_mailbox_uid_maps.cf': "query = SELECT uid FROM mailbox WHERE username='%s' AND active = '1'",
};

export function renderMailConfig(ds, plan) {
  const S = ds.SERVER;
  const creds = `user = postfix\npassword = ${S.mysql.postfixPassword}\ndbname = postfix\n`;
  const pf = { owner: 'root', group: 'postfix', mode: 0o640 };
  for (const [name, query] of Object.entries(MAPS)) plan.file(`/etc/postfix/${name}`, `hosts = localhost\n${creds}${query}\n`, pf);
  plan.file('/etc/postfix/mysql-virtual_vacation.cf',
    `${creds}table = vacation\nselect_field = email\nwhere_field = email\nadditional_conditions = and active = '1'\nresult_format = %u#%d@autoreply.${S.hostname}\n`, pf);
  const ssl = ds.CERTIFICATES.filter((c) => ds.MAIL_DOMAINS.some((m) => m.domain === c.name));
  plan.file('/etc/postfix/vmail_ssl.map', ssl.map((c) => `mail.${c.name} /etc/pki/tls/private/${c.name}.key /etc/pki/tls/certs/${c.name}.bundle`).join('\n') + '\n');

  const connect = `connect = host=localhost dbname=postfix user=postfix password=${S.mysql.postfixPassword}`;
  const dv = { owner: 'root', group: 'dovecot', mode: 0o640 };
  plan.file('/etc/dovecot/dovecot-mysql.conf', `driver = mysql
${connect}
default_pass_scheme = MD5-CRYPT
password_query = SELECT username as user, password, concat('/var/vmail/', maildir) as userdb_home, concat('maildir:/var/vmail/', maildir) as userdb_mail, uid as userdb_uid, gid as userdb_gid FROM mailbox WHERE username = '%u' AND active = '1'
user_query = SELECT concat('/var/vmail/', maildir) as home, concat('maildir:/var/vmail/', maildir) as mail, uid, gid, CONCAT('*:messages=0:bytes=', quota) as quota_rule FROM mailbox WHERE username = '%u' AND active = '1'
iterate_query = SELECT username AS user FROM mailbox
`, dv);
  plan.file('/etc/dovecot/dovecot-token.conf', `driver = mysql
${connect}
default_pass_scheme = SHA512-CRYPT
password_query = SELECT username as user, IF(token_validity >= NOW(), token,password) as password, concat('/var/vmail/', maildir) as userdb_home, concat('maildir:/var/vmail/', maildir) as userdb_mail, uid as userdb_uid, gid as userdb_gid FROM postfix.mailbox WHERE username = '%u' AND active = '1'
`, dv);
  plan.file('/etc/dovecot/dovecot-dict-quota.conf', `${connect}
map {
  pattern = priv/quota/storage
  table = quota2
  username_field = username
  value_field = bytes
}
map {
  pattern = priv/quota/messages
  table = quota2
  username_field = username
  value_field = messages
}
`, dv);
  // One block per domain with BOTH names, as on the source (`doveconf -n` prints
  // `local_name mail.<d> webmail.<d> {`, docs/cwp/dovecot-n.txt). In the FILE the
  // space-separated list must be quoted: Dovecot 2.3 rejects two bare names
  // ("Expecting '{'") and matches a quoted list name by name.
  plan.file('/etc/dovecot/sni.conf', ssl.map((c) => `local_name "mail.${c.name} webmail.${c.name}" {
  ssl_cert = </etc/pki/tls/certs/${c.name}.bundle
  ssl_key = </etc/pki/tls/private/${c.name}.key
}
`).join(''));
}

// ── OpenDKIM ─────────────────────────────────────────────────────────────────

export function renderDkim(ds, plan, crypto) {
  const publicByDomain = {};
  const dkimGroup = { owner: 'root', group: 'opendkim' };
  plan.dir('/etc/opendkim', { ...dkimGroup, mode: 0o750 });
  plan.dir('/etc/opendkim/keys', { owner: 'opendkim', group: 'opendkim', mode: 0o750 });
  plan.dir('/etc/opendkim/userkeys', { ...dkimGroup, mode: 0o750 });
  const keyTable = ['# OPENDKIM KEY TABLE', '# To use this file, uncomment the #KeyTable option in /etc/opendkim.conf,', '# then uncomment the following line and replace example.com with your domain', '#default._domainkey.example.com example.com:default:/etc/opendkim/keys/default.private', ''];
  const signingTable = ['# OPENDKIM SIGNING TABLE', '# This table controls how to apply one or more signatures to outgoing messages based', '# on the address found in the From: header field. In simple terms, this tells', '# OpenDKIM "how" to apply your keys.', ''];
  for (const k of ds.DKIM) {
    const priv = crypto.rsaKey(k.bits, `dkim-${k.domain}`);
    const pub = crypto.rsaPublicB64(priv);
    publicByDomain[k.domain] = pub;
    const dir = `/etc/opendkim/userkeys/${k.domain}`;
    plan.dir(dir, { owner: 'opendkim', group: 'opendkim', mode: 0o755 });
    plan.file(`${dir}/default.private`, priv, { owner: 'opendkim', group: 'opendkim', mode: 0o600 });
    const chunks = (`p=${pub}`.match(/.{1,250}/g) ?? []).map((c) => `\t  "${c}"`).join('\n');
    plan.file(`${dir}/default.txt`, `default._domainkey\tIN\tTXT\t( "v=DKIM1; k=rsa; "\n${chunks} )  ; ----- DKIM key default for ${k.domain}\n`,
      { owner: 'opendkim', group: 'opendkim', mode: 0o600 });
    keyTable.push(`default._domainkey.${k.domain} ${k.domain}:default:${dir}/default.private`);
    signingTable.push(`*@${k.domain} default._domainkey.${k.domain}`);
  }
  plan.file('/etc/opendkim/KeyTable', `${keyTable.join('\n')}\n`, { ...dkimGroup, mode: 0o640 });
  plan.file('/etc/opendkim/SigningTable', `${signingTable.join('\n')}\n`, { ...dkimGroup, mode: 0o640 });
  plan.file('/etc/opendkim/TrustedHosts', `127.0.0.1\n::1\n${ds.SERVER.hostname}\n`, { ...dkimGroup, mode: 0o640 });
  return publicByDomain;
}
