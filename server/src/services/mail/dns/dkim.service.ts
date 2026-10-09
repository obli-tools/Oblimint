import type { Request } from 'express';
import type { Knex } from 'knex';
import type { DkimAlgorithm, DkimKey, DkimKeyStatus, DkimRotateRequest } from '@oblimint/shared';
import { mailEngineHasMailboxes } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { open as openSecret, seal } from '../../../utils/secretBox';
import { auditService } from '../../audit.service';
import { iso } from '../../hosting/rows';
import type { HostingActor } from '../../hosting/access';
import { platformSettings } from '../../platformSettings';
import { loadMailDomain } from '../access';
import type { DesiredDkimKey } from '../driver';
import { emitMail } from '../events';
import { activeMailEngine } from '../registry';
import type { MailDkimKeyRow } from '../rows';
import { parseDnsSettings } from '../rows';
import { dkimRecord } from './records';
import {
  dkimSelector, DKIM_TIMING, generateDkimKey, needsAutoRotation, nextKeyReady, rotationUpdates, type DkimKeyMaterial, type RotationKey,
} from './keys';

// ─────────────────────────────────────────────────────────────────────────────
// DKIM keys (docs/P4-PLAN.md §9.3) — module mail-dns-tls.
//   - RSA 2048 always (+ ed25519 when the domain / platform asks for it),
//     generated with node:crypto; private key PKCS#8 PEM sealed with
//     secretBox('mail-dkim') — never returned, never logged (MA4);
//   - selector om<yyyymm>[e][-n];
//   - rotation (manual: POST …/dkim/rotate, 1 / 10 min / domain; automatic:
//     settings mail.dkimRotationDays): a 'next' key is published, becomes
//     'active' once its record is visible to the public resolvers (or 48 h in
//     a zone hosted and active here), the old key is 'retiring' 7 days, then
//     'retired' (record removed, private key erased 30 days later);
//   - after every change: engine resync (mailService.requestSync) + zone
//     resync (dnsService.domainChanged) + MAIL_UPDATED 'dkim'.
// ─────────────────────────────────────────────────────────────────────────────

const ROTATE_INTERVAL_MS = 10 * 60_000;
const lastManualRotation = new Map<number, number>();

type Conn = Knex | Knex.Transaction;

const STATUS_ORDER: Record<DkimKeyStatus, number> = { active: 0, next: 1, retiring: 2, retired: 3 };

export function toDkimKey(r: Pick<MailDkimKeyRow, 'id' | 'mail_domain_id' | 'selector' | 'algorithm' | 'status' | 'public_key' | 'created_at' | 'activated_at' | 'retire_after'>): DkimKey {
  return {
    id: r.id,
    mailDomainId: r.mail_domain_id,
    selector: r.selector,
    algorithm: r.algorithm,
    status: r.status,
    publicRecord: dkimRecord(r.algorithm, r.public_key),
    createdAt: iso(r.created_at) as string,
    activatedAt: iso(r.activated_at),
    retireAfter: iso(r.retire_after),
  };
}

const PUBLIC_COLS = ['id', 'account_id', 'mail_domain_id', 'selector', 'algorithm', 'public_key', 'status', 'activated_at', 'retire_after', 'created_at', 'updated_at'];

