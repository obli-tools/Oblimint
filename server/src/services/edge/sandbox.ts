import fs from 'fs';
import path from 'path';
import { CONTAINER_AUX_PREFIX, type ConfDirName } from './edgeTree';

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox of the edge (docs/P4b-PLAN.md §8.3): a candidate configuration tree
// tested IN ISOLATION with
//   docker exec oblimint-edge nginx -t -c /etc/nginx/oblimint/sandbox/<run>/nginx.conf
// The main file reuses the image's own building blocks (images/edge/base/*.conf:
// main-level directives, events, http defaults + default servers, stream
// defaults) and includes ONLY the sandbox's unit directories, so the test sees
// exactly the image configuration + the units under test. Aux files are
// copied under sandbox/<run>/aux/<id>/ and the unit's references to
// /etc/nginx/oblimint/aux/<id>/ are rewritten to that copy. The run directory
// is removed after the test (and stale runs at the start of a pass).
// ─────────────────────────────────────────────────────────────────────────────

/** Directory of the image's building blocks (images/edge/Dockerfile). */
export const EDGE_BASE_DIR = '/etc/nginx/oblimint-base';
export const CONTAINER_SANDBOX_DIR = '/etc/nginx/oblimint/sandbox';

export const SANDBOX_RUN_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SandboxUnit {
  id: string;
  dir: ConfDirName;
  /** Complete file content (header + configuration). */
  content: Buffer;
  aux: Map<string, Buffer> | undefined;
}

/** Main configuration of a sandbox run (container paths). */
export function sandboxMainConfig(run: string): string {
  const base = `${CONTAINER_SANDBOX_DIR}/${run}`;
  return [
    `# Oblimint edge sandbox ${run}: candidate units tested in isolation (nginx -t -c), never served.`,
    `include ${EDGE_BASE_DIR}/main.conf;`,
    'events {',
    `    include ${EDGE_BASE_DIR}/events.conf;`,
    '}',
    'http {',
    `    include ${EDGE_BASE_DIR}/http.conf;`,
    `    include ${base}/global.d/*.conf;`,
    `    include ${base}/conf.d/*.conf;`,
    '}',
    'stream {',
    `    include ${EDGE_BASE_DIR}/stream.conf;`,
    `    include ${base}/stream.d/*.conf;`,
    '}',
    '',
  ].join('\n');
}

/** `nginx -t` argv of a sandbox run. */
export function sandboxTestCommand(run: string): string[] {
  if (!SANDBOX_RUN_RE.test(run)) throw new Error('invalid sandbox run id');
  return ['nginx', '-t', '-c', `${CONTAINER_SANDBOX_DIR}/${run}/nginx.conf`];
}

/** Unit content with its aux references pointing to the sandbox copy. */
export function rewriteAuxPaths(content: Buffer, id: string, run: string): Buffer {
  const from = `${CONTAINER_AUX_PREFIX}${id}/`;
  const s = content.toString('utf8');
  if (!s.includes(from)) return content;
  return Buffer.from(s.split(from).join(`${CONTAINER_SANDBOX_DIR}/${run}/aux/${id}/`), 'utf8');
}

/** Writes the sandbox tree of `run` under `root` (host side). Returns the run directory. */
export function writeSandbox(root: string, run: string, units: SandboxUnit[]): string {
  if (!SANDBOX_RUN_RE.test(run)) throw new Error('invalid sandbox run id');
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const dir = path.join(root, run);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['conf.d', 'global.d', 'stream.d', 'aux']) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'nginx.conf'), sandboxMainConfig(run), { mode: 0o644 });
  for (const u of units) {
    fs.writeFileSync(path.join(dir, u.dir, `${u.id}.conf`), rewriteAuxPaths(u.content, u.id, run), { mode: 0o644 });
    for (const [name, content] of u.aux ?? []) {
      const file = path.join(dir, 'aux', u.id, ...name.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(file, content, { mode: 0o644 });
    }
  }
  return dir;
}

export function removeSandbox(root: string, run: string): void {
  if (!SANDBOX_RUN_RE.test(run)) return;
  fs.rmSync(path.join(root, run), { recursive: true, force: true });
}

/** Removes every leftover run (crash during a previous pass). The root itself (bind mount) is kept. */
export function sweepSandbox(root: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const e of entries) fs.rmSync(path.join(root, e), { recursive: true, force: true });
}

/**
 * Unit named by an `nginx -t` error (`… in /etc/nginx/oblimint/[sandbox/<run>/]<dir>/<id>.conf:<line>`),
 * or null when the error names no unit file.
 */
export function failingUnitOf(error: string): { dir: ConfDirName; id: string } | null {
  const m = /\/etc\/nginx\/oblimint\/(?:sandbox\/[a-z0-9-]+\/)?(conf\.d|global\.d|stream\.d)\/([a-z0-9][a-z0-9-]{0,63})\.conf:\d+/.exec(error);
  return m ? { dir: m[1] as ConfDirName, id: m[2] } : null;
}

/** nginx -t output made readable and bounded: sandbox paths shortened, the trailing "test failed" line dropped. */
export function cleanNginxError(raw: string): string {
  return raw
    .replace(/\/etc\/nginx\/oblimint\/sandbox\/[a-z0-9-]+\//g, '')
    .replace(/\/etc\/nginx\/oblimint\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/test failed$/.test(l) && !/syntax is ok$/.test(l))
    .join('\n')
    .slice(0, 1000) || 'nginx -t failed';
}
