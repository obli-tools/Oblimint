import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { API_GUIDE_LANGS, API_KEY_SCOPES, apiKeyGuide, type ApiGuideLang } from '@oblimint/shared';
import { MCP_INSTRUCTIONS, toolList } from './mcp';

// ─────────────────────────────────────────────────────────────────────────────
// The API / agent guide (shared/src/apiGuide.ts) against the code: every MCP
// tool and every /api/v1 route documented in en and fr, no tool, argument or
// scope cited that does not exist, no French line in the English guide.
// ─────────────────────────────────────────────────────────────────────────────

const PANEL = 'https://panel.example.com';
const guides = API_GUIDE_LANGS.map((lang) => [lang, apiKeyGuide(lang, PANEL)] as const);

const tools = toolList();
const toolNames = new Set(tools.map((t) => t.name));
const scopes = new Set<string>(API_KEY_SCOPES);

/** Every property name of the tools' argument schemas (nested items included). */
const argNames = new Set<string>();
const collectProps = (schema: unknown): void => {
  if (!schema || typeof schema !== 'object') return;
  const s = schema as { properties?: Record<string, unknown>; items?: unknown };
  for (const [k, v] of Object.entries(s.properties ?? {})) { argNames.add(k); collectProps(v); }
  if (s.items) collectProps(s.items);
};
for (const t of tools) collectProps(t.inputSchema);

/**
 * snake_case words of the guide that are neither a tool nor a tool argument:
 * REST query parameters / body fields that only exist on /api/v1, and names of
 * the outside world. Keep it short: a new entry must really not be a tool.
 */
const OTHER_SNAKE = new Set([
  'include_key', // POST /sites/:id/preview: returns the preview's key (REST only)
  'awaiting_approval', // a release status
  'unix_socket', // PDO DSN parameter
  'id_rsa', 'node_modules', 'pg_advisory_lock', // file and folder names, PostgreSQL function
]);

/** Sections "## n." of a guide. */
function section(md: string, n: number): string {
  const start = md.indexOf(`\n## ${n}.`);
  assert.ok(start >= 0, `section ${n} missing`);
  const end = md.indexOf('\n## ', start + 1);
  return md.slice(start, end < 0 ? undefined : end);
}

/** Body rows of the Markdown tables of a section, as cells (escaped \| kept inside a cell). */
function rows(md: string): string[][] {
  return md.split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .map((l) => l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()))
    .filter((cells) => !['Scope', 'Tool', 'Outil', 'Method', 'Méthode'].includes(cells[0]));
}

/** Inline code of a text, line by line (code fences aside: their ``` would shift the pairs). */
const ticks = (s: string) => s.split('\n').filter((l) => !l.trimStart().startsWith('```'))
  .flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]));

test('guide: the scopes table lists exactly API_KEY_SCOPES', () => {
  for (const [lang, md] of guides) {
    const listed = rows(section(md, 3)).filter((r) => r.length === 2).map((r) => ticks(r[0])[0]);
    assert.deepEqual([...listed].sort(), [...scopes].sort(), `${lang}: scopes table`);
  }
});

test('guide: the MCP tools table lists every tool of mcp.ts, and only those', () => {
  for (const [lang, md] of guides) {
    const listed = rows(section(md, 4)).flatMap((r) => ticks(r[0]));
    const set = new Set(listed);
    const missing = [...toolNames].filter((n) => !set.has(n));
    const unknown = [...set].filter((n) => !toolNames.has(n));
    assert.deepEqual(missing, [], `${lang}: MCP tools missing from §4`);
    assert.deepEqual(unknown, [], `${lang}: §4 lists tools that do not exist`);
    assert.equal(listed.length, set.size, `${lang}: a tool listed twice in §4`);
  }
});

test('guide: every scope cited exists', () => {
  const scopeLike = /\b(files|releases|previews|sites|cron|databases|routes|domains|logs|users|keys|mail|ftp)\.[a-z]+\b/g;
  for (const [lang, md] of guides) {
    const cited = new Set(ticks(md).flatMap((t) => [...t.matchAll(scopeLike)].map((m) => m[0])));
    const unknown = [...cited].filter((s) => !scopes.has(s) && !/\.(php|json|js|css|html|sql|zip|gz|log|com|example|tld)$/.test(s));
    assert.deepEqual(unknown, [], `${lang}: scopes cited but not in API_KEY_SCOPES`);
  }
});

