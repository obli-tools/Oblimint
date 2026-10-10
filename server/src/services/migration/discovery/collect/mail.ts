import { MAIL_PASSWORD_SCHEMES, type CwpDkimKey, type CwpMailAlias, type CwpMailbox, type CwpMailDomain, type MailPasswordScheme } from '@oblimint/shared';
import { cellInt, cellStr, parseMysqlBatch, type BatchCell } from '../parsers/mysqlBatch';
import { parseDkimTxt, parseKeyTable, parseSigningTable, signingPatternMatches, type KeyTableEntry } from '../parsers/dkim';
import { baseName, dirName } from '../parsers/system';
import { DiscoveryContext, normFqdn } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phases mail + dkim (P5-PLAN §7.4, CWP-MAP §8). postfix.domain / alias /
// quota2 through mysql.query, mailboxes through mail.mailboxMeta (every column
// but the hash, plus the hash SCHEME computed on the source). Account by mail
// domain (main / addon / sub-domain of the account), else by mailbox uid →
// passwd. DKIM: KeyTable / SigningTable + the PUBLIC .txt (bits, algorithm);
// the .private is never read here (keyPath only).
// ─────────────────────────────────────────────────────────────────────────────

export const MAIL_SQL = {
  domains: 'SELECT domain, backupmx, active FROM postfix.domain',
  aliases: 'SELECT address, goto, domain, active FROM postfix.alias',
  quota: 'SELECT username, bytes, messages FROM postfix.quota2',
} as const;

export const DKIM_PATHS = {
  keyTable: '/etc/opendkim/KeyTable',
  signingTable: '/etc/opendkim/SigningTable',
  userKeys: '/etc/opendkim/userkeys',
} as const;

/** mail.mailboxMeta scheme → { scheme, prefixed } ('SHA512-CRYPT' prefixed, 'SHA512-CRYPT*' bare crypt, '' / other → null). */
export function mailScheme(raw: string | null): { scheme: MailPasswordScheme | null; prefixed: boolean } {
  const s = (raw ?? '').trim().toUpperCase();
  const bare = s.endsWith('*');
  const name = bare ? s.slice(0, -1) : s;
  if ((MAIL_PASSWORD_SCHEMES as readonly string[]).includes(name)) return { scheme: name as MailPasswordScheme, prefixed: !bare };
  return { scheme: null, prefixed: false };
}

const active = (v: BatchCell | undefined) => (cellInt(v) ?? 1) !== 0;

