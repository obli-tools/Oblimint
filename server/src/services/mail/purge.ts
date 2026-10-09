import type { Knex } from 'knex';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import type { MailDriver } from './driver';
import type { MailPurgeRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Deferred purge of the DATA of deleted mailboxes / domains (MA12). The
// tombstones are written by the database triggers of migration 006 (also on
// CASCADE from a domain / an account deleted by P1/P2 code). Engine data is
// keyed by NAME only (vmail/<domain>/<local>, Stalwart principal), so:
//  - a name may only be reused with its old data by the SAME account (restore
//    within the grace period). createDomain / createMailbox call
//    purgeForeignTombstones() under their locks: the unpurged data of another
//    account (other tenant included) is purged BEFORE the name is reused, or
//    the creation is refused (409 mailDataPendingPurge) — MA5, MA12;
//  - once due: a holder of the same name AND the same account ⇒ data kept,
//    tombstone closed with a note; else driver.purge(); success ⇒ purged_at;
//    failure ⇒ error kept, retried at the next pass. A holder of ANOTHER
//    account (rows older than the creation guard) never keeps the data: a
//    mailbox is purged; a domain directory is not wiped under its new owner
//    (the per-mailbox tombstones the CASCADE wrote purge the old mailboxes).
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = 100;

export interface PurgeReport {
  purged: number;
  skipped: number;
  failed: number;
}

async function holderAccount(conn: Knex | Knex.Transaction, row: Pick<MailPurgeRow, 'kind' | 'name'>): Promise<number | null> {
  const back = row.kind === 'mailbox'
    ? await conn('mailboxes').where({ address: row.name }).first('account_id') as { account_id: number } | undefined
    : await conn('mail_domains').where({ name: row.name }).first('account_id') as { account_id: number } | undefined;
  return back ? Number(back.account_id) : null;
}

export async function runPurgeQueue(driver: MailDriver, now = new Date()): Promise<PurgeReport> {
  const report: PurgeReport = { purged: 0, skipped: 0, failed: 0 };
  const due = await db('mail_purge_queue')
    .whereNull('purged_at')
    .where('purge_after', '<=', now)
    .orderBy('id')
    .limit(BATCH) as MailPurgeRow[];
  for (const row of due) {
    const holder = await holderAccount(db, row);
    if (holder !== null && row.account_id !== null && holder === Number(row.account_id)) {
      await db('mail_purge_queue').where({ id: row.id }).update({ purged_at: now, error: 'Name in use again by the same account: data kept' });
      report.skipped++;
      continue;
    }
    if (holder !== null && row.kind === 'domain') {
      await db('mail_purge_queue').where({ id: row.id }).update({
        purged_at: now, error: 'Domain reused by another account: its directory is kept, the old mailboxes are purged one by one',
      });
      logger.warn({ name: row.name, oldAccount: row.account_id, newAccount: holder }, 'mail purge: domain reused by another account');
      report.skipped++;
      continue;
    }
    if (holder !== null) logger.warn({ name: row.name, oldAccount: row.account_id, newAccount: holder }, 'mail purge: mailbox reused by another account, old data purged');
    try {
      await driver.purge({ kind: row.kind, name: row.name });
      await db('mail_purge_queue').where({ id: row.id }).update({ purged_at: new Date(), error: null });
      report.purged++;
    } catch (err) {
      const message = errText(err).slice(0, 1000);
      await db('mail_purge_queue').where({ id: row.id }).update({ error: message });
      logger.warn({ kind: row.kind, name: row.name, err: message }, 'mail purge failed (retried at the next pass)');
      report.failed++;
    }
  }
  return report;
}

/**
 * Before a name is (re)used by `accountId`: purges NOW the unpurged data that
 * another account left under it (a domain: its own tombstone + every mailbox
 * tombstone under it; a mailbox: the tombstone of that address). Called inside
 * the creation transaction, under the per-name / per-domain lock. A purge that
 * fails ⇒ 409 mailDataPendingPurge (nothing created). The same account's own
 * tombstones are left alone (its data comes back, grace period).
 */
export async function purgeForeignTombstones(
  trx: Knex.Transaction,
  driver: MailDriver,
  target: { kind: 'mailbox' | 'domain'; name: string; accountId: number },
): Promise<number> {
  const name = target.name.toLowerCase();
  const q = trx('mail_purge_queue').whereNull('purged_at')
    .where((b) => { b.whereNull('account_id').orWhereNot('account_id', target.accountId); });
  if (target.kind === 'mailbox') {
    q.where({ kind: 'mailbox' }).whereRaw('lower(name) = ?', [name]);
  } else {
    q.where((b) => {
      b.where((x) => { x.where({ kind: 'domain' }).whereRaw('lower(name) = ?', [name]); })
        .orWhere((x) => { x.where({ kind: 'mailbox' }).whereRaw("lower(split_part(name, '@', 2)) = ?", [name]); });
    });
  }
  // Domains first: one directory purge covers its mailboxes (theirs are then no-ops).
  const rows = await q.orderByRaw("CASE WHEN kind = 'domain' THEN 0 ELSE 1 END").orderBy('id').select('id', 'kind', 'name') as
    Array<Pick<MailPurgeRow, 'id' | 'kind' | 'name'>>;
  for (const row of rows) {
    try {
      await driver.purge({ kind: row.kind, name: row.name });
    } catch (err) {
      logger.warn({ kind: row.kind, name: row.name, err: errText(err).slice(0, 500) }, 'mail purge before reuse failed');
      throw new AppError(409, `The previous data of ${name} is still being removed: try again in a few minutes`, 'mailDataPendingPurge', { name });
    }
    await trx('mail_purge_queue').where({ id: row.id }).update({ purged_at: new Date(), error: 'Purged before the name was reused by another account' });
  }
  if (rows.length) logger.info({ kind: target.kind, name, purged: rows.length }, 'mail: data of a previous owner purged before reuse');
  return rows.length;
}
