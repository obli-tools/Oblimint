import type { EdgeLogEntry } from '../usage/edgeLog';

// ─────────────────────────────────────────────────────────────────────────────
// Requests of the sites from the edge access log — PURE, in memory, bounded.
//   - a ring of per-minute counters per site (last RING_MINUTES): the
//     baseline of an observation is the span just before the switch (served
//     by the previous release);
//   - per observed site, counters since its switch, drained by the worker
//     into release_observations (added in SQL: a restart loses at most one tick).
// Counted: the site's own answers (kinds site / secondary). Previews, the
// panel, placeholders and ACME are not the release's traffic.
// ─────────────────────────────────────────────────────────────────────────────

export const RING_MINUTES = 130;
/** Bounded memory: sites tracked in the ring (new ones dropped beyond). */
export const MAX_RING_SITES = 50_000;
const COUNTED_KINDS = new Set(['site', 'secondary']);
const MINUTE = 60_000;

export interface Counts { requests: number; errors5xx: number; upstreamErrors: number }

const zero = (): Counts => ({ requests: 0, errors5xx: 0, upstreamErrors: 0 });

function add(c: Counts, status: number): void {
  c.requests += 1;
  if (status >= 500 && status <= 599) {
    c.errors5xx += 1;
    if (status === 502 || status === 503 || status === 504) c.upstreamErrors += 1;
  }
}

export class SiteTraffic {
  private ring = new Map<number, Map<number, Counts>>();
  private watched = new Map<number, { since: number; counts: Counts }>();
  dropped = 0;

  /** One edge log entry (fast: called for every line of the edge). */
  add(e: Pick<EdgeLogEntry, 'siteId' | 'kind' | 'status' | 'time'>, now: number = Date.now()): void {
    if (!e.siteId || !COUNTED_KINDS.has(e.kind)) return;
    const parsed = Date.parse(e.time);
    const at = Number.isFinite(parsed) ? parsed : now;
    let minutes = this.ring.get(e.siteId);
    if (!minutes) {
      if (this.ring.size >= MAX_RING_SITES) { this.dropped++; } else {
        minutes = new Map();
        this.ring.set(e.siteId, minutes);
      }
    }
    if (minutes) {
      const m = Math.floor(at / MINUTE);
      let c = minutes.get(m);
      if (!c) {
        c = zero();
        minutes.set(m, c);
        const oldest = Math.floor(now / MINUTE) - RING_MINUTES;
        if (minutes.size > RING_MINUTES) for (const k of minutes.keys()) if (k < oldest) minutes.delete(k);
      }
      add(c, e.status);
    }
    const w = this.watched.get(e.siteId);
    if (w && at >= w.since) add(w.counts, e.status);
  }

  /** Sum of the full minutes in [from, to) (ms): the baseline span. minutes = minutes of that span holding data. */
  window(siteId: number, from: number, to: number): Counts & { minutes: number } {
    const out = { ...zero(), minutes: 0 };
    const minutes = this.ring.get(siteId);
    if (!minutes) return out;
    const a = Math.ceil(from / MINUTE);
    const b = Math.floor(to / MINUTE); // the minute of the switch holds both releases: excluded
    for (const [m, c] of minutes) {
      if (m < a || m >= b) continue;
      out.requests += c.requests;
      out.errors5xx += c.errors5xx;
      out.upstreamErrors += c.upstreamErrors;
      out.minutes += 1;
    }
    return out;
  }

  /** Starts (or keeps) counting a site's requests from `since` (ms). */
  watch(siteId: number, since: number): void {
    const w = this.watched.get(siteId);
    if (w && w.since === since) return;
    this.watched.set(siteId, { since, counts: zero() });
  }

  unwatch(siteId: number): void {
    this.watched.delete(siteId);
  }

  watchedSites(): number[] {
    return [...this.watched.keys()];
  }

  /** Counters of a watched site since the last drain (reset). */
  drain(siteId: number): Counts {
    const w = this.watched.get(siteId);
    if (!w) return zero();
    const c = w.counts;
    w.counts = zero();
    return c;
  }

  /** Puts drained counters back (failed write). */
  restore(siteId: number, c: Counts): void {
    const w = this.watched.get(siteId);
    if (!w) return;
    w.counts.requests += c.requests;
    w.counts.errors5xx += c.errors5xx;
    w.counts.upstreamErrors += c.upstreamErrors;
  }

  /** Drops the ring minutes older than RING_MINUTES (and the sites left empty). */
  prune(now: number = Date.now()): void {
    const oldest = Math.floor(now / MINUTE) - RING_MINUTES;
    for (const [site, minutes] of this.ring) {
      for (const k of minutes.keys()) if (k < oldest) minutes.delete(k);
      if (minutes.size === 0) this.ring.delete(site);
    }
  }
}
