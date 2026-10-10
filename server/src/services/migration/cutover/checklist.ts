import type {
  DnsRecordType, MigrationAccountPlan, MigrationCutoverDomain, MigrationCutoverItem, MigrationCutoverItemCode, MigrationCutoverState,
  PlannedDomain,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PURE part of the cutover checklist (docs/P5-PLAN.md §10): which domains get a
// row, mode, items, instructions to give the operator, evaluation of the facts
// gathered by cutover.service (DB + live DNS) into the items, state machine.
// Nothing here writes anywhere — in particular NOT on the source (MG1: lowering
// the TTL is an instruction + a live check, never a command).
// ─────────────────────────────────────────────────────────────────────────────

export type CutoverMode = MigrationCutoverDomain['mode'];
export type CutoverInstruction = MigrationCutoverDomain['instructions'][number];

/** Seconds: a TTL at or below this is "lowered" (§10). */
export const LOWERED_TTL = 300;
/** TTL suggested for the records the operator sets during the cutover. */
export const CUTOVER_RECORD_TTL = 300;

export const CUTOVER_ITEM_ORDER: readonly MigrationCutoverItemCode[] = [
  'ttlLowered', 'targetReady', 'verified', 'finalSync', 'nsChanged', 'aRecordsChanged', 'mxChanged', 'certificateIssued', 'sourceDisabled',
];

/** Items the staff ticks by hand (no live check exists). */
export const MANUAL_ITEMS: ReadonlySet<MigrationCutoverItemCode> = new Set(['sourceDisabled']);
/** Auto items the staff may force to true WITH a note (the live check can be wrong: split DNS, anycast…). */
export const FORCEABLE_ITEMS: ReadonlySet<MigrationCutoverItemCode> = new Set(['ttlLowered']);

const lower = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/\.$/, '');

export function inZoneName(name: string, zone: string): boolean {
  const n = lower(name);
  const z = lower(zone);
  return n === z || n.endsWith(`.${z}`);
}

/**
 * Domains of an account that get a checklist row: served by a site or a proxy,
 * and also the mail-only domains whose mail is migrated (their MX has to move
 * too, and the maildir mirror rule depends on their switch).
 */
export function cutoverDomainsOf(account: MigrationAccountPlan): PlannedDomain[] {
  return account.domains.filter((d) => d.servedBy === 'site' || d.servedBy === 'proxy' || mailMigratedFor(account, d.fqdn));
}

export function modeOf(d: Pick<PlannedDomain, 'dnsZone'>): CutoverMode {
  return d.dnsZone === 'migrated' || d.dnsZone === 'parent' ? 'ns-delegation' : 'records';
}

/** Migrated zone holding the fqdn (closest), null when none. */
export function migratedZoneOf(account: Pick<MigrationAccountPlan, 'zones'>, fqdn: string): string | null {
  const zones = account.zones.map((z) => lower(z.name)).filter((z) => inZoneName(fqdn, z)).sort((a, b) => b.length - a.length);
  return zones[0] ?? null;
}

export function mailMigratedFor(account: Pick<MigrationAccountPlan, 'mailDomains'>, fqdn: string): boolean {
  return account.mailDomains.some((m) => lower(m.name) === lower(fqdn));
}

export function itemCodesFor(mode: CutoverMode, mailMigrated: boolean): MigrationCutoverItemCode[] {
  return CUTOVER_ITEM_ORDER.filter((c) => (c !== 'nsChanged' || mode === 'ns-delegation') && (c !== 'mxChanged' || mailMigrated));
}

/** Items of a row: kept ones (state of manual / forced items) + new ones, in the canonical order. */
export function mergeItemList(existing: MigrationCutoverItem[], codes: MigrationCutoverItemCode[]): MigrationCutoverItem[] {
  return codes.map((code) => existing.find((i) => i.code === code)
    ?? { code, done: false, auto: !MANUAL_ITEMS.has(code), checkedAt: null, detail: null });
}

export interface MailRecordLike { fqdn: string; type: DnsRecordType; content: string; priority: number | null; kind: string; zone: boolean }

export interface InstructionInput {
  fqdn: string;
  mode: CutoverMode;
  /** Apex of the migrated zone (ns-delegation): where the registrar delegation changes. */
  zoneApex: string | null;
  includeWww: boolean;
  nameservers: string[];
  ipv4: string | null;
  ipv6: string | null;
  /** Expected mail records of the domain (mail/dns/domains.ts expectedRecordsOf), [] when its mail is not migrated. */
  mailRecords: MailRecordLike[];
  /** Pending TXT verification: token of domains.verification_token. */
  verificationToken: string | null;
}

/**
 * What the operator sets: NS at the registrar (ns-delegation), else the
 * records at the current DNS host (A / AAAA apex, CNAME www, MX / SPF / DKIM /
 * DMARC of a migrated mail domain, TXT of a pending ownership verification).
 */