async function keysOf(mailDomainId: number, conn: Conn = db): Promise<DkimKey[]> {
  const rows = await conn('mail_dkim_keys').where({ mail_domain_id: mailDomainId }).select(PUBLIC_COLS) as MailDkimKeyRow[];
  return rows.map(toDkimKey).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

async function lockDomain(trx: Knex.Transaction, mailDomainId: number): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail-dkim:${mailDomainId}`]);
}

async function inTransaction<T>(conn: Conn | undefined, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  if (conn && (conn as Knex.Transaction).isTransaction) return fn(conn as Knex.Transaction);
  return db.transaction(fn);
}

/** Inserts one key (selector chosen under the domain lock). */
async function insertKey(
  trx: Knex.Transaction,
  md: { id: number; account_id: number },
  algorithm: DkimAlgorithm,
  material: DkimKeyMaterial,
  status: 'active' | 'next',
  now: Date,
): Promise<string> {
  const selectors = new Set((await trx('mail_dkim_keys').where({ mail_domain_id: md.id }).select('selector') as Array<{ selector: string }>).map((r) => r.selector));
  const selector = dkimSelector(algorithm, now, selectors);
  await trx('mail_dkim_keys').insert({
    account_id: md.account_id,
    mail_domain_id: md.id,
    selector,
    algorithm,
    public_key: material.publicKey,
    private_key_sealed: seal('mail-dkim', material.privateKeyPem),
    status,
    activated_at: status === 'active' ? now : null,
  });
  return selector;
}

/** Engine + zone + UI follow a key change. Never throws. */
function keysChanged(md: { id: number; domain_id: number; tenant_id: number; account_id: number }, reason: string): void {
  try {
    emitMail({ entity: 'dkim', id: md.id, accountId: md.account_id, action: 'updated' }, { tenantId: md.tenant_id, accountId: md.account_id });
  } catch { /* socket layer not ready (tests) */ }
  import('../mail.service')
    .then(({ mailService }) => mailService.requestSync(`dkim:${reason}`))
    .catch((err) => logger.warn({ err: (err as Error)?.message }, 'mail dkim: engine resync request failed'));
  import('../../dns/dns.service')
    .then(({ dnsService }) => dnsService.domainChanged(md.domain_id, 'mail'))
    .catch((err) => logger.warn({ err: (err as Error)?.message }, 'mail dkim: zone resync request failed'));
}

interface DomainKeyTarget { id: number; account_id: number; tenant_id: number; domain_id: number; name: string; dns_settings: unknown }

async function domainRowFor(mailDomainId: number, conn: Conn = db): Promise<DomainKeyTarget | null> {
  return (await conn('mail_domains').where({ id: mailDomainId })
    .first('id', 'account_id', 'tenant_id', 'domain_id', 'name', 'dns_settings') as DomainKeyTarget | undefined) ?? null;
}

/** Algorithms the domain must hold: RSA always, ed25519 when the domain (else the platform) asks. */
async function wantedAlgorithms(md: DomainKeyTarget): Promise<DkimAlgorithm[]> {
  const s = await platformSettings.section('mail');
  const ed = parseDnsSettings(md.dns_settings).dkimEd25519 ?? s.dkimEd25519;
  return ed ? ['rsa-2048', 'ed25519'] : ['rsa-2048'];
}

/**
 * Creates the missing key(s) of a mail domain. Status 'active' only while the
 * domain has no active key at all (creation: nothing is signed yet); a domain
 * that already signs and gains an algorithm gets a 'next' key, promoted by the
 * rotation pass once its record is visible (§9.3: never sign with a selector
 * whose TXT is not published yet). Idempotent; no-op under the 'external' engine. `opts.trx`:
 * the caller's transaction when the mail domain row is not committed yet.
 * Returns the number of keys created.
 */
async function ensureKeys(mailDomainId: number, opts: { trx?: Knex.Transaction } = {}): Promise<number> {
  if (!mailEngineHasMailboxes(await activeMailEngine())) return 0;
  const conn: Conn = opts.trx ?? db;
  const md = await domainRowFor(mailDomainId, conn);
  if (!md) throw new Error(`mail domain ${mailDomainId} not found`);
  const wanted = await wantedAlgorithms(md);
  const live = (rows: Array<{ algorithm: DkimAlgorithm; status: DkimKeyStatus }>) =>
    wanted.filter((alg) => !rows.some((k) => k.algorithm === alg && k.status !== 'retired'));
  const missing = live(await conn('mail_dkim_keys').where({ mail_domain_id: md.id }).select('algorithm', 'status'));
  if (missing.length === 0) return 0;
  // Key generation (RSA: ~100 ms) outside the transaction.
  const materials = new Map<DkimAlgorithm, DkimKeyMaterial>();
  for (const alg of missing) materials.set(alg, await generateDkimKey(alg));
  const created = await inTransaction(opts.trx, async (trx) => {
    await lockDomain(trx, md.id);
    const rows = await trx('mail_dkim_keys').where({ mail_domain_id: md.id }).select('algorithm', 'status') as Array<{ algorithm: DkimAlgorithm; status: DkimKeyStatus }>;
    const still = live(rows);
    const status: 'active' | 'next' = rows.some((k) => k.status === 'active') ? 'next' : 'active';
    const now = new Date();
    for (const alg of still) await insertKey(trx, md, alg, materials.get(alg)!, status, now);
    return still.length;
  });
  if (created > 0) {
    logger.info({ mailDomain: md.name, created }, 'mail dkim: initial key(s) created');
    keysChanged(md, 'created');
  }
  return created;
}

/** Starts a rotation of `algorithm`: a new 'next' key (older 'next' keys of that algorithm retired). Returns the selector. */
async function startRotation(md: DomainKeyTarget, algorithm: DkimAlgorithm, now = new Date()): Promise<string> {
  const material = await generateDkimKey(algorithm);
  return db.transaction(async (trx) => {
    await lockDomain(trx, md.id);
    const all = await trx('mail_dkim_keys').where({ mail_domain_id: md.id }).select('id', 'algorithm', 'status') as Array<{ id: number; algorithm: DkimAlgorithm; status: DkimKeyStatus }>;
    const pending = all.filter((k) => k.algorithm === algorithm && k.status === 'next').map((k) => k.id);
    if (pending.length) await trx('mail_dkim_keys').whereIn('id', pending).update({ status: 'retired', retire_after: now, updated_at: now });
    // Active right away only when the domain signs nothing yet; otherwise the
    // key waits (published only) until its record is visible (§9.3).
    const status = all.some((k) => k.status === 'active') ? 'next' : 'active';
    return insertKey(trx, md, algorithm, material, status, now);
  });
}

/** Turns an algorithm off for a domain (domain setting dkimEd25519 → false): active → retiring, next → retired. */
export async function retireAlgorithm(mailDomainId: number, algorithm: DkimAlgorithm, now = new Date()): Promise<boolean> {
  const md = await domainRowFor(mailDomainId);
  if (!md) return false;
  const changed = await db.transaction(async (trx) => {
    await lockDomain(trx, md.id);
    const a = await trx('mail_dkim_keys').where({ mail_domain_id: md.id, algorithm, status: 'active' })
      .update({ status: 'retiring', retire_after: new Date(now.getTime() + DKIM_TIMING.retiringMs), updated_at: now });
    const n = await trx('mail_dkim_keys').where({ mail_domain_id: md.id, algorithm, status: 'next' })
      .update({ status: 'retired', retire_after: now, updated_at: now });
    return Number(a) + Number(n);
  });
  if (changed > 0) keysChanged(md, `${algorithm}-off`);
  return changed > 0;
}

// ── rotation pass (worker, mailDnsService.start) ─────────────────────────────

export interface RotationDeps {
  /** Is TXT <selector>._domainkey.<domain> publicly visible with this p=? */
  visible(fqdn: string, publicKey: string): Promise<boolean>;
  /** Zone of the domain hosted and active on our PowerDNS? */
  hostedActive(domain: string, accountId: number): Promise<boolean>;
}

/**
 * One pass over every mail domain: missing keys created, automatic rotation
 * started when due, state machine stepped. Never throws (per-domain errors
 * are logged). Returns the number of domains whose keys changed.
 */
export async function runDkimRotation(deps: RotationDeps, now = new Date()): Promise<number> {
  let changedDomains = 0;
  try {
    if (!mailEngineHasMailboxes(await activeMailEngine())) return 0;
    const settings = await platformSettings.section('mail');
    const domains = await db('mail_domains').orderBy('id').select('id', 'account_id', 'tenant_id', 'domain_id', 'name', 'dns_settings') as DomainKeyTarget[];
    for (const md of domains) {
      try {
        let changed = (await ensureKeys(md.id)) > 0;
        // An algorithm no longer wanted (domain setting, else platform default
        // turned off) keeps no active / next key.
        const wanted = await wantedAlgorithms(md);
        if (!wanted.includes('ed25519')) {
          const live = await db('mail_dkim_keys').where({ mail_domain_id: md.id, algorithm: 'ed25519' }).whereIn('status', ['active', 'next']).first('id');
          if (live && await retireAlgorithm(md.id, 'ed25519', now)) changed = true;
        }
        const load = async (): Promise<Array<RotationKey & { selector: string; publicKey: string }>> => {
          const rows = await db('mail_dkim_keys').where({ mail_domain_id: md.id })
            .select('id', 'selector', 'algorithm', 'status', 'public_key', 'created_at', 'activated_at', 'retire_after',
              db.raw("(private_key_sealed <> '') AS has_private")) as Array<MailDkimKeyRow & { has_private: boolean }>;
          return rows.map((r) => ({
            id: r.id, selector: r.selector, publicKey: r.public_key, algorithm: r.algorithm, status: r.status,
            createdAt: new Date(r.created_at), activatedAt: r.activated_at ? new Date(r.activated_at) : null,
            retireAfter: r.retire_after ? new Date(r.retire_after) : null, hasPrivateKey: !!r.has_private,
          }));
        };
        let keys = await load();
        for (const alg of wanted) {
          if (needsAutoRotation(keys, alg, now, settings.dkimRotationDays)) {
            const selector = await startRotation(md, alg, now);
            logger.info({ mailDomain: md.name, selector, algorithm: alg }, 'mail dkim: automatic rotation started');
            changed = true;
          }
        }
        if (changed) keys = await load();
        const ready = new Set<number>();
        const nexts = keys.filter((k) => k.status === 'next');
        if (nexts.length) {
          const hosted = await deps.hostedActive(md.name, md.account_id).catch(() => false);
          for (const k of nexts) {
            const visible = await deps.visible(`${k.selector}._domainkey.${md.name}`, k.publicKey).catch(() => false);
            if (nextKeyReady(k, now, { visible, hostedActive: hosted })) ready.add(k.id);
          }
        }
        const updates = rotationUpdates(keys, now, (k) => ready.has(k.id));
        if (updates.length) {
          // The decision was taken on keys read without the lock (resolver
          // lookups in between): a manual rotation or an algorithm turned off
          // meanwhile makes it stale — skipped, the next pass recomputes.
          const seen = new Map(keys.map((k) => [k.id, k.status]));
          const applied = await db.transaction(async (trx) => {
            await lockDomain(trx, md.id);
            const nowRows = await trx('mail_dkim_keys').where({ mail_domain_id: md.id }).select('id', 'status') as Array<{ id: number; status: DkimKeyStatus }>;
            const stale = nowRows.length !== seen.size || nowRows.some((r) => seen.get(r.id) !== r.status);
            if (stale) return false;
            for (const u of updates) {
              const patch: Record<string, unknown> = { updated_at: now };
              if (u.status) patch.status = u.status;
              if (u.activatedAt) patch.activated_at = u.activatedAt;
              if (u.retireAfter !== undefined) patch.retire_after = u.retireAfter;
              if (u.clearPrivateKey) patch.private_key_sealed = '';
              await trx('mail_dkim_keys').where({ id: u.id, mail_domain_id: md.id, status: seen.get(u.id) }).update(patch);
            }
            return true;
          });
          if (!applied) {
            logger.info({ mailDomain: md.name }, 'mail dkim: keys changed during the rotation pass, step postponed');
          } else for (const u of updates) {
            const k = keys.find((x) => x.id === u.id);
            if (u.status) logger.info({ mailDomain: md.name, selector: k?.selector, status: u.status }, 'mail dkim: key status changed');
          }
          if (applied && updates.some((u) => u.status)) changed = true;
        }
        if (changed) {
          changedDomains++;
          keysChanged(md, 'rotation');
        }
      } catch (err) {
        logger.warn({ mailDomain: md.name, err: (err as Error)?.message }, 'mail dkim: rotation pass failed for this domain');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'mail dkim: rotation pass failed');
  }
  return changedDomains;
}

/** Tests. */
export function resetDkimRateLimitForTests(): void {
  lastManualRotation.clear();
}

export const dkimService = {
  async list(actor: HostingActor, mailDomainId: number): Promise<DkimKey[]> {
    await loadMailDomain(actor, mailDomainId, 'read');
    return keysOf(mailDomainId);
  },

  /** mail.manage; 429 rateLimited (1 rotation / 10 min / domain). Audited `mail.dkim.rotate`. */
  async rotate(req: Request, actor: HostingActor, mailDomainId: number, body: DkimRotateRequest): Promise<DkimKey[]> {
    const md = await loadMailDomain(actor, mailDomainId, 'mail.manage');
    if (!mailEngineHasMailboxes(await activeMailEngine())) {
      throw new AppError(409, 'The mail engine signs nothing here (DNS only): DKIM keys come from your mail provider', 'mailEngineNoMailboxes');
    }
    const now = Date.now();
    const last = lastManualRotation.get(md.id);
    if (last !== undefined && now - last < ROTATE_INTERVAL_MS) {
      const retryAfterSeconds = Math.ceil((ROTATE_INTERVAL_MS - (now - last)) / 1000);
      throw new AppError(429, 'A DKIM rotation was started a moment ago: try again later', 'rateLimited', { retryAfterSeconds });
    }
    const algorithm: DkimAlgorithm = body?.algorithm === 'ed25519' ? 'ed25519' : 'rsa-2048';
    const target = await domainRowFor(md.id);
    if (!target || !(await wantedAlgorithms(target)).includes(algorithm)) {
      throw new AppError(409, 'ed25519 DKIM signing is turned off for this domain: enable it in the DNS settings first', 'dkimAlgorithmDisabled');
    }
    lastManualRotation.set(md.id, now);
    let selector: string;
    try {
      selector = await startRotation(md, algorithm);
    } catch (err) {
      lastManualRotation.delete(md.id);
      throw err;
    }
    await auditService.logReqAs(req, md.tenant_id, 'mail.dkim.rotate', {
      resourceType: 'mailDomain', resourcePath: String(md.id), details: { domain: md.name, accountId: md.account_id, algorithm, selector },
    });
    keysChanged(md, 'manual');
    return keysOf(md.id);
  },

  /**
   * Creates the initial key(s) of a new mail domain when it has none (called
   * by mail-core, awaited, at mail domain creation). Idempotent. Throws on a
   * key generation / DB failure (the creation then fails). `opts.trx`: the
   * creation transaction, when the mail domain row is not committed yet.
   */
  async ensureForDomain(mailDomainId: number, opts: { trx?: Knex.Transaction } = {}): Promise<void> {
    await ensureKeys(mailDomainId, opts);
  },

  /** Every key the engine must hold (active = signing, next = published only), private keys opened. */
  async signingKeys(): Promise<DesiredDkimKey[]> {
    if (!mailEngineHasMailboxes(await activeMailEngine())) return [];
    const rows = await db('mail_dkim_keys as k')
      .join('mail_domains as md', 'md.id', 'k.mail_domain_id')
      .whereIn('k.status', ['active', 'next'])
      .orderBy([{ column: 'md.name' }, { column: 'k.selector' }])
      .select('k.id', 'k.selector', 'k.algorithm', 'k.status', 'k.private_key_sealed', 'md.name as domain') as
      Array<{ id: number; selector: string; algorithm: DkimAlgorithm; status: DkimKeyStatus; private_key_sealed: string; domain: string }>;
    const out: DesiredDkimKey[] = [];
    for (const r of rows) {
      try {
        out.push({ domain: r.domain, selector: r.selector, algorithm: r.algorithm, privateKeyPem: openSecret('mail-dkim', r.private_key_sealed), signing: r.status === 'active' });
      } catch (err) {
        // MA4: the selector only, never the sealed value.
        logger.error({ mailDomain: r.domain, selector: r.selector, err: (err as Error)?.name }, 'mail dkim: private key cannot be opened (skipped)');
      }
    }
    return out;
  },
};
