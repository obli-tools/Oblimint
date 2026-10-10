import path from 'path';
import type { MigrationFollowUp, MigrationWarning } from '@oblimint/shared';
import { DOMAIN_RE, LOCAL_PART_RE } from '../../../mail/engines/postfixDovecot/validate';
import { VMAIL_GID, VMAIL_UID } from '../../../mail/engines/postfixDovecot/layout';
import { MigrationInterruptedError, type MigrationStepContext, type MigrationStepOutcome } from '../../contracts/execution';
import type { RsyncPullResult } from '../../contracts/source';
import { followUp, lower, outcome, runOwner, skipped, splitMailAddress, warning } from './common';
import { mailDnsDeps, type MailFs } from './deps';
import { MAX_EXCLUDES } from '../../source/rsyncArgv';

// ─────────────────────────────────────────────────────────────────────────────
// Step mail:maildir:<address> (docs/P5-PLAN.md §9.4, D-MAIL, MG6).
//
// CWP keeps cur/ new/ tmp/ and the Maildir++ folders (.Sent, .Trash…) directly
// in the mailbox directory /var/vmail/<domain>/<local>/ (= its home); Oblimint
// (Dovecot mail_location maildir:/var/vmail/%d/%n/Maildir, home
// /var/vmail/%d/%n) expects them under <home>/Maildir/. So:
//   1. <vmail>/<domain>/<local>/Maildir is created if missing, every component
//      lstat'ed from the vmail root down (a symlink or a non-directory anywhere
//      refuses the step: never follow a link while creating — the panel is
//      root), owned 5000:5000 (vmail) 0700;
//   2. rsync pull (preset 'maildir', as uid:gid 5000:5000, never root) of the
//      source mailbox directory into <home>/Maildir/, excluding the Sieve
//      files of the home (sieve/, dovecot.sieve, dovecot.svbin) and the LDA
//      duplicate db; dovecot-uidlist / dovecot-uidvalidity / dovecot-keywords /
//      subscriptions are KEPT (same UIDVALIDITY / UIDs: no re-download), the
//      Dovecot indexes are excluded by the preset (rebuilt by Dovecot);
//   3. personal Sieve scripts (inventory hasSieve): sieve/ pulled into
//      <home>/sieve/, and the active script link dovecot.sieve (CWP) becomes
//      <home>/.dovecot.sieve (Oblimint: sieve = file:~/sieve;active=~/.dovecot.sieve)
//      when it points inside sieve/; anything else → info mailSieve.
// Preconditions: the mailbox exists for the target account (mapped or adopted
// by mail:mailbox), else skipped maildirNoMailbox before touching the disk.
// --delete: never on the initial copy; on a resync / final sync of a domain
// never switched it is implicit for a box created by the migration (Maildir
// flags live in file names: without it every read / moved message would be
// duplicated) and follows mirrorDeletes for an adopted box; once the domain was
// switched (any plan of the source) explicit mirrorDeletes → 409
// switchedNoMirror, and the Dovecot UID files are no longer copied
// (MAILDIR_UID_FILES — the target numbered new mail since).
// While the source is the authority (UID files copied), a later pull MERGES
// the dovecot-uidlist instead of replacing the target's: the UIDs Dovecot gave
// here to messages the source never numbered (source new/ never opened, mail
// delivered here) are kept when they cannot collide (uid ≥ the source's next
// UID), and the next UID never goes back (mergeUidlist) — otherwise every
// resync renumbered them and a client re-downloaded them.
// Engines: stalwart → skipped (mailStalwartMaildir + IMAP sync follow-up);
// external → skipped.
// ─────────────────────────────────────────────────────────────────────────────

export const MAILDIR_EXCLUDES = ['sieve/', 'dovecot.sieve', 'dovecot.svbin', '.dovecot.lda-dupes*'] as const;
/** Dovecot UID / keyword / subscription state: excluded once the target is the authority (switched domain, used adopted box). */
export const MAILDIR_UID_FILES = ['dovecot-uidlist', 'dovecot-uidvalidity*', 'dovecot-keywords', 'subscriptions'] as const;

const DIR_MODE = 0o700;
/** A message file of a Maildir (++) folder: cur/ or new/ entries, the only files a target-side delivery adds. */
const MESSAGE_FILE_RE = /(^|\/)(cur|new)\/[^/]+$/;
/** Exclusions a pull may carry in total (executor limit, rsyncArgv.ts). */
const MAX_MAILDIR_EXCLUDES = MAX_EXCLUDES;

