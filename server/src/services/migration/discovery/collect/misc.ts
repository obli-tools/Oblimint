import type { CwpCertificate, CwpCronEntry } from '@oblimint/shared';
import { parseFtpListUsers } from '../parsers/ftp';
import { parseCrontab } from '../parsers/crontab';
import { redactCommand } from '../parsers/redact';
import { certCovers, parseCertificate } from '../parsers/x509';
import { baseName, parseFind } from '../parsers/system';
import { DiscoveryContext, homeOwner } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phases ftp, cron, certificates (P5-PLAN §7.4, CWP-MAP §10).
//   ftp   ftp.listUsers (no hash) → account by uid, else by /home/<u>/ dir.
//   cron  /var/spool/cron/<owner> (+ ~/cron copies, deduplicated); root /
//         non-CWP owners are `system` (outside items).
//   certs /etc/pki/tls/certs/<fqdn>.cert (+ .bundle) analysed with
//         X509Certificate; the key is a PATH only (/etc/pki/tls/private).
// ─────────────────────────────────────────────────────────────────────────────

export const CRON_DIR = '/var/spool/cron';
export const CERT_DIR = '/etc/pki/tls/certs';
export const CERT_KEY_DIR = '/etc/pki/tls/private';

export async function phaseFtp(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const r = await ctx.tryRun('ftp users', 'ftp.listUsers', {}, { allowNonZeroExit: true });
  if (!r) return;
  const uidAccount = new Map<number, string>();
  const accounts = new Set(st.accounts.map((a) => a.username));
  for (const p of st.passwd) if (accounts.has(p.name)) uidAccount.set(p.uid, p.name);
  for (const u of parseFtpListUsers(r.stdout)) {
    const byDir = homeOwner(u.directory);
    const account = (u.uid !== null ? uidAccount.get(u.uid) : undefined) ?? (byDir && accounts.has(byDir) ? byDir : null);
    st.ftpUsers.push({ login: u.login, account, uid: u.uid, gid: u.gid, directory: u.directory, chroot: u.chroot, hashScheme: u.hashScheme });
  }
  st.ftpUsers.sort((a, b) => a.login.localeCompare(b.login));
}

export async function phaseCron(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const accounts = new Set(st.accounts.map((a) => a.username));
  // Listed directly (not ctx.find): a failed listing (no sudo rights…) must be told apart from an empty / missing spool.
  const listing = await ctx.tryRun('crontabs', 'fs.find', { path: CRON_DIR, maxDepth: 1, type: 'f' }, { allowNonZeroExit: true });
  const spoolListed = listing !== null && (listing.exitCode === 0 || /No such file or directory/i.test(listing.stderr));
  if (listing && !spoolListed) ctx.readFailed('crontabs', new Error(CRON_DIR));
  const spool = listing ? parseFind(listing.stdout).filter((e) => e.path !== CRON_DIR).map((e) => e.path) : [];
  const homeCopies = st.accounts.map((a) => `${a.homeDir}/cron`);
  const files = await ctx.readFiles('crontabs', [...spool, ...homeCopies]);
  const phpDefault = st.server.phpDefault;

  const push = (owner: string, keyPrefix: string, text: string, forceDisabled: boolean, known: Set<string>) => {
    const account = accounts.has(owner) ? owner : null;
    for (const l of parseCrontab(text, phpDefault)) {
      // MG2: credential values (mysqldump -pX, curl -u u:p, ?key=…, scheme://u:p@) never reach the inventory.
      const command = redactCommand(l.command);
      const sig = `${l.schedule}\u0000${command}`;
      if (known.has(sig)) continue;
      known.add(sig);
      const entry: CwpCronEntry = {
        key: `${keyPrefix}${l.lineNo}`, owner, account, schedule: l.schedule, command, phpBinary: l.phpBinary,
        phpVersion: l.phpVersion, disabled: l.disabled || forceDisabled, system: account === null, lineNo: l.lineNo,
      };
      st.crons.push(entry);
      if (entry.system && !entry.disabled) {
        ctx.addOutside({
          kind: 'root-cron', key: entry.key, account: null, code: 'rootCron', suggestion: 'manual',
          params: { owner, schedule: entry.schedule }, details: { owner, schedule: entry.schedule, command: entry.command },
        });
      }
    }
  };

  const seenPerOwner = new Map<string, Set<string>>();
  const known = (owner: string) => {
    if (!seenPerOwner.has(owner)) seenPerOwner.set(owner, new Set());
    return seenPerOwner.get(owner) as Set<string>;
  };
  /** Owners whose installed crontab was actually read. */
  const spoolRead = new Set<string>();
  const spoolOwners = new Set(spool.map((p) => baseName(p)));
  for (const p of spool) {
    const text = files.get(p) ?? null;
    const owner = baseName(p);
    if (text === null) { ctx.readFailed('crontab', new Error(p)); continue; }
    spoolRead.add(owner);
    push(owner, `${owner}:`, text, false, known(owner));
  }
  // ~/cron: CWP's copy of the user crontab. Its lines not installed in the spool are listed as disabled — only when
  // the installed crontab is KNOWN (read, or the spool listed without a file for the account). Otherwise they stay
  // as written and cronSpoolUnreadable asks for a review (never silently skipped by the planner).
  for (const a of st.accounts) {
    const text = files.get(`${a.homeDir}/cron`) ?? null;
    if (text === null) continue;
    const installedKnown = spoolRead.has(a.username) || (spoolListed && !spoolOwners.has(a.username));
    if (!installedKnown && parseCrontab(text, phpDefault).length > 0) {
      ctx.warn('cronSpoolUnreadable', 'warning', { kind: 'account', key: a.username, account: a.username }, { path: `${CRON_DIR}/${a.username}` });
    }
    push(a.username, `${a.username}:home:`, text, installedKnown, known(a.username));
  }
}

