// =============================================================================
// Access control of the .htaccess files on the litespeed bases (OpenLiteSpeed
// reads only their rewrite rules). Twin of images/siteconf/htaccess.go, which
// ENFORCES it at every render of a container (closed by default); this copy
// only REPORTS it in the panel (site page, staging before a publication,
// publication log). Same parsing, same verdicts:
//   - reproduced (action 'deny'): Require all denied, Deny from all, Order … +
//     Deny from all, and the same inside <Files x> / <FilesMatch re> → 403;
//   - closed (action 'closed'): what OpenLiteSpeed cannot reproduce — Auth* /
//     Require valid-user, Allow from <ip>, Require ip / host / env / expr,
//     <Limit>, <If>, <RequireAny>…, an unclosed section → the folder (or the
//     files of the section) answers 403, never served publicly.
// The files a <Files> section re-allows inside a refused folder (plugin
// assets) are served by the image and not listed here.
// =============================================================================

export type HtaccessAccessAction = 'deny' | 'closed';

export interface HtaccessFilePattern {
  kind: 'name' | 'glob' | 'regex';
  pattern: string;
}

export interface HtaccessAccessRule {
  /** Folder of the .htaccess, relative to the release root ('' = root). */
  dir: string;
  /** null: the whole folder and below; else the files of a <Files> / <FilesMatch> section. */
  files: HtaccessFilePattern | null;
  action: HtaccessAccessAction;
  /** The deciding directive ("Deny from all", "AuthType Basic"…). */
  directive: string;
}

/** GET /api/sites/:id/runtime/htaccess-access */
export interface HtaccessAccessReport {
  /** The site (or one of its runtimes) runs a litespeed base: the rules are enforced. */
  applies: boolean;
  releaseNumber: number | null;
  rules: HtaccessAccessRule[];
  /** The walk stopped at its bound. */
  truncated: boolean;
}

const AUTH_RE = /^(auth[a-z]*|anonymous[a-z_]*)$/i;
const OPEN_RE = /^<\s*([A-Za-z]+)\s*(.*?)\s*>$/;
const CLOSE_RE = /^<\s*\/\s*([A-Za-z]+)\s*>$/;
const COMPLEX = new Set(['limit', 'limitexcept', 'if', 'elseif', 'else', 'requireall', 'requireany', 'requirenone',
  'directory', 'directorymatch', 'location', 'locationmatch']);

interface Scope {
  files: HtaccessFilePattern | null;
  isFiles: boolean;
  requires: string[][];
  allows: string[];
  denies: string[];
  order: string;
  auth: string;
  complex: string;
  other: string;
}

const newScope = (isFiles = false, files: HtaccessFilePattern | null = null): Scope => ({
  files, isFiles, requires: [], allows: [], denies: [], order: '', auth: '', complex: '', other: '',
});

const has = (s: Scope) => s.requires.length > 0 || s.allows.length > 0 || s.denies.length > 0 || !!s.order || !!s.auth || !!s.complex || !!s.other;

function verdict(s: Scope): [HtaccessAccessAction | null, string] {
  if (s.auth) return ['closed', s.auth];
  if (s.complex) return ['closed', s.complex];
  if (s.other) return ['closed', s.other];
  let deny = '';
  for (const r of s.requires) {
    const arg = r.join(' ').toLowerCase();
    if (arg === 'all denied') deny = 'Require all denied';
    else if (arg !== 'all granted') return ['closed', `Require ${r.join(' ')}`];
  }
  let allowAll = false;
  let denyAll = false;
  for (const h of s.allows) {
    if (h.toLowerCase() !== 'all') return ['closed', `Allow from ${h}`];
    allowAll = true;
  }
  for (const h of s.denies) {
    if (h.toLowerCase() !== 'all') return ['closed', `Deny from ${h}`];
    denyAll = true;
  }
  if (s.allows.length || s.denies.length || s.order) {
    const order = s.order.toLowerCase().replace(/ /g, '');
    let refused: boolean;
    if (order === '' || order === 'deny,allow') refused = denyAll && !allowAll;
    else if (order === 'allow,deny') refused = !allowAll || denyAll;
    else return ['closed', `Order ${s.order}`];
    if (refused && !deny) deny = denyAll ? 'Deny from all' : `Order ${s.order}`;
  }
  return deny ? ['deny', deny] : [null, ''];
}

