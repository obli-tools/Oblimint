import { HostingSocketEvents, type QuarantineStatus } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import type { HostdQuarantineEntry } from '../hostd/client';
import { emitHosting } from '../hosting/events';
import { errText } from '../setup/docker';
import { deps } from './deps';
import { MISSING_ON_HOST_NOTE, quarantineNotification, quarantineNotifyKey, RESTORED_OUTSIDE_NOTE, rowFromEntry } from './logic';

// ─────────────────────────────────────────────────────────────────────────────
// hostd quarantine store → quarantine_items (P3-PLAN §12). One function does
// both the event path and the periodic resync: list the account's entries in
// hostd, insert the new ones (idempotent on (account_id, hostd_entry_id);
// only the inserting call audits 'quarantine.add' and notifies), and
// reconcile what changed outside the panel (restored by hostd, entry gone,
// entry back after being closed as missing) — every reconciliation is audited
// with a null user. Serialized per account; rows claimed by a staff action in
// progress are left alone.
// ─────────────────────────────────────────────────────────────────────────────

interface AccountInfo { id: number; tenant_id: number; node_id: number; username: string; status: string }

export interface IngestResult {
  added: number;
  restored: number;
  missing: number;
}

export function emitQuarantine(item: { tenantId: number; accountId: number; id: number; status: QuarantineStatus }): void {
  emitHosting(HostingSocketEvents.QUARANTINE_UPDATED, { accountId: item.accountId, itemId: item.id, status: item.status },
    { tenantId: item.tenantId, accountId: item.accountId });
}

/** Note of a row closed as missing whose entry showed up again in hostd's store. */
export const REAPPEARED_NOTE = "Entrée de nouveau présente sur l'hôte";

// ── Items claimed by a staff restore / delete in progress ───────────────────
// The service claims a row before calling hostd and releases it after its own
// conditional update: meanwhile the ingestion never reconciles it (hostd's
// store changes under the action: entry restored or gone) and a second staff
// action on the same row is refused (409).
const claimed = new Set<number>();
export function claimItem(id: number): boolean {
  if (claimed.has(id)) return false;
  claimed.add(id);
  return true;
}
export function releaseItem(id: number): void { claimed.delete(id); }

// ── Per-account serialization ───────────────────────────────────────────────
// The event path and the resync (boot, periodic, hostd restart) may ingest the
// same account at once; two interleaved passes would compare one pass's
// listing with rows the other just inserted. Calls are chained per account.
const chains = new Map<number, Promise<unknown>>();

/**
 * Brings the rows of one account in line with hostd's store. Throws when
 * hostd cannot be listed (the caller retries later; nothing is marked
 * missing on a failed listing). Serialized per account.
 */
export function ingestAccount(accountId: number): Promise<IngestResult> {
  const prev = chains.get(accountId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => ingestAccountNow(accountId));
  const tail = run.catch(() => undefined);
  chains.set(accountId, tail);
  void tail.then(() => { if (chains.get(accountId) === tail) chains.delete(accountId); });
  return run;
}

interface ExistingRow { id: number; status: QuarantineStatus; resolved_by: number | null; resolution_note: string | null; path: string; sha256: string; site_id: number | null; site_name: string | null }

