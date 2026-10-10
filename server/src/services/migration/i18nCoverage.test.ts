import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { CODES_FR, OUTSIDE_FR, SCOPES_FR, STEP_SKIPPED_FR } from './execution/reportFr';

// ─────────────────────────────────────────────────────────────────────────────
// Static coverage of the P5 server codes by the client catalogue
// (docs/P5-PLAN.md §8.4: « un module qui ajoute un code le signale »). Scans
// the non-test sources of services/migration (+ the migration routes,
// importedSiteCert, dkimImport) for:
//   - warning / follow-up codes (warn(…), warning(…), followUp(…) calls,
//     `code: '…'` object literals, also thrown errors) → migration.codes.*, .outside.* (or .errors.*);
//   - step skip reasons (skipped({ reason: '…' })) → migration.codes.stepSkipped.*;
//   - AppError codes → migration.errors.*;
// in en AND fr. Also checks that execution/reportFr.ts (Markdown report) still
// mirrors fr/migration.json. Regex based: a new emission shape must be added
// here.
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_SRC = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(SERVER_SRC, '..', '..');
const SEVERITIES = new Set(['blocking', 'warning', 'info', 'error', 'debug']);
// Codes carried as `code:` that are not catalogue entries (internal errors thrown inside steps: the step error text is shown).
const NOT_CATALOGUE = new Set(['mailDomainExists', 'addressTaken', 'zoneExists', 'cutoverItemAuto', 'cutoverNoteRequired']);

type Dict = Record<string, unknown>;

function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (f !== 'fixtures') walk(p); continue; }
      if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !/testLock|fixtures/.test(f)) out.push(p);
    }
  };
  walk(path.join(SERVER_SRC, 'services', 'migration'));
  for (const r of fs.readdirSync(path.join(SERVER_SRC, 'routes'))) if (/^migration/.test(r)) out.push(path.join(SERVER_SRC, 'routes', r));
  out.push(path.join(SERVER_SRC, 'services', 'edge', 'importedSiteCert.ts'), path.join(SERVER_SRC, 'services', 'mail', 'dns', 'dkimImport.ts'));
  return out;
}

function scan() {
  const warnings = new Map<string, string>();
  const literals = new Map<string, string>();
  const skips = new Map<string, string>();
  const errors = new Map<string, string>();
  for (const f of sources()) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SERVER_SRC, f);
    for (const m of s.matchAll(/(function\s+)?\b(?:[\w.]+\.)?(?:warn|warning|followUp)\(\s*((?:[^()]|\([^()]*\))*)\)/g)) {
      if (m[1]) continue; // declaration
      const lits = [...m[2].matchAll(/^\s*'([A-Za-z][A-Za-z0-9]*)'|,\s*'([A-Za-z][A-Za-z0-9]*)'/g)].slice(0, 3).map((x) => x[1] ?? x[2]);
      const code = lits.find((l) => !SEVERITIES.has(l) && /^[a-z][a-zA-Z0-9]+$/.test(l));
      if (code) warnings.set(code, rel);
    }
    for (const m of s.matchAll(/\bcode:\s*'([a-z][A-Za-z0-9]+)'/g)) if (!NOT_CATALOGUE.has(m[1])) literals.set(m[1], rel);
    for (const m of s.matchAll(/\bskipped\(\s*\{[^}]*\breason:\s*'([a-z][A-Za-z0-9]+)'/g)) skips.set(m[1], rel);
    for (const m of s.matchAll(/new AppError\(\s*\d+\s*,\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[^,]+)\s*,\s*'([A-Za-z]+)'/g)) errors.set(m[1], rel);
  }
  return { warnings, literals, skips, errors };
}

function catalogue(lng: string): Dict {
  const file = path.join(REPO, 'client', 'src', 'i18n', 'locales', lng, 'migration.json');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { migration: Dict }).migration;
}

test('every code emitted by the P5 server has an en + fr text (codes / outside / stepSkipped / errors)', () => {
  const { warnings, literals, skips, errors } = scan();
  assert.ok(warnings.size > 80, `scanner found only ${warnings.size} warning codes: emission shapes changed?`);
  assert.ok(errors.size > 10, `scanner found only ${errors.size} error codes`);
  const missing: string[] = [];
  for (const lng of ['en', 'fr']) {
    const c = catalogue(lng);
    const codes = c.codes as Dict; const outside = c.outside as Dict; const errs = c.errors as Dict;
    const stepSkipped = codes.stepSkipped as Dict;
    for (const [code, where] of warnings) if (codes[code] === undefined && outside[code] === undefined) missing.push(`${lng} codes.${code} (${where})`);
    // `code:` literals are warnings / follow-ups or thrown error codes.
    for (const [code, where] of literals) if (codes[code] === undefined && outside[code] === undefined && errs[code] === undefined) missing.push(`${lng} codes|errors.${code} (${where})`);
    for (const [r, where] of skips) if (stepSkipped[r] === undefined) missing.push(`${lng} codes.stepSkipped.${r} (${where})`);
    for (const [e, where] of errors) if (errs[e] === undefined) missing.push(`${lng} errors.${e} (${where})`);
  }
  assert.deepEqual(missing, []);
});

test('execution/reportFr.ts mirrors fr/migration.json (regenerate it when a code is added)', () => {
  const fr = catalogue('fr');
  const strings = (o: unknown) => Object.fromEntries(Object.entries(o as Dict).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  assert.deepEqual({ ...CODES_FR }, strings(fr.codes));
  assert.deepEqual({ ...STEP_SKIPPED_FR }, strings((fr.codes as Dict).stepSkipped));
  assert.deepEqual({ ...OUTSIDE_FR }, strings(fr.outside));
  assert.deepEqual({ ...SCOPES_FR }, strings(fr.scopes));
});