/**
 * Anchored rsync exclude protecting one receiver file from --delete (excluded receiver files are never
 * deleted without --delete-excluded). Characters outside the executor's exclude charset (':' ',' of the
 * Maildir flags) become '?' (any one character but '/'). null = not expressible.
 */
export function protectPattern(rel: string): string | null {
  if (!rel || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
  const p = `/${rel.replace(/[^A-Za-z0-9._@+/-]/g, '?')}`;
  return p.length <= 255 && !p.includes('..') ? p : null;
}
const SIEVE_LINK_RE = /^(?:\.\/)?sieve\/([A-Za-z0-9._-]{1,128})$/;

/** Largest dovecot-uidlist the merge reads (≈ 700k messages). */
export const MAX_UIDLIST_BYTES = 64 * 1024 * 1024;

interface UidlistEntry { uid: number; base: string; line: string }
interface Uidlist { header: string[]; next: number; entries: UidlistEntry[] }

/**
 * Dovecot maildir uidlist v3: `3 V<uidvalidity> N<next uid> [G<guid>…]` then
 * `<uid>[ <ext>…] :<file name>` lines (uids increasing; records may be
 * appended without the header being rewritten: next = max(N, last uid + 1)).
 * null = another version / unparsable (never merged).
 */
export function parseUidlist(text: string): (Uidlist & { validity: string }) | null {
  const lines = text.split('\n');
  const header = (lines[0] ?? '').trim().split(/\s+/);
  if (header[0] !== '3') return null;
  const validity = header.find((t) => /^V\d+$/.test(t))?.slice(1) ?? null;
  const n = Number(header.find((t) => /^N\d+$/.test(t))?.slice(1) ?? NaN);
  if (!validity || !Number.isInteger(n) || n < 1) return null;
  const entries: UidlistEntry[] = [];
  let last = 0;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const m = /^(\d+)(?: [^ :][^ ]*)* :(.+)$/.exec(line);
    if (!m) return null;
    const uid = Number(m[1]);
    if (!Number.isSafeInteger(uid) || uid <= last) return null;
    last = uid;
    entries.push({ uid, base: m[2].split(':')[0], line });
  }
  return { header, next: Math.max(n, last + 1), entries, validity };
}

/**
 * Merge of the target's uidlist (`previous`, before the pull) into the one the
 * pull just copied from the source (`copied`): the source records win; a
 * target record whose message the source does not list is kept when its uid
 * is ≥ the source's next UID (no collision possible with a source UID, past or
 * future of the copied state); the next UID is the largest of both. Returns
 * null when nothing has to change or when the files cannot be merged
 * (another format / UIDVALIDITY: the copied file stays).
 */
export function mergeUidlist(previous: string, copied: string): { text: string; kept: number } | null {
  const prev = parseUidlist(previous);
  const src = parseUidlist(copied);
  if (!prev || !src || prev.validity !== src.validity) return null;
  const known = new Set(src.entries.map((e) => e.base));
  const kept = prev.entries.filter((e) => !known.has(e.base) && e.uid >= src.next);
  const next = Math.max(src.next, prev.next, ...kept.map((e) => e.uid + 1));
  if (!kept.length && next === src.next) return null;
  const header = src.header.map((t) => (/^N\d+$/.test(t) ? `N${next}` : t));
  const text = [header.join(' '), ...src.entries.map((e) => e.line), ...kept.map((e) => e.line)].join('\n') + '\n';
  return { text, kept: kept.length };
}

/** Creates `rel` components under `root` (which must exist as a real directory), never through a symlink. */
export async function ensureVmailDirs(fs: MailFs, root: string, rel: string[]): Promise<string> {
  const rootStat = await fs.lstat(root);
  if (!rootStat) {
    await fs.mkdir(root, DIR_MODE);
    await fs.chown(root, VMAIL_UID, VMAIL_GID);
  } else if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${root} is not a plain directory`);
  }
  let cur = root;
  for (const part of rel) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) throw new Error(`Invalid path component ${part}`);
    cur = path.posix.join(cur, part);
    const st = await fs.lstat(cur);
    if (!st) {
      await fs.mkdir(cur, DIR_MODE);
      // Re-checked after the creation: a link swapped in between is refused, never chowned.
      const again = await fs.lstat(cur);
      if (!again || again.isSymbolicLink() || !again.isDirectory()) throw new Error(`${cur} is not a plain directory`);
      await fs.chown(cur, VMAIL_UID, VMAIL_GID);
      await fs.chmod(cur, DIR_MODE);
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${cur} is not a plain directory`);
    }
  }
  return cur;
}

