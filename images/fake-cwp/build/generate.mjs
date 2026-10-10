#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — generator of the synthetic CWP server (TEST ONLY, docs/P5-PLAN.md §16).
//
//   node build/generate.mjs apply [--root /] [--sql-dir /opt/fake-cwp/generated/sql]
//        image build (as root, on Rocky 8): creates the Linux users, writes every
//        file of the plan (owner / group / mode), writes the SQL scripts loaded
//        by build/seed.sh. Real keys / hashes / certificates (openssl, htpasswd,
//        ssh-keygen).
//   node build/generate.mjs summary
//        prints the plan summary (any OS, placeholder secrets).
//
// buildPlan() is pure apart from the crypto provider: check/check-dataset.mjs
// builds the very same plan with placeholderCrypto() and validates it.
// ─────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as dataset from '../dataset/dataset.mjs';
import { placeholderCrypto, realCrypto } from './lib/crypto.mjs';
import { renderDns } from './lib/dns.mjs';
import { postfixDataSql, renderDkim, renderMailConfig, renderMaildirs } from './lib/mail.mjs';
import { Plan } from './lib/plan.mjs';
import { clientDatabasesSql, rootCwpDataSql, rootPasswordSql, systemDatabasesSql, usersSql } from './lib/sql.mjs';
import { renderCertificates, renderCron, renderFtp, renderSystemd, renderUsers } from './lib/system.mjs';
import {
  renderAccountConf, renderAccountExtras, renderCwpConf, renderDocroots, renderHomes, renderPhp, renderTemplates, renderVhosts,
} from './lib/web.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IMAGE_DIR = path.resolve(HERE, '..');
export const ROOTFS_DIR = path.join(IMAGE_DIR, 'rootfs');

/** Modes of the static files of rootfs/ (default 0644 root:root). */
const ROOTFS_MODES = {
  '/etc/ssh/sshd_config': { mode: 0o600 },
  '/usr/local/bin/sync-dns-zones.sh': { mode: 0o755 },
  '/etc/postfix/main.cf': { mode: 0o644 },
  '/etc/pure-ftpd/pure-ftpd.conf': { mode: 0o644 },
};

/** Static files copied verbatim (CR stripped: a Windows checkout must not leak \r into the image). */
export function loadRootfs(plan, dir = ROOTFS_DIR) {
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, entry.name);
      const r = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(a, r);
      else plan.file(r, fs.readFileSync(a, 'utf8').replace(/\r\n/g, '\n'), ROOTFS_MODES[r] ?? {});
    }
  };
  walk(dir, '');
}

export function buildPlan(ds, crypto, { rootfsDir = ROOTFS_DIR } = {}) {
  const plan = new Plan();
  renderUsers(ds, plan);
  loadRootfs(plan, rootfsDir);
  renderHomes(ds, plan, crypto);
  renderDocroots(ds, plan);
  renderAccountExtras(ds, plan);
  const vhostFiles = renderVhosts(ds, plan);
  renderAccountConf(ds, plan);
  renderTemplates(ds, plan);
  renderCwpConf(ds, plan);
  renderPhp(ds, plan);
  const dkimPublic = renderDkim(ds, plan, crypto);
  const zoneFiles = renderDns(ds, plan, crypto, dkimPublic);
  renderMaildirs(ds, plan);
  renderMailConfig(ds, plan);
  renderFtp(ds, plan, crypto);
  renderCron(ds, plan);
  renderCertificates(ds, plan, crypto);
  renderSystemd(ds, plan);

  // root's MySQL client credentials (CWP: /root/.my.cnf) — never readable by the panel (deny list).
  plan.dir('/root', { mode: 0o550 });
  plan.file('/root/.my.cnf', `[client]\nuser=root\npassword=${ds.SERVER.mysql.rootPassword}\n`, { mode: 0o600 });

  plan.sql('10-system-databases', systemDatabasesSql(ds));
  plan.sql('20-users-grants', usersSql(ds, crypto));
  plan.sql('30-client-databases', clientDatabasesSql(ds));
  plan.sql('40-root_cwp-data', rootCwpDataSql(ds));
  plan.sql('50-postfix-data', postfixDataSql(ds, crypto));
  plan.sql('90-root-password', rootPasswordSql(ds));
  return { plan, vhostFiles, zoneFiles };
}

// ── apply (build host only) ──────────────────────────────────────────────────

function readIds(file) {
  const ids = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const f = line.split(':');
    if (f.length >= 3 && f[0]) ids.set(f[0], Number(f[2]));
  }
  return ids;
}

