import crypto from 'crypto';
import path from 'path';
import type { DesiredDkimKey, DesiredMailDomain, DesiredMailSettings, DesiredTlsCertificate } from '../../driver';
import { MailDriverError } from '../../driver';
import { ADMIN_HASH_ENV, ADMIN_USER, MASTER_USER, STALWART_API_PORT, STALWART_PATHS, STALWART_RELAY_PORT } from './constants';
import type { SendLimits } from './limits';
import { certName, domainName, invalid, ipAddress, positiveInt, selector } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// PURE renderer of the Stalwart configuration (config.test.ts). The panel
// writes the result into paths.mailEngineConfig('stalwart') (mounted READ-ONLY
// at /etc/oblimint/stalwart) and RESTARTS the engine to apply it: Stalwart
// 0.12.4 reads its local configuration file at start only (GET /api/reload
// rebuilds from the copy loaded at boot — verified on the Linux test host), see driver.ts.
//
// Except the DOMAIN-dependent settings (report P4, docs/P4b-PLAN.md §19: a
// mail domain / DKIM key never restarts the engine): the DKIM signatures
// (signature.*), the signing rules (auth.dkim.sign, report.dsn.sign), the
// message size (session.data.limits.size) and the expressions holding the site
// relay's exact addresses (session.rcpt.relay, auth.spf.verify.*,
// auth.dmarc.verify) are rendered as flat SETTINGS (output.settings,
// DYNAMIC_SETTINGS) that the driver stores in Stalwart's settings store
// (POST /api/settings) and applies with GET /api/reload — live, no restart,
// verified on the Linux test host 0.12.4 (a message signed with a key added this way,
// a size lowered this way enforced at once). They are NOT local keys (the
// exclusions in LOCAL_KEYS). Macros are not resolved in stored values
// (the Linux test host: "%{file:…}%" read literally), so the DKIM private key is stored
// inline (the engine already reads it; never logged, redactSecrets masks PEM).
//
// Every key the panel renders is a "local" key (config.local-keys =
// LOCAL_KEYS, the prefixes rendered here): the read-only file stays the only
// source of those settings. Everything else is Stalwart's own: at boot it
// stores its defaults (spam-filter rules and lists, oauth.key, report.*,
// default limiters, fail2ban bans…) — those keys must NOT be local, or the
// write into the read-only file fails ("Configuration write error … Read-only
// file system") and the defaults are lost; they go to its settings store
// (RocksDB, mail/data/stalwart).
//
// Security properties (tests assert each one):
//   MA1  AUTH is offered ONLY on 587 / 465 and only once TLS is up; never on
//        25 nor on the internal 10025; IMAP / POP3 / ManageSieve refuse
//        plain-text authentication without TLS (allow-plain-text = false).
//   MA2  relay = authenticated submission, or the site relay on the internal
//        port 10025 from its EXACT addresses (remote_ip == '<ip>', never a
//        subnet); everything else may only deliver to local domains.
//   MA3  session.auth.must-match-sender: a mailbox sends only as one of its
//        emails (its address + the aliases mapped to it).
//   MA7  the HTTP admin API listens on 8080 inside the mail network; the
//        container spec never publishes it (spec.ts).
//   MA14 SPF / DKIM / DMARC verified on 25 (and on 10025 from anything that is
//        not the relay); spam filter thresholds from the settings.
//   Reports: Stalwart never SENDS a report to a third party — no DMARC /
//        DKIM / SPF failure report (they carry the headers of a tenant's
//        inbound mail to whatever ruf= a forged sender's domain publishes),
//        no DMARC / TLS aggregate report (mail leaving under the platform's
//        domain). Its defaults (report.*.send = "[1, 1d]" / "daily", kept in
//        its own store) send them: a forged user@microsoft.com message made
//        it queue a DMARC failure report to Microsoft (the Linux test host). Same policy
//        as postfix-dovecot / Rspamd, which sends none. Only the five
//        report.*.send keys are local (exact keys): the rest of report.*
//        (from-name, report.analysis…) stays Stalwart's own.
//   Escaping: every string goes through tomlString() (TOML basic string,
//   control characters escaped, Stalwart macros "%{…}%" REFUSED); values
//   embedded in expressions are strictly validated (validate.ts), never
//   escaped. DKIM keys / certificates are referenced with %{file:…}% macros
//   built here from validated names only.
//
// Configuration keys used (hypothesis H12 of api.ts, checked on the Linux test host):
//   server.hostname, server.listener.<id>.{bind,protocol,tls.implicit},
//   server.max-connections, lookup.default.{hostname,domain},
//   store.<id>.{type,path,compression}, storage.{data,fts,blob,lookup,directory},
//   directory.internal.{type,store}, authentication.fallback-admin.{user,secret},
//   authentication.master.{user,secret}, config.local-keys, tracer.stdout.*,
//   tracing.level.<event>,
//   certificate.<id>.{cert,private-key,subjects,default}, server.tls.certificate,
//   session.auth.{mechanisms,directory,require,must-match-sender},
//   session.rcpt.{directory,relay,catch-all,sub-addressing},
//   session.data.limits.size, report.{dmarc,dkim,spf}.send,
//   report.{dmarc,tls}.aggregate.send, auth.{spf.verify.ehlo,spf.verify.mail-from,
//   dkim.verify,dmarc.verify,arc.verify,arc.seal,dkim.sign}, signature.<id>.*,
//   imap.auth.allow-plain-text, sieve.untrusted.limits.redirects,
//   queue.limiter.inbound.<id>.{key,rate,match,enable} (match: ends_with(authenticated_as, '@<domain>'),
//   hypothesis H-LIMIT: the expression function ends_with — limits.ts, checked on the Linux test host),
//   spam-filter.score.{spam,reject}, spam-filter.grey-list.duration.
// ─────────────────────────────────────────────────────────────────────────────

