import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiKeyPresetState, ApiKeyScope } from '@oblimint/shared';
import {
  API_KEY_PRESETS, API_KEY_SCOPES, apiKeyFormCutToGrantable, apiKeyPreset, apiKeyPresetMatches, apiKeyPresetNeedsParents, apiKeyPresetScopes, matchApiKeyPreset,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Presets of the key form (shared/src/apiKeys.ts API_KEY_PRESETS): no preset
// gives more than its name says, they are cut down to the grantable scopes,
// and the form / the audit find the preset a key matches.
// ─────────────────────────────────────────────────────────────────────────────

const ALL = [...API_KEY_SCOPES];
const scopesOf = (id: Parameters<typeof apiKeyPreset>[0]) => apiKeyPresetScopes(apiKeyPreset(id), ALL);
const lacks = (id: Parameters<typeof apiKeyPreset>[0], ...out: ApiKeyScope[]) => {
  const s = scopesOf(id);
  for (const o of out) assert.ok(!s.includes(o), `${id} must not hold ${o}`);
};
const state = (p: Partial<ApiKeyPresetState>): ApiKeyPresetState => ({
  scopes: [], siteScope: 'selected', siteCount: 1, domainScope: 'selected', domainCount: 0, ...p,
});

test('the presets are well-formed', () => {
  assert.deepEqual(API_KEY_PRESETS.map((p) => p.id), ['readonly', 'update', 'site', 'multisite', 'autonomous', 'all']);
  for (const p of API_KEY_PRESETS) {
    if (p.scopes !== 'all') for (const s of p.scopes) assert.ok(ALL.includes(s), `${p.id}: unknown scope ${s}`);
    assert.ok(p.siteScopes.length > 0);
    assert.ok(p.maxSites === null || p.maxSites >= p.minSites, `${p.id}: maxSites < minSites`);
  }
});

test('read only writes nothing', () => {
  assert.deepEqual(scopesOf('readonly'), ['files.read', 'logs.read']);
  lacks('readonly', 'files.write', 'releases.publish', 'previews.manage', 'sites.manage', 'sites.create', 'cron.manage', 'databases.manage', 'routes.manage', 'domains.subdomain');
  assert.equal(apiKeyPreset('readonly').domains, 'none');
});

test('updates only: files, previews and publication, no setting, cron, database, route or subdomain', () => {
  assert.deepEqual(scopesOf('update'), ['files.read', 'files.write', 'releases.publish', 'previews.manage']);
  lacks('update', 'sites.manage', 'sites.create', 'cron.manage', 'databases.manage', 'routes.manage', 'domains.subdomain', 'logs.read');
  const p = apiKeyPreset('update');
  assert.deepEqual(p.siteScopes, ['selected'], 'chosen sites only');
  assert.equal(p.minSites, 1);
  assert.equal(p.domains, 'none');
});

test('managing one / several sites: no site creation, no subdomain, no domain by default', () => {
  for (const id of ['site', 'multisite'] as const) {
    lacks(id, 'sites.create', 'domains.subdomain');
    for (const s of ['files.read', 'files.write', 'releases.publish', 'previews.manage', 'sites.manage', 'logs.read', 'databases.manage', 'routes.manage', 'cron.manage'] as const) {
      assert.ok(scopesOf(id).includes(s), `${id} manages ${s}`);
    }
  }
  const one = apiKeyPreset('site');
  assert.deepEqual([one.siteScopes, one.minSites, one.maxSites, one.domains], [['selected'], 1, 1, 'none'], 'exactly one site, no domain');
  const many = apiKeyPreset('multisite');
  assert.equal(many.minSites, 2);
  assert.equal(many.domains, 'optional', 'domains only when the user gives some');
});

test('autonomous creation: only its own sites, no route, no cron', () => {
  const s = scopesOf('autonomous');
  assert.ok(s.includes('sites.create') && s.includes('domains.subdomain'));
  // The domains it is given (parents of its subdomains) are also domains it
  // routes (keyApi manageableDomain): with routes.manage it would add a path
  // of example.com towards its own site, over the existing site example.com
  // serves. Its subdomains are attached to its site on creation.
  lacks('autonomous', 'routes.manage', 'cron.manage');
  const p = apiKeyPreset('autonomous');
  assert.deepEqual([p.siteScopes, p.minSites, p.maxSites], [['selected'], 0, 0], 'no existing site: the ones it creates');
  assert.equal(p.domains, 'pick');
});

test('previews.manage always comes with files.read (a preview without it is useless)', () => {
  for (const p of API_KEY_PRESETS) {
    const s = apiKeyPresetScopes(p, ALL);
    if (s.includes('previews.manage')) assert.ok(s.includes('files.read'), `${p.id}: previews.manage without files.read`);
  }
  for (const id of ['update', 'site', 'multisite', 'autonomous'] as const) assert.ok(scopesOf(id).includes('previews.manage'), id);
});

test('no preset asking for domains routes them', () => {
  for (const p of API_KEY_PRESETS) {
    if (p.domains === 'pick') lacks(p.id, 'routes.manage');
  }
});

test('everything is every grantable scope, never more', () => {
  assert.deepEqual(scopesOf('all'), ALL);
  const held: ApiKeyScope[] = ['files.read', 'logs.read', 'sites.manage'];
  assert.deepEqual(apiKeyPresetScopes(apiKeyPreset('all'), held), ['files.read', 'sites.manage', 'logs.read']);
  for (const p of API_KEY_PRESETS) {
    for (const s of apiKeyPresetScopes(p, held)) assert.ok(held.includes(s), `${p.id} keeps ${s} out of reach`);
  }
  assert.deepEqual(apiKeyPresetScopes(apiKeyPreset('update'), ['logs.read']), [], 'nothing held, nothing given');
});

test('a form state matches its preset; any change makes it custom', () => {
  const site = scopesOf('site');
  assert.equal(matchApiKeyPreset(state({ scopes: ['files.read', 'logs.read'], siteScope: 'all' }), ALL, true), 'readonly');
  assert.equal(matchApiKeyPreset(state({ scopes: scopesOf('update'), siteCount: 3 }), ALL, true), 'update');
  assert.equal(matchApiKeyPreset(state({ scopes: scopesOf('update'), siteScope: 'all' }), ALL, true), null, 'updates only: chosen sites');
  assert.equal(matchApiKeyPreset(state({ scopes: site, siteCount: 1 }), ALL, true), 'site');
  assert.equal(matchApiKeyPreset(state({ scopes: site, siteCount: 2 }), ALL, true), 'multisite');
  assert.equal(matchApiKeyPreset(state({ scopes: site, siteScope: 'all', domainScope: 'all' }), ALL, true), 'multisite');
  assert.equal(matchApiKeyPreset(state({ scopes: site, siteCount: 1, domainCount: 1 }), ALL, true), null, 'one site with a domain given');
  assert.equal(matchApiKeyPreset(state({ scopes: scopesOf('autonomous'), siteCount: 0, domainCount: 2 }), ALL, true), 'autonomous');
  assert.equal(matchApiKeyPreset(state({ scopes: scopesOf('autonomous'), siteCount: 1 }), ALL, true), null, 'autonomous: no existing site');
  assert.equal(matchApiKeyPreset(state({ scopes: ALL, siteScope: 'all', domainScope: 'all' }), ALL, true), 'all');
  assert.equal(matchApiKeyPreset(state({ scopes: ALL, siteScope: 'all' }), ALL, true), null, 'everything gives every domain when the user may');
  assert.equal(matchApiKeyPreset(state({ scopes: ALL, siteScope: 'all' }), ALL, false), 'all', 'and none when he may not');
  assert.equal(matchApiKeyPreset(state({ scopes: [...scopesOf('update'), 'logs.read'] }), ALL, true), null, 'an extra right: custom');
  // Cut down to what the user holds: the preset still matches.
  const held: ApiKeyScope[] = ['files.read', 'files.write', 'logs.read'];
  assert.equal(matchApiKeyPreset(state({ scopes: ['files.read', 'files.write'] }), held, false), 'update');
  // Chosen preset not yet complete (no site picked): still shown, not matched from scratch.
  assert.ok(apiKeyPresetMatches(apiKeyPreset('site'), state({ scopes: site, siteCount: 0 }), ALL, true));
  assert.equal(matchApiKeyPreset(state({ scopes: site, siteCount: 0 }), ALL, true), null);
});

test('autonomous creation without a parent domain: the form asks for one', () => {
  const p = apiKeyPreset('autonomous');
  const fresh = state({ scopes: scopesOf('autonomous'), siteCount: 0 });
  assert.equal(apiKeyPresetNeedsParents(p, fresh, ALL, true), true);
  assert.equal(apiKeyPresetNeedsParents(p, { ...fresh, domainCount: 1 }, ALL, true), false, 'a parent chosen');
  assert.equal(apiKeyPresetNeedsParents(p, { ...fresh, domainScope: 'all' }, ALL, true), false, 'every domain');
  assert.equal(apiKeyPresetNeedsParents(p, fresh, ALL, false), false, 'the user may not give domains: nothing to choose');
  const noSub = ALL.filter((x) => x !== 'domains.subdomain');
  assert.equal(apiKeyPresetNeedsParents(p, state({ scopes: apiKeyPresetScopes(p, noSub), siteCount: 0 }), noSub, true), false, 'subdomain right not held');
  for (const id of ['readonly', 'update', 'site', 'multisite', 'all'] as const) {
    assert.equal(apiKeyPresetNeedsParents(apiKeyPreset(id), state({ scopes: scopesOf(id) }), ALL, true), false, id);
  }
});

test('a new key touched before the grantable rights are known is cut down to them', () => {
  const form = { scopes: scopesOf('update'), domainScope: 'all' as const, domainIds: [3], name: 'ci' };
  const cut = apiKeyFormCutToGrantable(form, { scopes: ['files.read', 'files.write', 'logs.read'], canGrantDomains: true });
  assert.deepEqual(cut, { ...form, scopes: ['files.read', 'files.write'] }, 'releases.publish not held: dropped, the rest kept');
  const noDom = apiKeyFormCutToGrantable({ ...form, domainScope: 'selected' as const }, { scopes: ALL, canGrantDomains: false });
  assert.deepEqual([noDom.scopes, noDom.domainScope, noDom.domainIds], [form.scopes, 'selected', []], 'no domain when he may not give any');
  assert.deepEqual(apiKeyFormCutToGrantable(form, { scopes: ALL, canGrantDomains: false }).domainScope, 'selected');
});
