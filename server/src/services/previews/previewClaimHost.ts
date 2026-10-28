// Feature B — the preview domain as known by the synchronous originGuard (the
// claim POST of a share link carries a form body from the preview host). Set
// at boot, at every preview start and by the expiry worker (30 s).

let previewDomain: string | null = null;

export function setPreviewClaimDomain(d: string | null | undefined): void {
  const v = (d ?? '').trim().toLowerCase().replace(/\.$/, '');
  previewDomain = v || null;
}

export function previewClaimDomain(): string | null {
  return previewDomain;
}

/** A host name directly under the preview domain (one label). */
export function isPreviewClaimHost(host: string | undefined): boolean {
  if (!previewDomain || !host) return false;
  const h = host.trim().toLowerCase().replace(/:443$/, '');
  if (!h.endsWith(`.${previewDomain}`)) return false;
  const label = h.slice(0, -previewDomain.length - 1);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}
