// ─────────────────────────────────────────────────────────────────────────────
// /etc/named.conf as returned by dns.namedConf (secrets redacted on the
// source). Statements `zone "x" [IN] { type master; file "…"; allow-update
// { … }; | update-policy { … } | local; };`, top level or inside `view`;
// comments // # /* */; multi-line. Relative zone files resolve against
// `options { directory "…"; }` (default /var/named).
// ─────────────────────────────────────────────────────────────────────────────

export interface NamedZone {
  name: string;
  type: string | null;
  /** Absolute path (null when no `file`). */
  file: string | null;
  /** allow-update not { none; } or update-policy present. */
  dynamic: boolean;
  view: string | null;
}

interface Stmt {
  words: string[];
  block: Stmt[] | null;
}

type Tok = { t: 'w'; v: string } | { t: '{' | '}' | ';' };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if ((c === '/' && text[i + 1] === '/') || c === '#') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '{' || c === '}' || c === ';') { out.push({ t: c }); i += 1; continue; }
    if (c === '"') {
      let v = '';
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { v += text[i + 1]; i += 2; continue; }
        v += text[i];
        i += 1;
      }
      i += 1;
      out.push({ t: 'w', v });
      continue;
    }
    let v = '';
    while (i < n && !/[\s{};"]/.test(text[i])) {
      if ((text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) || text[i] === '#') break;
      v += text[i];
      i += 1;
    }
    if (v) out.push({ t: 'w', v });
    else i += 1;
  }
  return out;
}

function parse(toks: Tok[]): Stmt[] {
  let pos = 0;
  const block = (depth: number): Stmt[] => {
    const out: Stmt[] = [];
    let words: string[] = [];
    let pending: Stmt | null = null;
    while (pos < toks.length) {
      const t = toks[pos];
      pos += 1;
      if (t.t === 'w') {
        if (pending) { out.push(pending); pending = null; }
        words.push(t.v);
      } else if (t.t === '{') {
        pending = { words, block: depth > 32 ? [] : block(depth + 1) };
        words = [];
      } else if (t.t === ';') {
        if (pending) { out.push(pending); pending = null; }
        else if (words.length > 0) out.push({ words, block: null });
        words = [];
      } else {
        if (pending) { out.push(pending); pending = null; }
        if (words.length > 0) out.push({ words, block: null });
        if (depth > 0) return out;
        words = [];
      }
    }
    if (pending) out.push(pending);
    if (words.length > 0) out.push({ words, block: null });
    return out;
  };
  return block(0);
}

export function parseNamedConf(text: string): NamedZone[] {
  const tree = parse(tokenize(text));
  let directory = '/var/named';
  const options = tree.find((s) => s.words[0] === 'options' && s.block);
  const dir = options?.block?.find((s) => s.words[0] === 'directory' && s.words[1]);
  if (dir && dir.words[1].startsWith('/')) directory = dir.words[1].replace(/\/+$/, '');

  const zones: NamedZone[] = [];
  const visit = (stmts: Stmt[], view: string | null) => {
    for (const s of stmts) {
      if (s.words[0] === 'view' && s.block) { visit(s.block, s.words[1] ?? null); continue; }
      if (s.words[0] !== 'zone' || !s.block || !s.words[1]) continue;
      const name = s.words[1].toLowerCase().replace(/\.$/, '');
      if (name === '' || name === '.') continue;
      let type: string | null = null;
      let file: string | null = null;
      let dynamic = false;
      for (const d of s.block) {
        const k = d.words[0];
        if (k === 'type') type = d.words[1] ?? null;
        else if (k === 'file' && d.words[1]) file = d.words[1].startsWith('/') ? d.words[1] : `${directory}/${d.words[1]}`;
        else if (k === 'allow-update') {
          const inner = (d.block ?? []).map((x) => x.words.join(' ').trim()).filter(Boolean);
          if (inner.length > 0 && !(inner.length === 1 && inner[0] === 'none')) dynamic = true;
        } else if (k === 'update-policy') dynamic = true;
      }
      zones.push({ name, type, file, dynamic, view });
    }
  };
  visit(tree, null);
  return zones;
}
