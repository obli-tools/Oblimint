import type { Request } from 'express';
import { appConfigService } from './appConfig.service';

// ─────────────────────────────────────────────────────────────────────────────
// Host names of the panel itself: app_config panel_hostname (the panel, every
// user) and client_panel_hostname (optional client space: same panel, served
// by the edge on a second name with its own certificate, clients only).
// publicPanelOrigin() is the address shown to a user in commands and links:
// the configured host the request came through, else the panel host. The
// Host header is never echoed unless it IS one of the configured names.
// ─────────────────────────────────────────────────────────────────────────────

export interface PanelHosts {
  admin: string | null;
  client: string | null;
}

export type PanelHostRole = 'admin' | 'client';

export const normalizeHost = (v: string | null | undefined): string | null => v?.trim().toLowerCase().replace(/\.$/, '') || null;

export async function panelHosts(): Promise<PanelHosts> {
  const [admin, client] = await Promise.all([appConfigService.get('panel_hostname'), appConfigService.get('client_panel_hostname')]);
  return { admin: normalizeHost(admin), client: normalizeHost(client) };
}

/** Host name the request was sent to (Host header, without port), lower case. */
export function requestHost(req: Pick<Request, 'headers'>): string | null {
  const raw = req.headers?.host;
  const h = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? '';
  if (!h) return null;
  return normalizeHost(h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d+$/, ''));
}

/** Role of a configured panel host name; null for any other host (IP, localhost…). */
export function panelHostRole(host: string | null, hosts: PanelHosts): PanelHostRole | null {
  if (!host) return null;
  if (hosts.client && host === hosts.client) return 'client';
  if (hosts.admin && host === hosts.admin) return 'admin';
  return null;
}

/** https://<host> the user reached the panel through, else the panel host, else null. */
export async function publicPanelOrigin(req: Pick<Request, 'headers'>): Promise<string | null> {
  const hosts = await panelHosts();
  const role = panelHostRole(requestHost(req), hosts);
  const host = role ? hosts[role] : hosts.admin;
  return host ? `https://${host}` : null;
}

// ── host-based access (client space) ─────────────────────────────────────────
// Only when client_panel_hostname is set: the client space admits kind
// 'client' users only, the panel host refuses them (they have their own
// address). Any other host (IP, localhost, unknown name) stays unrestricted:
// the break-glass path when a name or its certificate is broken.

const CACHE_TTL_MS = 5_000;
let cached: { at: number; hosts: PanelHosts } | null = null;

/** panelHosts(), cached a few seconds (read on every signed-in request). */
export async function cachedPanelHosts(): Promise<PanelHosts> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.hosts;
  const hosts = await panelHosts();
  cached = { at: Date.now(), hosts };
  return hosts;
}

/** Drops the cache (panel identity saved; tests). */
export function forgetPanelHosts(): void {
  cached = null;
}

export interface WrongPanelHost {
  /** Address the user must use instead (null: none configured). */
  url: string | null;
  /** Role of that address. */
  expected: PanelHostRole;
}

/** Why a user of this kind may not use this host role; null = allowed. */
export function panelHostRefusal(role: PanelHostRole | null, kind: string, hosts: PanelHosts): WrongPanelHost | null {
  if (!hosts.client) return null;
  if (role === 'client' && kind !== 'client') return { url: hosts.admin ? `https://${hosts.admin}` : null, expected: 'admin' };
  if (role === 'admin' && kind === 'client') return { url: `https://${hosts.client}`, expected: 'client' };
  return null;
}

/** Role of the host the request was sent to (cached hosts). */
export async function requestPanelRole(req: Pick<Request, 'headers'>): Promise<{ role: PanelHostRole | null; hosts: PanelHosts }> {
  const hosts = await cachedPanelHosts();
  return { role: panelHostRole(requestHost(req), hosts), hosts };
}
