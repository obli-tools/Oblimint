import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_ACTION_USER_MESSAGE_FR, RESTRICTABLE_ACTIONS, restrictableAction } from '@oblimint/shared';
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
