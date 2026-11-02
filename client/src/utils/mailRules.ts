import type { MailRule, MailRuleAction, MailRuleCondition } from '@oblimint/shared';
import { MAIL_RULE_LIMITS } from '@oblimint/shared';

// Pure helpers of the inbox rules editors (panel mailbox page and Oblimint
// webmail): drafts, ordering, client-side checks mirroring the server's
// (server/src/services/mail/rules.ts stays the authority), folder paths.
// No DOM, no store: unit-tested (mailRules.test.ts).

export type RuleConditionKind = MailRuleCondition['kind'];
export type RuleActionKind = MailRuleAction['kind'];

export const RULE_CONDITION_KINDS: readonly RuleConditionKind[] = ['from', 'toCc', 'subject', 'body', 'hasAttachment', 'sizeOver', 'sizeUnder'];
export const RULE_ACTION_KINDS: readonly RuleActionKind[] = ['move', 'markRead', 'flag', 'forward', 'redirect', 'delete', 'discard'];

/** Actions that decide where the message goes: one per rule. */
export const PLACEMENT_ACTIONS: ReadonlySet<RuleActionKind> = new Set(['move', 'delete', 'discard', 'redirect']);

const ADDRESS_RE = /^(?!.*\.\.)[a-z0-9._+-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isRuleAddress(v: string): boolean {
  const a = v.trim().toLowerCase();
  return a.length <= 254 && ADDRESS_RE.test(a);
}

/** A fresh id ([A-Za-z0-9_-]). */
export function newRuleId(rand: () => number = Math.random): string {
  return `r${Date.now().toString(36)}${Math.floor(rand() * 1e9).toString(36)}`.slice(0, 40);
}

export function emptyRule(name = '', rand?: () => number): MailRule {
  return { id: newRuleId(rand), name, enabled: true, match: 'all', conditions: [], actions: [], stop: false };
}

/** Outlook's "Create a rule" from a message: From contains the sender. */
export function ruleFromSender(email: string, name: string | null | undefined, label: string, rand?: () => number): MailRule {
  const r = emptyRule(label.replace('{{who}}', (name ?? '').trim() || email).slice(0, MAIL_RULE_LIMITS.nameLength), rand);
  return { ...r, conditions: [{ kind: 'from', values: [email.toLowerCase()] }] };
}

/** Default condition / action of a kind (the editor's "Add" menus). */
export function newCondition(kind: RuleConditionKind): MailRuleCondition {
  if (kind === 'hasAttachment') return { kind };
  if (kind === 'sizeOver' || kind === 'sizeUnder') return { kind, kb: 1024 };
  return { kind, values: [] };
}

export function newAction(kind: RuleActionKind, defaultFolder = ''): MailRuleAction {
  if (kind === 'move') return { kind, folder: defaultFolder };
  if (kind === 'forward' || kind === 'redirect') return { kind, to: [] };
  return { kind };
}

/** Moves item i by delta (−1 up, +1 down); same array when out of range. */
export function moveItem<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** "a, b; c" → unique, trimmed, non-empty words / addresses. */
export function splitList(text: string, lower = false): string[] {
  return [...new Set(text.split(/[,;\n]+/).map((s) => (lower ? s.trim().toLowerCase() : s.trim())).filter(Boolean))];
}

/**
 * Problems of a rule before it is sent (null = fine). Codes, translated by
 * the editors: name, actions, oneDestination, sameAction, words, size,
 * folder, targets, targetSelf.
 */
export function ruleProblem(r: MailRule, ownAddress: string): string | null {
  const L = MAIL_RULE_LIMITS;
  if (!r.name.trim() || r.name.trim().length > L.nameLength) return 'name';
  if (r.actions.length === 0 || r.actions.length > L.actionsPerRule) return 'actions';
  const kinds = r.actions.map((a) => a.kind);
  if (new Set(kinds).size !== kinds.length) return 'sameAction';
  if (kinds.filter((k) => PLACEMENT_ACTIONS.has(k)).length > 1) return 'oneDestination';
  if (r.conditions.length > L.conditionsPerRule) return 'words';
  for (const c of r.conditions) {
    if ('values' in c) {
      const v = c.values.map((x) => x.trim()).filter(Boolean);
      if (!v.length || v.length > L.valuesPerCondition || v.some((x) => x.length > L.valueLength)) return 'words';
    }
    if ('kb' in c && (!Number.isInteger(c.kb) || c.kb < 1 || c.kb > 1_048_576)) return 'size';
  }
  for (const a of r.actions) {
    if (a.kind === 'move') {
      const parts = a.folder.split('/').map((p) => p.trim());
      if (!a.folder.trim() || parts.some((p) => !p) || a.folder.length > L.folderLength) return 'folder';
    }
    if (a.kind === 'forward' || a.kind === 'redirect') {
      if (!a.to.length || a.to.length > L.targetsPerAction || a.to.some((t) => !isRuleAddress(t))) return 'targets';
      if (a.to.some((t) => t.trim().toLowerCase() === ownAddress.trim().toLowerCase())) return 'targetSelf';
    }
  }
  return null;
}

/**
 * The message is gone after this rule (redirected, or deleted for good): the
 * rules below never run on it, whatever its "stop" switch (the server stores
 * stop = true and the script stops there).
 */
export function ruleEnds(r: Pick<MailRule, 'actions'>): boolean {
  return r.actions.some((a) => a.kind === 'redirect' || a.kind === 'discard');
}

/** The rule as the server expects it (words trimmed, addresses lower case, folder segments trimmed). */
export function cleanRule(r: MailRule): MailRule {
  return {
    ...r,
    stop: r.stop || ruleEnds(r),
    name: r.name.trim(),
    conditions: r.conditions.map((c) => ('values' in c ? { ...c, values: [...new Set(c.values.map((v) => v.trim()).filter(Boolean))] } : c)),
    actions: r.actions.map((a) => {
      if (a.kind === 'move') return { ...a, folder: a.folder.split('/').map((p) => p.trim()).join('/') };
      if (a.kind === 'forward' || a.kind === 'redirect') return { ...a, to: [...new Set(a.to.map((t) => t.trim().toLowerCase()).filter(Boolean))] };
      return a;
    }),
  };
}

/** Forward / redirect targets of the enabled rules (the redirect budget, MAIL_RULE_LIMITS.redirects). */
export function enabledRuleTargets(rules: readonly MailRule[]): number {
  return rules.filter((r) => r.enabled).reduce((n, r) => n + r.actions.reduce((m, a) => m + (a.kind === 'forward' || a.kind === 'redirect' ? a.to.length : 0), 0), 0);
}

/** Targets outside the internal domains (the owner policy of the webmail). */
export function externalTargets(targets: readonly string[], internalDomains: readonly string[]): string[] {
  const own = new Set(internalDomains.map((d) => d.toLowerCase()));
  return targets.filter((t) => !own.has(t.slice(t.lastIndexOf('@') + 1).toLowerCase()));
}

/** Sieve folder paths of JMAP mailboxes: Inbox = INBOX, children joined with '/', Drafts / Sent left out. */
export function mailboxFolderPaths(list: ReadonlyArray<{ id: string; name: string; parentId: string | null; role: string | null }>): Array<{ path: string; role: string | null }> {
  const byId = new Map(list.map((m) => [m.id, m]));
  const path = (m: { id: string; name: string; parentId: string | null; role: string | null }, depth = 0): string | null => {
    if (depth > 20) return null;
    if (m.role === 'inbox' && !m.parentId) return 'INBOX';
    const parent = m.parentId ? byId.get(m.parentId) : null;
    if (m.parentId && !parent) return null;
    const head = parent ? path(parent, depth + 1) : '';
    return head === null ? null : head ? `${head}/${m.name}` : m.name;
  };
  const out: Array<{ path: string; role: string | null }> = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (m.role === 'drafts' || m.role === 'sent') continue;
    const p = path(m);
    if (p && !seen.has(p) && p.length <= MAIL_RULE_LIMITS.folderLength) { seen.add(p); out.push({ path: p, role: m.role }); }
  }
  return out.sort((a, b) => (a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : a.path.localeCompare(b.path)));
}
