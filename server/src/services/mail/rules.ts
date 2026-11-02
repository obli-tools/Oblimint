import type { MailRule, MailRuleAction, MailRuleCondition } from '@oblimint/shared';
import { MAIL_RULE_LIMITS } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Inbox rules of a mailbox (Outlook-like, migration 034 mailboxes.mail_rules):
// PURE validation of an input list (panel route and webmail alike) and the
// helpers the forwarding policy needs. The sieve rendering is the engine's
// (engines/stalwart/sieve.ts): every value checked here is still re-checked
// there before it reaches a script.
//
// Errors: AppError 400 'invalidRule' with details { rule, field } (index of
// the rule in the list, the offending field).
// ─────────────────────────────────────────────────────────────────────────────

/** Same grammar as routes/mail.routes.ts MAIL_ADDRESS_RE. */
const ADDRESS_RE = /^(?!.*\.\.)[a-z0-9._+-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const TEXT_FIELDS = new Set(['from', 'toCc', 'subject', 'body']);
const L = MAIL_RULE_LIMITS;

function bad(rule: number, field: string, message: string): AppError {
  return new AppError(400, `Rule ${rule + 1}: ${message}`, 'invalidRule', { rule, field });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: string[], rule: number, where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(rule, where, `unknown field ${where}.${k}`);
}

/** A single-line text (trimmed), 1 … max characters, no control character. */
function text(v: unknown, max: number, rule: number, field: string, what: string): string {
  if (typeof v !== 'string') throw bad(rule, field, `${what}: text expected`);
  const s = v.trim();
  if (!s) throw bad(rule, field, `${what} is empty`);
  if (s.length > max) throw bad(rule, field, `${what}: at most ${max} characters`);
  if (CONTROL_RE.test(s)) throw bad(rule, field, `${what}: invalid characters`);
  return s;
}

function addresses(v: unknown, rule: number, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw bad(rule, field, 'at least one address');
  const out = [...new Set(v.map((a) => (typeof a === 'string' ? a.trim().toLowerCase() : '')))];
  if (out.length > L.targetsPerAction) throw bad(rule, field, `at most ${L.targetsPerAction} addresses`);
  for (const a of out) if (a.length > 254 || !ADDRESS_RE.test(a)) throw bad(rule, field, `invalid address ${a.slice(0, 80) || '(empty)'}`);
  return out;
}

/** "Projects/Clients": segments without control characters, no empty segment. */
export function normalizeFolder(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const parts = v.split('/').map((p) => p.trim());
  if (parts.some((p) => !p) || CONTROL_RE.test(v)) return null;
  const s = parts.join('/');
  return s.length >= 1 && s.length <= L.folderLength ? s : null;
}

function condition(v: unknown, rule: number, i: number): MailRuleCondition {
  const field = `conditions[${i}]`;
  if (!isObj(v) || typeof v.kind !== 'string') throw bad(rule, field, 'invalid condition');
  if (TEXT_FIELDS.has(v.kind)) {
    onlyKeys(v, ['kind', 'values'], rule, field);
    if (!Array.isArray(v.values) || v.values.length === 0) throw bad(rule, field, 'at least one word');
    const values = [...new Set(v.values.map((x) => text(x, L.valueLength, rule, field, 'a word')))];
    if (values.length > L.valuesPerCondition) throw bad(rule, field, `at most ${L.valuesPerCondition} words`);
    return { kind: v.kind as 'from' | 'toCc' | 'subject' | 'body', values };
  }
  if (v.kind === 'hasAttachment') {
    onlyKeys(v, ['kind'], rule, field);
    return { kind: 'hasAttachment' };
  }
  if (v.kind === 'sizeOver' || v.kind === 'sizeUnder') {
    onlyKeys(v, ['kind', 'kb'], rule, field);
    if (typeof v.kb !== 'number' || !Number.isInteger(v.kb) || v.kb < 1 || v.kb > 1_048_576) throw bad(rule, field, 'size: 1 to 1048576 KB');
    return { kind: v.kind, kb: v.kb };
  }
  throw bad(rule, field, `unknown condition ${String(v.kind).slice(0, 40)}`);
}

function action(v: unknown, rule: number, i: number): MailRuleAction {
  const field = `actions[${i}]`;
  if (!isObj(v) || typeof v.kind !== 'string') throw bad(rule, field, 'invalid action');
  switch (v.kind) {
    case 'move': {
      onlyKeys(v, ['kind', 'folder'], rule, field);
      const folder = normalizeFolder(v.folder);
      if (!folder) throw bad(rule, field, 'invalid folder');
      return { kind: 'move', folder };
    }
    case 'markRead': case 'flag': case 'delete': case 'discard':
      onlyKeys(v, ['kind'], rule, field);
      return { kind: v.kind };
    case 'forward': case 'redirect':
      onlyKeys(v, ['kind', 'to'], rule, field);
      return { kind: v.kind, to: addresses(v.to, rule, field) };
    default:
      throw bad(rule, field, `unknown action ${String(v.kind).slice(0, 40)}`);
  }
}

/** Kinds that decide where the message goes: at most one per rule. */
const PLACEMENT = new Set(['move', 'delete', 'discard', 'redirect']);

/**
 * Validated, normalized rule list. Throws AppError 400 invalidRule. The own
 * address of the mailbox is refused as a forward / redirect target (loop).
 */
export function parseMailRulesInput(input: unknown, ownAddress: string): MailRule[] {
  if (!Array.isArray(input)) throw new AppError(400, 'rules: a list expected', 'invalidRule', { field: 'rules' });
  if (input.length > L.rules) throw new AppError(400, `At most ${L.rules} rules`, 'invalidRule', { field: 'rules' });
  const own = ownAddress.toLowerCase();
  const ids = new Set<string>();
  return input.map((r, idx): MailRule => {
    if (!isObj(r)) throw bad(idx, 'rule', 'invalid rule');
    onlyKeys(r, ['id', 'name', 'enabled', 'match', 'conditions', 'actions', 'stop'], idx, 'rule');
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw bad(idx, 'id', 'invalid id');
    if (ids.has(r.id)) throw bad(idx, 'id', 'duplicate id');
    ids.add(r.id);
    const name = text(r.name, L.nameLength, idx, 'name', 'the name');
    if (typeof r.enabled !== 'boolean') throw bad(idx, 'enabled', 'enabled: boolean expected');
    if (r.match !== 'all' && r.match !== 'any') throw bad(idx, 'match', 'match: all or any');
    if (typeof r.stop !== 'boolean') throw bad(idx, 'stop', 'stop: boolean expected');
    if (!Array.isArray(r.conditions) || r.conditions.length > L.conditionsPerRule) throw bad(idx, 'conditions', `0 to ${L.conditionsPerRule} conditions`);
    if (!Array.isArray(r.actions) || r.actions.length === 0 || r.actions.length > L.actionsPerRule) throw bad(idx, 'actions', `1 to ${L.actionsPerRule} actions`);
    const conditions = r.conditions.map((c, i) => condition(c, idx, i));
    const actions = r.actions.map((a, i) => action(a, idx, i));
    const kinds = actions.map((a) => a.kind);
    if (new Set(kinds).size !== kinds.length) throw bad(idx, 'actions', 'the same action twice');
    if (kinds.filter((k) => PLACEMENT.has(k)).length > 1) throw bad(idx, 'actions', 'one destination at most (move, delete, discard or redirect)');
    for (const a of actions) {
      if ((a.kind === 'forward' || a.kind === 'redirect') && a.to.includes(own)) throw bad(idx, 'actions', 'the mailbox cannot forward to itself');
    }
    // Redirected / deleted for good: the message is gone, the rules below never see it (the
    // script stops there, sieve.ts) — stored as such so that both editors show it.
    const stop = r.stop || kinds.includes('redirect') || kinds.includes('discard');
    return { id: r.id, name, enabled: r.enabled, match: r.match, conditions, actions, stop };
  });
}

/** Forward / redirect targets of rules (lower case, in order, duplicates kept per rule). */
export function ruleTargets(rules: readonly MailRule[], onlyEnabled = false): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (onlyEnabled && !r.enabled) continue;
    for (const a of r.actions) if (a.kind === 'forward' || a.kind === 'redirect') out.push(...a.to);
  }
  return out;
}

