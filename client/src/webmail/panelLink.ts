import type { WebmailSessionInfo } from '@oblimint/shared';
import { safePanelUrl } from './lib/view';

// "Back to Oblimint" link of the header. The SSO answer carries the page of
// the mailbox on the panel host the user came from; it is remembered per
// address in this host's local storage (a per-browser convenience), so a
// reload — whose /session answer only knows the panel host — still goes back
// to the same place. Anything stored is re-validated (absolute http(s) only).

const STORAGE_KEY = 'wm-panel-links';
const MAX_ENTRIES = 20;

function read(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Remembers the link the SSO answer carried for this mailbox. */
export function rememberPanelLink(info: WebmailSessionInfo): void {
  const url = safePanelUrl(info.panelUrl);
  const address = info.address?.toLowerCase();
  if (!url || !address) return;
  try {
    const all = read();
    delete all[address];
    const entries = [...Object.entries(all), [address, url] as [string, string]].slice(-MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage unavailable: the server's link is used */ }
}

/** Link of the header's "Back to Oblimint" for this session (null: none known). */
export function panelLinkFor(info: WebmailSessionInfo | null): string | null {
  if (!info?.authenticated) return null;
  const stored = info.address ? read()[info.address.toLowerCase()] : undefined;
  return safePanelUrl(stored) ?? safePanelUrl(info.panelUrl);
}
