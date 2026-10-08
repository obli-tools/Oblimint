import Docker from 'dockerode';
import { config } from '../../config';

/** Label put on every container / network the panel creates for itself. */
export const INTERNAL_LABELS = { 'oblimint.internal': 'true' } as const;

let client: Docker | null = null;

/** Docker Engine client over the mounted socket (lazy: nothing is opened at import). */
export function docker(): Docker {
  if (!client) client = new Docker({ socketPath: config.dockerSocket, timeout: 15_000 });
  return client;
}

/** Rejects after `ms` (a hung socket must never hang a check or a step). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Short, single-line error text (dockerode errors embed JSON bodies). */
export function errText(err: unknown): string {
  const e = err as { json?: { message?: string }; message?: string; code?: string } | null;
  const msg = e?.json?.message || e?.message || String(err);
  return (e?.code && !msg.includes(e.code) ? `${e.code}: ${msg}` : msg).replace(/\s+/g, ' ').slice(0, 300);
}

/** The container this process runs in: Docker sets HOSTNAME to its short id. */
export function selfContainerRef(): string | null {
  const h = (process.env.OBLIMINT_SELF_CONTAINER || process.env.HOSTNAME || '').trim();
  return h || null;
}
