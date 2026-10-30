import { isSecretField } from '../../api/pendingReplay';

// The parameters of a request flattened to « path → value » rows (Obliance
// ApprovalsPage payloadRows). The server already masks secret-named fields
// (canonical.ts maskSecrets) and never stores a secret; masked again here
// whatever reaches the page.

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function payloadRows(v: unknown, path = '', out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (depth > 6) { out.push([path || '·', fmtValue(v)]); return out; }
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) { out.push([path || '·', v.map(fmtValue).join(', ') || '[]']); return out; }
    v.forEach((x, i) => payloadRows(x, `${path}[${i}]`, out, depth + 1));
    return out;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) { if (path) out.push([path, '{}']); return out; }
    for (const [k, x] of entries) {
      const p = path ? `${path}.${k}` : k;
      if (isSecretField(k) && x !== null && x !== undefined && x !== '' && typeof x !== 'boolean') out.push([p, '•••']);
      else payloadRows(x, p, out, depth + 1);
    }
    return out;
  }
  out.push([path || '·', fmtValue(v)]);
  return out;
}
