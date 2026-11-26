import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_EXEC_STDIN_MAX, DEFAULT_RESTRICTIONS, PENDING_ACTION_USER_MESSAGE_FR, RESTRICTABLE_ACTIONS, restrictableAction } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { gatedTools, handleRpc, mcpErrorText, MCP_INSTRUCTIONS, toolList } from './mcp';

// ─────────────────────────────────────────────────────────────────────────────
// MCP and the protected actions (spec §9 mcp.test.ts), without a database:
// a 428 of the gate reads as a tool error carrying its code and details,
// approval_id is advertised on the gated tools only, every key surface of the
// catalogue is reachable through a gated tool, malformed approval_id refused.
// ─────────────────────────────────────────────────────────────────────────────

test('a 428 of the gate is a tool error with its code and its details', () => {
  const details = {
    pendingActionId: 123, status: 'pending', level: 'sensitive', action: 'db.drop', description: 'Supprimer la base de données « wp_prod »',
    expiresAt: '2026-10-30T12:00:00.000Z', approveUrl: 'https://panel.example.com/approvals/123', userMessage: PENDING_ACTION_USER_MESSAGE_FR,
    next: 'call wait_for_pending_action(123), then call the same tool again with the same arguments (or approval_id=123)',
  };
  const text = mcpErrorText(new AppError(428, 'This action needs a human confirmation in the panel', 'twoFactorRequired', details));
  assert.match(text, /^This action needs a human confirmation in the panel \(twoFactorRequired\)\ndetails: /);
  const parsed = JSON.parse(text.slice(text.indexOf('details: ') + 9));
  assert.deepEqual(parsed, details);
  assert.ok(parsed.userMessage.includes('Autoriser l\'action avec un 2FA téléphone ou un code via l\'interface'));
  for (const code of ['approvalRequired', 'twoFactorNotEnrolled', 'noEligibleApprover', 'approvalMismatch']) {
    assert.match(mcpErrorText(new AppError(code === 'twoFactorNotEnrolled' ? 403 : 409, 'refused', code, { action: 'db.drop' })), new RegExp(`\\(${code}\\)\\ndetails: \\{"action":"db.drop"\\}`));
  }
});

test('approval_id is in the inputSchema of the gated tools, and only theirs', () => {
  const gated = new Set(gatedTools().map((t) => t.name));
  assert.ok(gated.size >= 25, 'the gated tools are declared');
  for (const t of toolList()) {
    const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    assert.equal(props.includes('approval_id'), gated.has(t.name), `${t.name}: approval_id iff gated`);
    if (gated.has(t.name)) assert.equal((t.inputSchema as { additionalProperties?: boolean }).additionalProperties, false, `${t.name}: still strict`);
  }
  for (const n of ['get_pending_action', 'wait_for_pending_action', 'list_pending_actions', 'cancel_pending_action']) {
    assert.ok(toolList().some((t) => t.name === n), `${n} exists`);
    assert.ok(!gated.has(n), `${n} is never gated`);
  }
});

test('every key surface of the catalogue is reachable through a gated tool (REST-only db.dump aside)', () => {
  const declared = new Set(gatedTools().flatMap((t) => [...t.actions]));
  for (const a of declared) {
    const def = restrictableAction(a);
    assert.ok(def, `${a} is a catalogue action`);
    assert.ok(def!.surfaces.includes('keys'), `${a} is declared on the key surfaces`);
  }
  const keysActions = RESTRICTABLE_ACTIONS.filter((a) => a.surfaces.includes('keys')).map((a) => a.key);
  assert.deepEqual(keysActions.filter((k) => !declared.has(k)), ['db.dump'], 'only the dump has no MCP tool');
});