async function ingestAccountNow(accountId: number): Promise<IngestResult> {
  const result: IngestResult = { added: 0, restored: 0, missing: 0 };
  const account = await db('hosting_accounts').where({ id: accountId }).first('id', 'tenant_id', 'node_id', 'username', 'status') as AccountInfo | undefined;
  if (!account) return result;

  // Rows read BEFORE the listing: a row is only declared missing when it
  // existed before hostd was asked (an entry quarantined between the two reads
  // can never be closed by this pass's older listing).
  const existing = new Map<string, ExistingRow>();
  for (const r of await db('quarantine_items').where({ account_id: account.id })
    .select('id', 'hostd_entry_id', 'status', 'resolved_by', 'resolution_note', 'path', 'sha256', 'site_id', 'site_name') as Array<ExistingRow & { hostd_entry_id: string }>) {
    existing.set(r.hostd_entry_id, { ...r, id: Number(r.id) });
  }

  const entries = await deps.hostd(account.node_id).listQuarantine(account.id);
  const now = deps.now();

  const siteIds = [...new Set(entries.map((e) => e.siteId).filter((v): v is number => Number.isInteger(v)))];
  // Tenant isolation: a site id from hostd is trusted only when it belongs to this account.
  const sites = siteIds.length
    ? await db('sites').where({ account_id: account.id }).whereIn('id', siteIds).select('id', 'name') as Array<{ id: number; name: string }>
    : [];
  const siteById = new Map(sites.map((s) => [Number(s.id), { id: Number(s.id), name: s.name }]));

  const listed = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string') continue;
    listed.add(e.id);
    const known = existing.get(e.id);
    if (known) {
      if (claimed.has(known.id)) continue; // a staff action owns it right now
      // Closed as missing by a reconciliation (never by a person) and back in the store: live again.
      if (known.status === 'deleted' && known.resolved_by === null && known.resolution_note === MISSING_ON_HOST_NOTE) {
        if (await reconcile(account, known, 'quarantined', REAPPEARED_NOTE, now)) known.status = 'quarantined';
      }
      if (known.status === 'quarantined' && e.restoredAt) {
        if (await reconcile(account, known, 'restored', RESTORED_OUTSIDE_NOTE, now)) result.restored++;
      }
      continue;
    }
    if (await insertEntry(account, e, e.siteId !== null ? siteById.get(e.siteId) ?? null : null, now)) result.added++;
  }

  // Rows still 'quarantined' whose entry is gone from the host: deleted outside the panel.
  for (const [entryId, row] of existing) {
    if (row.status !== 'quarantined' || listed.has(entryId) || claimed.has(row.id)) continue;
    if (await reconcile(account, row, 'deleted', MISSING_ON_HOST_NOTE, now)) result.missing++;
  }
  if (result.restored || result.missing) {
    logger.info({ accountId: account.id, ...result }, 'quarantine: rows reconciled with hostd');
  }
  return result;
}

async function insertEntry(account: AccountInfo, e: HostdQuarantineEntry, site: { id: number; name: string } | null, now: Date): Promise<boolean> {
  const row = rowFromEntry(e, { id: account.id, tenantId: account.tenant_id }, site, now);
  if (!row) {
    logger.warn({ accountId: account.id, entryId: e.id, source: e.source, reason: e.reason }, 'quarantine: unusable hostd entry ignored');
    return false;
  }
  const inserted = await db('quarantine_items').insert({ ...row, created_at: now, updated_at: now })
    .onConflict(['account_id', 'hostd_entry_id']).ignore()
    .returning('id') as Array<{ id: number } | number>;
  if (inserted.length === 0) return false; // ingested concurrently (event + resync)
  const id = Number(typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);

  await auditService.log({
    tenantId: account.tenant_id,
    action: 'quarantine.add',
    resourceType: 'quarantine',
    resourcePath: String(id),
    details: {
      accountId: account.id, username: account.username, siteId: row.site_id, siteName: row.site_name,
      source: row.source, reason: row.reason, path: row.path, sha256: row.sha256, sizeBytes: row.size_bytes,
      ...(row.status === 'restored' ? { note: RESTORED_OUTSIDE_NOTE } : {}),
    },
  });
  emitQuarantine({ tenantId: account.tenant_id, accountId: account.id, id, status: row.status });
  if (row.status === 'quarantined') {
    const text = quarantineNotification({ path: row.path, reason: row.reason, source: row.source, siteName: row.site_name, accountUsername: account.username });
    deps.notify('quarantine.added', {
      tenantId: account.tenant_id,
      accountId: account.id,
      key: quarantineNotifyKey(account.id, row.site_id, now),
      title: text.title,
      message: text.message,
      severity: 'warning',
      link: '/maintenance?tab=quarantine',
    });
  }
  return true;
}

