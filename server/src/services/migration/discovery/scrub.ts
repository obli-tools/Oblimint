// ─────────────────────────────────────────────────────────────────────────────
// MG2 last line of defence: the inventory is persisted, sent to the UI and
// feeds the plan; it must hold NO hash, key or password. Every collector
// already avoids secrets (constant meta templates, Environment redacted on
// the source, credential arguments redacted); this pass redacts anything that
// still LOOKS like a secret in any string (crypt hashes, {SCHEME} prefixed
// hashes, MySQL native hashes, private-key PEM blocks, URL passwords) and counts it.
// ─────────────────────────────────────────────────────────────────────────────

export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; replace?: (m: string, ...g: string[]) => string }> = [
  { name: 'pem-private-key', re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g },
  { name: 'scheme-hash', re: /\{(?:SHA512-CRYPT|SHA256-CRYPT|MD5-CRYPT|BLF-CRYPT|SSHA512|SSHA256|SSHA|SHA|SMD5|PLAIN-MD5|CRYPT|PLAIN|CRAM-MD5|ARGON2I|ARGON2ID|PBKDF2)\}[^\s"',]*/gi },
  { name: 'crypt-hash', re: /\$(?:1|2[abxy]|5|6|y|7|argon2(?:id|i|d))\$[./A-Za-z0-9$=,+]{8,}/g },
  { name: 'mysql-native', re: /\*[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/g },
  // scheme://user:password@host — only the password goes (the URL stays readable).
  { name: 'url-userinfo', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'\\]+:)(?!<redacted>@)[^\s/@"'\\]+@/gi, replace: (_m, head) => `${head}<redacted>@` },
];

export const REDACTED = '<redacted>';

/** Redacts secret-looking substrings; returns the new string and how many were found. */
export function redactSecrets(s: string): { value: string; hits: number } {
  let hits = 0;
  let value = s;
  for (const { re, replace } of SECRET_PATTERNS) {
    value = value.replace(re, (m: string, ...g: string[]) => { hits += 1; return replace ? replace(m, ...g) : REDACTED; });
  }
  return { value, hits };
}

/** Deep copy with every string scrubbed (object keys included). */
export function scrubDeep<T>(input: T): { value: T; hits: number } {
  let hits = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecrets(v);
      hits += r.hits;
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const rk = redactSecrets(k);
        hits += rk.hits;
        o[rk.value] = walk(x);
      }
      return o;
    }
    return v;
  };
  return { value: walk(input) as T, hits };
}

/** Throws when a serialized value still contains something secret-looking (tests + final assert). */
export function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const { name, re } of SECRET_PATTERNS) {
    const r = new RegExp(re.source, re.flags.replace('g', ''));
    if (r.test(text)) throw new Error(`secret-looking value in the inventory (${name})`);
  }
}