export async function phaseCertificates(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  const listing = await ctx.find('certificates', CERT_DIR, 1, 'f');
  const names = new Set(listing.map((e) => e.path));
  const certs = listing.filter((e) => e.path.endsWith('.cert')).map((e) => e.path).sort();
  const files = await ctx.readFiles('certificates', certs, 256 * 1024);
  const domainAccount = new Map(st.domains.map((d) => [d.fqdn, d.account]));
  const nowMs = st.now.getTime();

  for (const p of certs) {
    const fqdn = baseName(p).slice(0, -'.cert'.length).toLowerCase();
    const text = files.get(p) ?? null;
    if (text === null) { ctx.readFailed('certificate', new Error(p), { kind: 'certificate', key: fqdn }); continue; }
    const facts = parseCertificate(text);
    if (!facts) { ctx.warn('readFailed', 'info', { kind: 'certificate', key: fqdn }, { what: 'certificate', path: p }); continue; }
    const bundle = `${CERT_DIR}/${baseName(p).slice(0, -'.cert'.length)}.bundle`;
    const reg = st.vhostsSsl.get(fqdn);
    const notAfterMs = facts.notAfter ? Date.parse(facts.notAfter) : NaN;
    const cert: CwpCertificate = {
      fqdn,
      certPath: p,
      keyPath: `${CERT_KEY_DIR}/${baseName(p).slice(0, -'.cert'.length)}.key`,
      bundlePath: names.has(bundle) ? bundle : null,
      names: facts.names,
      notBefore: facts.notBefore,
      notAfter: facts.notAfter,
      issuer: facts.issuer,
      selfSigned: facts.selfSigned,
      expired: Number.isFinite(notAfterMs) ? notAfterMs < nowMs : false,
      autossl: reg?.autossl ?? false,
      account: (reg?.user && st.accounts.some((a) => a.username === reg.user) ? reg.user : null) ?? domainAccount.get(fqdn) ?? null,
      keyType: facts.keyType,
    };
    st.certificates.push(cert);
  }

  // Domain → certificate covering it (own file first, then any covering one).
  for (const d of st.domains) {
    const own = st.certificates.find((c) => c.fqdn === d.fqdn && certCovers(c.names, d.fqdn));
    const any = own ?? st.certificates.find((c) => !c.expired && certCovers(c.names, d.fqdn));
    d.certificate = any ? any.certPath : null;
  }
}

