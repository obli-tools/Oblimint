// ─────────────────────────────────────────────────────────────────────────────
// External images a Dockerfile makes the builder pull (docs/P4b-PLAN.md §5.6,
// AP5 — security audit P4b). PURE. A build must not bypass the tenant's
// registry allow-list / deny list, so every image the builder may fetch is
// listed here and checked like a service image:
//   FROM <image> [AS name]           (stage names / scratch excluded)
//   COPY|ADD --from=<image>          (stage names / indexes excluded)
//   RUN --mount=…,from=<image>       (same)
//   # syntax=<image>                 (BuildKit frontend)
// Variables ($X, ${X}, ${X:-d}, ${X:+v}) are substituted from the global ARGs
// declared before the first FROM (overridden by the build args), and inside a
// stage from the ARGs it declares; a reference that cannot be resolved is
// reported (refused by the caller: the builder could resolve it otherwise).
// ─────────────────────────────────────────────────────────────────────────────

export interface DockerfileImages {
  /** External image references, as written after substitution (deduplicated). */
  images: Array<{ ref: string; line: number }>;
  /** References that could not be resolved (unknown variable). */
  unresolved: Array<{ text: string; line: number }>;
}

interface LogicalLine { text: string; line: number }

function logicalLines(text: string): { lines: LogicalLine[]; syntax: { ref: string; line: number } | null } {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  let escape = '\\';
  let syntax: { ref: string; line: number } | null = null;
  // Parser directives: leading `# key=value` comment lines only.
  let i = 0;
  for (; i < raw.length; i++) {
    const m = /^\s*#\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(\S.*?)\s*$/.exec(raw[i]);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (key === 'escape' && (m[2] === '`' || m[2] === '\\')) escape = m[2];
    else if (key === 'syntax') syntax = { ref: m[2], line: i + 1 };
  }
  const lines: LogicalLine[] = [];
  let cur: LogicalLine | null = null;
  for (let j = 0; j < raw.length; j++) {
    const l = raw[j];
    if (/^\s*#/.test(l)) continue; // comments (also inside continuations)
    const trimmed = l.replace(/\s+$/, '');
    const cont = trimmed.endsWith(escape);
    const body = cont ? trimmed.slice(0, -1) : trimmed;
    if (cur) cur.text += ` ${body}`;
    else cur = { text: body, line: j + 1 };
    if (!cont) {
      if (cur.text.trim()) lines.push({ text: cur.text.trim(), line: cur.line });
      cur = null;
    }
  }
  if (cur && cur.text.trim()) lines.push({ text: cur.text.trim(), line: cur.line });
  return { lines, syntax };
}

/** Substitutes variables; null when one is unknown (and has no default). */
function substitute(s: string, vars: ReadonlyMap<string, string>): string | null {
  let failed = false;
  const out = s.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, braced, op, word, bare) => {
    const name = (braced ?? bare) as string;
    const has = vars.has(name);
    const val = vars.get(name) ?? '';
    if (op === ':-') return has && val !== '' ? val : (word ?? '');
    if (op === '-') return has ? val : (word ?? '');
    if (op === ':+') return has && val !== '' ? (word ?? '') : '';
    if (op === '+') return has ? (word ?? '') : '';
    if (!has) { failed = true; return ''; }
    return val;
  });
  return failed || out.includes('$') ? null : out;
}

function parseArg(rest: string, vars: Map<string, string>, buildArgs: Readonly<Record<string, string>>, overridable: boolean): void {
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    const name = eq >= 0 ? tok.slice(0, eq) : tok;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let def: string | null = eq >= 0 ? tok.slice(eq + 1).replace(/^(["'])(.*)\1$/, '$2') : null;
    if (def !== null) def = substitute(def, vars) ?? null;
    if (overridable && Object.prototype.hasOwnProperty.call(buildArgs, name)) vars.set(name, buildArgs[name]);
    else if (def !== null) vars.set(name, def);
  }
}

/** Lists the external images `text` (a Dockerfile) makes the builder pull. */
export function dockerfileImages(text: string, buildArgs: Readonly<Record<string, string>> = {}): DockerfileImages {
  const { lines, syntax } = logicalLines(text);
  const images: DockerfileImages['images'] = [];
  const unresolved: DockerfileImages['unresolved'] = [];
  const seen = new Set<string>();
  const add = (ref: string, line: number) => { if (!seen.has(ref)) { seen.add(ref); images.push({ ref, line }); } };
  if (syntax) add(syntax.ref, syntax.line);

  const globals = new Map<string, string>();
  const stages = new Set<string>();
  let stageIndex = -1;
  let stageVars = new Map<string, string>();
  const isStage = (name: string) => stages.has(name.toLowerCase()) || (/^\d+$/.test(name) && Number(name) <= stageIndex);
  const external = (raw: string, vars: ReadonlyMap<string, string>, line: number) => {
    const v = substitute(raw, vars);
    if (v === null) { unresolved.push({ text: raw.slice(0, 200), line }); return; }
    if (!v || isStage(v) || v.toLowerCase() === 'scratch') return;
    add(v, line);
  };

  for (const { text: l, line } of lines) {
    const m = /^([A-Za-z]+)\s*(.*)$/s.exec(l);
    if (!m) continue;
    const inst = m[1].toUpperCase();
    const rest = m[2];
    if (inst === 'ARG') {
      if (stageIndex < 0) parseArg(rest, globals, buildArgs, true);
      else {
        // In a stage, `ARG X` re-imports the global value; `ARG X=d` defines it (overridable by build args).
        for (const tok of rest.split(/\s+/).filter(Boolean)) {
          const name = tok.split('=')[0];
          if (!tok.includes('=') && globals.has(name)) stageVars.set(name, globals.get(name)!);
        }
        parseArg(rest, stageVars, buildArgs, true);
      }
      continue;
    }
    if (inst === 'FROM') {
      const toks = rest.split(/\s+/).filter(Boolean).filter((t) => !t.startsWith('--'));
      const image = toks[0];
      if (image) external(image, globals, line);
      stageIndex++;
      if (toks.length >= 3 && toks[1].toLowerCase() === 'as') stages.add(toks[2].toLowerCase());
      stageVars = new Map();
      continue;
    }
    if (inst === 'COPY' || inst === 'ADD') {
      for (const f of rest.matchAll(/(?:^|\s)--from=(\S+)/g)) external(f[1], stageVars, line);
      continue;
    }
    if (inst === 'RUN') {
      for (const mnt of rest.matchAll(/(?:^|\s)--mount=(\S+)/g)) {
        for (const kv of mnt[1].split(',')) {
          const [k, v] = kv.split('=');
          if (k === 'from' && v) external(v, stageVars, line);
        }
      }
      continue;
    }
    if (inst === 'ONBUILD') {
      // ONBUILD COPY --from=<image> runs in a child build of this image (same check, conservative).
      for (const f of rest.matchAll(/(?:^|\s)--from=(\S+)/g)) external(f[1], stageVars, line);
    }
  }
  return { images, unresolved };
}