test('guide: every snake_case name cited is a tool or a tool argument', () => {
  const snake = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
  for (const [lang, md] of guides) {
    const cited = new Set(ticks(md).flatMap((t) => [...t.matchAll(snake)].map((m) => m[0])));
    const unknown = [...cited].filter((n) => !toolNames.has(n) && !argNames.has(n) && !OTHER_SNAKE.has(n));
    assert.deepEqual(unknown, [], `${lang}: names cited that are neither a tool nor an argument`);
  }
});

test('MCP server instructions: every snake_case name is a tool or a tool argument', () => {
  const words = new Set([...MCP_INSTRUCTIONS.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]));
  const unknown = [...words].filter((n) => !toolNames.has(n) && !argNames.has(n));
  assert.deepEqual(unknown, []);
});

// ── REST: /api/v1 routes of v1.routes.ts against §6 ──

const norm = (p: string) => p.replace(/\?.*$/, '').replace(/:[A-Za-z]+/g, ':p').replace(/\/+$/, '') || '/';

function codeRoutes(): Set<string> {
  const src = readFileSync(path.join(__dirname, '../../routes/v1.routes.ts'), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) out.add(`${m[1].toUpperCase()} ${norm(m[2])}`);
  return out;
}

/** "GET · PATCH" × "`/a` · `…/b` · `/c`" of the guide's REST table, expanded to full routes. */
function guideRoutes(md: string): Set<string> {
  const out = new Set<string>();
  for (const r of rows(section(md, 6))) {
    if (r.length !== 4) continue;
    const methods = r[0].split('·').map((m) => m.trim()).filter((m) => /^[A-Z]+$/.test(m));
    let prev: string | null = null;
    for (const raw of ticks(r[1])) {
      let p = raw.replace(/\?.*$/, '');
      if (p.startsWith('…/') && prev) {
        // "…/tables/:table": the previous route up to where its first segment starts.
        const first = p.slice(2).split('/')[0];
        const at = prev.lastIndexOf(`/${first}`);
        p = (at >= 0 ? prev.slice(0, at) : prev) + p.slice(1);
      } else if (prev && p.split('/').length === 2 && prev.split('/').length > 2) {
        p = prev.replace(/\/[^/]+$/, p); // "/copy" after "/sites/:id/files/move": a sibling
      }
      prev = p;
      for (const m of methods) out.add(`${m} ${norm(p)}`);
    }
  }
  return out;
}

test('guide: every /api/v1 route is documented in §6, and no route documented is missing from the code', () => {
  const code = codeRoutes();
  assert.ok(code.size > 50, 'v1.routes.ts parsed');
  for (const [lang, md] of guides) {
    const doc = guideRoutes(md);
    assert.deepEqual([...code].filter((r) => !doc.has(r)).sort(), [], `${lang}: routes missing from §6`);
    assert.deepEqual([...doc].filter((r) => !code.has(r)).sort(), [], `${lang}: §6 documents routes that do not exist`);
  }
});

// ── languages ──

test('guide: no French line in the English guide, no English line in the French one', () => {
  const french = /\b(une|des|avec|sauf|lecture seule|chaque|pour|d'une|droit sur le code|vues|ou bien)\b/i;
  const english = /\b(the|with|only|every|which|without)\b/i;
  const check = (lang: ApiGuideLang, re: RegExp) => {
    const md = apiKeyGuide(lang, PANEL);
    // Code and identifiers aside: only the prose of each line is read.
    const bad = md.split('\n')
      .filter((l) => !l.startsWith('  ') && !/^(curl|claude) /.test(l))
      .filter((l) => re.test(l.replace(/`[^`]*`/g, ' ').replace(/«[^»]*»/g, ' ')));
    assert.deepEqual(bad, [], `${lang}: lines in the wrong language`);
  };
  check('en', french);
  check('fr', english);
});
