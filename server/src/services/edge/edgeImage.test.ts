import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { EDGE_LOG_VARIABLES } from './nginxConfig';
import { parseNginx } from './nginxParse';
import { RELOAD_COMMAND } from './pipeline';
import { PROBE_SCRIPT } from './probe';
import { EDGE_BASE_DIR, sandboxMainConfig } from './sandbox';

// The panel's contract with images/edge (docs/P4b-PLAN.md §8.3, §8.6, §8.7):
// building blocks shared by the live / fallback / sandbox configurations, the
// scripts it execs, the access-log fields. Real `nginx -t` runs at image build.

const IMAGE = path.resolve(__dirname, '../../../../images/edge');
const read = (rel: string) => fs.readFileSync(path.join(IMAGE, rel), 'utf8');
const directives = (text: string) => text.replace(/#.*$/gm, '').split('\n').map((l) => l.trim()).filter(Boolean);

test('live nginx.conf: main / events directives identical to the base blocks; units included after the defaults', () => {
  const live = read('nginx.conf');
  const main = directives(read('base/main.conf'));
  const liveLines = directives(live);
  for (const l of main) assert.ok(liveLines.includes(l), `${l} missing from nginx.conf`);
  assert.deepEqual(directives(read('base/events.conf')), ['worker_connections 4096;']);
  assert.match(live, /events \{\n {4}worker_connections 4096;\n\}/);
  assert.match(live, /http \{\n {4}include \/etc\/nginx\/oblimint-base\/http\.conf;\n[\s\S]*include \/etc\/nginx\/oblimint\/global\.d\/\*\.conf;\n[\s\S]*include \/etc\/nginx\/oblimint\/conf\.d\/\*\.conf;\n\}/);
  assert.match(live, /stream \{\n {4}include \/etc\/nginx\/oblimint-base\/stream\.conf;\n {4}include \/etc\/nginx\/oblimint\/stream\.d\/\*\.conf;\n\}/);
  for (const f of ['nginx.conf', 'base/main.conf', 'base/events.conf', 'base/http.conf', 'base/stream.conf', 'base/good.conf', 'base/minimal.conf']) {
    assert.deepEqual(parseNginx(read(f)).issues, [], f);
  }
});

test('fallback and sandbox configurations reuse the same base blocks', () => {
  const good = read('base/good.conf');
  for (const d of ['global.d', 'conf.d', 'stream.d']) assert.ok(good.includes(`include /etc/nginx/oblimint/good/${d}/*.conf;`), d);
  assert.doesNotMatch(read('base/minimal.conf'), /oblimint\/(conf|global|stream)\.d/);
  const sandbox = sandboxMainConfig('r1');
  for (const m of sandbox.matchAll(/include (\/etc\/nginx\/oblimint-base\/[a-z]+\.conf);/g)) {
    assert.ok(fs.existsSync(path.join(IMAGE, 'base', path.basename(m[1]))), m[1]);
    assert.ok(good.includes(`include ${m[1]};`), `${m[1]} in good.conf too`);
  }
  assert.equal(EDGE_BASE_DIR, '/etc/nginx/oblimint-base');
  assert.match(read('Dockerfile'), /COPY edge\/base\/ \/etc\/nginx\/oblimint-base\//);
});

test('access log: the P4b fields (§8.7) and every $oblimint_* variable set in each default location', () => {
  const http = read('base/http.conf');
  const fmt = /log_format oblimint_json escape=json '([^']+)';/.exec(http)?.[1] ?? '';
  for (const f of ['"ph":"$oblimint_host"', '"app":"$oblimint_app"', '"hp":"$oblimint_hp"', '"urt":"$upstream_response_time"', '"uct":"$upstream_connect_time"', '"scheme":"$scheme"']) {
    assert.ok(fmt.includes(f), f);
  }
  const parsed = parseNginx(http).statements;
  const locations = parsed.filter((s) => s.directive === 'location');
  assert.ok(locations.length >= 4);
  for (const loc of locations) {
    const inside = parsed.filter((s) => s.line > loc.line && s.depth === loc.depth + 1 && s.parents[s.parents.length - 1] === 'location');
    const block = inside.filter((s) => s.line < (locations.find((l) => l.line > loc.line)?.line ?? Infinity));
    if (block.some((s) => s.directive === 'internal')) continue;
    for (const v of EDGE_LOG_VARIABLES) assert.ok(block.some((s) => s.directive === 'set' && s.args[0] === v), `${v} in location ${loc.args.join(' ')}`);
  }
  // The ban variables come from the g-bans unit only (a duplicate geo would fail nginx -t).
  assert.doesNotMatch(http.replace(/#.*$/gm, ''), /\$oblimint_ban_/);
});

test('scripts: shipped, executable at build, the commands the panel execs', () => {
  const docker = read('Dockerfile');
  for (const s of ['oblimint-edge-entrypoint', 'oblimint-edge-reload', PROBE_SCRIPT]) {
    assert.ok(fs.existsSync(path.join(IMAGE, s)), s);
    assert.ok(docker.includes(s), `${s} in the Dockerfile`);
    assert.ok(read(s).startsWith('#!/bin/sh\n'), s);
  }
  assert.deepEqual(RELOAD_COMMAND, ['oblimint-edge-reload']);
  // Tested first, then signalled, then the new workers awaited (a cycle rejected by the master ⇒ exit 1).
  assert.match(read('oblimint-edge-reload'), /nginx -t -c "\$LIVE"[\s\S]*before=[\s\S]*\nnginx -s reload\n[\s\S]*workers\)[\s\S]*exit 0[\s\S]*exit 1\n$/);
  // The canary probe reports a slow upstream (connection accepted, no response in time) apart from no answer.
  assert.match(read(PROBE_SCRIPT), /"\$rc" -eq 28[\s\S]*echo slow/);
  assert.match(read('oblimint-edge-entrypoint'), /exec nginx -c "\$ACTIVE" -g 'daemon off;'/);
  assert.match(docker, /nginx -V 2>&1 \| grep -q -- '--with-stream'/);
  assert.match(docker, /nginx -t -c \/etc\/nginx\/oblimint-base\/good\.conf/);
});
