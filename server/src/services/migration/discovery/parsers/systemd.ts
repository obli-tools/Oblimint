// ─────────────────────────────────────────────────────────────────────────────
// systemd unit files (sys.unitFile output: Environment= values already
// redacted ON THE SOURCE). Facts kept for the outside items: Description,
// User, Group, WorkingDirectory, ExecStart (credential-looking arguments
// redacted here too), runtime (node / python / other), ports seen in the
// command line. EnvironmentFile paths are kept (never their content).
// ─────────────────────────────────────────────────────────────────────────────
import { redactCommand } from './redact';

export interface UnitFacts {
  description: string | null;
  user: string | null;
  group: string | null;
  workingDirectory: string | null;
  execStart: string | null;
  environmentFiles: string[];
  runtime: 'node' | 'python' | 'other';
  ports: number[];
  wantedBy: string | null;
}

/** Redacts credential values of an ExecStart (shared command redactor, MG2). */
export function redactArgs(cmd: string): string {
  return redactCommand(cmd);
}

function runtimeOf(exec: string): UnitFacts['runtime'] {
  const toks = exec.split(/\s+/).filter(Boolean);
  for (const t of toks.slice(0, 3)) {
    const b = t.replace(/^[-@:+!]+/, '').split('/').pop() ?? '';
    if (/^(node|nodejs|npm|npx|pm2|pm2-runtime|yarn|pnpm|bun|deno)$/.test(b)) return 'node';
    if (/^(python[0-9.]*|gunicorn|uvicorn|celery|pipenv|poetry)$/.test(b)) return 'python';
    if (b === 'env' || b === 'sudo') continue;
    break;
  }
  if (/\.(m?js|cjs|ts)(\s|$)/.test(exec)) return 'node';
  if (/\.py(\s|$)/.test(exec)) return 'python';
  return 'other';
}

export function parseUnitFile(text: string): UnitFacts {
  const out: UnitFacts = {
    description: null, user: null, group: null, workingDirectory: null, execStart: null, environmentFiles: [], runtime: 'other',
    ports: [], wantedBy: null,
  };
  let section = '';
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  const logical: string[] = [];
  let acc = '';
  for (const r of rows) {
    if (r.endsWith('\\')) { acc += `${r.slice(0, -1)} `; continue; }
    logical.push(acc + r);
    acc = '';
  }
  if (acc) logical.push(acc);
  for (const raw of logical) {
    const l = raw.trim();
    if (l === '' || l.startsWith('#') || l.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(l);
    if (sec) { section = sec[1]; continue; }
    const i = l.indexOf('=');
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim();
    if (section === 'Unit' && k === 'Description') out.description = v;
    else if (section === 'Install' && k === 'WantedBy') out.wantedBy = v;
    else if (section === 'Service') {
      if (k === 'User') out.user = v || null;
      else if (k === 'Group') out.group = v || null;
      else if (k === 'WorkingDirectory') out.workingDirectory = v.replace(/^-/, '') || null;
      else if (k === 'ExecStart' && v && out.execStart === null) out.execStart = redactArgs(v);
      else if (k === 'EnvironmentFile') out.environmentFiles.push(v.replace(/^-/, ''));
    }
  }
  if (out.execStart) {
    out.runtime = runtimeOf(out.execStart);
    const ports = new Set<number>();
    for (const m of out.execStart.matchAll(/(?:--port|-p|--listen|--bind)[=\s]+(?:[0-9.]+:)?(\d{2,5})\b|:(\d{4,5})\b/g)) {
      const p = Number(m[1] ?? m[2]);
      if (p > 0 && p < 65536) ports.add(p);
    }
    out.ports = [...ports];
  }
  return out;
}

/** Varnish vhost / VCL: `backend name { .host = "x"; .port = "y"; }`. */
export function parseVarnishBackends(text: string): Array<{ name: string; host: string; port: number }> {
  const out: Array<{ name: string; host: string; port: number }> = [];
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])(\/\/|#).*$/gm, '$1');
  for (const m of noComments.matchAll(/backend\s+([A-Za-z0-9_]+)\s*\{([^}]*)\}/g)) {
    const host = /\.host\s*=\s*"([^"]+)"/.exec(m[2]);
    const port = /\.port\s*=\s*"?(\d{1,5})"?/.exec(m[2]);
    if (host) out.push({ name: m[1], host: host[1].toLowerCase(), port: port ? Number(port[1]) : 80 });
  }
  return out;
}