export interface StalwartRenderInput {
  settings: DesiredMailSettings;
  domains: DesiredMailDomain[];
  /**
   * Hourly limits per mail domain + the fallback for the other authenticated
   * senders (limits.ts): never the mailbox list, so a mailbox create / delete
   * or a send toggle leaves the file unchanged (report P4, no restart).
   */
  sendLimits: SendLimits;
  dkim: DesiredDkimKey[];
  tls: DesiredTlsCertificate[];
  /** Exact addresses of the site relay on the mail network ([] = relay not deployed: nobody may relay through 10025). */
  relayAddresses: string[];
  /** Host directories that hold the mail certificates (paths.mailCerts(), local and host views). */
  certRoots: string[];
}

export interface StalwartRenderOutput {
  /** config.toml content. */
  toml: string;
  /**
   * Settings kept in Stalwart's store (key → raw value, Stalwart's flattened
   * form: arrays as <key>.0000…): every key under DYNAMIC_SETTINGS, nothing
   * else. Holds the DKIM private keys: never logged.
   */
  settings: Record<string, string>;
  /** Certificates skipped (path outside mail/certs): staff warnings. */
  warnings: string[];
}

/**
 * Outgoing reports, all disabled (see "Reports" in the header): the DMARC /
 * DKIM / SPF failure reports and the DMARC / TLS aggregate reports. Rendered
 * as is and listed EXACTLY in LOCAL_KEYS (never 'report.*': Stalwart stores
 * the other report.* keys itself).
 */
export const REPORT_SEND_KEYS = {
  'report.dmarc.send': 'false',
  'report.dkim.send': 'false',
  'report.spf.send': 'false',
  'report.dmarc.aggregate.send': 'false',
  'report.tls.aggregate.send': 'false',
} as const;

/**
 * Domain-dependent settings applied live through the settings store (see the
 * header): `root` and every key under `root.`, read back with
 * GET /api/settings/list?prefix=<list> (keys come back relative to it).
 * Stalwart refuses an expression made of a lone else ("Found 'else' before
 * 'if'", the Linux test host): without a branch the root key holds the plain value.
 */