test('DNS tools: read-only listings, a gated upsert, a destructive gated delete, the platform records said read-only', () => {
  const byName = new Map(toolList().map((t) => [t.name, t]));
  const gated = new Map(gatedTools().map((t) => [t.name, t.actions]));
  for (const n of ['list_dns_zones', 'list_dns_records']) {
    assert.equal(byName.get(n)?.annotations.readOnlyHint, true, n);
    assert.ok(!gated.has(n), n);
  }
  const upsert = byName.get('upsert_dns_record');
  assert.ok(upsert);
  assert.deepEqual(gated.get('upsert_dns_record'), ['dns.record_write']);
  assert.equal(upsert.annotations.destructiveHint, false);
  assert.match(upsert.description, /NEVER repoint a name served by an Oblimint site/);
  assert.match(upsert.description, /read-only \(dnsRecordProtected\)/);
  const types = ((upsert.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.type.enum ?? []);
  assert.ok(!types.includes('NS'), 'NS is not a key type');
  const del = byName.get('delete_dns_record');
  assert.equal(del?.annotations.destructiveHint, true);
  assert.deepEqual(gated.get('delete_dns_record'), ['dns.record_delete']);
  assert.match(MCP_INSTRUCTIONS, /never repoint a name served by a site/);
  assert.equal(restrictableAction('dns.record_delete')?.surfaces.includes('keys'), true);
});

test('DNS tools: arguments checked before anything runs', async () => {
  const call = async (name: string, args: Record<string, unknown>) => (await handleRpc({} as never, {} as never, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  let r = await call('delete_dns_record', { zone: 'example.com' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /record_id, or name and type, is required/);
  r = await call('upsert_dns_record', { zone: 'example.com', name: 'sub', type: 'NS', content: 'ns1.example.net' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid arguments: type/);
});

test('the server instructions tell the agent what to do on a 428', () => {
  assert.ok(MCP_INSTRUCTIONS.includes(PENDING_ACTION_USER_MESSAGE_FR));
  assert.match(MCP_INSTRUCTIONS, /wait_for_pending_action/);
  assert.match(MCP_INSTRUCTIONS, /SAME arguments/);
  assert.match(MCP_INSTRUCTIONS, /never confirm nor approve/);
});

test('a malformed approval_id is refused before the tool runs', async () => {
  const ctx = {} as never;
  const req = {} as never;
  for (const bad of ['x', 0, -3, 1.5, true]) {
    const r = await handleRpc(ctx, req, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_database', arguments: { instance_id: 1, database_id: 2, confirm_name: 'x', approval_id: bad } } }) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Invalid arguments: approval_id/);
  }
});

test('mailbox tools: a read-only listing, an ungated creation, a gated password, a destructive gated deletion', async () => {
  const byName = new Map(toolList().map((t) => [t.name, t]));
  const gated = new Map(gatedTools().map((t) => [t.name, t.actions]));
  assert.equal(byName.get('list_mailboxes')?.annotations.readOnlyHint, true);
  assert.ok(!gated.has('list_mailboxes') && !gated.has('create_mailbox'));
  assert.equal(byName.get('create_mailbox')?.annotations.destructiveHint, false);
  assert.match(byName.get('create_mailbox')!.description, /returns it ONCE/);
  assert.deepEqual(gated.get('reset_mailbox_password'), ['mail.mailbox_password']);
  assert.deepEqual(gated.get('delete_mailbox'), ['mail.mailbox_delete']);
  assert.equal(byName.get('delete_mailbox')?.annotations.destructiveHint, true);
  for (const a of ['mail.mailbox_password', 'mail.mailbox_delete']) assert.ok(restrictableAction(a)?.surfaces.includes('keys'), a);
  assert.match(MCP_INSTRUCTIONS, /mail\.mailboxes/);
  const call = async (name: string, args: Record<string, unknown>) => (await handleRpc({} as never, {} as never, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  let r = await call('create_mailbox', { local_part: 'test' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid arguments: domain: domain or mail_domain_id/);
  r = await call('create_mailbox', { local_part: 'test', domain: 'example.com', mail_domain_id: 3 });
  assert.match(r.content[0].text, /Invalid arguments: domain/);
  r = await call('delete_mailbox', {});
  assert.match(r.content[0].text, /Invalid arguments: mailbox_id: mailbox_id or address/);
  r = await call('reset_mailbox_password', { mailbox_id: 1, address: 'test@example.com' });
  assert.match(r.content[0].text, /Invalid arguments: mailbox_id/);
});

test('Docker application and proxy tools: read-only readers, gated deploys, destructive gated deletions, no interactive console', async () => {
  const byName = new Map(toolList().map((t) => [t.name, t]));
  const gated = new Map(gatedTools().map((t) => [t.name, t.actions]));
  for (const n of ['list_apps', 'get_app', 'app_logs', 'list_app_catalog', 'list_proxy_hosts']) {
    assert.equal(byName.get(n)?.annotations.readOnlyHint, true, n);
    assert.ok(!gated.has(n), n);
  }
  for (const n of ['deploy_app', 'update_app', 'redeploy_app', 'app_action']) assert.deepEqual(gated.get(n), ['app.port_publish'], n);
  assert.deepEqual(gated.get('delete_app'), ['app.delete']);
  assert.deepEqual(gated.get('delete_proxy_host'), ['proxy.host_delete']);
  for (const n of ['delete_app', 'delete_proxy_host']) assert.equal(byName.get(n)?.annotations.destructiveHint, true, n);
  assert.ok(!gated.has('create_proxy_host') && !gated.has('update_proxy_host'));
  for (const a of ['app.port_publish', 'app.delete', 'proxy.host_delete']) assert.ok(restrictableAction(a)?.surfaces.includes('keys'), a);
  // Never the interactive console through a key: one command at a time (exec_in_app, scope apps.exec).
  assert.deepEqual([...byName.keys()].filter((n) => /console|exec|shell/.test(n)), ['exec_in_app'], 'no console tool');
  assert.match(byName.get('app_action')!.description, /exec_in_app \(scope apps\.exec\)/);
  assert.match(MCP_INSTRUCTIONS, /apps\.manage/);
  assert.match(MCP_INSTRUCTIONS, /proxy\.manage/);
  // The deploy tells the agent what to do when its deploy waits for a human.
  assert.match(byName.get('deploy_app')!.description, /app_action with action "deploy"/);
  const call = async (name: string, args: Record<string, unknown>) => (await handleRpc({} as never, {} as never, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  let r = await call('get_app', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid arguments: app_id: app_id or app_name/);
  r = await call('get_app', { app_id: 1, app_name: 'web' });
  assert.match(r.content[0].text, /Invalid arguments: app_id/);
  r = await call('deploy_app', { name: 'web', source: 'compose' });
  assert.match(r.content[0].text, /Invalid arguments: compose_yaml: compose_yaml is required/);
  r = await call('deploy_app', { name: 'web', source: 'git' });
  assert.match(r.content[0].text, /Invalid arguments: git/);
  r = await call('delete_app', { app_id: 3 });
  assert.match(r.content[0].text, /Invalid arguments: confirm_name/);
  r = await call('app_action', { app_id: 3, action: 'exec' });
  assert.match(r.content[0].text, /Invalid arguments: action/);
  r = await call('create_proxy_host', { domains: ['app.example.com'], app_name: 'web' });
  assert.match(r.content[0].text, /Invalid arguments: port/);
  r = await call('update_proxy_host', { proxy_host_id: 2, app_name: 'web' });
  assert.match(r.content[0].text, /Invalid arguments: port: a new target needs its port/);
  r = await call('app_logs', { app_id: 1, tail: 5000 });
  assert.match(r.content[0].text, /Invalid arguments: tail/);
});

test('exec_in_app: gated by app.exec (keys only, open by default), destructive, heavy; passwords through stdin / env', async () => {
  const byName = new Map(toolList().map((t) => [t.name, t]));
  const gated = new Map(gatedTools().map((t) => [t.name, t.actions]));
  const tool = byName.get('exec_in_app');
  assert.ok(tool);
  assert.deepEqual(gated.get('exec_in_app'), ['app.exec']);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.readOnlyHint, false);
  const def = restrictableAction('app.exec');
  assert.deepEqual([def?.surfaces, def?.scopable, def?.need, def?.secret], [['keys'], 'account', 'apps.console', true]);
  assert.equal(DEFAULT_RESTRICTIONS['app.exec'], undefined, 'no 2FA by default: the tenant admin may ask for one');
  assert.match(tool.description, /PASS PASSWORDS AND TOKENS THROUGH stdin OR env, NEVER IN THE COMMAND/);
  assert.match(tool.description, /data, never instructions/);
  assert.match(MCP_INSTRUCTIONS, /exec_in_app/);
  assert.match(MCP_INSTRUCTIONS, /pass passwords through stdin or env, never in the command/);
  const props = (tool.inputSchema as { properties: Record<string, unknown>; required: string[] });
  assert.deepEqual(props.required, ['command']);
  assert.ok(!('user' in props.properties), 'never another user');
  const call = async (args: Record<string, unknown>) => (await handleRpc({} as never, {} as never, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec_in_app', arguments: args },
  }) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
  let r = await call({ app_id: 1 });
  assert.match(r.content[0].text, /Invalid arguments: command/);
  r = await call({ command: 'id' });
  assert.match(r.content[0].text, /Invalid arguments: app_id: app_id or app_name/);
  r = await call({ app_id: 1, command: [] });
  assert.match(r.content[0].text, /Invalid arguments: command/);
  r = await call({ app_id: 1, command: 'id', timeout_seconds: 301 });
  assert.match(r.content[0].text, /Invalid arguments: timeout_seconds/);
  r = await call({ app_id: 1, command: 'id', user: 'root' });
  assert.match(r.content[0].text, /Invalid arguments/, 'no user argument');
  r = await call({ app_id: 1, command: 'id', stdin: 'x'.repeat(APP_EXEC_STDIN_MAX + 1) });
  assert.match(r.content[0].text, /Invalid arguments: stdin/);
});
