import DOMPurify from 'dompurify';
import { sanitizeEmailHtml, type RenderOptions, type SanitizeResult } from './htmlPolicy';

// Browser binding of the rendering policy (htmlPolicy.ts): a fresh DOMPurify
// instance per call (hooks are per instance).

const factory = () => DOMPurify(window);

export function sanitizeForDisplay(html: string, opts: RenderOptions): SanitizeResult {
  return sanitizeEmailHtml(factory, html, opts);
}

/**
 * HTML entering the rich editor (quoted reply / forward, pasted, dropped) and
 * leaving it (the message sent): compose mode — no <style>, no remote CSS,
 * no fixed / absolute positioning. Remote <img> are kept for the recipient
 * (the editor's own CSP never loads them).
 */
export function sanitizeOutgoing(html: string): string {
  return sanitizeEmailHtml(factory, html, { allowRemote: true, mode: 'compose' }).html;
}

/** Text of an HTML body, from an INERT document (DOMParser: no script runs, nothing loads). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeEmailHtml(factory, html, { allowRemote: false }).html, 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote').forEach((b) => b.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
