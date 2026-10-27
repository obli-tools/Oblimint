// Return to the OAuth consent page (/oauth/authorize?…) after signing in: the
// page stores itself before sending a signed-out user to /login, and the
// protected routes send the user back once signed in. Stale after 10 min.

const KEY = 'oblimint.oauthReturn';
const TTL_MS = 10 * 60_000;

export function rememberOAuthReturn(path: string): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() })); } catch { /* storage unavailable */ }
}

/** The pending consent page, if any (not consumed: the page clears it). */
export function pendingOAuthReturn(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof v.path !== 'string' || !v.path.startsWith('/oauth/authorize?') || typeof v.at !== 'number' || Date.now() - v.at > TTL_MS) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return v.path;
  } catch {
    return null;
  }
}

export function clearOAuthReturn(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}