function sh(cmd, args, input) {
  execFileSync(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'], input });
}

function applyUsers(plan) {
  const groups = readIds('/etc/group');
  const users = readIds('/etc/passwd');
  for (const g of plan.groups) {
    if (groups.has(g.name)) {
      if (groups.get(g.name) !== g.gid) throw new Error(`group ${g.name} exists with gid ${groups.get(g.name)} ≠ ${g.gid}`);
      continue;
    }
    if ([...groups.values()].includes(g.gid)) throw new Error(`gid ${g.gid} already taken (wanted by ${g.name})`);
    sh('groupadd', ['-g', String(g.gid), g.name]);
  }
  const passwords = [];
  for (const u of plan.users) {
    if (users.has(u.name)) {
      if (users.get(u.name) !== u.uid) throw new Error(`user ${u.name} exists with uid ${users.get(u.name)} ≠ ${u.uid}`);
    } else {
      if ([...users.values()].includes(u.uid)) throw new Error(`uid ${u.uid} already taken (wanted by ${u.name})`);
      sh('useradd', [...(u.system ? ['-r'] : []), '-M', '-u', String(u.uid), '-g', u.group, '-d', u.home, '-s', u.shell, u.name]);
    }
    if (u.password) passwords.push(`${u.name}:${u.password}`);
  }
  // SHA-512 crypt ($6$, the Rocky 8 default): /etc/shadow like the source — never read by the panel.
  if (passwords.length > 0) sh('chpasswd', ['-c', 'SHA512'], `${passwords.join('\n')}\n`);
}

function applyFiles(plan, root) {
  const users = readIds('/etc/passwd');
  const groups = readIds('/etc/group');
  const uid = (n) => { if (!users.has(n)) throw new Error(`unknown user ${n}`); return users.get(n); };
  const gid = (n) => { if (!groups.has(n)) throw new Error(`unknown group ${n}`); return groups.get(n); };
  const target = (p) => (root === '/' ? p : path.posix.join(root, p));
  const entries = plan.ordered();
  for (const e of entries) {
    const t = target(e.path);
    if (e.type === 'dir') {
      fs.mkdirSync(t, { recursive: true });
    } else if (e.type === 'file') {
      fs.mkdirSync(path.posix.dirname(t), { recursive: true });
      fs.rmSync(t, { force: true });
      fs.writeFileSync(t, e.content);
    } else {
      fs.mkdirSync(path.posix.dirname(t), { recursive: true });
      fs.rmSync(t, { force: true, recursive: false });
      fs.symlinkSync(e.target, t);
    }
  }
  // Ownership / modes once everything exists (deepest first is irrelevant: no traversal by the target users).
  for (const e of entries) {
    const t = target(e.path);
    if (e.type === 'symlink') {
      fs.lchownSync(t, uid(e.owner), gid(e.group));
    } else {
      fs.chownSync(t, uid(e.owner), gid(e.group));
      fs.chmodSync(t, e.mode);
    }
  }
}

function applySql(plan, sqlDir) {
  fs.mkdirSync(sqlDir, { recursive: true, mode: 0o700 });
  for (const s of plan.sqlScripts) fs.writeFileSync(path.join(sqlDir, `${s.name}.sql`), s.sql, { mode: 0o600 });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'apply') {
    if (process.getuid?.() !== 0) throw new Error('apply must run as root (image build)');
    const crypto = realCrypto();
    try {
      const { plan } = buildPlan(dataset, crypto);
      applyUsers(plan);
      applyFiles(plan, arg('--root', '/'));
      applySql(plan, arg('--sql-dir', '/opt/fake-cwp/generated/sql'));
      const counts = { dirs: 0, files: 0, symlinks: 0 };
      for (const e of plan.entries.values()) counts[`${e.type === 'dir' ? 'dirs' : e.type === 'file' ? 'files' : 'symlinks'}`] += 1;
      console.log(`fake-cwp: applied ${counts.dirs} directories, ${counts.files} files, ${counts.symlinks} symlinks, ${plan.users.length} users, ${plan.sqlScripts.length} SQL scripts`);
    } finally {
      crypto.cleanup();
    }
    return;
  }
  if (cmd === 'summary') {
    const { plan } = buildPlan(dataset, placeholderCrypto());
    for (const e of plan.ordered()) {
      const mode = e.mode !== undefined ? e.mode.toString(8).padStart(4, '0') : 'link';
      console.log(`${e.type.padEnd(7)} ${mode} ${`${e.owner}:${e.group}`.padEnd(20)} ${e.path}${e.type === 'symlink' ? ` -> ${e.target}` : ''}`);
    }
    return;
  }
  console.error('usage: node build/generate.mjs apply [--root DIR] [--sql-dir DIR] | summary');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`fake-cwp generate: ${err.stack ?? err}`);
    process.exit(1);
  });
}
