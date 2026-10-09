import type { QuarantineReason, QuarantineSource, RiskLevel, WindowChangeCounts } from '@oblimint/shared';
import type { HostdQuarantineEntry, HostdWatchSpec } from '../hostd/client';

// ─────────────────────────────────────────────────────────────────────────────
// Pure logic of the quarantine module (no DB, no hostd): watch specs computed
// from the account rows, hostd entry → quarantine_items row, notification
// texts and dedup keys, digest scheduling, preview text sniffing. Tested by
// logic.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

// ── Watch specs ──────────────────────────────────────────────────────────────

/** What the watch sync needs to know about one account (from AccountState or the DB). */
export interface AccountWatchTarget {
  accountId: number;
  nodeId: number;
  uid: number;
  gid: number;
  status: string;
  sites: Array<{
    siteId: number;
    slug: string;
    dataPaths: Array<{ path: string; policy: string; allowedExtensions: unknown }>;
  }>;
}

export type WatchOp =
  | { kind: 'set'; siteId: number; spec: HostdWatchSpec; signature: string }
  | { kind: 'remove'; siteId: number; signature: string };

/** Signature of a site that must not be watched. */
export const NO_WATCH = 'none';

/** Lower-case extensions without dot, de-duplicated and sorted (stable signature). */
export function normalizeExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const ext = v.trim().toLowerCase().replace(/^\.+/, '');
    if (/^[a-z0-9][a-z0-9_+-]{0,15}$/.test(ext)) out.add(ext);
  }
  return [...out].sort();
}

/**
 * Accounts whose watches are pushed at all. 'deleting': hostd's
 * removeAccount tears the tree (and its watches) down, the panel never
 * re-arms them. Suspended / provisioning / error accounts keep their watches:
 * their data directories still exist, and a file dropped before a suspension
 * must still be caught (the watch costs nothing while the site is stopped).
 */
export function accountWatched(status: string): boolean {
  return status !== 'deleting';
}

