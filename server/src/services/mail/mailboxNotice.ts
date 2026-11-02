import MailComposer from 'nodemailer/lib/mail-composer';
import { logger } from '../../utils/logger';
import type { WebmailEngine } from './webmail/oblimint/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Informational e-mail to a mailbox about its own settings (forwarding turned
// on / changed, a rule that forwards, from the panel: the Outlook-like
// notice). It must reach the OWNER: sent by SMTP it would go through the
// mailbox's managed sieve script — a forwarding without a copy hands it to
// the forwarding target (possibly whoever set it up), a rule may file or drop
// it, and the sync applying the new script races with its delivery. So:
//   1. Stalwart: the message is imported straight into the Inbox through JMAP
//      (Email/import, impersonating the mailbox as the rules' folder list
//      does): no sieve, no forwarding, delivered whatever the script;
//   2. otherwise (other engine, the mailbox's login disabled, engine down): the
//      transactional sender, ONLY when SMTP reaches the mailbox
//      (smtpReachesMailbox: no forwarding without a copy); else nothing is
//      sent (logged) — the webmail banner / the panel notice remain.
// Never throws to the caller (deps.ts runs it as a fire-and-forget hook).
// ─────────────────────────────────────────────────────────────────────────────

export interface MailboxNoticeDeps {
  activeEngine(): Promise<string>;
  webmailEngine(): Promise<WebmailEngine>;
  sendTransactional(m: { to: string; subject: string; text: string; kind: 'mailbox' }): Promise<unknown>;
  now(): Date;
}

const realDeps: MailboxNoticeDeps = {
  async activeEngine() { return (await import('./registry')).activeMailEngine(); },
  async webmailEngine() { return (await import('./webmail/oblimint/server')).webmailEngine; },
  async sendTransactional(m) { return (await import('./transactional')).sendTransactional(m); },
  now: () => new Date(),
};

/** RFC 5322 message of the notice (From: postmaster of the mailbox's own domain, auto-generated). */
export function buildNoticeMessage(address: string, subject: string, text: string, now: Date): Promise<Buffer> {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const node = new MailComposer({
    from: { name: 'Oblimint', address: `postmaster@${domain}` },
    to: address,
    subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 250),
    text,
    date: now,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  }).compile();
  return new Promise((resolve, reject) => node.build((err, message) => (err ? reject(err) : resolve(message))));
}

/** Imports the notice into the Inbox of `address` (JMAP Email/import, unread). Throws on any refusal. */
export async function importNoticeIntoInbox(engine: WebmailEngine, address: string, subject: string, text: string, now: Date): Promise<string> {
  const ep = await engine.endpoints(address);
  const boxes = await engine.call(address, [['Mailbox/get', { accountId: ep.accountId, ids: null, properties: ['id', 'role'] }, 'm']]);
  const list = ((boxes.methodResponses?.[0]?.[1] as { list?: unknown[] } | undefined)?.list ?? []) as Array<{ id?: string; role?: string | null }>;
  const inbox = list.find((m) => m.role === 'inbox')?.id;
  if (!inbox) throw new Error('no Inbox');
  const raw = await buildNoticeMessage(address, subject, text, now);
  const blob = await engine.upload(address, ep.accountId, 'message/rfc822', new Uint8Array(raw));
  const out = await engine.call(address, [['Email/import', {
    accountId: ep.accountId,
    emails: { n: { blobId: blob.blobId, mailboxIds: { [inbox]: true }, keywords: {}, receivedAt: now.toISOString() } },
  }, 'i']]);
  const res = out.methodResponses?.[0];
  const created = (res?.[1] as { created?: Record<string, { id?: string }> } | undefined)?.created?.n?.id;
  if (res?.[0] !== 'Email/import' || !created) {
    const why = (res?.[1] as { notCreated?: Record<string, { type?: string }>; type?: string } | undefined);
    throw new Error(`Email/import refused: ${String(why?.notCreated?.n?.type ?? why?.type ?? 'unknown')}`);
  }
  return created;
}

/** Delivers the notice (see the header). Never throws. */
export async function deliverMailboxNotice(
  address: string, subject: string, text: string, opts: { smtpReachesMailbox: boolean }, deps: MailboxNoticeDeps = realDeps,
): Promise<'inbox' | 'smtp' | 'skipped'> {
  try {
    if ((await deps.activeEngine()) === 'stalwart') {
      try {
        await importNoticeIntoInbox(await deps.webmailEngine(), address, subject, text, deps.now());
        return 'inbox';
      } catch (err) {
        logger.warn({ err: (err as Error)?.message ?? String(err), mailbox: address }, 'mail: notice not imported into the Inbox');
      }
    }
    if (!opts.smtpReachesMailbox) {
      // By SMTP it would follow the forwarding (no copy kept): the owner would not get it.
      logger.info({ mailbox: address }, 'mail: notice not sent (the mailbox forwards without a copy)');
      return 'skipped';
    }
    await deps.sendTransactional({ to: address, subject, text, kind: 'mailbox' });
    return 'smtp';
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? String(err), mailbox: address }, 'mail: notice failed');
    return 'skipped';
  }
}