export const DYNAMIC_SETTINGS = [
  { root: 'signature', list: 'signature' },
  { root: 'auth.dkim.sign', list: 'auth.dkim' },
  { root: 'session.data.limits.size', list: 'session.data.limits' },
  // The expressions holding the site relay's EXACT addresses (MA2, MA14): the
  // relay (re)joins the mail network after the engine's first syncs on a fresh
  // install and its address may change on any recreation — a restart each time
  // otherwise (the Linux test host: the first mail domain restarted the engine).
  { root: 'session.rcpt.relay', list: 'session.rcpt' },
  { root: 'auth.spf.verify', list: 'auth.spf.verify' },
  { root: 'auth.dmarc.verify', list: 'auth.dmarc' },
  // DSN / bounce signing with the panel's signatures of the default domain
  // (Stalwart's default expects "rsa-<domain>" / "ed25519-<domain>" signers
  // that never exist here: "DKIM signer not found", unsigned bounces).
  { root: 'report.dsn.sign', list: 'report.dsn' },
] as const;

/** A key under one of DYNAMIC_SETTINGS. */
export function isDynamicSetting(key: string): boolean {
  return DYNAMIC_SETTINGS.some((d) => key === d.root || key.startsWith(`${d.root}.`));
}

/**
 * config.local-keys: the prefixes of every key rendered below (and nothing
 * Stalwart writes on its own, see the header). Exclusions first, as in
 * Stalwart's own default list.
 */
export const LOCAL_KEYS = [
  'config.local-keys.*',
  '!server.blocked-ip.*', '!server.allowed-ip.*', 'server.*',
  'lookup.default.*',
  'store.*', 'storage.*', 'directory.*',
  'authentication.fallback-admin.*', 'authentication.master.*',
  'tracer.*', 'tracing.level.*',
  'certificate.*',
  // Domain-dependent settings: in Stalwart's store (DYNAMIC_SETTINGS), never local.
  '!session.data.limits.size', '!session.data.limits.size.*',
  '!auth.dkim.sign', '!auth.dkim.sign.*',
  '!session.rcpt.relay', '!session.rcpt.relay.*',
  '!auth.spf.verify', '!auth.spf.verify.*',
  '!auth.dmarc.verify', '!auth.dmarc.verify.*',
  'session.*',
  'auth.*',
  'queue.limiter.inbound.oblimint-*',
  'imap.*',
  'sieve.untrusted.*',
  'spam-filter.score.*', 'spam-filter.grey-list.*',
  'report.dmarc.send', 'report.dkim.send', 'report.spf.send', 'report.dmarc.aggregate.send', 'report.tls.aggregate.send',
] as const;

/**
 * Events logged at "info" although Stalwart's default level is lower: the
 * failed logins feed the ban logic (logs.ts → recordAuthFailure, MA8);
 * auth.failed is a DEBUG event in 0.12.4 (verified on the Linux test host).
 */
export const INFO_EVENTS = ['auth.failed', 'auth.too-many-attempts'] as const;

/** Recipients / senders per expression branch before splitting (keeps each expression bounded). */
const EXPR_CHUNK = 200;
const MAX_MESSAGE_MB = 100;

// ── TOML primitives ──────────────────────────────────────────────────────────

