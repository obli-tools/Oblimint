import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOSTING_SETTINGS, DEFAULT_PLAN_LIMITS } from '@oblimint/shared';
import { BUILTIN_TEMPLATES } from './catalog/templates';
import { generateValue, renderFieldValues, unsafePattern } from './catalog/render';
import { validateCompose } from './compose/validate';
import { combinePolicy } from './policy.service';

// Every built-in template passes the compose validator (docs/P4b-PLAN.md §5.4) with the DEFAULT platform
// settings and the DEFAULT plan, its fields render (generated secrets), images are pinned by a tag.

const settings = DEFAULT_HOSTING_SETTINGS.apps;
const policy = combinePolicy(settings, { tenantId: 1, allowedRegistries: null, deniedImages: [], allowBuild: null, allowConsole: null, allowExternalProxyTargets: null, updatedAt: null });

const sample: Record<string, string> = {
  NEXTCLOUD_TRUSTED_DOMAINS: 'cloud.example.com', GITEA_DOMAIN: 'git.example.com', DOMAIN: 'https://vault.example.com',
  N8N_HOST: 'n8n.example.com', PUBLIC_URL: 'https://app.example.com', APP_VERSION: '1.4.2',
};

for (const t of BUILTIN_TEMPLATES) {
  test(`builtin template ${t.slug} validates`, () => {
    const given: Record<string, string> = {};
    for (const f of t.fields) if (sample[f.key]) given[f.key] = sample[f.key];
    const rendered = renderFieldValues(t.fields, given);
    for (const f of t.fields.filter((x) => x.secret)) {
      assert.ok(rendered.env.some(([k, v]) => k === f.key && v.length >= 16), `${f.key} generated`);
      assert.equal(rendered.values[f.key], undefined, 'secret values never in clear');
    }
    const out = validateCompose(t.composeYaml, {
      env: new Map(rendered.env), baseDir: 'src', rootDir: 'src', inspector: null,
      policy: { allowedRegistries: policy.allowedRegistries, deniedImages: policy.deniedImages, allowBuild: false, capAddAllowed: policy.capAddAllowed },
      maxServices: settings.maxServicesPerStack, defaults: { memoryMb: settings.defaultServiceMemoryMb, cpus: settings.defaultServiceCpus },
      plan: { cpus: DEFAULT_PLAN_LIMITS.appsCpuCores, memoryMb: DEFAULT_PLAN_LIMITS.appsMemoryMb, containers: DEFAULT_PLAN_LIMITS.maxAppContainers, pidsPerContainer: DEFAULT_PLAN_LIMITS.appsPidsPerContainer },
      node: { memoryMb: 8192, cpus: 4 }, others: { cpus: 0, memoryMb: 0, containers: 0 },
    });
    assert.equal(out.result.ok, true, `${t.slug}: ${JSON.stringify(out.result.issues.filter((i) => i.severity === 'error'))}`);
    for (const s of out.resolved!.services) assert.ok(s.imageRef && !s.imageRef.endsWith(':latest'), `${t.slug}/${s.name} pinned by a tag`);
    for (const f of t.fields) if (f.pattern) assert.equal(unsafePattern(f.pattern), null, `${t.slug}.${f.key} pattern is linear-time`);
    if (t.defaultProxy) {
      const svc = out.resolved!.services.find((s) => s.name === t.defaultProxy!.service);
      assert.ok(svc, 'default proxy service exists');
      assert.ok(svc!.exposedPorts.some((p) => p.port === t.defaultProxy!.port), 'default proxy port exposed');
    }
    // the effective YAML never shows a generated secret
    for (const [k, v] of rendered.env) if (t.fields.find((f) => f.key === k)?.secret) assert.ok(!out.result.effectiveYaml!.includes(v), `${k} masked`);
  });
}

test('the catalog covers the required applications', () => {
  const slugs = BUILTIN_TEMPLATES.map((t) => t.slug);
  for (const s of ['wordpress', 'nextcloud', 'gitea', 'vaultwarden', 'uptime-kuma', 'grafana', 'n8n', 'redis', 'obliview', 'obliguard', 'oblimap', 'obliance', 'oblihub']) assert.ok(slugs.includes(s), s);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(BUILTIN_TEMPLATES.filter((t) => t.category === 'obli').every((t) => !t.enabled), 'Obli apps disabled until their images are verified');
});

