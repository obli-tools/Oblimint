import { db } from '../db';
import type { AppConfigData, ObligateConfig } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { obligateUrlError } from './obligateUrl';

export { obligateUrlError };

// Ported from Obliance (Obligate part + generic key/value). Same storage:
// app_config 'obligate_config' (JSON {url, apiKey, inboundSecret?}) and
// 'obligate_enabled' ('true' | 'false').

const OBLIGATE_CONFIG_KEY = 'obligate_config';

interface ObligateStored {
  url: string | null;
  apiKey: string | null;
  inboundSecret: string | null;
}

function envInboundSecret(): string | null {
  const v = process.env.OBLIGATE_INBOUND_SECRET?.trim();
  return v ? v : null;
}

/** What the admin UI may see: flags, never a secret. */
function obligatePublicView(s: ObligateStored, enabled: boolean): ObligateConfig {
  const envSecret = envInboundSecret();
  return {
    url: s.url,
    apiKeySet: !!s.apiKey,
    enabled,
    inboundSecretSet: !!(envSecret ?? s.inboundSecret),
    inboundSecretFromEnv: !!envSecret,
  };
}

/** Keys PUT /api/admin/config/:key may write (string values). */
export const WRITABLE_CONFIG_KEYS: Record<string, (v: string) => boolean> = {
  allow_2fa: (v) => v === 'true' || v === 'false',
  force_2fa: (v) => v === 'true' || v === 'false',
  app_name: (v) => v.length >= 1 && v.length <= 64,
  default_language: (v) => /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(v),
};

export interface ObligatePatch {
  url?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
  inboundSecret?: string | null;
}

/** PUT /admin/config/obligate body → patch (same rules as Obliance settingsWrite.obligatePatch). */
export function obligatePatch(body: Record<string, unknown>): ObligatePatch {
  const patch: ObligatePatch = {};
  if ('url' in body) {
    const url = (typeof body.url === 'string' ? body.url.trim().replace(/\/+$/, '') : '') || null;
    if (url) {
      const error = obligateUrlError(url);
      if (error) throw new AppError(400, error);
    }
    patch.url = url;
  }
  if ('apiKey' in body) patch.apiKey = (typeof body.apiKey === 'string' ? body.apiKey.trim() : '') || null;
  if ('enabled' in body) patch.enabled = !!body.enabled;
  if (body.clientIdMode === 'raw') throw new AppError(400, 'The raw API key can no longer be sent as client_id');
  if ('inboundSecret' in body) {
    const s = body.inboundSecret;
    if (s !== null && typeof s !== 'string') throw new AppError(400, 'inboundSecret must be a string or null');
    if (s === null) {
      patch.inboundSecret = null;
    } else {
      const trimmed = s.trim();
      if (trimmed.length > 0 && trimmed.length < 16) throw new AppError(400, 'inboundSecret must be at least 16 characters');
      if (trimmed) patch.inboundSecret = trimmed;
    }
  }
  return patch;
}

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first('value');
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await db('app_config').insert({ key, value }).onConflict('key').merge({ value });
  },

  async getAll(): Promise<AppConfigData> {
    const rows = await db('app_config').select('key', 'value');
    const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value])) as Record<string, string | undefined>;
    let obligateUrl: string | null = null;
    if (map[OBLIGATE_CONFIG_KEY]) {
      try { obligateUrl = (JSON.parse(map[OBLIGATE_CONFIG_KEY]!) as { url?: string }).url || null; } catch { obligateUrl = null; }
    }
    return {
      allow_2fa: map.allow_2fa ?? 'true',
      force_2fa: map.force_2fa ?? 'false',
      app_name: map.app_name ?? 'Oblimint',
      default_language: map.default_language ?? 'en',
      obligate_url: obligateUrl,
      obligate_enabled: map.obligate_enabled ?? 'false',
      panel_hostname: map.panel_hostname ?? null,
      public_ipv4: map.public_ipv4 ?? null,
      public_ipv6: map.public_ipv6 ?? null,
      nameservers: map.nameservers ?? null,
      acme_email: map.acme_email ?? null,
      mail_engine: map.mail_engine ?? null,
    };
  },

  async getObligateConfig(): Promise<ObligateConfig> {
    const enabled = (await this.get('obligate_enabled')) === 'true';
    return obligatePublicView(await this.readObligateStored(), enabled);
  },

  async readObligateStored(): Promise<ObligateStored> {
    const raw = await this.get(OBLIGATE_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null, inboundSecret: null };
    try {
      const cfg = JSON.parse(raw) as { url?: string; apiKey?: string; inboundSecret?: string };
      return {
        url: cfg.url ?? null,
        apiKey: cfg.apiKey ?? null,
        inboundSecret: typeof cfg.inboundSecret === 'string' && cfg.inboundSecret ? cfg.inboundSecret : null,
      };
    } catch { return { url: null, apiKey: null, inboundSecret: null }; }
  },

  /** Effective Obligate settings (environment overrides applied). Server-side only. */
  async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null; inboundSecret: string | null }> {
    const s = await this.readObligateStored();
    return { url: s.url, apiKey: s.apiKey, inboundSecret: envInboundSecret() ?? s.inboundSecret };
  },

  async patchObligateConfig(patch: ObligatePatch): Promise<ObligateConfig> {
    const existing = await this.readObligateStored();
    // A NEW URL never inherits the stored API key: the panel would send it, as
    // a Bearer token, to whatever server the URL now names. The key must be
    // entered again with the URL (the inbound secret, which Obligate sends to
    // the panel, is never sent out and is kept).
    if ('url' in patch && patch.url && existing.url && patch.url !== existing.url && existing.apiKey && !patch.apiKey) {
      throw new AppError(400, 'Enter the API key again when changing the Obligate URL', 'obligateApiKeyRequired');
    }
    const merged: ObligateStored = {
      url: 'url' in patch ? (patch.url ?? null) : existing.url,
      apiKey: ('apiKey' in patch && patch.apiKey) ? patch.apiKey : existing.apiKey,
      inboundSecret: 'inboundSecret' in patch
        ? (typeof patch.inboundSecret === 'string' && patch.inboundSecret ? patch.inboundSecret : null)
        : existing.inboundSecret,
    };
    const toStore: Record<string, unknown> = { url: merged.url, apiKey: merged.apiKey };
    if (merged.inboundSecret) toStore.inboundSecret = merged.inboundSecret;
    await this.set(OBLIGATE_CONFIG_KEY, JSON.stringify(toStore));
    if ('enabled' in patch) await this.set('obligate_enabled', patch.enabled ? 'true' : 'false');
    const enabled = (await this.get('obligate_enabled')) === 'true';
    return obligatePublicView(merged, enabled);
  },
};
