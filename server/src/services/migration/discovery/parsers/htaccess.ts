import { phpVersionOfHandler } from './cwpConf';

// ─────────────────────────────────────────────────────────────────────────────
// fs.grepHtaccess output (`grep -HinE` on the .htaccess files of a docroot):
// `<path>:<line>:<content>`. A line `AddHandler application/x-httpd-php56 .php`
// (or SetHandler / AddType) forces the suPHP handler → version through the
// suphp.conf map (CWP-MAP §6). The last PHP line of a file wins (Apache
// applies directives in order). Root .htaccess = the site version; sub-dir
// ones = htaccessOverrides (path relative to the docroot).
// ─────────────────────────────────────────────────────────────────────────────

export interface HtaccessPhpLine {
  file: string;
  line: number;
  handler: string;
  version: string | null;
}

const LINE = /^(.*?\/\.htaccess):(\d+):(.*)$/;
const HANDLER = /^\s*(AddHandler|SetHandler|AddType)\s+(?:"|')?((?:application\/)?x-httpd-[A-Za-z0-9._-]*php[A-Za-z0-9._-]*)(?:"|')?/i;

export function parseHtaccessGrep(text: string, suphp: Map<string, string>, defaultVersion: string | null): HtaccessPhpLine[] {
  const out: HtaccessPhpLine[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = LINE.exec(l);
    if (!m) continue;
    const content = m[3];
    if (/^\s*#/.test(content)) continue;
    const h = HANDLER.exec(content);
    if (!h) continue;
    out.push({ file: m[1], line: Number(m[2]), handler: h[2].toLowerCase(), version: phpVersionOfHandler(h[2], suphp, defaultVersion) });
  }
  return out;
}

export interface HtaccessPhpSummary {
  /** Version forced by <docroot>/.htaccess (null = none). */
  root: string | null;
  /** Sub-directories (relative to the docroot) forcing a version. */
  overrides: Array<{ path: string; version: string }>;
}

/** Summary for one docroot from the grep lines (files outside the docroot are ignored). */
export function summarizeHtaccess(lines: HtaccessPhpLine[], docroot: string): HtaccessPhpSummary {
  const base = docroot.replace(/\/+$/, '');
  const lastPerFile = new Map<string, HtaccessPhpLine>();
  for (const l of lines) {
    const prev = lastPerFile.get(l.file);
    if (!prev || l.line >= prev.line) lastPerFile.set(l.file, l);
  }
  let root: string | null = null;
  const overrides: Array<{ path: string; version: string }> = [];
  for (const [file, l] of lastPerFile) {
    if (!l.version) continue;
    if (file === `${base}/.htaccess`) { root = l.version; continue; }
    if (!file.startsWith(`${base}/`)) continue;
    const rel = file.slice(base.length + 1, -'/.htaccess'.length);
    if (rel) overrides.push({ path: rel, version: l.version });
  }
  overrides.sort((a, b) => a.path.localeCompare(b.path));
  return { root, overrides };
}
