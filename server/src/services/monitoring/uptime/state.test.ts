import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicStatusPage } from '@oblimint/shared';
import { cssProblem, lastDays, MAX_CSS_BYTES, nextState, overallStatus, projectStatusPage, type MonitorState } from './state';

test('transitions: retries consecutive failures before down, down notified once, recovery notified from down only', () => {
  let s: MonitorState = { status: 'pending', consecutiveFailures: 0 };
  let t = nextState(s, true, 2);
  assert.deepEqual(t, { status: 'up', consecutiveFailures: 0, event: null }, 'pending → up: no event');
  s = t;
  t = nextState(s, false, 2);
  assert.deepEqual(t, { status: 'up', consecutiveFailures: 1, event: null }, 'first failure: still up');
  s = t;
  t = nextState(s, false, 2);
  assert.deepEqual(t, { status: 'down', consecutiveFailures: 2, event: 'down' });
  s = t;
  t = nextState(s, false, 2);
  assert.deepEqual(t, { status: 'down', consecutiveFailures: 3, event: null }, 'dedup: no second down');
  s = t;
  t = nextState(s, true, 2);
  assert.deepEqual(t, { status: 'up', consecutiveFailures: 0, event: 'up' });
  // retries 0 behaves as 1: the first failure is down.
  assert.equal(nextState({ status: 'up', consecutiveFailures: 0 }, false, 0).event, 'down');
  // A new monitor failing goes down (notified).
  assert.equal(nextState({ status: 'pending', consecutiveFailures: 0 }, false, 1).event, 'down');
  // A failure flapping under the threshold never notifies.
  s = { status: 'up', consecutiveFailures: 0 };
  for (let i = 0; i < 10; i++) {
    const a = nextState(s, false, 3);
    const b = nextState(a, true, 3);
    assert.equal(a.event, null);
    assert.equal(b.event, null);
    s = b;
  }
});

test('status page CSS: refused constructs, size cap', () => {
  assert.equal(cssProblem('body { color: #E03A3A; } .card { border-radius: 8px }'), null);
  for (const bad of [
    '@import "https://evil";',
    'a{background:url(https://evil/x.png)}',
    'a{background: URL ( "x" )}',
    'a{width:expression(alert(1))}',
    'a{background:u/**/rl(x)}',
    '</style><script>alert(1)</script>',
    'a{background:\\75 rl(x)}',
    'a{behavior: url(x.htc)}',
    'a{-moz-binding: x}',
    '@font-face{font-family:x}',
    'a{b:c} /* unterminated',
    'a{background-image:image-set("x" 1x)}',
  ]) assert.ok(cssProblem(bad), `refused: ${bad}`);
  assert.ok(cssProblem('a{}'.repeat(MAX_CSS_BYTES)));
});

test('public projection: whitelisted fields only, 90 days of history, overall status', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const days = lastDays(now, 90);
  assert.equal(days.length, 90);
  assert.equal(days[89], '2026-10-10');
  assert.equal(days[0], '2026-07-13');
  const page = projectStatusPage(
    { slug: 'acme', title: 'Acme', description: null, customCss: null },
    [
      // Extra fields an implementation could leak: they must not reach the output.
      { name: 'Site', status: 'up', enabled: true, uptime24h: 1, uptime30d: 0.999, lastLatencyMs: 42, daily: new Map([['2026-10-10', 1], ['2026-10-09', 0.5]]),
        ...({ url: 'https://10.0.0.5/secret', host: 'db.internal', lastError: 'ECONNREFUSED 10.0.0.5', id: 12, accountId: 3 } as object) },
      { name: 'Paused', status: 'down', enabled: false, uptime24h: null, uptime30d: null, lastLatencyMs: null, daily: new Map() },
    ] as never,
    now,
  );
  const json = JSON.stringify(page);
  for (const leak of ['10.0.0.5', 'db.internal', 'ECONNREFUSED', 'secret', '"id"', 'accountId', '"url"', '"host"']) assert.ok(!json.includes(leak), `no ${leak}`);
  const keys: Array<keyof PublicStatusPage> = ['slug', 'title', 'description', 'customCss', 'generatedAt', 'overall', 'monitors'];
  assert.deepEqual(Object.keys(page).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(page.monitors[0]).sort(), ['history', 'latencyMs', 'name', 'status', 'uptime24h', 'uptime30d']);
  assert.equal(page.monitors[0].history.length, 90);
  assert.deepEqual(page.monitors[0].history.slice(-2), [{ day: '2026-10-09', uptime: 0.5 }, { day: '2026-10-10', uptime: 1 }]);
  assert.equal(page.monitors[0].history[0].uptime, null);
  assert.equal(page.monitors[1].status, 'paused', 'disabled monitor shown paused');
  assert.equal(page.overall, 'up', 'paused ones do not count');

  assert.equal(overallStatus([]), 'unknown');
  assert.equal(overallStatus(['pending', 'paused']), 'unknown');
  assert.equal(overallStatus(['up', 'down']), 'degraded');
  assert.equal(overallStatus(['down', 'down', 'pending']), 'down');
});
