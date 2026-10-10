import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';
import type { DkimAlgorithm, DkimKey, DkimKeyStatus } from '@oblimint/shared';
import { db } from '../../../db';
import { logger } from '../../../utils/logger';
import { seal } from '../../../utils/secretBox';
import type { MailDkimKeyRow } from '../rows';
import { emitMail } from '../events';
import { toDkimKey } from './dkim.service';
import { DKIM_TIMING } from './keys';

// ─────────────────────────────────────────────────────────────────────────────
// P5 — DKIM key imported from CWP / OpenDKIM (docs/P5-PLAN.md §9.4, step
// mail:dkim:<domain>, D-MAIL). OWNED BY MODULE `executor-mail-dns` (new file in
// mail/dns/). Keeps the SAME selector so the DKIM record already published in
// DNS keeps verifying.
//   - PEM (PKCS#1 'RSA PRIVATE KEY' as OpenDKIM writes it, or PKCS#8) parsed
//     with node:crypto; RSA 2048…4096 bits → algorithm 'rsa-2048' (the only RSA
//     label of the schema: it names the family, the row keeps the real key),
//     ed25519 → 'ed25519'; RSA < 2048 → weakKey; anything else (RSA > 4096,
//     RSA-PSS, EC, DSA, encrypted PEM…) → unsupportedKey / invalidPem;
//   - public key derived exactly as keys.ts does (RSA: base64 SPKI DER = p=;
//     ed25519: base64 of the raw 32-byte key, RFC 8463);
//   - stored as PKCS#8 PEM sealed with secretBox('mail-dkim'), status 'active'
//     (activated_at now), under the same advisory lock as dkim.service;
//   - the keys of the same algorithm that Oblimint generated at the mail domain
//     creation are taken out of service, never deleted: 'next' → 'retired';
//     'active' → 'retired' when it was activated less than a day ago (its record
//     can only have been published by our own zone, not delegated yet: the
//     domain is being migrated), else 'retiring' (record kept published 7 days,
//     the normal rotation path of keys.ts);
//   - idempotent: same selector + same public key = no-op (imported: true);
//     same selector, another key → selectorTaken (nothing changed);
//   - then the mail module is notified as dkim.service does after a change
//     (MAIL_UPDATED 'dkim', engine resync, zone resync for the DNS contributor).
// The PEM is never logged, never returned, never put in an error.
// ─────────────────────────────────────────────────────────────────────────────

export type DkimImportSkip = 'weakKey' | 'unsupportedKey' | 'invalidPem' | 'selectorTaken';

/** Same rule as the mail_dkim_keys_selector_check constraint (selectors are case-insensitive in DNS). */
const SELECTOR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MIN_RSA_BITS = 2048;
const MAX_RSA_BITS = 4096;
/** An auto-generated active key younger than this was never visible outside our own (not yet delegated) zone. */
const FRESH_KEY_MS = 24 * 3600_000;

export interface ParsedDkimKey {
  algorithm: DkimAlgorithm;
  bits: number | null;
  /** p= value. */
  publicKey: string;
  /** PKCS#8 PEM (what dkim.service stores). */
  privateKeyPkcs8: string;
}

