import { CUSTOM_PAGE_CODES } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PURE custom pages (docs/P4b-PLAN.md §8.8, OBLIHUB-PARITY §1.8): the HTML of a
// page is written as a static aux file per code; its placeholders are replaced
// at render time with HTML-ESCAPED values (a tenant value never becomes markup
// of another page). Built-in waking page when none is chosen.
// ─────────────────────────────────────────────────────────────────────────────

export const CUSTOM_PAGE_MAX_BYTES = 256 * 1024;

export const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`=/]/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface PagePlaceholders {
  code: number;
  appName: string;
  proxyHostId: number | null;
  host: string | null;
  wakeEtaSec: number | null;
}

/** Replaces {{CODE}} {{MESSAGE}} {{APP_NAME}} {{PROXY_HOST_ID}} {{HOST}} {{WAKE_ETA_SEC}} (escaped). */
export function renderPagePlaceholders(html: string, p: PagePlaceholders): string {
  const values: Record<string, string> = {
    '{{CODE}}': escapeHtml(p.code),
    '{{MESSAGE}}': escapeHtml(STATUS_MESSAGES[p.code] ?? 'Error'),
    '{{APP_NAME}}': escapeHtml(p.appName),
    '{{PROXY_HOST_ID}}': escapeHtml(p.proxyHostId ?? ''),
    '{{HOST}}': escapeHtml(p.host ?? ''),
    '{{WAKE_ETA_SEC}}': escapeHtml(p.wakeEtaSec ?? 15),
  };
  return String(html ?? '').replace(/\{\{(CODE|MESSAGE|APP_NAME|PROXY_HOST_ID|HOST|WAKE_ETA_SEC)\}\}/g, (m) => values[m] ?? m);
}

export function isCustomPageCode(c: unknown): c is (typeof CUSTOM_PAGE_CODES)[number] {
  return (CUSTOM_PAGE_CODES as readonly unknown[]).includes(c);
}

/** Built-in waking page: reloads every 3 s while the app starts. */
export const BUILTIN_WAKING_PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<meta name="robots" content="noindex">
<title>Démarrage en cours…</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e6e6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{text-align:center;max-width:28rem;padding:2rem}
  .spin{width:2.5rem;height:2.5rem;margin:0 auto 1.25rem;border:3px solid #333;border-top-color:#E03A3A;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  p{color:#9aa0a6;font-size:.9rem}
</style>
</head>
<body>
<div class="card">
  <div class="spin"></div>
  <h1>L'application démarre…</h1>
  <p>{{HOST}} sort de veille. Cette page se recharge automatiquement (environ {{WAKE_ETA_SEC}} s).</p>
</div>
</body>
</html>
`;
