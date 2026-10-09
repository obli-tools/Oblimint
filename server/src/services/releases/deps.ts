import http from 'http';
import { hostdFor, type HostdClient } from '../hostd/client';
import { realLinkOps, type LinkOps } from './materialize';

// ─────────────────────────────────────────────────────────────────────────────
// Collaborators of the release pipeline owned by OTHER modules (orchestration,
// hostd) plus the side effects worth faking in tests (HTTP healthcheck,
// symlinks, delays). Production wiring loads the real services lazily (no
// import cycle with docker/reconcile → releaseService).
// ─────────────────────────────────────────────────────────────────────────────

export type ReleaseHostd = Pick<HostdClient, 'ensureDataPaths' | 'seedDataPath' | 'clearDataPaths'>;

export interface HealthcheckResult { ok: boolean; status: number | null; error: string | null }

export interface ReleaseDeps {
  /** runtimeService.reloadSite (orchestration). */
  reloadSite(siteId: number): Promise<{ ok: boolean; errors: string[] }>;
  /** hostdFor(nodeId) (hostd). */
  hostd(nodeId: number): ReleaseHostd;
  /** One HTTP probe: GET url with `Host: host`; ok = status < 500. */
  probe(url: string, host: string, timeoutMs: number): Promise<HealthcheckResult>;
  links: LinkOps;
  sleep(ms: number): Promise<void>;
  /** Healthcheck schedule (attempts, delay between them, per-attempt timeout). */
  health: { attempts: number; delayMs: number; timeoutMs: number };
}

/** GET with an explicit Host header (node:http: fetch would not let us set Host). */
export function httpProbe(url: string, host: string, timeoutMs: number): Promise<HealthcheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: HealthcheckResult): void => { if (!settled) { settled = true; resolve(r); } };
    try {
      const req = http.request(url, {
        method: 'GET',
        headers: { Host: host, 'User-Agent': 'Oblimint-Healthcheck/1', Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      }, (res) => {
        res.resume(); // drain, body ignored
        const status = res.statusCode ?? 0;
        done({ ok: status > 0 && status < 500, status, error: status >= 500 ? `HTTP ${status}` : null });
      });
      req.on('error', (err) => done({ ok: false, status: null, error: err.message }));
      req.end();
    } catch (err) {
      done({ ok: false, status: null, error: (err as Error).message });
    }
  });
}

const defaults: ReleaseDeps = {
  async reloadSite(siteId) {
    const { runtimeService } = await import('../docker/runtime.service');
    return runtimeService.reloadSite(siteId);
  },
  hostd: (nodeId) => hostdFor(nodeId),
  probe: httpProbe,
  links: realLinkOps,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  health: { attempts: 3, delayMs: 3000, timeoutMs: 10_000 },
};

let current: ReleaseDeps = { ...defaults };

export function releaseDeps(): ReleaseDeps {
  return current;
}

/** Tests: replaces some collaborators (the rest keeps its production value). */
export function setReleaseDeps(over: Partial<ReleaseDeps>): void {
  current = { ...current, ...over };
}

export function resetReleaseDeps(): void {
  current = { ...defaults };
}
