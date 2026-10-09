// Per-key serialization (after Oblihub composeRunner's per-target locks): every
// operation that changes the containers of an account (reconcile pass,
// runtime switch / preview, file server activation) runs under the account's
// lock, so two of them never race on the same container names.

const tails = new Map<string, Promise<unknown>>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export const accountLockKey = (accountId: number): string => `account:${accountId}`;
export const infraLockKey = (component: 'edge' | 'hostd'): string => `infra:${component}`;

export function withAccountLock<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  return withLock(accountLockKey(accountId), fn);
}

/** Is an operation running / queued on this key (tests, diagnostics)? */
export function isLocked(key: string): boolean {
  return tails.has(key);
}