/** Words separated by blanks, double quotes grouping. */
export function htaccessArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  let started = false;
  for (const c of s) {
    if (c === '"') { inQ = !inQ; started = true; continue; }
    if (!inQ && (c === ' ' || c === '\t')) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

function filesPattern(name: string, args: string): HtaccessFilePattern | null {
  const a = htaccessArgs(args);
  if (name.toLowerCase() === 'filesmatch') return a.length === 1 ? { kind: 'regex', pattern: a[0] } : null;
  if (a.length === 2 && a[0] === '~') return { kind: 'regex', pattern: a[1] };
  if (a.length !== 1 || !a[0]) return null;
  return /[*?[]/.test(a[0]) ? { kind: 'glob', pattern: a[0] } : { kind: 'name', pattern: a[0] };
}

/** The refusals of one .htaccess (dir left '': the caller sets it). */
export function parseHtaccessAccess(content: string): HtaccessAccessRule[] {
  const dir = newScope();
  const scopes: Scope[] = [dir];
  const stack: Array<{ name: string; files: Scope | null }> = [];
  const current = (): Scope => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].files) return stack[i].files!;
    return dir;
  };
  const inComplex = (): string => {
    for (let i = stack.length - 1; i >= 0; i--) if (COMPLEX.has(stack[i].name)) return `<${stack[i].name}>`;
    return '';
  };
  let pending = '';
  for (const rawLine of content.split('\n')) {
    const raw = rawLine.replace(/\r$/, '');
    if (raw.endsWith('\\')) { pending += `${raw.slice(0, -1)} `; continue; }
    const l = (pending + raw).trim();
    pending = '';
    if (!l || l.startsWith('#')) continue;
    const close = CLOSE_RE.exec(l);
    if (close) {
      const name = close[1].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }
    const open = OPEN_RE.exec(l);
    if (open) {
      const name = open[1].toLowerCase();
      let files: Scope | null = null;
      if (name === 'files' || name === 'filesmatch') {
        const p = filesPattern(name, open[2]);
        files = newScope(true, p);
        if (!p) files.other = `<${open[1]} ${open[2]}>`;
        scopes.push(files);
      }
      stack.push({ name, files });
      continue;
    }
    const words = htaccessArgs(l);
    if (!words.length) continue;
    const d = words[0].toLowerCase();
    const args = words.slice(1);
    const s = current();
    const isAccess = d === 'require' || d === 'allow' || d === 'deny' || d === 'order' || d === 'satisfy' || AUTH_RE.test(d);
    if (!isAccess) continue;
    const c = inComplex();
    if (c) {
      const grantsAll = (d === 'require' && args.join(' ').toLowerCase() === 'all granted') || (d === 'allow' && args.length === 2 && args[1].toLowerCase() === 'all');
      if (!grantsAll && !s.complex) s.complex = `${c} ${words[0]} ${args.join(' ')}`;
      continue;
    }
    if (AUTH_RE.test(d)) {
      if (!s.auth) s.auth = `${words[0]} ${args.join(' ')}`.trim();
    } else if (d === 'require') {
      const low = args.join(' ').toLowerCase();
      if (low.startsWith('valid-user') || low.startsWith('user ') || low.startsWith('group ')) {
        if (!s.auth) s.auth = `Require ${args.join(' ')}`;
      } else {
        s.requires.push(args);
      }
    } else if (d === 'allow' || d === 'deny') {
      if (args.length < 2 || args[0].toLowerCase() !== 'from') {
        if (!s.other) s.other = `${words[0]} ${args.join(' ')}`;
        continue;
      }
      if (d === 'allow') s.allows.push(...args.slice(1)); else s.denies.push(...args.slice(1));
    } else if (d === 'order') {
      s.order = args.join('');
    } else if (d === 'satisfy') {
      if (args.join('').toLowerCase() !== 'all' && !s.other) s.other = `Satisfy ${args.join(' ')}`;
    }
  }
  if (stack.some((f) => f.files || COMPLEX.has(f.name))) {
    const f = stack.find((x) => x.files || COMPLEX.has(x.name))!;
    return [{ dir: '', files: null, action: 'closed', directive: `<${f.name}> non fermé` }];
  }
  const out: HtaccessAccessRule[] = [];
  for (const s of scopes) {
    if (!has(s)) continue;
    const [action, directive] = verdict(s);
    if (!action) continue;
    out.push({ dir: '', files: s.isFiles ? s.files : null, action, directive });
  }
  return out;
}