/** TOML basic string. Refuses Stalwart macros ("%{env:…}%", "%{file:…}%") in data. */
export function tomlString(v: string): string {
  const s = String(v);
  if (s.includes('%{')) throw new MailDriverError('invalidState', 'stalwart: a configuration value contains a macro sequence "%{"');
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** A %{file:…}% macro on a path built here from validated parts. */
function fileMacro(p: string): string {
  if (!/^\/[A-Za-z0-9._/*-]+$/.test(p) || p.includes('..')) throw invalid('file path');
  return `"%{file:${p}}%"`;
}

const tomlList = (items: string[]): string => `[${items.map(tomlString).join(', ')}]`;

/** Table header with a quoted key segment (ids are validated anyway). */
const table = (...parts: string[]): string => `[${parts.map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : tomlString(p))).join('.')}]`;

/** Expression branches: [{ if = "...", then = ... }, …, { else = ... }] (then / else already TOML values). */
function ifBlock(branches: Array<{ if: string; then: string }>, otherwise: string): string {
  const lines = branches.map((b) => `  { if = ${tomlString(b.if)}, then = ${b.then} },`);
  return `[\n${lines.join('\n')}${lines.length ? '\n' : ''}  { else = ${otherwise} },\n]`;
}

/** Expression string literal of a VALIDATED value (single-quoted in Stalwart's expression language). */
const lit = (v: string): string => {
  if (/['\\]/.test(v)) throw invalid('expression value');
  return `'${v}'`;
};

function chunks<T>(items: T[], size = EXPR_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "<var> == 'a' || <var> == 'b'" over validated values. */
const anyOf = (variable: string, values: string[]): string => values.map((v) => `${variable} == ${lit(v)}`).join(' || ');

const DKIM_HEADERS = ['From', 'To', 'Cc', 'Date', 'Subject', 'Message-ID', 'Reply-To', 'In-Reply-To', 'References', 'MIME-Version', 'Content-Type'];

/** Index of a flattened array entry (Stalwart's form: 0000, 0001…). */
const idx = (i: number): string => String(i).padStart(4, '0');

/**
 * An expression as flat settings: <key>.<n>.if / .then …, then <key>.<n>.else;
 * without any branch the plain value in <key> (a lone else is refused).
 */
function setExpression(out: Record<string, string>, key: string, branches: Array<{ if: string; then: string }>, otherwise: string): void {
  if (!branches.length) {
    out[key] = otherwise;
    return;
  }
  branches.forEach((b, i) => {
    out[`${key}.${idx(i)}.if`] = b.if;
    out[`${key}.${idx(i)}.then`] = b.then;
  });
  out[`${key}.${idx(branches.length)}.else`] = otherwise;
}

/** Stable short id for config keys (signature / certificate ids). */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}${crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)}`;
}

/** Container path of a host certificate file, or null when it is not under mail/certs. */
export function certContainerPath(hostPath: string, roots: string[]): string | null {
  const p = String(hostPath ?? '').replace(/\\/g, '/');
  for (const root of roots) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!r || !p.startsWith(`${r}/`)) continue;
    const rel = p.slice(r.length + 1).split('/');
    if (rel.length !== 2 || !['fullchain.pem', 'privkey.pem', 'cert.pem', 'key.pem'].includes(rel[1])) return null;
    return path.posix.join(STALWART_PATHS.certs, certName(rel[0]), rel[1]);
  }
  return null;
}

// ── render ───────────────────────────────────────────────────────────────────

export function renderStalwartConfig(input: StalwartRenderInput): StalwartRenderOutput {
  const s = input.settings;
  const hostname = domainName(s.hostname, 'mail host name');
  const warnings: string[] = [];
  const relayIps = [...new Set(input.relayAddresses.map(ipAddress))].sort();
  const platformMax = positiveInt(Math.round(s.maxMessageSizeMb), 'maximum message size', MAX_MESSAGE_MB) || 1;
  const spamTag = Number(s.spamTagScore);
  const spamReject = Number(s.spamRejectScore);
  if (!Number.isFinite(spamTag) || !Number.isFinite(spamReject)) throw invalid('spam score');

  const out: string[] = [];
  const kv = (k: string, v: string) => out.push(`${k} = ${v}`);
  const blank = () => out.push('');

  out.push('# Rendered by the Oblimint panel (engine stalwart) — DO NOT EDIT: rewritten at every sync.');
  out.push(`# Admin API on :${STALWART_API_PORT} (mail network only, never published); site relay on :${STALWART_RELAY_PORT}.`);
  blank();

  // The keys rendered here are local (read-only file); Stalwart's own
  // defaults go to its store (see the header). Bans are applied by hostd
  // (nftables) from the panel.
  out.push('[config]');
  kv('local-keys', tomlList([...LOCAL_KEYS]));
  blank();

  out.push('[server]');
  kv('hostname', tomlString(hostname));
  kv('max-connections', '8192');
  blank();
  const defaultDomain = hostname.split('.').slice(1).join('.') || hostname;
  out.push('[lookup.default]');
  kv('hostname', tomlString(hostname));
  kv('domain', tomlString(defaultDomain));
  blank();

  // Listeners: public ports + the internal relay port + the admin API.
  const listener = (id: string, port: number, protocol: string, implicitTls = false) => {
    out.push(table('server', 'listener', id));
    kv('bind', tomlList([`[::]:${port}`]));
    kv('protocol', tomlString(protocol));
    if (implicitTls) kv('tls.implicit', 'true');
    blank();
  };
  listener('smtp', 25, 'smtp');
  listener('submission', 587, 'smtp');
  listener('submissions', 465, 'smtp', true);
  listener('relay', STALWART_RELAY_PORT, 'smtp');
  listener('imap', 143, 'imap');
  listener('imaptls', 993, 'imap', true);
  listener('pop3', 110, 'pop3');
  listener('pop3s', 995, 'pop3', true);
  listener('sieve', 4190, 'managesieve');
  listener('http', STALWART_API_PORT, 'http');

  // Storage: RocksDB for everything but the blobs (files).
  out.push(table('store', 'rocksdb'));
  kv('type', tomlString('rocksdb'));
  kv('path', tomlString(`${STALWART_PATHS.data}/db`));
  kv('compression', tomlString('lz4'));
  blank();
  out.push(table('store', 'blobs'));
  kv('type', tomlString('fs'));
  kv('path', tomlString(`${STALWART_PATHS.data}/blobs`));
  kv('depth', '2');
  blank();
  out.push('[storage]');
  kv('data', tomlString('rocksdb'));
  kv('fts', tomlString('rocksdb'));
  kv('lookup', tomlString('rocksdb'));
  kv('blob', tomlString('blobs'));
  kv('directory', tomlString('internal'));
  blank();
  out.push(table('directory', 'internal'));
  kv('type', tomlString('internal'));
  kv('store', tomlString('rocksdb'));
  blank();

  // Administration: the secret is a SHA512-CRYPT hash in the container
  // environment (never the clear secret, never in this file).
  out.push(table('authentication', 'fallback-admin'));
  kv('user', tomlString(ADMIN_USER));
  kv('secret', `"%{env:${ADMIN_HASH_ENV}}%"`);
  blank();
  out.push(table('authentication', 'master'));
  kv('user', tomlString(MASTER_USER));
  kv('secret', `"%{env:${ADMIN_HASH_ENV}}%"`);
  blank();

  out.push(table('tracer', 'stdout'));
  kv('type', tomlString('stdout'));
  kv('level', tomlString('info'));
  kv('ansi', 'false');
  kv('enable', 'true');
  blank();
  out.push('[tracing.level]');
  for (const ev of INFO_EVENTS) kv(tomlString(ev), tomlString('info'));
  blank();

  // ── TLS: SNI certificates from mail/certs ──
  let defaultCert: string | null = null;
  for (const c of [...input.tls].sort((a, b) => (a.names[0] ?? '').localeCompare(b.names[0] ?? ''))) {
    const cert = certContainerPath(c.certPath, input.certRoots);
    const key = certContainerPath(c.keyPath, input.certRoots);
    if (!cert || !key) {
      warnings.push(`certificate ${c.names[0] ?? '?'} skipped: not under the mail certificates directory`);
      continue;
    }
    const names = c.names.map((n) => certName(n));
    if (names.length === 0) continue;
    const id = stableId('c', names[0]);
    out.push(table('certificate', id));
    kv('cert', fileMacro(cert));
    kv('private-key', fileMacro(key));
    kv('subjects', tomlList(names));
    if (c.isDefault && !defaultCert) {
      kv('default', 'true');
      defaultCert = id;
    }
    blank();
  }
  if (defaultCert) {
    out.push('[server.tls]');
    kv('certificate', tomlString(defaultCert));
    blank();
  }

  // ── SMTP session ──
  const fromRelay = relayIps.length ? `(${anyOf('remote_ip', relayIps)})` : null;
  out.push('[session.auth]');
  // MA1: AUTH only on submission ports, only over TLS; nothing on 25 / 10025.
  kv('mechanisms', ifBlock([{ if: '(local_port == 587 || local_port == 465) && is_tls', then: tomlString('[plain, login]') }], 'false'));
  kv('directory', ifBlock([{ if: 'local_port == 587 || local_port == 465', then: tomlString("'internal'") }], 'false'));
  kv('require', ifBlock([{ if: 'local_port == 587 || local_port == 465', then: 'true' }], 'false'));
  kv('must-match-sender', 'true');
  blank();

  out.push('[session.rcpt]');
  kv('directory', tomlString("'internal'"));
  kv('catch-all', 'true');
  kv('sub-addressing', 'true');
  blank();

  // Message size: per recipient domain (min(domain, plan, platform) computed by mail-core), platform ceiling otherwise.
  const sizeBranches: Array<{ if: string; then: string }> = [];
  const bySize = new Map<number, string[]>();
  for (const d of input.domains) {
    if (!d.active) continue;
    const mb = Math.min(platformMax, positiveInt(Math.round(d.maxMessageSizeMb), 'domain message size', MAX_MESSAGE_MB) || platformMax);
    if (mb === platformMax) continue;
    bySize.set(mb, [...(bySize.get(mb) ?? []), domainName(d.name)]);
  }
  for (const [mb, names] of [...bySize.entries()].sort((a, b) => a[0] - b[0])) {
    for (const part of chunks(names.sort())) sizeBranches.push({ if: anyOf('rcpt_domain', part), then: String(mb * 1048576) });
  }
  const settings: Record<string, string> = {};
  setExpression(settings, 'session.data.limits.size', sizeBranches, String(platformMax * 1048576));

  // MA2: relay = authenticated user, or the site relay on 10025 from its exact
  // address(es). Settings store (relay addresses: see DYNAMIC_SETTINGS).
  const relayBranches: Array<{ if: string; then: string }> = [{ if: '!is_empty(authenticated_as)', then: 'true' }];
  if (fromRelay) relayBranches.push({ if: `local_port == ${STALWART_RELAY_PORT} && ${fromRelay}`, then: 'true' });
  setExpression(settings, 'session.rcpt.relay', relayBranches, 'false');

  // ── DKIM signing: active keys of each domain, only for mail submitted by a
  // mailbox or handed over by the site relay (never for inbound mail). Settings store (header).
  const signers = new Map<string, string[]>();
  for (const k of [...input.dkim].sort((a, b) => `${a.domain}/${a.selector}`.localeCompare(`${b.domain}/${b.selector}`))) {
    if (!k.signing) continue;
    const domain = domainName(k.domain, 'DKIM domain');
    const sel = selector(k.selector);
    const pem = String(k.privateKeyPem ?? '');
    if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(pem)) throw invalid('DKIM private key');
    if (k.algorithm !== 'rsa-2048' && k.algorithm !== 'ed25519') throw invalid('DKIM algorithm');
    const id = stableId('k', domain, sel);
    const sig = `signature.${id}`;
    settings[`${sig}.algorithm`] = k.algorithm === 'ed25519' ? 'ed25519-sha256' : 'rsa-sha256';
    settings[`${sig}.domain`] = domain;
    settings[`${sig}.selector`] = sel;
    settings[`${sig}.private-key`] = pem.endsWith('\n') ? pem : `${pem}\n`;
    DKIM_HEADERS.forEach((h, i) => { settings[`${sig}.headers.${idx(i)}`] = h; });
    settings[`${sig}.canonicalization`] = 'relaxed/relaxed';
    settings[`${sig}.set-body-length`] = 'false';
    settings[`${sig}.report`] = 'false';
    signers.set(domain, [...(signers.get(domain) ?? []), id]);
  }
  const outbound = fromRelay
    ? `(!is_empty(authenticated_as) || (local_port == ${STALWART_RELAY_PORT} && ${fromRelay}))`
    : '!is_empty(authenticated_as)';
  const signBranches = [...signers.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, ids]) => ({ if: `${outbound} && sender_domain == ${lit(domain)}`, then: `[${ids.map(lit).join(', ')}]` }));
  setExpression(settings, 'auth.dkim.sign', signBranches, 'false');
  // DSNs / bounces leave as MAILER-DAEMON@<default domain> (lookup.default.domain):
  // signed with the panel's active keys of that domain when it has any.
  const dsnSigners = signers.get(defaultDomain) ?? [];
  settings['report.dsn.sign'] = dsnSigners.length ? `[${dsnSigners.map(lit).join(', ')}]` : 'false';

  // ── inbound authentication checks (MA14): port 25, and 10025 from anything
  // but the relay. SPF / DMARC depend on the relay addresses: settings store.
  const verifyWhen = fromRelay ? `local_port == 25 || (local_port == ${STALWART_RELAY_PORT} && !${fromRelay})` : `local_port == 25 || local_port == ${STALWART_RELAY_PORT}`;
  setExpression(settings, 'auth.spf.verify.ehlo', [{ if: verifyWhen, then: 'relaxed' }], 'disable');
  setExpression(settings, 'auth.spf.verify.mail-from', [{ if: verifyWhen, then: 'relaxed' }], 'disable');
  setExpression(settings, 'auth.dmarc.verify', [{ if: verifyWhen, then: 'relaxed' }], 'disable');
  out.push('[auth.dkim]');
  kv('verify', tomlString('relaxed'));
  blank();
  out.push('[auth.arc]');
  kv('verify', tomlString('relaxed'));
  // No ARC sealing: Stalwart's default seals with "rsa-<default domain>", a
  // signature that never exists here ("ARC sealer not found" on every message).
  kv('seal', 'false');
  blank();

  // ── outgoing reports: none (privacy, see the header) ──
  out.push('[report]');
  for (const [key, value] of Object.entries(REPORT_SEND_KEYS)) kv(key.slice('report.'.length), value);
  blank();

  // ── hourly limits (MA9): per account rate, matched on the mail domains
  // (the login is the address), grouped by rate; then the fallback (strictest
  // rate) for any authenticated sender of a domain without a rule.
  const endsWithAny = (domains: string[]): string => domains.map((d) => `ends_with(authenticated_as, ${lit(`@${d}`)})`).join(' || ');
  const limiter = (id: string, rate: number, match: string) => {
    out.push(table('queue', 'limiter', 'inbound', id));
    kv('key', tomlList(['authenticated_as']));
    kv('rate', tomlString(`${Math.max(rate, 1)}/1h`));
    kv('match', tomlString(match));
    kv('enable', 'true');
    blank();
  };
  const byRate = new Map<number, string[]>();
  const limitedDomains: string[] = [];
  for (const [d, r] of Object.entries(input.sendLimits.byDomain)) {
    const domain = domainName(d, 'sender domain');
    limitedDomains.push(domain);
    if (r === null) continue;
    const rate = positiveInt(r, 'hourly sending limit', 1_000_000);
    byRate.set(rate, [...(byRate.get(rate) ?? []), domain]);
  }
  for (const [rate, domains] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
    chunks([...new Set(domains)].sort()).forEach((part, i) => limiter(`oblimint-rate-${rate}-${i}`, rate, endsWithAny(part)));
  }
  if (input.sendLimits.fallback !== null) {
    const rate = positiveInt(input.sendLimits.fallback, 'fallback hourly sending limit', 1_000_000);
    const known = chunks([...new Set(limitedDomains)].sort()).map((part) => ` && !(${endsWithAny(part)})`).join('');
    limiter('oblimint-rate-default', rate, `!is_empty(authenticated_as)${known}`);
  }

  // ── IMAP / sieve ──
  out.push('[imap.auth]');
  kv('allow-plain-text', 'false');
  blank();
  out.push('[sieve.untrusted.limits]');
  // Forwarding: up to 20 targets (mail-core limit) + the autoresponder.
  kv('redirects', '20');
  blank();

  // ── spam filter ──
  out.push('[spam-filter.score]');
  kv('spam', spamTag.toFixed(1));
  kv('reject', spamReject.toFixed(1));
  blank();
  if (s.greylisting) {
    out.push('[spam-filter.grey-list]');
    kv('duration', tomlString('5m'));
    blank();
  }

  for (const [k, v] of Object.entries(settings)) {
    if (!isDynamicSetting(k)) throw new MailDriverError('invalidState', `stalwart: setting ${k} outside the dynamic settings`);
    if (v.includes('%{')) throw new MailDriverError('invalidState', 'stalwart: a configuration value contains a macro sequence "%{"');
  }
  return { toml: `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, settings, warnings };
}