export async function phaseMail(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  if (!st.mysqlOk) return;
  let domains: Array<Record<string, BatchCell>>;
  try {
    domains = await ctx.query(MAIL_SQL.domains);
  } catch (err) {
    ctx.checkAbort();
    ctx.warn('postfixDbMissing', 'warning', { kind: 'server', key: 'postfix' });
    return;
  }
  const domainAccount = new Map(st.domains.map((d) => [d.fqdn, d.account]));
  const uidAccount = new Map<number, string>();
  const accountNames = new Set(st.accounts.map((a) => a.username));
  for (const p of st.passwd) if (accountNames.has(p.name)) uidAccount.set(p.uid, p.name);

  let boxes: Array<Record<string, BatchCell>> = [];
  try {
    const r = await ctx.run('mail.mailboxMeta', {});
    boxes = parseMysqlBatch(r.stdout, { header: true });
  } catch (err) {
    ctx.checkAbort();
    ctx.readFailed('mail.mailboxMeta', err);
  }
  let aliases: Array<Record<string, BatchCell>> = [];
  try { aliases = await ctx.query(MAIL_SQL.aliases); } catch (err) { ctx.checkAbort(); ctx.readFailed('postfix.alias', err); }
  const quota = new Map<string, { bytes: number | null; messages: number | null }>();
  try {
    for (const r of await ctx.query(MAIL_SQL.quota)) {
      quota.set((cellStr(r.username) ?? '').toLowerCase(), { bytes: cellInt(r.bytes), messages: cellInt(r.messages) });
    }
  } catch (err) { ctx.checkAbort(); ctx.readFailed('postfix.quota2', err); }

  for (const r of boxes) {
    const address = (cellStr(r.username) ?? '').trim().toLowerCase();
    if (!address.includes('@')) continue;
    const domain = normFqdn(cellStr(r.domain) ?? address.split('@')[1]);
    const uid = cellInt(r.uid);
    const maildir = (cellStr(r.maildir) ?? `${domain}/${address.split('@')[0]}/`).replace(/^\/+/, '');
    const { scheme, prefixed } = mailScheme(cellStr(r.scheme));
    const q = quota.get(address);
    const quotaBytes = cellInt(r.quota);
    const mb: CwpMailbox = {
      address,
      localPart: cellStr(r.local_part) ?? address.split('@')[0],
      domain,
      account: domainAccount.get(domain) ?? (uid !== null ? uidAccount.get(uid) ?? null : null),
      active: active(r.active),
      quotaBytes: quotaBytes && quotaBytes > 0 ? quotaBytes : null,
      usedBytes: q?.bytes ?? null,
      messages: q?.messages ?? null,
      maildir,
      maildirPath: `/var/vmail/${maildir}${maildir.endsWith('/') ? '' : '/'}`,
      uid,
      hashScheme: scheme,
      hashPrefixed: prefixed,
      hasSieve: false,
      displayName: (cellStr(r.name) ?? '').trim() || null,
      maildirBytes: null,
    };
    st.mailboxes.push(mb);
    if (!mb.active) ctx.warn('mailboxInactive', 'info', { kind: 'mailbox', key: address, account: mb.account });
  }

  // Sieve scripts: <maildir>/sieve/ and <maildir>/dovecot.sieve (stat only).
  const sieve = await ctx.stat('sieve', st.mailboxes.flatMap((m) => [`${m.maildirPath}sieve`, `${m.maildirPath}dovecot.sieve`]));
  for (const m of st.mailboxes) m.hasSieve = sieve.has(`${m.maildirPath}sieve`) || sieve.has(`${m.maildirPath}dovecot.sieve`);

  const mailDomainNames = new Set(domains.map((r) => normFqdn(cellStr(r.domain) ?? '')).filter(Boolean));
  const mailboxAddresses = new Set(st.mailboxes.map((m) => m.address));
  for (const r of aliases) {
    const address = (cellStr(r.address) ?? '').trim().toLowerCase();
    if (!address) continue;
    const targets = (cellStr(r.goto) ?? '').split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    // postfixadmin-style self alias of a mailbox: not a redirection.
    if (targets.length === 1 && targets[0] === address && mailboxAddresses.has(address)) continue;
    const domain = normFqdn(cellStr(r.domain) ?? address.split('@')[1] ?? '');
    const kind: CwpMailAlias['kind'] = address.startsWith('@') ? 'catch-all'
      : targets.every((t) => mailDomainNames.has(t.split('@')[1] ?? '')) ? 'local' : 'forward';
    st.mailAliases.push({ address, domain, targets, active: active(r.active), account: domainAccount.get(domain) ?? null, kind });
  }

  for (const r of domains) {
    const name = normFqdn(cellStr(r.domain) ?? '');
    if (!name) continue;
    const boxesOf = st.mailboxes.filter((m) => m.domain === name);
    let account = domainAccount.get(name) ?? null;
    if (!account) {
      const counts = new Map<string, number>();
      for (const m of boxesOf) if (m.account) counts.set(m.account, (counts.get(m.account) ?? 0) + 1);
      account = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    const md: CwpMailDomain = {
      name, account, active: active(r.active), backupMx: (cellInt(r.backupmx) ?? 0) !== 0,
      mailboxes: boxesOf.length, aliases: st.mailAliases.filter((a) => a.domain === name).length, hasDkim: false,
    };
    st.mailDomains.push(md);
    for (const m of boxesOf) if (!m.account) m.account = account;
    for (const a of st.mailAliases) if (a.domain === name && !a.account) a.account = account;
  }
  st.mailDomains.sort((a, b) => a.name.localeCompare(b.name));
  st.mailboxes.sort((a, b) => a.address.localeCompare(b.address));
  st.mailAliases.sort((a, b) => a.address.localeCompare(b.address));
}

export async function phaseDkim(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const tables = await ctx.readFiles('OpenDKIM tables', [DKIM_PATHS.keyTable, DKIM_PATHS.signingTable]);
  const keyTable = parseKeyTable(tables.get(DKIM_PATHS.keyTable) ?? '');
  const signing = parseSigningTable(tables.get(DKIM_PATHS.signingTable) ?? '');

  // Keys on disk that the KeyTable does not reference are listed too (not in the signing table).
  const onDisk = await ctx.find('DKIM keys', DKIM_PATHS.userKeys, 2, 'f', '*.private');
  const entries: KeyTableEntry[] = [...keyTable];
  for (const f of onDisk) {
    if (entries.some((e) => e.keyPath === f.path)) continue;
    const domain = baseName(dirName(f.path)).toLowerCase();
    const selector = baseName(f.path).replace(/\.private$/, '');
    entries.push({ keyName: `${selector}._domainkey.${domain}`, domain, selector, keyPath: f.path });
  }

  const txtPath = (e: KeyTableEntry) => (e.keyPath.endsWith('.private') ? `${e.keyPath.slice(0, -'.private'.length)}.txt` : `${dirName(e.keyPath)}/${e.selector}.txt`);
  const txt = await ctx.readFiles('DKIM public keys', entries.map(txtPath));
  const domainAccount = new Map(st.domains.map((d) => [d.fqdn, d.account]));
  const mailAccount = new Map(st.mailDomains.map((m) => [m.name, m.account]));
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.domain}/${e.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pub = txt.get(txtPath(e)) ?? null;
    const facts = pub !== null ? parseDkimTxt(pub) : { publicKey: null, algorithm: 'unknown' as const, bits: null };
    const inSigningTable = signing.some((s) => s.keyName === e.keyName && (signingPatternMatches(s.pattern, `x@${e.domain}`) || signingPatternMatches(s.pattern, e.domain)));
    const k: CwpDkimKey = {
      domain: e.domain, selector: e.selector, account: domainAccount.get(e.domain) ?? mailAccount.get(e.domain) ?? null, keyPath: e.keyPath,
      bits: facts.bits, algorithm: facts.algorithm, inSigningTable, publicKey: facts.publicKey,
    };
    st.dkimKeys.push(k);
    if (pub === null) ctx.warn('readFailed', 'info', { kind: 'dkim', key, account: k.account }, { what: 'DKIM public key', path: txtPath(e) });
    if (k.algorithm === 'rsa' && k.bits !== null && k.bits < 2048) ctx.warn('dkimWeakKey', 'info', { kind: 'dkim', key, account: k.account }, { bits: k.bits });
  }
  st.dkimKeys.sort((a, b) => `${a.domain}/${a.selector}`.localeCompare(`${b.domain}/${b.selector}`));
  const withKey = new Set(st.dkimKeys.map((k) => k.domain));
  for (const md of st.mailDomains) md.hasDkim = withKey.has(md.name);
}
