import type { Config, DOMPurify } from 'dompurify';

// ─────────────────────────────────────────────────────────────────────────────
// Rendering policy of a message's HTML body — PURE apart from the DOMPurify
// instance it is given (browser: DOMPurify bound to window; tests: bound to a
// jsdom window). Two independent layers:
//
//  1. sanitizeEmailHtml (DOMPurify, pinned version): HTML profile only (no
//     SVG / MathML), no script / frame / object / form / meta / link / base,
//     no event handler, URLs limited to https / http / mailto (links) and
//     cid / data:image (images); CSS neutralized (expression, behavior,
//     -moz-binding, javascript:, @import), remote images and CSS url()
//     removed unless the reader asked for them; cid: images replaced by the
//     data: URLs the caller fetched through the proxy; every link opens in a
//     new tab with rel="noopener noreferrer".
//  2. buildSrcDoc + IFRAME_SANDBOX: rendered in an iframe WITHOUT
//     allow-scripts / allow-same-origin / allow-forms / top navigation, with a
//     strict <meta> CSP (no script, no remote image until "show images", no
//     form, no base) and no referrer.
// Either layer alone blocks script execution; both are applied.
// ─────────────────────────────────────────────────────────────────────────────

/** iframe sandbox: links may open a new tab (escaping the sandbox for the target site); nothing else. */
export const IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

const FORBID_TAGS = [
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'portal',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'output', 'keygen', 'fieldset',
  'meta', 'link', 'base', 'title', 'head', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas', 'dialog', 'slot',
];
const FORBID_ATTR = ['action', 'formaction', 'srcdoc', 'ping', 'autofocus', 'http-equiv', 'srcset', 'xlink:href', 'is', 'popover', 'contenteditable'];

/**
 * URL-bearing attributes: web, mail, cid and inline raster data; the last two
 * branches (as in DOMPurify's default) accept values that are not a scheme at
 * all ("100%", relative paths) — the hooks below then drop relative links and
 * non-image sources.
 */
const URI_RE = /^(?:(?:https?|mailto|cid):|data:image\/(?:png|jpe?g|gif|webp);base64,|#|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;
const REMOTE_RE = /^\s*(?:https?:)?\/\//i;
const IMAGE_DATA_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

export interface RenderOptions {
  /** Show remote images / CSS backgrounds (the reader's choice). */
  allowRemote: boolean;
  /** cid (without "cid:", lower case) → data:image URL fetched through the proxy. */
  cidMap?: Record<string, string>;
}

export interface SanitizeResult {
  html: string;
  /** Remote resources removed (shows the "show images" bar when > 0). */
  blockedRemote: number;
}

/** CSS text with every dangerous construct removed; remote url() dropped unless allowed. */
export function sanitizeCss(css: string, allowRemote: boolean, onBlocked: () => void = () => undefined): string {
  let out = String(css ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '') // CSS escapes are how filters get bypassed (e\xpression, u\rl): none needed in a mail
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/behavior\s*:/gi, 'x:')
    .replace(/-moz-binding\s*:/gi, 'x:')
    .replace(/javascript\s*:/gi, 'x:')
    .replace(/vbscript\s*:/gi, 'x:');
  out = out.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q: string, url: string) => {
    const u = url.trim();
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(u)) return m;
    if (/^https:\/\//i.test(u) && allowRemote) return `url('${u.replace(/["'\s()]/g, '')}')`;
    if (REMOTE_RE.test(u) || /^http:/i.test(u)) onBlocked();
    return 'none';
  });
  return out;
}

/** Sanitizes a message's HTML body for the sandboxed iframe. */
export function sanitizeEmailHtml(purifyFactory: () => DOMPurify, html: string, opts: RenderOptions): SanitizeResult {
  const purify = purifyFactory();
  let blocked = 0;
  const cids = opts.cidMap ?? {};

  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      node.textContent = sanitizeCss(node.textContent, opts.allowRemote, () => { blocked++; });
    }
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    if (el.hasAttribute('style')) {
      const css = sanitizeCss(el.getAttribute('style') ?? '', opts.allowRemote, () => { blocked++; });
      if (css.trim()) el.setAttribute('style', css); else el.removeAttribute('style');
    }
    if (el.hasAttribute('background')) {
      const bg = el.getAttribute('background') ?? '';
      if (!(opts.allowRemote && /^https:\/\//i.test(bg)) && !IMAGE_DATA_RE.test(bg)) {
        if (REMOTE_RE.test(bg) || /^http:/i.test(bg)) blocked++;
        el.removeAttribute('background');
      }
    }
    const tag = el.tagName?.toLowerCase();
    if (tag === 'a' || tag === 'area') {
      const href = el.getAttribute('href') ?? '';
      if (href && !/^(?:https?:|mailto:|#)/i.test(href.trim())) el.removeAttribute('href');
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'img') {
      const src = (el.getAttribute('src') ?? '').trim();
      if (/^cid:/i.test(src)) {
        const key = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, '').toLowerCase();
        const url = cids[key];
        if (url && IMAGE_DATA_RE.test(url)) el.setAttribute('src', url); else el.removeAttribute('src');
      } else if (REMOTE_RE.test(src) || /^http:/i.test(src)) {
        if (!(opts.allowRemote && /^https:\/\//i.test(src))) {
          blocked++;
          el.removeAttribute('src');
        }
      } else if (src && !IMAGE_DATA_RE.test(src)) {
        el.removeAttribute('src');
      }
    }
    // Anything that is not an image cannot load a URL.
    for (const attr of ['src', 'poster', 'data', 'codebase', 'longdesc', 'usemap', 'dynsrc', 'lowsrc']) {
      if (attr === 'src' && tag === 'img') continue;
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
    }
  });

  const config: Config = {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR: ['target'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: URI_RE,
    WHOLE_DOCUMENT: false,
    // A leading <style> would otherwise be parsed into <head> and lost.
    FORCE_BODY: true,
    KEEP_CONTENT: true,
    SANITIZE_DOM: true,
    RETURN_TRUSTED_TYPE: false,
  };
  const out = purify.sanitize(String(html ?? ''), config) as unknown as string;
  purify.removeAllHooks();
  return { html: out, blockedRemote: blocked };
}

/** CSP of the message document (in addition to the inherited host policy). */
export function iframeCsp(allowRemote: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${allowRemote ? ' https:' : ''}`,
    'font-src data:',
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
  ].join('; ');
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Complete document for <iframe srcdoc> (the body must come from sanitizeEmailHtml). */
export function buildSrcDoc(sanitizedBody: string, opts: { allowRemote: boolean }): string {
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(iframeCsp(opts.allowRemote))}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<base target="_blank">'
    + '<style>html{color-scheme:light}body{margin:0;padding:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
    + 'color:#1f2328;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}'
    + 'blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:3px solid #d0d7de;color:#57606a}</style>'
    + `</head><body>${sanitizedBody}</body></html>`;
}