/**
 * Redirections the managed script may run for one message: the forwarding
 * targets (when on) + every forward / redirect target of the enabled rules.
 * Bounded by MAIL_RULE_LIMITS.redirects (the engine's own limit).
 */
export function assertRedirectBudget(forwardTargets: readonly string[], rules: readonly MailRule[]): void {
  const n = forwardTargets.length + ruleTargets(rules, true).length;
  if (n > L.redirects) {
    throw new AppError(400, `At most ${L.redirects} forwarding destinations in all (forwarding and rules together): ${n} requested`, 'tooManyRedirects', { max: L.redirects, requested: n });
  }
}

/**
 * Owner policy (webmail): targets outside the account's own mail domains are
 * refused unless the platform allows them — a target already present in
 * `alreadyThere` (set by the panel) is kept. 403 forwardingNotAllowed.
 */
export function assertOwnerTargets(targets: readonly string[], ctx: { external: boolean; internalDomains: ReadonlySet<string>; alreadyThere: ReadonlySet<string> }): void {
  if (ctx.external) return;
  for (const t of targets) {
    const domain = t.slice(t.lastIndexOf('@') + 1).toLowerCase();
    if (!ctx.internalDomains.has(domain) && !ctx.alreadyThere.has(t.toLowerCase())) {
      throw new AppError(403, `Forwarding outside your own domains is not allowed on this platform (${t})`, 'forwardingNotAllowed', { target: t });
    }
  }
}

/** '/'-joined paths of JMAP mailboxes (the Inbox as INBOX, the sieve name), sorted, Drafts / Sent left out. */
export function folderPaths(list: Array<{ id: string; name: string; parentId: string | null; role: string | null }>): string[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  const path = (m: { id: string; name: string; parentId: string | null; role: string | null }, depth = 0): string | null => {
    if (depth > 20) return null;
    if (m.role === 'inbox' && !m.parentId) return 'INBOX';
    const parent = m.parentId ? byId.get(m.parentId) : null;
    if (m.parentId && !parent) return null;
    const head = parent ? path(parent, depth + 1) : '';
    return head === null ? null : head ? `${head}/${m.name}` : m.name;
  };
  return [...new Set(list.filter((m) => m.role !== 'drafts' && m.role !== 'sent' && typeof m.name === 'string')
    .map((m) => path(m)).filter((p): p is string => !!p && p.length <= MAIL_RULE_LIMITS.folderLength))]
    .sort((a, b) => (a === 'INBOX' ? -1 : b === 'INBOX' ? 1 : a.localeCompare(b)));
}
