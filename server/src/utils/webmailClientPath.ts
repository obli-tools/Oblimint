import path from 'path';

/**
 * Files of the Oblimint webmail's own client entry (webmail.html and its
 * assets/webmail-* bundle): served by the webmail listener on the webmail
 * host only (services/mail/webmail/oblimint), never by the panel, where the
 * page would run on the panel's origin. Checked on the path as the static
 * server resolves it: decoded, normalized, any case, trailing dots / spaces
 * dropped.
 */
export function isWebmailClientPath(reqPath: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(reqPath);
  } catch {
    return true; // malformed: served by nobody anyway
  }
  p = path.posix.normalize(p.replace(/\\/g, '/')).toLowerCase().replace(/[.\s]+$/, '');
  return /^\/+(webmail\.html|assets\/webmail-[^/]*)$/.test(p);
}