/** Typed data paths of a site, as hostd expects them (sorted by path). */
export function typedPathsOf(dataPaths: AccountWatchTarget['sites'][number]['dataPaths']): HostdWatchSpec['typed'] {
  return dataPaths
    .filter((d) => d.policy === 'typed' && typeof d.path === 'string' && d.path.length > 0)
    .map((d) => ({ path: d.path, allowedExtensions: normalizeExtensions(d.allowedExtensions) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * hostd calls that bring the watches of an account to the wanted state.
 * `known`: signature last pushed per site (in-memory cache), skipped unless
 * `force` (hostd restarted: its in-memory watches are gone). Sites in `known`
 * but no longer in the account get a removeWatch.
 */
export function planWatchOps(
  target: AccountWatchTarget,
  typedWatcher: boolean,
  known: ReadonlyMap<number, string> | undefined,
  force: boolean,
): WatchOp[] {
  const ops: WatchOp[] = [];
  const seen = new Set<number>();
  for (const s of target.sites) {
    seen.add(s.siteId);
    const typed = typedWatcher && accountWatched(target.status) ? typedPathsOf(s.dataPaths) : [];
    if (typed.length > 0) {
      const spec: HostdWatchSpec = { accountId: target.accountId, siteId: s.siteId, slug: s.slug, uid: target.uid, gid: target.gid, typed };
      const signature = JSON.stringify([s.slug, target.uid, target.gid, typed]);
      if (force || known?.get(s.siteId) !== signature) ops.push({ kind: 'set', siteId: s.siteId, spec, signature });
    } else if (force || known?.get(s.siteId) !== NO_WATCH) {
      ops.push({ kind: 'remove', siteId: s.siteId, signature: NO_WATCH });
    }
  }
  for (const [siteId, sig] of known ?? []) {
    if (!seen.has(siteId) && sig !== NO_WATCH) ops.push({ kind: 'remove', siteId, signature: NO_WATCH });
  }
  return ops;
}

// ── hostd entry → quarantine_items ───────────────────────────────────────────

const REASONS: readonly QuarantineReason[] = ['extension', 'php-content', 'polyglot', 'magic-mismatch', 'executable-write', 'special'];

export function sourceOf(source: HostdQuarantineEntry['source']): QuarantineSource | null {
  if (source === 'typed') return 'typed-path';
  if (source === 'supervised') return 'supervised';
  return null;
}

export function reasonOf(reason: string): QuarantineReason | null {
  return (REASONS as readonly string[]).includes(reason) ? reason as QuarantineReason : null;
}

/** POSIX relative path, no leading './' or '/', no empty segment; '' when unusable. */
export function cleanRelPath(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return '';
  return parts.join('/').slice(0, 4096);
}

/**
 * Path shown to the user, relative to the site root (code view). Data area:
 * hostd gives the path relative to data/<slug>/ ('<data path>/<file>'); a
 * path relative to the data path itself is prefixed with it. Code area
 * (supervised): relative to the release root already.
 */
export function itemPathOf(e: Pick<HostdQuarantineEntry, 'area' | 'path' | 'dataPath'>): { path: string; dataPath: string | null } {
  const rel = cleanRelPath(e.path);
  if (e.area !== 'data') return { path: rel, dataPath: null };
  const dp = cleanRelPath(e.dataPath ?? '') || null;
  if (dp && rel !== dp && !rel.startsWith(`${dp}/`)) return { path: rel ? `${dp}/${rel}` : dp, dataPath: dp };
  return { path: rel, dataPath: dp };
}

export interface QuarantineInsertRow {
  tenant_id: number;
  account_id: number;
  site_id: number | null;
  site_name: string | null;
  source: QuarantineSource;
  reason: QuarantineReason;
  path: string;
  data_path: string | null;
  size_bytes: number;
  sha256: string;
  detected_type: string | null;
  detail: string | null;
  hostd_entry_id: string;
  status: 'quarantined' | 'restored';
  detected_at: Date;
  resolved_at: Date | null;
  resolution_note: string | null;
}

/** Note of an entry hostd reports as restored that the panel did not restore. */
export const RESTORED_OUTSIDE_NOTE = 'Restauré hors du panel';
/** Note of a row whose entry disappeared from hostd's store. */
export const MISSING_ON_HOST_NOTE = "Entrée absente de l'hôte (supprimée hors du panel)";

function validDate(v: unknown, fallback: Date): Date {
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d : fallback;
}

/**
 * Row of a hostd entry (null when the entry is unusable: unknown source /
 * reason, invalid id, empty path). `site`: the site row of the entry when it
 * still belongs to the account (tenant isolation: hostd's siteId is only
 * trusted after this check), else null (the slug is kept as the name).
 */
export function rowFromEntry(
  e: HostdQuarantineEntry,
  account: { id: number; tenantId: number },
  site: { id: number; name: string } | null,
  now: Date,
): QuarantineInsertRow | null {
  const source = sourceOf(e.source);
  const reason = reasonOf(e.reason);
  if (!source || !reason) return null;
  if (typeof e.id !== 'string' || !/^[0-9a-z-]{8,64}$/.test(e.id)) return null;
  const { path, dataPath } = itemPathOf(e);
  if (!path) return null;
  const restoredAt = e.restoredAt ? validDate(e.restoredAt, now) : null;
  return {
    tenant_id: account.tenantId,
    account_id: account.id,
    site_id: site?.id ?? null,
    site_name: (site?.name ?? (typeof e.slug === 'string' ? e.slug : null))?.slice(0, 255) ?? null,
    source,
    reason,
    path,
    data_path: dataPath?.slice(0, 255) ?? null,
    size_bytes: Number.isFinite(e.size) && e.size > 0 ? Math.floor(e.size) : 0,
    sha256: typeof e.sha256 === 'string' ? e.sha256.toLowerCase().slice(0, 64) : '',
    detected_type: typeof e.detectedType === 'string' && e.detectedType ? e.detectedType.slice(0, 128) : null,
    detail: typeof e.detail === 'string' && e.detail ? e.detail.slice(0, 2000) : null,
    hostd_entry_id: e.id,
    status: restoredAt ? 'restored' : 'quarantined',
    detected_at: validDate(e.quarantinedAt, now),
    resolved_at: restoredAt,
    resolution_note: restoredAt ? RESTORED_OUTSIDE_NOTE : null,
  };
}

// ── Notifications (French) ───────────────────────────────────────────────────

export const REASON_FR: Record<QuarantineReason, string> = {
  extension: 'extension non autorisée',
  'php-content': 'contenu PHP',
  polyglot: 'fichier polyglotte (média contenant du code)',
  'magic-mismatch': "type réel différent de l'extension",
  'executable-write': 'écriture d’un fichier exécutable hors fenêtre',
  special: 'fichier spécial (lien symbolique, FIFO, périphérique)',
};

export const RISK_LEVEL_FR: Record<RiskLevel, string> = {
  none: 'aucun', low: 'faible', medium: 'moyen', high: 'élevé', critical: 'critique',
};

/** UTC hour bucket ('2026-10-09T14'). */
export function hourBucket(at: Date): string {
  return at.toISOString().slice(0, 13);
}

/** One 'quarantine.added' notification per site (or account) and hour. */
export function quarantineNotifyKey(accountId: number, siteId: number | null, at: Date): string {
  return siteId !== null ? `quarantine:site:${siteId}:${hourBucket(at)}` : `quarantine:account:${accountId}:${hourBucket(at)}`;
}

export function quarantineNotification(item: {
  path: string; reason: QuarantineReason; source: QuarantineSource; siteName: string | null; accountUsername: string;
}): { title: string; message: string } {
  const where = item.siteName ? `du site « ${item.siteName} » (compte « ${item.accountUsername} »)` : `du compte « ${item.accountUsername} »`;
  const origin = item.source === 'supervised' ? 'Mode supervisé' : 'Chemin de données typé';
  return {
    title: 'Fichier mis en quarantaine',
    message: `${origin} : le fichier « ${item.path} » ${where} a été mis en quarantaine (motif : ${REASON_FR[item.reason]}).\n`
      + 'Il est conservé comme preuve, rien n’a été supprimé ; un administrateur peut le restaurer ou le supprimer depuis la visionneuse.\n'
      + 'D’autres fichiers mis en quarantaine dans l’heure ne déclenchent pas de nouvelle alerte.',
  };
}

// ── Supervision digest ───────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
/** Retry delay of a digest that failed (windows module / hostd unavailable). */
export const DIGEST_RETRY_MS = 15 * 60_000;

export function clampDigestHours(hours: unknown): number {
  const h = typeof hours === 'number' && Number.isFinite(hours) ? hours : 24;
  return Math.min(24 * 30, Math.max(1, h));
}

export function nextDigestAt(now: Date, hours: unknown): Date {
  return new Date(now.getTime() + clampDigestHours(hours) * HOUR_MS);
}

/**
 * What the digest worker does with a supervised site at `now`:
 * 'schedule' (no next date yet: first digest one interval from now — the
 * supervised window was just opened), 'run' (due), 'wait'.
 */
export function digestDue(nextAt: Date | string | null, now: Date): 'schedule' | 'run' | 'wait' {
  if (nextAt === null || nextAt === undefined) return 'schedule';
  const t = new Date(nextAt).getTime();
  if (!Number.isFinite(t)) return 'schedule';
  return t <= now.getTime() ? 'run' : 'wait';
}

export interface DigestFacts {
  siteName: string;
  accountUsername: string;
  /** Changes accumulated in the overlay (counts.total) now / at the previous digest. */
  counts: WindowChangeCounts | null;
  previousTotal: number | null;
  firstDigest: boolean;
  risk: { score: number; level: RiskLevel } | null;
  /** Files quarantined (supervised source) since the last digest. */
  newQuarantined: number;
}

/**
 * Notify when something new appeared since the last digest: the change count
 * moved (or a first digest with changes), or new quarantined files. Pending
 * changes that did not move are not re-announced.
 */
export function digestShouldNotify(f: DigestFacts): boolean {
  const total = f.counts?.total ?? 0;
  const newChanges = total > 0 && (f.firstDigest || f.previousTotal === null || total !== f.previousTotal);
  return newChanges || f.newQuarantined > 0;
}

export function digestNotification(f: DigestFacts): { title: string; message: string; severity: 'info' | 'warning' | 'critical' } {
  const total = f.counts?.total ?? 0;
  const lines: string[] = [];
  if (total > 0) {
    const c = f.counts!;
    lines.push(`${total} changement(s) en attente de validation dans le code (${c.added} ajouté(s), ${c.modified} modifié(s), ${c.deleted} supprimé(s), dont ${c.executable} exécutable(s)).`);
  } else {
    lines.push('Aucun changement en attente dans le code.');
  }
  if (f.risk) lines.push(`Niveau de risque : ${RISK_LEVEL_FR[f.risk.level]} (score ${f.risk.score}/100).`);
  if (f.newQuarantined > 0) lines.push(`${f.newQuarantined} fichier(s) exécutable(s) mis en quarantaine depuis le dernier résumé.`);
  lines.push('Validez ou rejetez les changements depuis l’onglet Maintenance du site.');
  const level = f.risk?.level ?? 'none';
  const severity = level === 'high' || level === 'critical' ? 'critical' : (f.newQuarantined > 0 || level === 'medium') ? 'warning' : 'info';
  return {
    title: `Résumé de supervision : ${f.siteName}`,
    message: `Site « ${f.siteName} » (compte « ${f.accountUsername} »).\n${lines.join('\n')}`,
    severity,
  };
}

// ── Preview ──────────────────────────────────────────────────────────────────

/** Bytes of a quarantined file shown in the viewer (staff only). */
export const PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * Printable text? No NUL byte, valid UTF-8 (a truncated trailing sequence is
 * tolerated), at most 5 % control characters other than tab / CR / LF / FF.
 */
export function looksLikeText(buf: Buffer, truncated: boolean): boolean {
  if (buf.length === 0) return true;
  if (buf.includes(0)) return false;
  let body = buf;
  if (truncated) {
    // Drop an incomplete UTF-8 sequence cut by the preview limit.
    let i = buf.length - 1;
    let back = 0;
    while (i >= 0 && back < 3 && (buf[i] & 0xc0) === 0x80) { i--; back++; }
    if (i >= 0 && buf[i] >= 0xc0) {
      const need = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : 2;
      if (buf.length - i < need) body = buf.subarray(0, i);
    }
  }
  const text = body.toString('utf8');
  if (text.includes('�')) return false;
  let control = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) || c === 0x7f) control++;
  }
  return control <= text.length * 0.05;
}