/**
 * A status change decided by the reconciliation (no person): conditional on
 * the status read, emitted and audited in the account's tenant (M9: no
 * deletion / restore without an audit trail). Returns whether the row moved.
 */
async function reconcile(account: AccountInfo, row: ExistingRow, status: QuarantineStatus, note: string, now: Date): Promise<boolean> {
  const live = status === 'quarantined';
  const n = await db('quarantine_items').where({ id: row.id, status: row.status })
    .update({ status, resolved_at: live ? null : now, resolved_by: null, resolution_note: live ? null : note, updated_at: now });
  if (n === 0) return false;
  emitQuarantine({ tenantId: account.tenant_id, accountId: account.id, id: row.id, status });
  await auditReconciliation({ tenantId: account.tenant_id, accountId: account.id, username: account.username }, row, status, note);
  return true;
}

/** Audit of a reconciliation (user null): restored → quarantine.restore, deleted → quarantine.delete, live again → quarantine.add. */
export async function auditReconciliation(
  account: { tenantId: number; accountId: number; username: string },
  row: { id: number; path: string; sha256: string; site_id: number | null; site_name: string | null },
  status: QuarantineStatus,
  note: string,
): Promise<void> {
  try {
    await auditService.log({
      tenantId: account.tenantId,
      action: status === 'restored' ? 'quarantine.restore' : status === 'deleted' ? 'quarantine.delete' : 'quarantine.add',
      resourceType: 'quarantine',
      resourcePath: String(row.id),
      details: {
        accountId: account.accountId, username: account.username, siteId: row.site_id === null ? null : Number(row.site_id), siteName: row.site_name,
        path: row.path, sha256: row.sha256, note, reconciled: true,
      },
    });
  } catch (err) {
    logger.warn({ itemId: row.id, err: errText(err) }, 'quarantine: reconciliation not audited');
  }
}

/**
 * Accounts worth a full resync: a site with a typed data path, a supervised
 * site, or rows still quarantined. Deleting accounts are left alone.
 */
export async function resyncAccountIds(): Promise<number[]> {
  const rows = await db.raw(`
    SELECT a.id FROM hosting_accounts a
     WHERE a.status <> 'deleting' AND (
       EXISTS (SELECT 1 FROM sites s JOIN site_data_paths d ON d.site_id = s.id WHERE s.account_id = a.id AND d.policy = 'typed')
       OR EXISTS (SELECT 1 FROM sites s JOIN site_maintenance m ON m.site_id = s.id WHERE s.account_id = a.id AND m.settings->>'supervised' = 'true')
       OR EXISTS (SELECT 1 FROM quarantine_items q WHERE q.account_id = a.id AND q.status = 'quarantined')
     )
     ORDER BY a.id`) as { rows: Array<{ id: number }> };
  return rows.rows.map((r) => Number(r.id));
}

/** Full resync. Never throws: a failing account is logged and retried at the next pass. */
export async function resyncAll(): Promise<{ accounts: number; failed: number } & IngestResult> {
  const out = { accounts: 0, failed: 0, added: 0, restored: 0, missing: 0 };
  let ids: number[];
  try {
    ids = await resyncAccountIds();
  } catch (err) {
    logger.warn({ err: errText(err) }, 'quarantine: resync account list failed');
    return out;
  }
  for (const id of ids) {
    try {
      const r = await ingestAccount(id);
      out.accounts++;
      out.added += r.added; out.restored += r.restored; out.missing += r.missing;
    } catch (err) {
      out.failed++;
      logger.debug({ accountId: id, err: errText(err) }, 'quarantine: resync of the account failed');
    }
  }
  return out;
}