/** Target of the CWP active-script link dovecot.sieve, from an fs.find line (`%y|%m|%u|%g|%s|%T@|%p|%l`). */
export function sieveLinkTarget(findOutput: string, maildirPath: string): string | null {
  const base = maildirPath.replace(/\/+$/, '');
  for (const line of findOutput.split('\n')) {
    const f = line.split('|');
    if (f.length < 8 || f[0] !== 'l') continue;
    if (f[6].replace(/\/+$/, '') !== `${base}/dovecot.sieve`) continue;
    let target = f.slice(7).join('|').trim();
    if (target.startsWith(`${base}/`)) target = target.slice(base.length + 1);
    const m = SIEVE_LINK_RE.exec(target);
    return m && m[1] !== '.' && m[1] !== '..' ? `sieve/${m[1]}` : null;
  }
  return null;
}

async function installSieveLink(fs: MailFs, home: string, target: string): Promise<boolean> {
  const link = path.posix.join(home, '.dovecot.sieve');
  const st = await fs.lstat(link);
  if (st && !st.isSymbolicLink()) return false; // a real file there: left as is
  if (st) {
    if (await fs.readlink(link) === target) return true;
    await fs.unlink(link);
  }
  await fs.symlink(target, link);
  await fs.lchown(link, VMAIL_UID, VMAIL_GID);
  return true;
}

