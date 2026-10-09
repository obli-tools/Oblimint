import { isIP } from 'net';

// Pure (no database import): also used by the setup wizard's schema.

/**
 * The Obligate URL is the SSO trust anchor: the panel sends its API key there
 * and believes the role it answers (an 'admin' assertion = platform admin).
 * Plain http:// is only accepted where no internet path exists: loopback,
 * a single-label Docker / LAN name, a private / link-local / ULA address, or
 * a .local / .lan / .internal / .home.arpa name — elsewhere a man in the middle
 * could forge assertions. OBLIGATE_ALLOW_HTTP=true lifts it (explicit opt-in).
 * Returns an English error, or null.
 */
export function obligateUrlError(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'url must be an http(s) URL'; }
  if (u.protocol === 'https:') return null;
  if (u.protocol !== 'http:') return 'url must be an http(s) URL';
  if (process.env.OBLIGATE_ALLOW_HTTP === 'true') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  } else if (family === 6) {
    if (host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return null;
  } else if (host === 'localhost' || !host.includes('.') || /\.(local|lan|internal|home\.arpa)$/.test(host)) {
    return null;
  }
  return 'The Obligate URL must use https:// (plain http:// is only accepted for a local or private address; OBLIGATE_ALLOW_HTTP=true overrides)';
}