export function buildInstructions(input: InstructionInput): CutoverInstruction[] {
  const fqdn = lower(input.fqdn);
  const out: CutoverInstruction[] = [];
  const seen = new Set<string>();
  const add = (i: CutoverInstruction) => {
    const k = `${i.name}|${i.type}|${i.value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  if (input.mode === 'ns-delegation') {
    const apex = lower(input.zoneApex ?? fqdn);
    for (const ns of input.nameservers) add({ name: apex, type: 'NS', value: lower(ns), ttl: null });
    return out;
  }
  if (input.ipv4) add({ name: fqdn, type: 'A', value: input.ipv4, ttl: CUTOVER_RECORD_TTL });
  if (input.ipv6) add({ name: fqdn, type: 'AAAA', value: input.ipv6, ttl: CUTOVER_RECORD_TTL });
  if (input.includeWww) add({ name: `www.${fqdn}`, type: 'CNAME', value: `${fqdn}.`, ttl: CUTOVER_RECORD_TTL });
  for (const r of input.mailRecords) {
    if (!r.zone || !['mx', 'spf', 'dkim', 'dmarc'].includes(r.kind)) continue;
    add({ name: lower(r.fqdn), type: r.type, value: r.type === 'MX' ? `${r.priority ?? 10} ${r.content}` : r.content, ttl: CUTOVER_RECORD_TTL });
  }
  if (input.verificationToken) add({ name: `_oblimint-challenge.${fqdn}`, type: 'TXT', value: `oblimint-verify=${input.verificationToken}`, ttl: null });
  return out;
}

// ── facts → items ────────────────────────────────────────────────────────────

type Detail = Record<string, string | number | boolean | null>;

/** One fact per auto item; undefined = not checked this time (item left as is). */
export interface CutoverFacts {
  ttl?: { observedTtl: number | null; nameservers: string[]; error: string | null };
  nsChanged?: { ok: boolean; seen: string[]; expected: string[]; error: string | null };
  aRecordsChanged?: { ok: boolean; seen: string[]; expected: string[]; error: string | null };
  mxChanged?: { ok: boolean; seen: string[]; expected: string | null; error: string | null };
  verified?: { ok: boolean; status: string | null };
  certificateIssued?: { ok: boolean; issuer: string | null; status: string | null };
  targetReady?: { ok: boolean; initialDone: boolean; published: boolean; zoneActive: boolean | null };
  /** Finish time of the latest successful final-sync run of the account. */
  lastFinalSyncAt?: string | null;
}

const joined = (xs: string[]) => xs.slice(0, 8).join(', ');

/**
 * New items from the facts. Rules: a forced ttlLowered stays true (detail.forced);
 * ttlLowered keeps `since` = first time it was seen done (the final sync must
 * come AFTER it), and an inconclusive check (observedTtl null) leaves it as it
 * was; finalSync = a final-sync run finished at / after that time. The caller
 * stops passing `ttl` / `lastFinalSyncAt` once the row is switched (the TTL
 * then served is the platform's own: both items are frozen).
 */
export function applyFacts(items: MigrationCutoverItem[], facts: CutoverFacts, now: Date): { items: MigrationCutoverItem[]; observedTtl: number | null | undefined } {
  const at = now.toISOString();
  const out = items.map((i) => ({ ...i, detail: i.detail ? { ...i.detail } : null }));
  const item = (code: MigrationCutoverItemCode) => out.find((i) => i.code === code);
  const set = (code: MigrationCutoverItemCode, done: boolean, detail: Detail) => {
    const i = item(code);
    if (!i || !i.auto) return;
    i.done = done;
    i.checkedAt = at;
    i.detail = detail;
  };
  let observedTtl: number | null | undefined;

  if (facts.ttl) {
    const i = item('ttlLowered');
    observedTtl = facts.ttl.observedTtl;
    if (i) {
      const forced = i.detail?.forced === true;
      const prevSince = i.done && typeof i.detail?.since === 'string' ? i.detail.since : null;
      // No answer (resolver timeout, no NS reachable…): inconclusive, the previous
      // verdict and its `since` stay (a transient failure must not invalidate a
      // final sync done after the TTL was lowered).
      const unknown = facts.ttl.observedTtl === null;
      const live = !unknown && (facts.ttl.observedTtl as number) <= LOWERED_TTL;
      const done = unknown ? i.done || forced : live || forced;
      i.done = done;
      i.checkedAt = at;
      i.detail = {
        observedTtl: facts.ttl.observedTtl, max: LOWERED_TTL, nameservers: joined(facts.ttl.nameservers), error: facts.ttl.error,
        ...(forced ? { forced: true } : {}),
        since: done ? prevSince ?? at : null,
      };
    }
  }
  if (facts.nsChanged) {
    const f = facts.nsChanged;
    set('nsChanged', f.ok, { seen: joined(f.seen), expected: joined(f.expected), error: f.error });
  }
  if (facts.aRecordsChanged) {
    const f = facts.aRecordsChanged;
    set('aRecordsChanged', f.ok, { seen: joined(f.seen), expected: joined(f.expected), error: f.error });
  }
  if (facts.mxChanged) {
    const f = facts.mxChanged;
    set('mxChanged', f.ok, { seen: joined(f.seen), expected: f.expected, error: f.error });
  }
  if (facts.verified) set('verified', facts.verified.ok, { status: facts.verified.status });
  if (facts.certificateIssued) {
    const f = facts.certificateIssued;
    set('certificateIssued', f.ok, { issuer: f.issuer, status: f.status });
  }
  if (facts.targetReady) {
    const f = facts.targetReady;
    set('targetReady', f.ok, { initialDone: f.initialDone, published: f.published, zoneActive: f.zoneActive });
  }
  if (facts.lastFinalSyncAt !== undefined) {
    const ttl = item('ttlLowered');
    const since = ttl?.done && typeof ttl.detail?.since === 'string' ? ttl.detail.since : null;
    const last = facts.lastFinalSyncAt;
    const ok = !!(since && last && new Date(last).getTime() >= new Date(since).getTime());
    set('finalSync', ok, { lastFinalSyncAt: last ?? null, after: since });
  }
  return { items: out, observedTtl };
}

// ── manual update ────────────────────────────────────────────────────────────

export class CutoverItemError extends Error {
  constructor(public readonly code: 'cutoverItemAuto' | 'cutoverNoteRequired', public readonly item: MigrationCutoverItemCode) {
    super(code === 'cutoverItemAuto' ? `${item} is checked automatically` : `Forcing ${item} needs a note`);
  }
}

/**
 * Staff change of items: manual items freely; ttlLowered may be forced true
 * when a note explains it (and false removes the force); any other auto item
 * → CutoverItemError('cutoverItemAuto'). Unknown codes are ignored.
 */
export function applyManualItems(
  items: MigrationCutoverItem[],
  changes: Partial<Record<MigrationCutoverItemCode, boolean>>,
  note: string | null,
  now: Date,
): MigrationCutoverItem[] {
  const at = now.toISOString();
  const out = items.map((i) => ({ ...i, detail: i.detail ? { ...i.detail } : null }));
  for (const [code, value] of Object.entries(changes) as Array<[MigrationCutoverItemCode, boolean | undefined]>) {
    if (typeof value !== 'boolean') continue;
    const i = out.find((x) => x.code === code);
    if (!i) continue;
    if (MANUAL_ITEMS.has(code)) {
      i.done = value;
      i.checkedAt = at;
      i.detail = { ...(i.detail ?? {}), manual: true };
      continue;
    }
    if (!FORCEABLE_ITEMS.has(code)) throw new CutoverItemError('cutoverItemAuto', code);
    if (value) {
      if (!note || !note.trim()) throw new CutoverItemError('cutoverNoteRequired', code);
      const since = i.done && typeof i.detail?.since === 'string' ? i.detail.since : at;
      i.done = true;
      i.checkedAt = at;
      i.detail = { ...(i.detail ?? {}), forced: true, since };
    } else if (i.detail?.forced) {
      const { forced: _f, ...rest } = i.detail;
      const live = typeof rest.observedTtl === 'number' && rest.observedTtl <= LOWERED_TTL;
      i.done = live;
      i.checkedAt = at;
      i.detail = { ...rest, since: live ? rest.since ?? at : null };
    }
  }
  return out;
}

export function itemDone(items: MigrationCutoverItem[], code: MigrationCutoverItemCode): boolean {
  return items.some((i) => i.code === code && i.done);
}

/** State after a run of the account ended (hook). Switched rows never move. */
export function stateAfterRun(state: MigrationCutoverState, input: { initialDone: boolean; finalSyncDone: boolean }): MigrationCutoverState {
  if (state === 'switched') return state;
  if (input.finalSyncDone && input.initialDone) return 'synced';
  if ((state === 'pending' || state === 'rolled-back') && input.initialDone) return 'prepared';
  return state;
}

/** French rollback guidance (rollback response notes). */
export function rollbackGuidance(input: { fqdn: string; mode: CutoverMode; originalNameservers: string[]; originalA: string[]; mailMigrated: boolean; at: Date }): string {
  const lines = [`Retour arrière de ${input.fqdn} le ${input.at.toISOString().slice(0, 16).replace('T', ' ')} UTC :`];
  if (input.mode === 'ns-delegation') {
    lines.push(input.originalNameservers.length
      ? `- remettre chez le registraire les serveurs de noms d'origine : ${input.originalNameservers.join(', ')} ;`
      : `- remettre chez le registraire les serveurs de noms d'origine (ceux du serveur CWP) ;`);
  } else {
    lines.push(input.originalA.length
      ? `- remettre chez l'hébergeur DNS les enregistrements d'origine (A ${input.originalA.join(', ')}, www, MX…) ;`
      : `- remettre chez l'hébergeur DNS les enregistrements d'origine (A / AAAA, www, MX, SPF, DKIM) ;`);
  }
  lines.push('- réactiver le site / le courrier dans CWP s\'ils y ont été désactivés ;');
  if (input.mailMigrated) {
    lines.push('- le courrier reçu par Oblimint entre-temps y reste : le récupérer par IMAP (client de messagerie ou imapsync) vers CWP ;');
  }
  lines.push('- rien n\'a été supprimé côté Oblimint : la checklist repart de « préparé », une synchronisation finale puis une nouvelle bascule restent possibles (sans suppression miroir des boîtes).');
  return lines.join('\n');
}
