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
//     -moz-binding, javascript:, @import, src() / image()), remote images,
//     CSS url() and image-set() / -webkit-image-set() (which take a bare
//     string URL) removed unless the reader asked for them, position:fixed /
//     sticky made static (no overlay over the message); cid: images replaced
//     by the data: URLs the caller fetched through the proxy; every link
//     opens in a new tab with rel="noopener noreferrer".
//     mode 'compose' (quoted reply / forward, pasted and outgoing HTML):
//     stricter — no <style> element, no url() / image-set() other than
//     inline raster data, no fixed / absolute / sticky positioning.
//  2. buildSrcDoc + IFRAME_SANDBOX: rendered in an iframe WITHOUT
//     allow-scripts / allow-same-origin / allow-forms / top navigation, with a
//     strict <meta> CSP (no script, no remote image until "show images", no
//     form, no base) and no referrer.
// Either layer alone blocks script execution; both are applied.
// The rich editor (components/RichEditor.tsx) is ALSO a sandboxed iframe
// (no script, own CSP without any remote load: composerCsp), so quoted HTML
// can never style, overlay or read the webmail document itself.
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
  /** 'display' (default): a message in the reading view; 'compose': the rich editor and outgoing HTML (stricter CSS, no <style>). */
  mode?: 'display' | 'compose';
  /** cid (without "cid:", lower case) → data:image URL fetched through the proxy. */
  cidMap?: Record<string, string>;
}

export interface SanitizeResult {
  html: string;
  /** Remote resources removed (shows the "show images" bar when > 0). */
  blockedRemote: number;
}

/**
 * Replaces every call of the CSS functions matched by `start` (a global
 * regex ending with the opening parenthesis; its group 1 is the character
 * before the name, kept — no lookbehind, unsupported before Safari 16.4) WHOLE — arguments included, up
 * to the matching parenthesis, quotes respected; an unterminated call runs to
 * the end of the text.
 */
function replaceCssCalls(css: string, start: RegExp, replace: (call: string) => string): string {
  let out = '';
  let from = 0;
  start.lastIndex = 0;
  for (let m = start.exec(css); m; m = start.exec(css)) {
    const at = m.index + (m[1] ?? '').length;
    let i = m.index + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    for (; i < css.length && depth > 0; i++) {
      const c = css[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out += css.slice(from, at) + replace(css.slice(at, i));
    from = i;
    start.lastIndex = i;
  }
  return out + css.slice(from);
}

/** CSS text with every dangerous construct removed; remote url() / image-set() dropped unless allowed (never in compose mode). */
export function sanitizeCss(css: string, allowRemote: boolean, onBlocked: () => void = () => undefined, mode: 'display' | 'compose' = 'display'): string {
  const compose = mode === 'compose';
  const remoteOk = allowRemote && !compose;
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
  // src("…") and image("…") take a bare URL string: never needed in a mail.
  out = replaceCssCalls(out, /(^|[^a-z0-9_-])(?:src|image)\s*\(/gi, () => 'none');
  // image-set("https://…" 1x) loads a bare string URL (no url()): remote content like url().
  out = replaceCssCalls(out, /(^|[^a-z0-9_])(?:-webkit-)?image-set\s*\(/gi, (call) => {
    if (remoteOk) return call;
    onBlocked();
    return 'none';
  });
  out = out.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q: string, url: string) => {
    const u = url.trim();
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(u)) return m;
    if (/^https:\/\//i.test(u) && remoteOk) return `url('${u.replace(/["'\s()]/g, '')}')`;
    if (REMOTE_RE.test(u) || /^http:/i.test(u)) onBlocked();
    return 'none';
  });
  // No overlay over the reading pane (fixed / sticky), nor anything taken out
  // of the flow in the editor: only the listed values survive (a var() or a
  // prefixed value never does).
  const positions = compose ? /^(?:static|relative)$/ : /^(?:static|relative|absolute)$/;
  out = out.replace(/(^|[^a-z0-9_-])position\s*:\s*([^;}"'<]*)/gi, (m, pre: string, v: string) => {
    const value = v.replace(/!\s*important/i, '').trim().toLowerCase();
    return positions.test(value) ? m : `${pre}position:static${/!\s*important/i.test(v) ? ' !important' : ''}`;
  });
  return out;
}

/** Sanitizes a message's HTML body for the sandboxed iframe. */
export function sanitizeEmailHtml(purifyFactory: () => DOMPurify, html: string, opts: RenderOptions): SanitizeResult {
  const purify = purifyFactory();
  let blocked = 0;
  const cids = opts.cidMap ?? {};
  const mode = opts.mode ?? 'display';

  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      node.textContent = sanitizeCss(node.textContent, opts.allowRemote, () => { blocked++; }, mode);
    }
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    if (el.hasAttribute('style')) {
      const css = sanitizeCss(el.getAttribute('style') ?? '', opts.allowRemote, () => { blocked++; }, mode);
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
    // Compose: no <style> at all (a quoted newsletter keeps its inline styles only).
    FORBID_TAGS: mode === 'compose' ? [...FORBID_TAGS, 'style'] : FORBID_TAGS,
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

/**
 * CSP of the rich editor's document (sandboxed iframe, same origin, no
 * script): inline styles only, images from data: / blob: only — nothing
 * remote is ever loaded while writing (a quoted message's trackers, a CSS
 * exfiltration attempt), whatever survived the sanitizer.
 */
export function composerCsp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "font-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
  ].join('; ');
}

/** iframe sandbox of the rich editor: same origin (the composer drives it), never scripts / forms / popups / navigation. */
export const COMPOSER_SANDBOX = 'allow-same-origin';

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

/**
 * Empty document of the rich editor (its content is set by the composer,
 * sanitized in compose mode). Colors: the app theme's variables, copied onto
 * its root by the composer (fallbacks: a light page).
 */
export function buildComposerDoc(placeholder: string): string {
  const v = (name: string, fallback: string) => `rgb(var(${name}, ${fallback}))`;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(composerCsp())}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<style>html,body{height:100%}body{margin:0;padding:8px 12px;box-sizing:border-box;'
    + 'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;'
    + `color:${v('--c-text-primary', '31 35 40')};background:${v('--c-bg-secondary', '255 255 255')};overflow-wrap:anywhere;outline:none}`
    + `a{color:${v('--c-accent', '35 133 106')};text-decoration:underline}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}`
    + 'ul{list-style:disc;padding-left:1.5em}ol{list-style:decimal;padding-left:1.5em}'
    + `blockquote{margin:0 0 0 .5em;padding-left:.75em;border-left:3px solid ${v('--c-border-light', '208 215 222')};color:${v('--c-text-secondary', '87 96 106')}}`
    + `body:empty::before{content:attr(data-placeholder);color:${v('--c-text-muted', '129 141 161')};pointer-events:none}</style>`
    + `</head><body contenteditable="true" spellcheck="true" data-placeholder="${escapeAttr(placeholder)}"></body></html>`;
}