/** Pure: validates and normalizes an OpenDKIM private key. */
export function parseDkimPrivateKey(pem: string): { ok: true; key: ParsedDkimKey } | { ok: false; reason: Exclude<DkimImportSkip, 'selectorTaken'> } {
  const text = typeof pem === 'string' ? pem.trim() : '';
  if (!text || text.length > 64 * 1024 || !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text) || /ENCRYPTED/.test(text)) {
    return { ok: false, reason: 'invalidPem' };
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: 'pem' });
  } catch {
    return { ok: false, reason: 'invalidPem' };
  }
  const pkcs8 = () => key.export({ type: 'pkcs8', format: 'pem' }).toString();
  if (key.asymmetricKeyType === 'rsa') {
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < MIN_RSA_BITS) return { ok: false, reason: 'weakKey' };
    if (bits > MAX_RSA_BITS) return { ok: false, reason: 'unsupportedKey' };
    const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
    return { ok: true, key: { algorithm: 'rsa-2048', bits, publicKey: spki.toString('base64'), privateKeyPkcs8: pkcs8() } };
  }
  if (key.asymmetricKeyType === 'ed25519') {
    const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (spki.length !== ED25519_SPKI_PREFIX.length + 32 || !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
      return { ok: false, reason: 'unsupportedKey' };
    }
    return { ok: true, key: { algorithm: 'ed25519', bits: null, publicKey: spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64'), privateKeyPkcs8: pkcs8() } };
  }
  return { ok: false, reason: 'unsupportedKey' };
}

const PUBLIC_COLS = ['id', 'account_id', 'mail_domain_id', 'selector', 'algorithm', 'public_key', 'status', 'activated_at', 'retire_after', 'created_at', 'updated_at'];

interface DomainTarget { id: number; account_id: number; tenant_id: number; domain_id: number; name: string }

/** Engine + zone + UI follow a key change (same as dkim.service keysChanged). Never throws. */
function keysChanged(md: DomainTarget): void {
  try {
    emitMail({ entity: 'dkim', id: md.id, accountId: md.account_id, action: 'updated' }, { tenantId: md.tenant_id, accountId: md.account_id });
  } catch { /* socket layer not ready (tests) */ }
  import('../mail.service')
    .then(({ mailService }) => mailService.requestSync('dkim:import'))
    .catch((err) => logger.warn({ err: (err as Error)?.message }, 'mail dkim import: engine resync request failed'));
  import('../../dns/dns.service')
    .then(({ dnsService }) => dnsService.domainChanged(md.domain_id, 'mail'))
    .catch((err) => logger.warn({ err: (err as Error)?.message }, 'mail dkim import: zone resync request failed'));
}

export async function importDkimKey(
  mailDomainId: number,
  input: { selector: string; privateKeyPem: string },
): Promise<{ imported: boolean; reason: DkimImportSkip | null; key: DkimKey | null }> {
  const selector = String(input?.selector ?? '').trim().toLowerCase();
  if (!SELECTOR_RE.test(selector)) return { imported: false, reason: 'unsupportedKey', key: null };
  const parsed = parseDkimPrivateKey(input?.privateKeyPem);
  if (!parsed.ok) return { imported: false, reason: parsed.reason, key: null };
  const material = parsed.key;

  const md = await db('mail_domains').where({ id: mailDomainId }).first('id', 'account_id', 'tenant_id', 'domain_id', 'name') as DomainTarget | undefined;
  if (!md) throw new Error(`mail domain ${mailDomainId} not found`);

  const result = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`mail-dkim:${md.id}`]);
    const same = await trx('mail_dkim_keys').where({ mail_domain_id: md.id, selector }).first(PUBLIC_COLS) as MailDkimKeyRow | undefined;
    if (same) {
      if (same.public_key === material.publicKey && same.algorithm === material.algorithm) {
        return { changed: false, row: same, reason: null };
      }
      return { changed: false, row: null, reason: 'selectorTaken' as const };
    }
    const now = new Date();
    const others = await trx('mail_dkim_keys').where({ mail_domain_id: md.id, algorithm: material.algorithm })
      .whereIn('status', ['active', 'next']).select('id', 'status', 'activated_at', 'created_at') as
      Array<{ id: number; status: DkimKeyStatus; activated_at: Date | string | null; created_at: Date | string }>;
    for (const k of others) {
      const since = new Date(k.activated_at ?? k.created_at).getTime();
      const fresh = k.status === 'next' || now.getTime() - since < FRESH_KEY_MS;
      await trx('mail_dkim_keys').where({ id: k.id, mail_domain_id: md.id, status: k.status }).update(fresh
        ? { status: 'retired', retire_after: now, updated_at: now }
        : { status: 'retiring', retire_after: new Date(now.getTime() + DKIM_TIMING.retiringMs), updated_at: now });
    }
    const [row] = await trx('mail_dkim_keys').insert({
      account_id: md.account_id,
      mail_domain_id: md.id,
      selector,
      algorithm: material.algorithm,
      public_key: material.publicKey,
      private_key_sealed: seal('mail-dkim', material.privateKeyPkcs8),
      status: 'active',
      activated_at: now,
    }).returning(PUBLIC_COLS) as MailDkimKeyRow[];
    return { changed: true, row, reason: null, replaced: others.length };
  });

  if (!result.row) {
    logger.info({ mailDomain: md.name, selector }, 'mail dkim import: selector already used by another key (not imported)');
    return { imported: false, reason: result.reason, key: null };
  }
  if (result.changed) {
    logger.info({ mailDomain: md.name, selector, algorithm: material.algorithm, bits: material.bits }, 'mail dkim import: key imported');
    keysChanged(md);
  }
  return { imported: true, reason: null, key: toDkimKey(result.row) };
}