export async function runMaildirStep(ctx: MigrationStepContext, addressKey: string): Promise<MigrationStepOutcome> {
  const deps = mailDnsDeps();
  const address = lower(addressKey);
  const scope = { kind: 'mailbox' as const, key: address };
  const planned = ctx.account.mailboxes.find((m) => lower(m.address) === address);
  if (!planned) return skipped({ address, reason: 'notInPlan' });

  const engine = await deps.mail.engine();
  if (engine === 'stalwart') {
    return skipped({ address, reason: 'mailStalwartMaildir' }, [warning(ctx, 'mailStalwartMaildir', 'warning', scope, { address })],
      [followUp(ctx, 'mailStalwartMaildir', scope, 'manual', { address })]);
  }
  if (engine !== 'postfix-dovecot') {
    return skipped({ address, reason: 'mailEngineExternal', engine }, [warning(ctx, 'mailEngineExternal', 'info', scope, { engine })]);
  }

  const { local, domain } = splitMailAddress(address);
  if (!LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(domain)) throw new Error(`Invalid mailbox address ${address}`);
  const remote = String(planned.maildirPath ?? '').replace(/\/+$/, '');
  // MG6: the source maildir must be THIS address's (postfix.mailbox.maildir is a free column: a row of the
  // attacker's domain pointing at victim.tld/ceo/ would otherwise pull another tenant's mail into this box).
  if (remote.toLowerCase() !== `/var/vmail/${domain}/${local}`) {
    throw new Error(`Unexpected maildir path on the source for ${address} (expected /var/vmail/${domain}/${local})`);
  }
  const binding = { kind: 'mailbox' as const, address };

  // The box must exist (created or adopted by mail:mailbox for THIS account):
  // never fill a maildir the mail module does not know (plan limit refused it,
  // invalid address…) — orphan data outside any quota (MG8).
  const accountId = ctx.targetAccountId();
  let boxId = await deps.objectMap.resolve(ctx.run.sourceId, 'mailbox', address, runOwner(ctx));
  const mapped = boxId !== null;
  if (!boxId && accountId) {
    const box = await deps.mail.findMailbox(address);
    if (box && box.accountId === accountId) boxId = box.id;
  }
  if (!boxId || !accountId) {
    await ctx.log('warn', 'maildirNoMailbox', { address });
    return skipped({ address, reason: 'maildirNoMailbox' }, [warning(ctx, 'maildirNoMailbox', 'warning', scope, { address })]);
  }
  // A box found by address only (mapping lost / not ours) is treated as adopted: never mirrored implicitly.
  const boxMeta = mapped ? (await deps.objectMap.meta(ctx.run.sourceId, 'mailbox', address)) ?? {} : { adopted: true };
  const adopted = boxMeta.adopted === true;

  // MG5 / D-RESYNC. A switched (or once switched) domain receives its mail
  // here: explicit mirrorDeletes refused (409), never an implicit --delete.
  let switched = await deps.domainSwitched(ctx.run.planId, domain);
  if (ctx.run.kind !== 'initial' && ctx.run.mirrorDeletes && switched) {
    throw Object.assign(new Error(`${domain} was switched to Oblimint: mirroring deletions would erase the mail received here`),
      { statusCode: 409, code: 'switchedNoMirror' });
  }
  // Maildir encodes the flags in the file NAME (<base>:2,S) and a move changes
  // the folder: a delta without --delete would leave the old names next to the
  // new ones (Dovecot shows every read / moved message twice, deleted ones come
  // back). A resync / final sync therefore mirrors a box created by the
  // migration — except an adopted box (it may hold mail of its own) unless the
  // staff asked for mirrorDeletes explicitly — and never deletes mail the
  // target received itself (see below).
  let mirror = ctx.run.kind !== 'initial' && !switched && (ctx.run.mirrorDeletes || !adopted);

  const root = deps.vmailRoot();
  const home = await ensureVmailDirs(deps.fs, root, [domain, local]);
  const maildir = await ensureVmailDirs(deps.fs, root, [domain, local, 'Maildir']);
  // Dovecot UID files (dovecot-uidlist / -uidvalidity / -keywords, subscriptions)
  // come from the source while it is the authority; once the domain was switched
  // (Oblimint delivered and numbered new mail) or into an adopted box already used
  // here, the source copies are older: never put them back (UIDs reused for other
  // messages, or a UIDVALIDITY reset = every client downloads everything again).
  let protectUidFiles = switched || (adopted && !!(await deps.fs.lstat(path.posix.join(maildir, 'dovecot-uidlist'))));
  const excludes: string[] = [...MAILDIR_EXCLUDES, ...(protectUidFiles ? MAILDIR_UID_FILES : [])];
  // Target uidlist before the pull (merged back after it, see mergeUidlist). undefined = unreadable (not merged).
  const uidlistPath = path.posix.join(maildir, 'dovecot-uidlist');
  const readUidlist = async (): Promise<string | null | undefined> => {
    try {
      return await deps.fs.readSmallFile(uidlistPath, MAX_UIDLIST_BYTES);
    } catch (err) {
      await ctx.log('warn', 'maildirUidlistUnreadable', { address, error: String((err as Error)?.message ?? err).slice(0, 200) });
      return undefined;
    }
  };
  const uidlistBefore = protectUidFiles ? undefined : await readUidlist();
  await ctx.checkpoint();

  const session = await ctx.session();
  const warnings: MigrationWarning[] = [];
  const followUps: MigrationFollowUp[] = [];
  const pull = (o: { deleteExtraneous: boolean; dryRun?: boolean; excludes: string[] }) => session.rsyncPull({
    binding,
    remotePath: remote,
    localPath: maildir,
    uid: VMAIL_UID,
    gid: VMAIL_GID,
    preset: 'maildir',
    excludes: o.excludes,
    deleteExtraneous: o.deleteExtraneous,
    ...(o.dryRun ? { dryRun: true } : {}),
    signal: ctx.signal,
    ...(o.dryRun ? {} : { onProgress: (p: { bytes: number }) => ctx.progress({ bytes: p.bytes }) }),
  });

  // Mail the TARGET received itself before the switch (the migrated sites' own
  // mail(), other tenants of the platform — the mail domain is live here since
  // the initial run) is not on the source: a mirror would delete it. A dry run
  // lists what --delete would remove; a message file that arrived here after
  // the previous pull started (mtime ≥ that start; copies keep the source
  // mtime) is target-only: protected (excluded from the deletion), or — too
  // many to exclude — the pull runs without --delete. Reported either way.
  let targetOnly = 0;
  if (mirror) {
    const dry = await pull({ deleteExtraneous: true, dryRun: true, excludes });
    const lastPullAt = typeof boxMeta.maildirPullStartedAt === 'number' ? boxMeta.maildirPullStartedAt : null;
    const local: string[] = [];
    for (const rel of dry.deletions ?? []) {
      if (!MESSAGE_FILE_RE.test(rel)) continue;
      const st = await deps.fs.lstat(path.posix.join(maildir, rel));
      if (!st || st.isDirectory() || st.isSymbolicLink()) continue;
      if (lastPullAt === null || st.mtimeMs === undefined || st.mtimeMs >= lastPullAt) local.push(rel);
    }
    targetOnly = local.length;
    if (local.length) {
      const patterns = local.map(protectPattern);
      if (patterns.every((p) => p !== null) && excludes.length + patterns.length <= MAX_MAILDIR_EXCLUDES) {
        excludes.push(...(patterns as string[]));
      } else {
        mirror = false;
      }
      warnings.push(warning(ctx, 'maildirTargetOnly', 'warning', scope, { address, count: local.length, mirrorDeletes: mirror }));
      await ctx.log('warn', 'maildirTargetOnly', { address, count: local.length, mirrorDeletes: mirror });
    }
  }

  // Re-checked right before the copy (the cutover may have switched the domain
  // during the dry run / a long queue): never a --delete nor the source UID
  // files into a box that is now live.
  if (!switched && await deps.domainSwitched(ctx.run.planId, domain)) {
    switched = true;
    mirror = false;
    if (!protectUidFiles) { protectUidFiles = true; excludes.push(...MAILDIR_UID_FILES); }
    warnings.push(warning(ctx, 'maildirSwitchedDuringRun', 'warning', scope, { address, domain }));
  }

  const pullStartedAt = Date.now();
  const res: RsyncPullResult = await pull({ deleteExtraneous: mirror, excludes });
  // Start of this pull: the next mirror tells target-only mail by it (mtime of a later local delivery).
  if (mapped) {
    await deps.objectMap.put({
      sourceId: ctx.run.sourceId, cwpUsername: ctx.run.cwpUsername, kind: 'mailbox', sourceKey: address, targetTable: 'mailboxes',
      targetId: boxId, meta: { ...boxMeta, address, maildirPullStartedAt: pullStartedAt }, runId: ctx.run.id,
    });
  }

  // Source UID files copied over the target's: keep what Dovecot numbered here (mergeUidlist).
  let uidsKept = 0;
  if (!protectUidFiles && typeof uidlistBefore === 'string') {
    const after = await readUidlist();
    if (after !== undefined) {
      // No uidlist on the source (never opened there) but a mirror removed ours: the target numbering is put back.
      const merged = after === null ? { text: uidlistBefore, kept: 0 } : mergeUidlist(uidlistBefore, after);
      if (merged) {
        await deps.fs.writeFileAtomic(uidlistPath, merged.text, VMAIL_UID, VMAIL_GID, 0o600);
        uidsKept = merged.kept;
        await ctx.log('info', 'maildirUidlistMerged', { address, kept: merged.kept });
      }
    }
  }

  if (res.partial) warnings.push(warning(ctx, 'maildirPartial', 'info', scope, { address }));
  if (res.unsafeLinks.length) warnings.push(warning(ctx, 'maildirUnsafeLinks', 'info', scope, { address, count: res.unsafeLinks.length }));

  // ── personal Sieve scripts ──
  let sieve: 'none' | 'copied' | 'active' | 'failed' = 'none';
  const inv = ctx.inventory.mailboxes.find((m) => lower(m.address) === address);
  if (inv?.hasSieve) {
    try {
      const sieveDir = await ensureVmailDirs(deps.fs, root, [domain, local, 'sieve']);
      await session.rsyncPull({
        binding, remotePath: `${remote}/sieve`, localPath: sieveDir, uid: VMAIL_UID, gid: VMAIL_GID, preset: 'maildir',
        deleteExtraneous: false, signal: ctx.signal,
      });
      sieve = 'copied';
      const found = await session.run('fs.find', { path: remote, maxDepth: 1, type: 'l', name: 'dovecot.sieve' }, { allowNonZeroExit: true });
      const target = sieveLinkTarget(found.stdout, remote);
      if (target && await installSieveLink(deps.fs, home, target)) sieve = 'active';
      else warnings.push(warning(ctx, 'mailSieve', 'info', scope, { address, active: false }));
    } catch (err) {
      if (err instanceof MigrationInterruptedError || ctx.signal.aborted) throw err;
      sieve = 'failed';
      warnings.push(warning(ctx, 'mailSieve', 'info', scope, { address, active: false }));
      followUps.push(followUp(ctx, 'mailSieve', scope, 'manual', { address }));
    }
  }

  // The postfix-dovecot driver exposes no rescan hook: Dovecot rebuilds its indexes / quota on the next access.
  await ctx.log('info', 'maildirSynced', { address, bytes: res.bytes, files: res.files, deleted: res.deleted, partial: res.partial, sieve });
  await ctx.log('debug', 'maildirIndexRebuild', { address });
  return outcome({
    address, bytes: res.bytes, files: res.files, deleted: res.deleted, partial: res.partial, unsafeLinks: res.unsafeLinks.length,
    mirrorDeletes: mirror, uidFilesKept: protectUidFiles, uidsKept, adopted, sieve, targetOnly,
  }, warnings, followUps);
}
