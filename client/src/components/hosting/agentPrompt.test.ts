import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKeyPreset, agentKeySites, agentStarterPrompt } from './agentPrompt';

// Fallback translator: interpolates {{var}} in the default value.
const t = (_key: string, o: Record<string, unknown> & { defaultValue: string }) =>
  o.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(o[k] ?? ''));

test('agent key preset and sites', () => {
  assert.equal(agentKeyPreset(0), 'autonomous');
  assert.equal(agentKeyPreset(1), 'site');
  assert.equal(agentKeyPreset(3), 'site');
  assert.deepEqual(agentKeySites([]), []);
  assert.deepEqual(agentKeySites([{ id: 7, name: 'shop' }]), [7]);
  assert.deepEqual(agentKeySites([{ id: 7, name: 'a' }, { id: 8, name: 'b' }]), []);
});

test('starter prompt without a site asks to create one', () => {
  const p = agentStarterPrompt(t, 'acme', []);
  assert.match(p, /hosting account "acme"/);
  assert.match(p, /get_guide/);
  assert.match(p, /create_site/);
  assert.match(p, /Never publish before I have approved the preview/);
  assert.doesNotMatch(p, /Sites you may work on/);
});

test('starter prompt with sites names them (5 at most)', () => {
  const sites = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `s${i + 1}`, primaryDomain: i === 0 ? 'www.example.com' : null }));
  const p = agentStarterPrompt(t, 'acme', sites);
  assert.match(p, /Sites you may work on: s1 \(www\.example\.com\), s2, s3, s4, s5\./);
  assert.doesNotMatch(p, /s6/);
  assert.doesNotMatch(p, /create_site/);
  assert.equal(p.split('\n\n').length, 4);
});