test('field rendering: types, patterns, required, kept secrets', () => {
  const t = BUILTIN_TEMPLATES.find((x) => x.slug === 'vaultwarden')!;
  assert.throws(() => renderFieldValues(t.fields, {}), /DOMAIN/);
  assert.throws(() => renderFieldValues(t.fields, { DOMAIN: 'ftp://x' }), /URL/);
  const r = renderFieldValues(t.fields, { DOMAIN: 'https://v.example.com', SIGNUPS_ALLOWED: true });
  assert.equal(r.values.SIGNUPS_ALLOWED, true);
  const token = r.env.find(([k]) => k === 'ADMIN_TOKEN')![1];
  // update: an empty secret keeps the existing value
  const again = renderFieldValues(t.fields, { DOMAIN: 'https://v.example.com', ADMIN_TOKEN: '' }, new Map([['ADMIN_TOKEN', token]]));
  assert.equal(again.env.find(([k]) => k === 'ADMIN_TOKEN')![1], token);
  const n = BUILTIN_TEMPLATES.find((x) => x.slug === 'nextcloud')!;
  assert.throws(() => renderFieldValues(n.fields, { NEXTCLOUD_TRUSTED_DOMAINS: 'x.fr', NEXTCLOUD_ADMIN_USER: 'bad user;' }), /format/);
  assert.equal(generateValue('hex32').length, 64);
  assert.match(generateValue('uuid'), /^[0-9a-f-]{36}$/);
  assert.equal(generateValue('password').length, 24);
});

test('policy combination: tenant can only narrow', () => {
  const p = combinePolicy({ ...settings, allowBuild: true, consoleEnabled: true }, {
    tenantId: 2, allowedRegistries: ['ghcr.io', 'evil.example'], deniedImages: ['*:latest'], allowBuild: false, allowConsole: null, allowExternalProxyTargets: null, updatedAt: null,
  });
  assert.deepEqual(p.allowedRegistries, ['ghcr.io']);
  assert.ok(p.deniedImages.includes('*:latest'));
  assert.equal(p.allowBuild, false);
  assert.equal(p.allowConsole, true);
  assert.equal(p.allowExternalProxyTargets, false);
  const off = combinePolicy({ ...settings, allowBuild: false, consoleEnabled: false }, { tenantId: 2, allowedRegistries: null, deniedImages: [], allowBuild: true, allowConsole: true, allowExternalProxyTargets: true, updatedAt: null });
  assert.equal(off.allowBuild, false, 'a tenant never widens the platform');
  assert.equal(off.allowConsole, false);
  assert.equal(off.allowExternalProxyTargets, true);
});

test('field patterns: catastrophic-backtracking shapes refused, a pattern never runs unchecked', () => {
  for (const bad of ['^(a+)+$', '(a*)*', '(a|aa)+', '(\\w+\\s?)*$', '((ab)+)+', '(x+){2,}', '(a|b)*c', '(\\d+)\\1', '(?<=a)b', 'x'.repeat(300)]) {
    assert.notEqual(unsafePattern(bad), null, bad);
  }
  for (const ok of ['^[a-z0-9_.@-]{1,64}$', '^v?[0-9]+(\\.[0-9]+)?$', '^(?:https?)://[^ ]+$', '^[A-Z]{2}-\\d{4}$', '^(foo|bar)$', '[(+*)]+']) {
    assert.equal(unsafePattern(ok), null, ok);
  }
  const evil = { key: 'X', label: 'X', type: 'string', required: true, pattern: '^(a+)+$', labelKey: null, description: null, default: null, options: null, generate: null, secret: false } as const;
  const started = Date.now();
  assert.throws(() => renderFieldValues([{ ...evil }], { X: `${'a'.repeat(2000)}!` }), /not usable/);
  assert.ok(Date.now() - started < 1000, 'the unsafe pattern is never executed');
  // a polynomial blow-up the structural check lets through is cut by the time budget
  const poly = { ...evil, pattern: '^a*a*a*a*a*a*b$' };
  assert.equal(unsafePattern(poly.pattern), null);
  const t0 = Date.now();
  assert.throws(() => renderFieldValues([poly], { X: 'a'.repeat(2000) }), /too slow/);
  assert.ok(Date.now() - t0 < 2000, 'bounded');
  assert.equal(renderFieldValues([{ ...poly }], { X: 'aab' }).env[0][1], 'aab');
});
